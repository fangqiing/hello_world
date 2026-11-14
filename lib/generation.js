/**
 * 生成层：图片 / 视频 / 自制表情包 + 生成前确认门。
 *
 * 用户 2026-11-13 硬要求：任何生成之前必须先向本人确认。
 * 两阶段：第一次只出待确认票据（不调 API、不产生费用）；
 * 收到本人新消息且含确认词后，带票据 ID 再调一次才真正提交并回发微信。
 *
 * 端点：阿里云百炼 workspace 域名（DashScope 异步 /api/v1/...）。
 * /compatible-mode/v1/images/generations 在该账号返回 400 url error，不可用。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadProviderConfig } from './vision-tool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(HERE, '..', 'config');
const SKILL_FILE = path.resolve(HERE, '..', 'skills', 'image-prompt', 'SKILL.md');
const PENDING_FILE = path.join(CONFIG_DIR, 'generation-pending.json');
const USAGE_FILE = path.join(CONFIG_DIR, 'generation-usage.json');
const MEDIA_ROOT = '/root/whale-media';
const STICKER_ROOT = path.join(MEDIA_ROOT, 'stickers', 'custom');
const CONFIRM_YES = /^(确认|可以|好|行|对|要|嗯|来吧|发吧|生成吧|同意|出图|出视频|ok|yes|go)[\s，,。!！~～]*/i;
const CONFIRM_NO = /^(不|别|不要|不用|不必|先不|算了|取消|停|no|cancel|stop)|不可以|不确认|不行|别生成/i;
const AUDIT_FILE = path.join(CONFIG_DIR, 'generation-audit.jsonl');
const MIN_CONFIRM_GAP_MS = 3000;

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  },
};

const STICKER_STYLE = {
  joy: '开心、眼睛发亮、嘴角上扬',
  calm: '放松、淡淡微笑、安静',
  sad: '垂眼、委屈、带一点泪光',
  angry: '鼓腮、皱眉、冒小火苗',
  surprised: '瞪大眼、张嘴、惊叹',
  neutral: '呆萌、面无表情、微微歪头',
};

function readJson(p, fallback) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }
  catch (err) { return fallback; }
}
function writeJson(p, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
}
function today() { return new Date().toISOString().slice(0, 10); }
function audit(row) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  } catch (err) { /* audit must never block generation */ }
}
function safeErr(err) {
  return String(err?.message || err)
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/Signature=[^&\s"']+/gi, 'Signature=[redacted]')
    .slice(0, 220);
}
function lastInboundAt(whale) {
  for (const name of ['wechat', 'qq']) {
    const ch = whale?.channels?.get?.(name);
    if (ch && Number(ch.lastInboundAt) > 0) return Number(ch.lastInboundAt);
  }
  return 0;
}
function targetOf(whale) {
  return whale?.config?.ownerId || whale?.channels?.conversationIds?.()?.[0] || '';
}
function liveTickets(list, now) {
  return (Array.isArray(list) ? list : []).filter((t) => Number(t?.expiresAt) > now);
}
function skillGuide() {
  try { return readFileSync(SKILL_FILE, 'utf8').slice(0, 1500); }
  catch (err) { return ''; }
}
function stickerPrompt(prompt, bucket) {
  return `一张微信聊天用的可爱表情包贴纸：${prompt}。${STICKER_STYLE[bucket] || STICKER_STYLE.neutral}。Q版chibi比例，大头小身，粗描边，平涂色块，纯白背景，主体居中且占画面大部分，四周留白。不要边框、不要场景、不要水印、不要任何文字。正方形构图。`;
}

/** DashScope 异步任务：提交 -> 轮询 -> 从结果里取媒体 URL。 */
async function submitAndWait({ base, key, submitPath, body, pollIntervalMs, maxPolls, pickUrl }) {
  const res = await fetch(base + submitPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`submit ${res.status} ${JSON.stringify(j?.error || j?.message || {}).slice(0, 180)}`);
  const taskId = j?.output?.task_id;
  if (!taskId) throw new Error(`no task_id: ${JSON.stringify(j).slice(0, 180)}`);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const r = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const t = await r.json();
    const o = t?.output || {};
    if (o.task_status === 'SUCCEEDED') {
      const url = pickUrl(o);
      if (!url) throw new Error(`no media url in task result: ${JSON.stringify(o).slice(0, 200)}`);
      const dl = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!dl.ok) throw new Error(`media download ${dl.status}`);
      return Buffer.from(await dl.arrayBuffer());
    }
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(o.task_status)) {
      throw new Error(`task ${o.task_status}: ${JSON.stringify(o?.message || o?.code || '').slice(0, 160)}`);
    }
  }
  throw new Error(`task timeout (${maxPolls} polls), task_id=${taskId}`);
}

function imageUrlFrom(o) {
  const content = o?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    const hit = content.find((c) => c?.type === 'image' && c?.image);
    if (hit?.image) return hit.image;
  }
  return o?.results?.[0]?.url || '';
}
function videoUrlFrom(o) {
  return o?.video_url || o?.results?.[0]?.video_url || o?.results?.[0]?.url || '';
}

/** 两阶段共用的执行骨架。 */
function makeTool({ whale, name, description, kind, defaultModel, extraParams, defaultSize, priceCny, buildBody, pickUrl, ext }) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面 / 视频内容描述' },
        confirm: { type: 'string', description: '第二阶段：第一次调用返回的 requestId' },
        confirmText: { type: 'string', description: '第二阶段：本人回复确认的原话' },
        ...(extraParams || {}),
      },
      required: [],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const cfg = loadProviderConfig();
      const gen = cfg.generation || {};
      const qwen = cfg.qwen || {};
      let prompt = String(args.prompt || '').trim();
      if (!args.confirm && !prompt) return { ok: false, error: 'prompt required' };
      if (prompt.length > 1000) return { ok: false, error: 'prompt too long (max 1000)' };
      if (!qwen.enabled || !qwen.apiKey) return { ok: false, error: '未配置千问 key，生成能力不可用', needConfig: true };
      if (gen.confirmRequired === false) return { ok: false, error: '配置里关闭了确认门，按约定不允许直接生成' };

      const sticker = kind === 'image' && args.sticker === true;
      const bucket = ['joy', 'calm', 'sad', 'angry', 'surprised', 'neutral'].includes(String(args.mood || ''))
        ? String(args.mood) : 'neutral';
      if (sticker) prompt = stickerPrompt(prompt, bucket);

      const day = today();
      const usage = readJson(USAGE_FILE, {});
      const used = Number(usage[day] || 0) || 0;
      const limit = Number(gen.dailyLimit || 3);
      const now = Date.now();
      let pending = liveTickets(readJson(PENDING_FILE, []), now);

      if (args.confirm) {
        const ticket = pending.find((t) => t.id === String(args.confirm) && t.kind === kind);
        if (!ticket) return { ok: false, error: '票据不存在或已过期，请重新发起' };
        if (now - Number(ticket.createdAt) < MIN_CONFIRM_GAP_MS) return { ok: false, error: '还没经过本人确认（同一轮里连调两次不算）' };
        if (!(lastInboundAt(whale) > Number(ticket.createdAt))) return { ok: false, error: '还没收到本人的新消息，不能生成' };
        const confirmText = String(args.confirmText || '').trim();
        if (CONFIRM_NO.test(confirmText)) return { ok: false, error: '本人明确拒绝了，不生成' };
        if (!CONFIRM_YES.test(confirmText)) return { ok: false, error: '本人回复里没有明确确认，不能生成' };
        if (used >= limit) {
          writeJson(PENDING_FILE, pending.filter((t) => t.id !== ticket.id));
          return { ok: false, error: `今日生成额度已用完（${used}/${limit}）` };
        }
        const target = targetOf(whale);
        if (!target) return { ok: false, error: '没有可用的会话目标' };
        const base = qwen.dashscopeBase || String(qwen.baseUrl || '').replace(/\/compatible-mode\/v1\/?$/, '');
        if (!base) return { ok: false, error: '未配置 dashscopeBase' };
        let buf;
        try {
          buf = await submitAndWait({
            base, key: qwen.apiKey,
            submitPath: ticket.submitPath,
            body: buildBody(ticket),
            pollIntervalMs: Number(gen.pollIntervalMs || 3000),
            maxPolls: Number(gen.maxPolls || 40),
            pickUrl,
          });
        } catch (err) {
          audit({ event: 'failed', id: ticket.id, kind, reason: safeErr(err) });
          return { ok: false, error: `生成失败：${safeErr(err)}` };
        }
        if (!buf?.length) return { ok: false, error: '生成返回空文件' };
        let dir = MEDIA_ROOT;
        if (ticket.sticker) dir = path.join(STICKER_ROOT, ticket.bucket);
        mkdirSync(dir, { recursive: true });
        const fileName = `${ticket.sticker ? 'sticker' : 'gen'}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
        const abs = path.join(dir, fileName);
        writeFileSync(abs, buf);
        let sent = false;
        try {
          await whale.channels.sendMedia('wechat', target,
            { kind: ticket.sticker ? 'image' : kind, data: buf.toString('base64'), fileName }, { agentBypass: true });
          sent = true;
        } catch (err) {
          return { ok: false, error: `已生成但发送失败：${safeErr(err)}`, path: abs };
        }
        audit({ event: 'generated', id: ticket.id, kind, model: ticket.model, bytes: buf.length,
                path: abs, sent, target, sticker: Boolean(ticket.sticker), estimatedCostCny: ticket.estimatedCostCny });
        writeJson(PENDING_FILE, pending.filter((t) => t.id !== ticket.id));
        usage[day] = used + 1;
        writeJson(USAGE_FILE, usage);
        return {
          ok: true, generated: true, sent, path: abs, bytes: buf.length,
          model: ticket.model, size: ticket.size, sticker: Boolean(ticket.sticker),
          bucket: ticket.bucket || null, todayUsed: used + 1, dailyLimit: limit,
        };
      }

      if (used >= limit) return { ok: false, error: `今日生成额度已用完（${used}/${limit}）` };
      const ttl = Number(gen.confirmTtlMs || 600000);
      const ticket = {
        id: randomUUID(), kind, prompt,
        size: String(args.size || defaultSize),
        provider: 'qwen',
        model: defaultModel,
        submitPath: ticketSubmitPath(kind),
        duration: Math.min(10, Math.max(2, Number(args.duration || 5))),
        sticker: Boolean(sticker), bucket,
        createdAt: now, expiresAt: now + ttl,
        estimatedCostCny: priceCny,
      };
      pending.push(ticket);
      writeJson(PENDING_FILE, pending);
      audit({ event: 'ticket', id: ticket.id, kind, prompt: ticket.prompt, model: ticket.model,
              size: ticket.size, sticker: ticket.sticker, estimatedCostCny: ticket.estimatedCostCny });
      return {
        ok: true, needConfirm: true, requestId: ticket.id,
        prompt: ticket.prompt, size: ticket.size, model: ticket.model,
        sticker: ticket.sticker, bucket: ticket.bucket,
        estimatedCostCny: ticket.estimatedCostCny,
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        todayUsed: used, dailyLimit: limit,
        promptGuide: skillGuide(),
        instruction: '把「待生成：内容 / 模型 / 预估费用」原样发给本人并问要不要生成。只有他明确回复确认后，才带 confirm=requestId 与 confirmText=他的原话再调一次本工具（第二次 prompt 可省略）。不许自己连调两次，不许编造确认词。',
      };
    },
  };
}

function ticketSubmitPath(kind) {
  return kind === 'video'
    ? '/api/v1/services/aigc/video-generation/video-synthesis'
    : '/api/v1/services/aigc/image-generation/generation';
}

export function createGenerationTool(whale) {
  return makeTool({
    whale,
    name: 'whale_generate_image',
    kind: 'image',
    description: '生成一张图片（或自制表情包）并直接发到当前微信会话。第一次调用只返回待确认票据、不花钱；本人明确回复确认后再带 confirm 与 confirmText 调一次才真正生成。sticker=true 时按表情包风格生成并存入自制表情包库。',
    defaultModel: loadProviderConfig().generation?.imageModel || 'wan2.7-image',
    defaultSize: '1024*1024',
    priceCny: Number(loadProviderConfig().generation?.estimatedUnitPriceCny || 0.2),
    ext: 'png',
    extraParams: {
      size: { type: 'string', description: '尺寸，默认 1024*1024' },
      sticker: { type: 'boolean', description: 'true=生成表情包贴纸并收入自制表情包库' },
      mood: { type: 'string', description: 'sticker 时的心情：joy/calm/sad/angry/surprised/neutral' },
    },
    pickUrl: imageUrlFrom,
    buildBody: (t) => ({
      model: t.model,
      input: { messages: [{ role: 'user', content: [{ text: t.prompt }] }] },
      parameters: { size: t.size, n: 1, watermark: false },
    }),
  });
}

export function createVideoGenerationTool(whale) {
  const cfg = loadProviderConfig();
  return makeTool({
    whale,
    name: 'whale_generate_video',
    kind: 'video',
    description: '生成一段短视频并直接发到当前微信会话。同样必须先拿待确认票据、等本人明确回复确认后才真正生成。视频按秒计费，比图片贵得多。',
    defaultModel: cfg.generation?.videoModel || 'wan2.7-t2v',
    defaultSize: '720P',
    priceCny: Number(cfg.generation?.estimatedVideoUnitPriceCny || 3),
    ext: 'mp4',
    extraParams: {
      size: { type: 'string', description: '分辨率，默认 720P（1080P 更贵）' },
      duration: { type: 'number', description: '时长秒数，默认 5，最大 10' },
    },
    pickUrl: videoUrlFrom,
    buildBody: (t) => ({
      model: t.model,
      input: { prompt: t.prompt },
      parameters: { resolution: t.size, duration: Math.min(10, Math.max(2, Number(t.duration || 5))) },
    }),
  });
}
