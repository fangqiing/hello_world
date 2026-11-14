/**
 * STEP 14 - 记忆的时间锚点（纯函数）
 *
 * 目标：回忆的时候不只给内容，还给「什么时候」。
 * 「你上周说的那家店」比「你说过那家店」更像人。
 */

import { relativeTime, zonedParts, dayDiff, periodOf } from './temporal-context.js';

/** 给一条记忆加人类可读的时间标签。 */
export function annotateMemory(memory, { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  if (!memory || typeof memory !== 'object') return memory;
  const t = Number(memory.createdAt || memory.at || memory.ts);
  const when = Number.isFinite(t) && t > 0 ? relativeTime(t, now, timeZone) : '';
  return { ...memory, when, at: Number.isFinite(t) ? t : null };
}

/** 批量加标签；检索结果在拼 prompt 前过一遍。 */
export function annotateAll(memories = [], opts = {}) {
  return memories.map(m => annotateMemory(m, opts));
}

/**
 * 按自然日分组（今天 / 昨天 / 更早），用于时间线视图与夜间回顾。
 * 返回 [{ bucket, label, items }]，bucket 为 'today' | 'yesterday' | 'earlier'。
 */
export function timelineOf(memories = [], { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const today = zonedParts(timeZone, now).date;
  const buckets = { today: [], yesterday: [], earlier: [] };
  for (const m of memories) {
    const t = Number(m && (m.createdAt || m.at || m.ts));
    if (!Number.isFinite(t) || t <= 0) { buckets.earlier.push(m); continue; }
    const d = zonedParts(timeZone, t).date;
    const diff = dayDiff(d, today);
    if (diff === 0) buckets.today.push(m);
    else if (diff === 1) buckets.yesterday.push(m);
    else buckets.earlier.push(m);
  }
  const sortDesc = arr => arr.slice().sort((a, b) => Number(b.createdAt || b.at || 0) - Number(a.createdAt || a.at || 0));
  return [
    { bucket: 'today', label: '今天', items: sortDesc(buckets.today) },
    { bucket: 'yesterday', label: '昨天', items: sortDesc(buckets.yesterday) },
    { bucket: 'earlier', label: '更早', items: sortDesc(buckets.earlier) },
  ];
}

/**
 * 把记忆变成一句带时间锚点的话，例如「你上周说的：那家店」。
 * phrase 只给「时间 + 内容」的拼装，语气由生成层决定。
 */
export function anchorPhrase(memory, opts = {}) {
  const m = annotateMemory(memory, opts);
  const text = String(m.text || m.content || '').trim();
  if (!text) return '';
  if (!m.when) return text;
  return `${m.when}：${text}`;
}

/** 同一天内按上午/下午/夜里分段的短标签，用于日记页眉。 */
export function dayPhaseLabel(at, timeZone = 'Asia/Shanghai') {
  const p = zonedParts(timeZone, at);
  return `${p.weekdayZh}${periodOf(p.hour).label}`;
}

/** 防止把「未来时间」的记忆当成事实（时钟漂移或导入数据常见）。 */
export function isFutureDated(memory, now = Date.now(), toleranceMs = 5 * 60 * 1000) {
  const t = Number(memory && (memory.createdAt || memory.at || memory.ts));
  return Number.isFinite(t) && t > now + toleranceMs;
}
