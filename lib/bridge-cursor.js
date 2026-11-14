/**
 * STEP 11 / 桥 - 持久化游标（纯函数，零副作用）
 *
 * 修「每次重启丢掉重启前的未读」：
 *  - seen 与 lastSeq 落盘，重启读回；
 *  - 未读消息即使早于启动时间也补推一次（backfill）；
 *  - 原子写：tmp → fsync → rename。
 *
 * fs 由注入的 adapter 提供（writeTmp / rename / readFile），模块内不碰磁盘。
 */

export const STATE_VERSION = 1;
export const MAX_SEEN = 2000;
export const GRACE_MS = 5000;

export function emptyState() {
  return { version: STATE_VERSION, seen: [], lastSeq: 0, updatedAt: 0 };
}

/** 容错解析：非法 JSON / 版本不符 / 字段缺失都退回空状态，不抛。 */
export function loadState(raw) {
  if (!raw) return emptyState();
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return emptyState();
    if (Number(obj.version) !== STATE_VERSION) return emptyState();
    const seen = Array.isArray(obj.seen) ? obj.seen.filter(x => typeof x === 'string') : [];
    return {
      version: STATE_VERSION,
      seen: pruneSeen(seen),
      lastSeq: Number(obj.lastSeq) || 0,
      updatedAt: Number(obj.updatedAt) || 0,
    };
  } catch (err) {
    return emptyState();
  }
}

/** 只保留最近 N 条（尾部最新）。 */
export function pruneSeen(seen, max = MAX_SEEN) {
  const arr = Array.isArray(seen) ? seen : [];
  if (arr.length <= max) return arr.slice();
  return arr.slice(arr.length - max);
}

/** 去重键：会话 + 消息 id；缺 id 用时间兜底，避免所有缺 id 的消息互相覆盖。 */
export function keyOf(msg) {
  const conv = String(msg?.conversationId || msg?.conv || '');
  const id = String(msg?.id || msg?.messageId || '');
  if (id) return `${conv}|${id}`;
  const ts = String(msg?.timestamp || msg?.time || msg?.createdAt || '');
  return `${conv}|t:${ts}`;
}

/**
 * 是否该推。
 * 规则：不在 seen，且满足以下之一：
 *  - createdAt >= startedAt - graceMs（实时消息）
 *  - unreadCount > 0（重启前的未读，补推一次）
 */
export function shouldPush(msg, state, startedAt, graceMs = GRACE_MS) {
  if (!msg) return { push: false, reason: 'empty' };
  if (msg.direction && msg.direction !== 'incoming') return { push: false, reason: 'not_incoming' };
  const key = keyOf(msg);
  const seen = new Set((state && state.seen) || []);
  if (seen.has(key)) return { push: false, reason: 'seen', key };

  const t = toMs(msg.timestamp ?? msg.time ?? msg.createdAt ?? msg.createTime);
  const fresh = Number.isFinite(t) && t >= Number(startedAt) - graceMs;
  const unread = Number(msg.unreadCount || msg.unread || 0) > 0;

  if (fresh) return { push: true, reason: 'fresh', key, backfill: false };
  if (unread) return { push: true, reason: 'unread_backfill', key, backfill: true };
  return { push: false, reason: 'stale_and_read', key };
}

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;  // 秒 / 毫秒兼容
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** 推送成功后合并状态（不可变返回）。 */
export function mergePushed(state, key, seq, at = Date.now()) {
  const base = state || emptyState();
  const seen = pruneSeen([...(base.seen || []), String(key)]);
  return {
    version: STATE_VERSION,
    seen,
    lastSeq: Math.max(Number(base.lastSeq) || 0, Number(seq) || 0),
    updatedAt: at,
  };
}

/**
 * 原子写契约：adapter 提供 writeTmp(path, data) 与 rename(from, to)。
 * 两者都成功才算保存；失败返回 { ok:false }，调用方保持旧文件不动。
 */
export async function saveStateAtomic(adapter, path, state) {
  if (!adapter || typeof adapter.writeTmp !== 'function' || typeof adapter.rename !== 'function') {
    return { ok: false, reason: 'adapter_missing' };
  }
  const tmp = `${path}.tmp`;
  try {
    await adapter.writeTmp(tmp, JSON.stringify(state));
    await adapter.rename(tmp, path);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, reason: 'write_failed', error: String(err && err.message || err) };
  }
}

/** 读回：adapter.readFile(path) 返回字符串；失败返回空状态。 */
export async function loadStateFrom(adapter, path) {
  if (!adapter || typeof adapter.readFile !== 'function') return emptyState();
  try {
    const raw = await adapter.readFile(path);
    return loadState(raw);
  } catch (err) {
    return emptyState();
  }
}
