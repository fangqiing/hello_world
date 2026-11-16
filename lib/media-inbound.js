/**
 * STEP 29 - 微信媒体入站：图片 / 语音 / 文件（零副作用，adapter 注入）
 *
 * 链路：
 *   wx-bridge 把媒体落盘 → 入站消息带 mediaPath / fileId / url
 *     → MediaIngest.ingest(msg)
 *        ├ 图片  → vision adapter（智谱 glm-4.6v-flash，STEP 13 已有）
 *        ├ 语音  → transcribe adapter（SILK 转码 + ASR，STEP 12 已有骨架）
 *        └ 文件  → extractText adapter → 文本（可走 read-book）
 *     → 生成 episode payload → store.appendEpisode
 *
 * 硬约束：
 *  - 文件路径只能来自 bridge，绝不接受用户在消息里给的路径
 *  - 大小/扩展名白名单，防任意文件读
 *  - 模型可见即已记录：转写/描述/正文进 prompt 前，必须先写 episode
 *  - 失败降级，不阻断对话
 */

import path from 'node:path';
import { DEFAULT_PROMPT } from './vision-tool.js';

/**
 * 把识别结果标记成「她看到的东西」，而不是「对方说的话」。
 *
 * 线上事故：识图描述被直接塞进 msg.text，于是那句「帮你把图里的文字提取出来了」
 * 变成了用户的发言。她的回应是「不是我。我没说过这种话」—— 她在反驳自己看到的描述。
 */
export function wrapSeenMedia(desc, kind, caption) {
  const label = kind === 'image' ? '图片' : kind === 'audio' ? '语音' : '文件';
  const cap = String(caption || '').trim();
  const capLine = cap && cap.length <= 200 ? `对方同时说：「${cap}」\n` : '';
  return `【对方发来一张${label}。下面是它里面的内容——这是你看到的，不是对方说的话】\n${capLine}${desc}`;
}

export const MEDIA = {
  IMAGE: 'image',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  UNSUPPORTED: 'unsupported',
};

export const DEFAULTS = {
  maxBytes: 1024 * 1024 * 1024,   // 1 GB；传 0 表示完全不限
  maxTextChars: 0,                // 0 = 不截断，正文原样进 episode
  lowConfidenceHint: true,
  // dsh 能解析的格式全集：只做「归哪一类」的判断，不做「能不能收」的限制。
  // DSH 侧可按实际解析器能力覆盖 allowedExt；留空数组 = 除 denyExt 外全收。
  allowedExt: [],
  // 唯一保留的黑名单：可执行/动态库，收了也不能执行，落盘也没意义
  denyExt: ['exe', 'dll', 'so', 'dylib', 'bin', 'com', 'scr', 'msi', 'appimage', 'deb', 'rpm', 'dmg', 'jar', 'class', 'wasm'],
  imageExt: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'heic', 'avif'],
  audioExt: ['silk', 'amr', 'wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'opus'],
  videoExt: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv'],
  docExt: [
    'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml',
    'ini', 'conf', 'xml', 'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb',
    'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'bash', 'ps1', 'sql', 'r', 'lua', 'php',
    'swift', 'kt', 'dart', 'vue', 'svelte', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt',
    'pptx', 'epub', 'rtf', 'odt', 'zip', 'tar', 'gz', '7z', 'rar', 'eml', 'ics', 'vcf',
  ],
};

const IMAGE_TYPE = /^(image|pic|photo|sticker|emoji)/i;
const AUDIO_TYPE = /^(voice|audio|sound)/i;
const DOC_TYPE = /^(file|doc|document|attachment)/i;

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

/** 只保留 ASCII 安全字符，防止 ../ 与中文路径问题。 */
export function safeFileName(name) {
  const s = String(name || 'file').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_');
  const clean = s.replace(/[^\w.\-]/g, '_').slice(0, 120);
  return clean || 'file';
}

/** 路径必须在媒体根目录内（真·路径规范化，不是字符串比较）。 */
export function assertInsideRoot(rootDir, filePath) {
  const root = path.resolve(String(rootDir || ''));
  const target = path.resolve(String(filePath || ''));
  if (target === root || target.startsWith(root + path.sep)) return target;
  throw Object.assign(new Error('media path escapes root'), { code: 'path_escape' });
}

/** 分类：优先看消息 type，其次看扩展名，最后看字段。 */
export function classifyMedia(msg = {}, cfg = DEFAULTS) {
  const m = msg || {};
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const type = String(m.type || '').toLowerCase();
  const name = String(m.fileName || m.mediaPath || m.url || '');
  const ext = extOf(name);

  let kind = MEDIA.UNSUPPORTED;
  if (IMAGE_TYPE.test(type) || c.imageExt.includes(ext)) kind = MEDIA.IMAGE;
  else if (AUDIO_TYPE.test(type) || c.audioExt.includes(ext)) kind = MEDIA.AUDIO;
  else if (DOC_TYPE.test(type) || c.docExt.includes(ext) || c.videoExt.includes(ext)) kind = MEDIA.DOCUMENT;
  else if (m.image || m.imageUrl) kind = MEDIA.IMAGE;
  else if (m.file || m.fileId) kind = MEDIA.DOCUMENT;

  return {
    kind,
    ext,
    type,
    hasPath: !!m.mediaPath,
    needsDownload: !m.mediaPath && !!(m.fileId || m.url || m.mediaUrl),
    source: m.mediaPath || m.url || m.mediaUrl || m.fileId || null,
  };
}

/** 生成可进会话日志的 episode（模型可见输入，必须先落这个再进 prompt）。 */
export function episodeForMedia({ msg = {}, kind, text, meta = {}, at = Date.now() } = {}) {
  const base = {
    id: `${msg.id || 'media'}:${kind}`,
    conversationId: msg.conversationId,
    sessionId: msg.sessionId || '',
    channel: msg.channel || 'wechat',
    peer_id: msg.peerId || null,
    speaker_id: msg.senderId || null,
    role: 'user',
    kind,
    sourceMedia: meta.path || msg.mediaPath || null,
    at,
  };
  return {
    ...base,
    text: String(text || '').trim(),
    asr: kind === MEDIA.AUDIO,
    vision: kind === MEDIA.IMAGE,
    file: kind === MEDIA.DOCUMENT,
    asrConfidence: meta.confidence ?? null,
    model: meta.model || null,
    truncated: !!meta.truncated,
  };
}

/** 降级文案：不让媒体失败变成「她不回话」。 */
export function fallbackText(kind, reason) {
  if (kind === MEDIA.IMAGE) return '（收到一张图，没看清）';
  if (kind === MEDIA.AUDIO) return '（收到一条语音，没转出来）';
  if (kind === MEDIA.DOCUMENT) return '（收到一个文件，没读出来）';
  return `（收到一个附件，没处理：${reason || '未知'}）`;
}

export class MediaIngest {
  /**
   * adapter 契约：
   *   download({ fileId, url, fileName }) -> { ok, path, size, error? }
   *   stat(path) -> { size }
   *   readAsDataUri(path) -> string
   *   vision({ dataUri, question }) -> { ok, text, confidence, model }
   *   transcribe({ path, format }) -> { ok, text, confidence, model }
   *   extractText({ path, ext }) -> { ok, text }
   *   store.appendEpisode(row)
   */
  constructor({ adapters = {}, store = null, clock = () => Date.now(), config = {}, rootDir = '' } = {}) {
    Object.assign(this, { ...adapters, store, clock });
    this.rootDir = rootDir;
    this.cfg = { ...DEFAULTS, ...config };
  }

  async ingest(msg = {}) {
    const info = classifyMedia(msg, this.cfg);
    const at = this.clock();
    if (info.kind === MEDIA.UNSUPPORTED) {
      return this._done(msg, info.kind, fallbackText(info.kind, 'unsupported'), { at }, { reason: 'unsupported' });
    }

    let path = msg.mediaPath || null;
    let size = Number(msg.size) || 0;

    // 没有本地路径但有 fileId/url → 由 bridge 下载，不接受用户给的路径
    if (!path && info.needsDownload) {
      if (typeof this.download !== 'function') {
        return this._done(msg, info.kind, fallbackText(info.kind, 'no_download_adapter'), { at }, { reason: 'no_download_adapter' });
      }
      try {
        const r = await this.download({ fileId: msg.fileId, url: msg.url || msg.mediaUrl, fileName: msg.fileName });
        if (!r || !r.ok || !r.path) throw new Error((r && r.error) || 'download_failed');
        path = r.path;
        size = Number(r.size) || 0;
      } catch (err) {
        return this._done(msg, info.kind, fallbackText(info.kind, 'download_failed'), { at }, { reason: 'download_failed', error: String(err.message || err) });
      }
    }
    if (!path) {
      return this._done(msg, info.kind, fallbackText(info.kind, 'no_media_path'), { at }, { reason: 'no_media_path' });
    }

    // 安全：只拒可执行格式；其余 dsh 能解析的都收
    if (this.cfg.denyExt.includes(info.ext)) {
      return this._done(msg, info.kind, fallbackText(info.kind, 'ext_denied'), { at }, { reason: 'ext_denied', ext: info.ext });
    }
    if (this.cfg.allowedExt.length && !this.cfg.allowedExt.includes(info.ext)) {
      return this._done(msg, info.kind, fallbackText(info.kind, 'ext_not_allowed'), { at }, { reason: 'ext_not_allowed', ext: info.ext });
    }
    try {
      if (typeof this.stat === 'function') size = Number((await this.stat(path)).size) || size;
      if (this.cfg.maxBytes > 0 && size > this.cfg.maxBytes) {
        return this._done(msg, info.kind, fallbackText(info.kind, 'too_large'), { at }, { reason: 'too_large', size });
      }
      if (this.rootDir) assertInsideRoot(this.rootDir, path);
    } catch (err) {
      return this._done(msg, info.kind, fallbackText(info.kind, err.code || 'guard_failed'), { at }, { reason: err.code || 'guard_failed' });
    }

    let text = '';
    let meta = { path };

    try {
      if (info.kind === MEDIA.IMAGE) {
        if (typeof this.readAsDataUri !== 'function' || typeof this.vision !== 'function') throw new Error('no_vision_adapter');
        const dataUri = await this.readAsDataUri(path);
        // 不要直接把对方的话当提问：视觉模型会顺着对话口吻回答「帮你把图里的文字提取出来了」，
        // 而那段话接着会被当成对方的发言塞进上下文。对方的话只用来说明该看哪里。
        const caption = String(msg.text || '').trim();
        const ask = caption && caption.length <= 120
          ? `${DEFAULT_PROMPT}\n（对方附了一句「${caption}」，据此决定重点看哪里；输出仍是客观描述，不要对话口吻。）`
          : DEFAULT_PROMPT;
        const r = await this.vision({ dataUri, question: ask });
        if (!r || !r.ok || !r.text) throw new Error((r && r.error) || 'vision_empty');
        text = r.text;
        meta = { ...meta, confidence: r.confidence ?? null, model: r.model || 'glm-4.6v-flash' };
      } else if (info.kind === MEDIA.AUDIO) {
        if (typeof this.transcribe !== 'function') throw new Error('no_asr_adapter');
        const r = await this.transcribe({ path, format: info.ext, size });
        if (!r || !r.ok || !r.text) throw new Error((r && r.error) || 'asr_empty');
        text = r.text;
        meta = { ...meta, confidence: r.confidence ?? null, model: r.model || null };
      } else {
        if (typeof this.extractText !== 'function') throw new Error('no_text_adapter');
        const r = await this.extractText({ path, ext: info.ext });
        if (!r || !r.ok || !r.text) throw new Error((r && r.error) || 'text_empty');
        text = r.text;
        if (this.cfg.maxTextChars > 0 && text.length > this.cfg.maxTextChars) {
          text = text.slice(0, this.cfg.maxTextChars);
          meta.truncated = true;
        }
      }
    } catch (err) {
      return this._done(msg, info.kind, fallbackText(info.kind, 'process_failed'), meta, { reason: 'process_failed', error: String(err.message || err) });
    }

    if (this.cfg.lowConfidenceHint && Number.isFinite(meta.confidence) && meta.confidence < 0.45) {
      text += '（可能不准）';
    }
    return this._done(msg, info.kind, text, meta, { at });
  }

  async _done(msg, kind, text, meta, extra) {
    const row = episodeForMedia({ msg, kind, text, meta, at: extra.at || this.clock() });
    if (this.store && typeof this.store.appendEpisode === 'function') {
      try { await this.store.appendEpisode(row); }
      catch (err) { return { ok: false, code: 'store_failed', episode: row, error: String(err.message || err) }; }
    }
    return { ok: true, episode: row, text, kind, reason: extra.reason || null, error: extra.error || null };
  }
}
