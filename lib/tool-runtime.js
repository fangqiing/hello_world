/**
 * STEP 13 - 外部 API 工具运行时（零副作用，可直接使用）
 *
 * 每个外部 API 都走这一层，保证 8 条约束：
 *  1 域名白名单（防 SSRF）  2 超时  3 结果截断  4 失败降级
 *  5 密钥不进日志/不进 prompt  6 来源标注  7 默认不写记忆  8 可开关
 *
 * fetch 由注入提供（默认 globalThis.fetch），便于测试与替换。
 */

export const TOOL_DEFAULTS = {
  timeoutMs: 8000,
  maxChars: 1200,
  maxRetries: 0,
  requireSource: true,
};

export class ToolError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'ToolError';
    this.code = code;
    this.meta = meta;
  }
}

export function hostOf(url) {
  try { return new URL(String(url)).host.toLowerCase(); } catch (err) { return ''; }
}

/** 域名白名单：精确匹配，不做后缀通配，避免 open-meteo.com.evil.com 混进来。 */
export function assertAllowed(url, allow = []) {
  const host = hostOf(url);
  if (!host) throw new ToolError('bad_url', 'invalid url');
  const list = (allow || []).map(h => String(h).toLowerCase());
  if (!list.includes(host)) throw new ToolError('domain_not_allowed', `blocked: ${host}`, { host });
  return host;
}

export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ToolError('timeout', `timeout ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 结果截断：超长直接切，不把上下文塞爆。 */
export function truncate(text, maxChars = TOOL_DEFAULTS.maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: `${s.slice(0, maxChars)}…`, truncated: true };
}

/** 抹掉可能出现在错误信息里的密钥。 */
export function redact(text, secrets = []) {
  let s = String(text || '');
  for (const k of secrets.filter(Boolean)) {
    if (k.length < 6) continue;
    s = s.split(k).join('***');
  }
  return s;
}

/**
 * 统一执行：白名单 → 超时 → 截断 → 来源标注 → 错误分类。
 * spec: { name, domains, timeoutMs, maxChars, fetch(url, init), buildRequest(args) }
 */
export async function runTool(spec, args = {}, ctx = {}) {
  const cfg = { ...TOOL_DEFAULTS, ...spec.config };
  const startedAt = Date.now();
  const fetchImpl = ctx.fetch || spec.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, code: 'no_fetch', text: '（当前环境没有 fetch）' };

  try {
    const req = spec.buildRequest(args, ctx);
    if (!req || !req.url) throw new ToolError('bad_request', 'no url');
    assertAllowed(req.url, spec.domains || []);
    const res = await withTimeout(fetchImpl(req.url, req.init || {}), cfg.timeoutMs);
    if (!res || res.ok === false) {
      throw new ToolError('http_error', `http ${res && res.status}`, { status: res && res.status });
    }
    const raw = typeof spec.parse === 'function' ? await spec.parse(res, args, ctx) : await res.text();
    const t = truncate(typeof raw === 'string' ? raw : (raw && raw.text) || '', cfg.maxChars);
    return {
      ok: true,
      text: t.text,
      truncated: t.truncated,
      source: (raw && raw.source) || hostOf(req.url),
      at: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      data: raw && raw.data ? raw.data : undefined,
    };
  } catch (err) {
    const code = err && err.code ? err.code : 'failed';
    const message = redact(err && err.message || err, [cfg.apiKey, ctx.apiKey]);
    // 失败降级：给一句能让对话继续的话，不抛给上层
    return {
      ok: false,
      code,
      text: code === 'timeout' ? '（这次查询超时了，没查到）' : '（这次没查到，稍后再试）',
      error: message,
      at: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/** 工具描述要短：模型看到的是这段文字，越长越容易被忽略。 */
export function toolSpec({ name, description, params, domains, fetch, buildRequest, parse, config }) {
  return { name, description, params, domains, fetch, buildRequest, parse, config };
}
