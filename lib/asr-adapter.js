/**
 * STEP 32 - ASR adapter（完整实现，对齐 STEP 29 MediaIngest 契约）
 *
 *   transcribe({ path, format }) -> { ok, text, confidence, model, error? }
 *
 * 链路：读文件头 → 探测 SILK/WAV/AMR → 转码成 16k mono wav → POST SenseVoice 服务
 * 所有外部动作注入：run（跑命令）、readHead（读前 16 字节）、fetchImpl（HTTP）。
 * 失败一律返回 ok:false，由 MediaIngest 走「（收到一条语音，没转出来）」降级。
 */

import { detectAudio, buildTranscodePlan, FORMAT } from './silk.js';

export const DEFAULTS = {
  endpoint: 'http://172.21.0.1:6176/transcribe',
  decoder: 'pilk',
  sampleRate: 24000,
  pilkScript: '/opt/asr/pilk_decode.py',
  timeoutMs: 30000,
  maxAudioBytes: 200 * 1024 * 1024,
  model: 'sensevoice-small',
};

function fillArgs(args, vars) {
  return args.map(a => {
    let s = String(a);
    for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(v);
    if (s === 'PILK_DECODE') return vars.pilkScript;
    return s;
  });
}

export function createAsrAdapter({ run, readHead, fetchImpl, tmpPath, config = {}, logger = null } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const log = (kind, data) => { if (typeof logger === 'function') { try { logger(kind, data); } catch (e) {} } };

  async function transcribe({ path, format: hinted = null, size = 0 } = {}) {
    if (!path) return { ok: false, error: 'no_path' };
    if (cfg.maxAudioBytes > 0 && Number(size) > cfg.maxAudioBytes) {
      return { ok: false, error: 'too_large', size };
    }

    // ① 探测格式
    let info = hinted ? { format: hinted } : null;
    if (!info) {
      if (typeof readHead !== 'function') return { ok: false, error: 'no_readHead' };
      try { info = detectAudio(await readHead(path)); }
      catch (err) { return { ok: false, error: 'read_head_failed', detail: String(err.message || err) }; }
    }
    if (info.format === FORMAT.UNKNOWN) return { ok: false, error: 'unknown_audio_format', magic: info.magic };

    // ② 转码
    const plan = buildTranscodePlan(info.format, { decoder: cfg.decoder, sampleRate: cfg.sampleRate });
    const vars = {
      in: path,
      pcm: tmpPath ? tmpPath(path, '.pcm') : path + '.pcm',
      wav: tmpPath ? tmpPath(path, '.wav') : path + '.wav',
      pilkScript: cfg.pilkScript,
    };
    let wavPath = vars.wav;
    if (plan.needed) {
      if (typeof run !== 'function') return { ok: false, error: 'no_run' };
      for (const step of plan.steps) {
        const [cmd, args] = step;
        try {
          const r = await run(cmd, fillArgs(args, vars), { timeoutMs: cfg.timeoutMs });
          if (!r || r.ok === false || (Number.isFinite(r.code) && r.code !== 0)) {
            log('asr_transcode_failed', { cmd, code: r && r.code, stderr: r && r.stderr });
            return { ok: false, error: 'transcode_failed', step: cmd, detail: String((r && r.stderr) || '') };
          }
        } catch (err) {
          return { ok: false, error: 'transcode_exception', step: cmd, detail: String(err.message || err) };
        }
      }
    } else {
      wavPath = path;
    }

    // ③ 调 SenseVoice 服务
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' };
    let payload;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;
      const res = await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wavPath, model: cfg.model }),
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!res || res.ok === false) return { ok: false, error: 'asr_http', status: res && res.status };
      payload = await res.json();
    } catch (err) {
      return { ok: false, error: 'asr_unavailable', detail: String(err.message || err) };
    }

    const text = String((payload && (payload.text || payload.result)) || '').trim();
    if (!text) return { ok: false, error: 'empty_transcript', payload };
    return {
      ok: true,
      text,
      confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0.85,
      model: payload.model || cfg.model,
      language: payload.language || null,
      elapsedMs: payload.elapsedMs || null,
    };
  }

  return { transcribe, config: cfg };
}

/** 把本 adapter 挂到 STEP 29 的 buildMedia() 上的最小代码（供 DSH 复制）。 */
export const WIRING_SNIPPET = `import { createAsrAdapter } from './lib/asr-adapter.js';
const asr = createAsrAdapter({
  run: (cmd, args, opts) => execFileAsync(cmd, args, opts),
  readHead: (p) => fs.promises.readFile(p).then(b => b.subarray(0, 16)),
  fetchImpl: fetch,
  tmpPath: (p, ext) => path.join(os.tmpdir(), 'asr_' + path.basename(p) + ext),
  config: { endpoint: 'http://172.21.0.1:6176/transcribe' },
});
// buildMedia() 里：
transcribe: asr.transcribe,`;
