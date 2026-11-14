/**
 * STEP 15 - 成长页视图模型（纯函数，可直接使用）
 *
 * 目的：把「原则 / 章节 / 日记」三份原始数据整理成**时间轴 + 权重条**，
 * 不再把长文本直接堆成一面墙。
 *
 * 输入都按运行态真实字段适配；缺字段不报错，给空数组。
 */

import { relativeTime, zonedParts, periodOf } from './temporal-context.js';

export const TIERS = [
  { key: 'seed', min: 0, max: 0.35, label: '萌芽' },
  { key: 'grow', min: 0.35, max: 0.55, label: '成形' },
  { key: 'firm', min: 0.55, max: 0.75, label: '稳固' },
  { key: 'deep', min: 0.75, max: 1.01, label: '根深' },
];

export function tierOf(weight) {
  const w = Math.max(0, Math.min(1, Number(weight) || 0));
  return TIERS.find(t => w >= t.min && w < t.max) || TIERS[0];
}

/** 原则按权重降序，附 tier / 百分比 / 相对时间。 */
export function shapePrinciples(principles = [], { now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  return principles
    .filter(p => p && (p.statement || p.text))
    .map(p => {
      const w = Math.max(0, Math.min(1, Number(p.weight) || 0));
      return {
        id: String(p.id || ''),
        statement: String(p.statement || p.text || ''),
        weight: w,
        pct: Math.round(w * 100),
        tier: tierOf(w).label,
        status: String(p.status || 'candidate'),
        evidenceCount: Number(p.evidence_count || p.evidenceCount || 0),
        when: relativeTime(Number(p.learned_at || p.learnedAt || p.updated_at || 0), now, timeZone),
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** 按自然日分桶，倒序。 */
export function groupByDay(items = [], { timeZone = 'Asia/Shanghai' } = {}) {
  const map = new Map();
  for (const it of items) {
    const t = Number(it && (it.at || it.createdAt || it.ts));
    const date = Number.isFinite(t) && t > 0 ? zonedParts(timeZone, t).date : 'unknown';
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(it);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => ({ date, items: list }));
}

function dayLabel(date, nowDate) {
  if (date === 'unknown') return '更早';
  if (date === nowDate) return '今天';
  const [y, m, d] = date.split('-').map(Number);
  const [ny, nm, nd] = nowDate.split('-').map(Number);
  const diff = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(y, m - 1, d)) / 86400000);
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 0 && diff < 7) return `${diff} 天前`;
  return `${m} 月 ${d} 日`;
}

/**
 * 组装整个成长页。
 * chapters: [{ id, peer_id, at, kind, summary, status }]
 * diaries:  [{ id, peer_id, at, content }]
 */
export function buildGrowthView({
  principles = [], chapters = [], diaries = [], peer = {},
  now = Date.now(), timeZone = 'Asia/Shanghai', limit = 60,
} = {}) {
  const nowParts = zonedParts(timeZone, now);
  const shaped = shapePrinciples(principles, { now, timeZone });

  const events = [];
  for (const c of chapters) {
    const t = Number(c && c.at);
    if (!Number.isFinite(t)) continue;
    events.push({
      id: String(c.id || `ch_${t}`), at: t, kind: 'chapter',
      title: String(c.kind || '章节'), summary: String(c.summary || ''),
      open: c.status === 'open',
    });
  }
  for (const d of diaries) {
    const t = Number(d && d.at);
    if (!Number.isFinite(t)) continue;
    events.push({
      id: String(d.id || `dy_${t}`), at: t, kind: 'diary',
      title: '手记', summary: String(d.content || '').slice(0, 400), open: false,
    });
  }
  events.sort((a, b) => b.at - a.at);

  const timeline = groupByDay(events.slice(0, limit), { timeZone }).map(g => ({
    date: g.date,
    label: dayLabel(g.date, nowParts.date),
    count: g.items.length,
    items: g.items.map(e => ({ ...e, when: relativeTime(e.at, now, timeZone) })),
  }));

  const firstSeen = Number(peer.firstSeenAt || peer.first_seen || 0);
  return {
    header: {
      name: String(peer.displayName || peer.name || ''),
      knownFor: firstSeen > 0 ? relativeTime(firstSeen, now, timeZone) : '',
      principleCount: shaped.length,
      activeCount: shaped.filter(p => p.status === 'active').length,
      openChapters: chapters.filter(c => c && c.status === 'open').length,
      lastSeen: Number(peer.lastSeenAt || 0) > 0 ? relativeTime(Number(peer.lastSeenAt), now, timeZone) : '',
      period: periodOf(nowParts.hour).label,
    },
    principles: shaped,
    timeline,
    empty: shaped.length === 0 && timeline.length === 0,
  };
}
