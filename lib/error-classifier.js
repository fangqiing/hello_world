/**
 * STEP 12 / 补丁 3 - 错误分类（纯函数）
 *
 * 问题：extractJson 未导入的 ReferenceError 被 catch 吞成 infer_unavailable，
 *      代码 bug 伪装成环境问题。
 * 修法：degradable / fatal 二分；fatal 打 stack 进 health，不退化成降级。
 */

/** 这些错误说明代码自身有问题，不能当成「服务不可用」。 */
export const FATAL_NAMES = new Set([
  'ReferenceError', 'TypeError', 'SyntaxError', 'RangeError',
]);

/** 这些错误可以安全降级（走 heuristic / 跳过本轮）。 */
export const DEGRADABLE_NAMES = new Set([
  'TimeoutError', 'AbortError', 'FetchError',
]);

const DEGRADABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENOENT']);

/**
 * 分类。ctx 可提供 { phase: 'infer'|'extract'|'store', httpStatus }。
 * 返回 { kind:'fatal'|'degradable', reason, healthKey }
 */
export function classify(err, ctx = {}) {
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const status = Number(ctx.httpStatus || err?.status || 0);

  if (FATAL_NAMES.has(name)) {
    return { kind: 'fatal', reason: `exception:${name}`, healthKey: 'internal_fatal' };
  }
  if (DEGRADABLE_NAMES.has(name) || DEGRADABLE_CODES.has(code)) {
    return { kind: 'degradable', reason: `io:${name || code}`, healthKey: 'infer_degraded' };
  }
  if (status === 429 || status >= 500) {
    return { kind: 'degradable', reason: `http:${status}`, healthKey: 'infer_degraded' };
  }
  if (status >= 400) {
    return { kind: 'degradable', reason: `http:${status}`, healthKey: 'infer_degraded' };
  }
  // JSON 解析失败属于模型输出问题，可降级
  if (/JSON/i.test(String(err?.message || '')) && /parse|unexpected token/i.test(String(err?.message || ''))) {
    return { kind: 'degradable', reason: 'bad_json', healthKey: 'infer_degraded' };
  }
  // 未知错误按 fatal 处理：宁可吵，也不要静默伪装成可用
  return { kind: 'fatal', reason: `unknown:${name || code || 'error'}`, healthKey: 'internal_fatal' };
}

/** 统一错误记录，禁止空 catch。 */
export function toHealthRecord(err, ctx = {}) {
  const c = classify(err, ctx);
  return {
    ...c,
    phase: ctx.phase || 'unknown',
    message: String(err?.message || err || '').slice(0, 300),
    stack: String(err?.stack || '').split('\n').slice(0, 20).join('\n'),
    at: ctx.at || Date.now(),
  };
}

/** 启动自检：依赖必须是函数，缺失直接抛，不等到运行期第一次调用。 */
export function assertDeps(deps = {}, scope = 'startup') {
  const missing = Object.entries(deps)
    .filter(([, v]) => typeof v !== 'function')
    .map(([k]) => k);
  if (missing.length) {
    const err = new ReferenceError(`[${scope}] missing deps: ${missing.join(', ')}`);
    err.missing = missing;
    throw err;
  }
  return true;
}

/** health 汇总：fatal 非零就是 P0。 */
export function healthSummary(records = []) {
  const out = { infer_degraded: 0, internal_fatal: 0, last: null };
  for (const r of records) {
    if (r?.healthKey === 'internal_fatal') out.internal_fatal += 1;
    else if (r?.healthKey === 'infer_degraded') out.infer_degraded += 1;
    out.last = r || out.last;
  }
  return { ...out, alert: out.internal_fatal > 0 };
}
