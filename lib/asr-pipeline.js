/**
 * STEP 12 / 语音 - 可直接使用的语音入站流水线（零副作用）
 *
 * 目标：微信语音 → 转码 → ASR → 文本 episode，DSH 只需注入三个 adapter：
 *   transcode(path, format) -> { ok, wavPath, error? }
 *   transcribe(wavPath)     -> { ok, text, confidence, model, error? }
 *   store.appendEpisode(row) / store.markVoiceSkipped(row)
 *
 * 设计要点：
 *  - 每一步都有明确 stage，失败停在该 stage 并给原因，便于排障；
 *  - ASR 失败不阻断回复：降级为「收到一条语音（未转写）」；
 *  - 转写文本是模型可见输入，落 episode 时带 asr/sourceMedia/confidence 证据；
 *  - 群语音保留 speaker_id，不因转写抹掉发言人。
 */

export const SILK_MAGIC = '#!SILK_V3';
export const STAGE = {
  RECEIVED: 'received',
  MEDIA_MISSING: 'media_missing',
  PROBED: 'probed',
  TRANSCODED: 'transcoded',
  TRANSCRIBED: 'transcribed',
  INJECTED: 'injected',
  DEGRADED: 'degraded',
  FAILED: 'failed',
};

export const DEFAULTS = {
  confidenceThreshold: 0.45,
  maxDurationSec: 120,
  hintLowConfidence: true,
};

/** 从文件头判断音频格式。head 为 Uint8Array / Buffer 前 16 字节。 */
export function detectAudioFormat(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  const ascii = Array.from(bytes.slice(0, 10)).map(b => String.fromCharCode(b)).join('');
  if (ascii.startsWith(SILK_MAGIC.slice(0, 9)) || ascii.startsWith('#!SILK')) return { format: 'silk', magic: ascii };
  if (ascii.startsWith('RIFF')) return { format: 'wav', magic: ascii };
  if (ascii.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { format: 'mp3', magic: ascii };
  if (ascii.startsWith('#!AMR')) return { format: 'amr', magic: ascii };
  return { format: 'unknown', magic: ascii };
}

/** 给出转码计划（不执行）。目标统一 16k 单声道 wav。 */
export function buildTranscodePlan(format) {
  if (format === 'wav') return { needed: false, tool: null };
  if (format === 'silk') {
    return {
      needed: true,
      tool: 'silk_v3_decoder',
      steps: ['silk_v3_decoder <in> /tmp/asr.pcm', 'ffmpeg -f s16le -ar 24000 -ac 1 -i /tmp/asr.pcm -ar 16000 -ac 1 <out.wav'],
      note: '多数发行版 ffmpeg 不带 libsilk，必须先用 silk_v3_decoder 解出 pcm',
    };
  }
  if (format === 'amr') {
    return { needed: true, tool: 'ffmpeg', steps: ['ffmpeg -i <in> -ar 16000 -ac 1 <out.wav>'] };
  }
  if (format === 'mp3') {
    return { needed: true, tool: 'ffmpeg', steps: ['ffmpeg -i <in> -ar 16000 -ac 1 <out.wav>'] };
  }
  return { needed: true, tool: null, steps: [], note: '未知格式，需人工确认' };
}

/** 置信度够不够、文本是否可用。 */
export function shouldInject({ text, confidence, threshold = DEFAULTS.confidenceThreshold } = {}) {
  const t = String(text || '').trim();
  if (!t) return { inject: false, reason: 'empty_text' };
  if (/^\[?(音乐|音乐声|噪声|静音|无法识别|听不清)\]?$/.test(t)) return { inject: false, reason: 'noise' };
  const c = Number(confidence);
  if (Number.isFinite(c) && c < threshold) return { inject: true, lowConfidence: true, reason: 'below_threshold' };
  return { inject: true, lowConfidence: false, reason: 'ok' };
}

/** 落库 payload：模型可见即已记录，证据齐全。 */
export function episodePayload({ msg = {}, transcript, asr = {}, lowConfidence = false } = {}) {
  const text = String(transcript || '').trim();
  const hint = lowConfidence ? '（语音转写，可能不准）' : '';
  return {
    id: `${msg.id || 'voice'}:asr`,
    conversationId: msg.conversationId,
    peer_id: msg.peerId || null,
    speaker_id: msg.senderId || null,
    role: 'user',
    kind: 'voice',
    text: hint ? `${text}${hint}` : text,
    asr: true,
    asrModel: asr.model || 'unknown',
    asrConfidence: Number.isFinite(Number(asr.confidence)) ? Number(asr.confidence) : null,
    sourceMedia: msg.mediaPath || null,
    durationSec: Number(msg.duration) || null,
    at: Number(msg.createdAt ? Date.parse(msg.createdAt) : Date.now()) || Date.now(),
  };
}

export class VoiceIngest {
  constructor({ transcode, transcribe, store, clock = () => Date.now(), config = {} } = {}) {
    Object.assign(this, { transcode, transcribe, store, clock });
    this.cfg = { ...DEFAULTS, ...config };
    this.last = null;
  }

  _fail(stage, reason, extra = {}) {
    const rec = { ok: false, stage, reason, at: this.clock(), ...extra };
    this.last = rec;
    return rec;
  }

  /**
   * msg 需要：{ id, conversationId, senderId, peerId?, mediaPath?, duration?, createdAt? }
   * 返回 { ok, stage, episode?, reason? }
   */
  async ingest(msg = {}) {
    if (!msg.mediaPath) return this._fail(STAGE.MEDIA_MISSING, 'no_media_path');
    if (Number(msg.duration) > this.cfg.maxDurationSec) {
      return this._fail(STAGE.RECEIVED, 'too_long', { duration: Number(msg.duration) });
    }

    if (typeof this.transcode !== 'function') return this._fail(STAGE.PROBED, 'transcode_adapter_missing');
    let t;
    try {
      t = await this.transcode(msg.mediaPath, msg.mediaFormat || 'silk');
    } catch (err) {
      return this._fail(STAGE.TRANSCODED, 'transcode_exception', { error: String(err && err.message || err) });
    }
    if (!t || t.ok === false || !t.wavPath) {
      return this._fail(STAGE.TRANSCODED, (t && t.error) || 'transcode_failed');
    }

    if (typeof this.transcribe !== 'function') {
      // 没有 ASR 也要有降级：记一条「收到语音未转写」
      return this._degrade(msg, 'transcribe_adapter_missing');
    }
    let r;
    try {
      r = await this.transcribe(t.wavPath);
    } catch (err) {
      return this._degrade(msg, 'transcribe_exception', String(err && err.message || err));
    }
    const verdict = shouldInject({ text: r && r.text, confidence: r && r.confidence, threshold: this.cfg.confidenceThreshold });
    if (!verdict.inject) return this._degrade(msg, verdict.reason);

    const row = episodePayload({ msg, transcript: r.text, asr: r, lowConfidence: verdict.lowConfidence && this.cfg.hintLowConfidence });
    if (this.store && typeof this.store.appendEpisode === 'function') {
      try { await this.store.appendEpisode(row); }
      catch (err) { return this._fail(STAGE.INJECTED, 'store_failed', { error: String(err && err.message || err) }); }
    }
    const rec = { ok: true, stage: STAGE.INJECTED, episode: row, lowConfidence: verdict.lowConfidence, at: this.clock() };
    this.last = rec;
    return rec;
  }

  async _degrade(msg, reason, error) {
    const row = {
      id: `${msg.id || 'voice'}:skipped`,
      conversationId: msg.conversationId,
      peer_id: msg.peerId || null,
      speaker_id: msg.senderId || null,
      role: 'user',
      kind: 'voice',
      text: '（收到一条语音，未转写）',
      asr: false,
      sourceMedia: msg.mediaPath || null,
      reason,
      at: this.clock(),
    };
    if (this.store && typeof this.store.markVoiceSkipped === 'function') {
      try { await this.store.markVoiceSkipped(row); } catch (err) { /* 降级写失败不阻断 */ }
    }
    const rec = { ok: false, stage: STAGE.DEGRADED, reason, episode: row, error, at: this.clock() };
    this.last = rec;
    return rec;
  }
}
