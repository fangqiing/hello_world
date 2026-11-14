/**
 * STEP 38 - 跨关系社会图谱（纯函数 + 轻存储）
 *
 * 问题：她对每个人的印象是隔离的。A 说过什么，到了 B 面前就消失。
 *       真人不是这样 —— 人有一个「谁跟谁有什么关系」的图，聊天时会自然带出来。
 * 定案：把「她跟某个人说话时提到了另一个人」记成一条边，带权重和来源原话。
 *
 * 边界（用户明确允许转述具体内容，但仍有三条硬约束）：
 *   ① 群聊一律不转述。群里有第三方，转述等于替别人公开私聊。
 *   ② 每条边可单独关闭（shareable=0），关了就不再注入。
 *   ③ 必须存来源原话。没有来源的印象不许进图谱 —— 否则她会被自己的幻觉喂大。
 */

export const GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS peer_edges (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'mention',
  weight REAL NOT NULL DEFAULT 0.5,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  shareable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_pair ON peer_edges(a_id, b_id, kind);
`;

export const EDGE_KINDS = ['mention', 'knows', 'like', 'dislike'];

const KIND_LABEL = {
  mention: '提到过',
  knows: '认识',
  like: '跟这个人处得不错',
  dislike: '跟这个人不太对付',
};

/** 名字太短会误伤（单字名、常见字），至少两个字才用来扫。 */
export function usableName(name) {
  const text = String(name || '').trim();
  if (text.length < 2) return '';
  if (/^(对方|他|她|你|我|某人|好友)$/.test(text)) return '';
  return text;
}

/**
 * 从她的一段话里找出「提到了谁」。
 * peers: [{id, labels:[displayName, learnedName, ...]}]
 * 返回 [{bId, name, kind}]，不含 aId 自己。
 */
export function findMentions(text, peers, { selfId = null } = {}) {
  const source = String(text || '');
  if (!source) return [];
  const hits = [];
  for (const peer of peers || []) {
    if (!peer || !peer.id || peer.id === selfId) continue;
    const labels = (peer.labels || []).map(usableName).filter(Boolean);
    const matched = labels.find((label) => source.includes(label));
    if (!matched) continue;
    const kind = /不喜欢|讨厌|烦|受不了/.test(source.slice(Math.max(0, source.indexOf(matched) - 12), source.indexOf(matched)))
      ? 'dislike'
      : /喜欢|挺好|不错/.test(source.slice(Math.max(0, source.indexOf(matched) - 12), source.indexOf(matched)))
        ? 'like'
        : 'mention';
    hits.push({ bId: peer.id, name: matched, kind });
  }
  return hits;
}

export function mergeEdge(existing, incoming, at = Date.now()) {
  if (!existing) {
    return {
      id: incoming.id || `eg_${at.toString(36)}`,
      a_id: incoming.aId,
      b_id: incoming.bId,
      kind: incoming.kind || 'mention',
      weight: 0.4,
      note: String(incoming.note || '').slice(0, 200),
      source: String(incoming.source || '').slice(0, 300),
      shareable: incoming.shareable === 0 ? 0 : 1,
      created_at: at,
      updated_at: at,
    };
  }
  const weight = Math.min(1, Number(existing.weight || 0) + 0.2);
  // 保留最近一次的原话作为来源，但不动 shareable —— 用户关掉的不许被自动打开。
  return {
    ...existing,
    weight,
    note: incoming.note ? String(incoming.note).slice(0, 200) : existing.note,
    source: incoming.source ? String(incoming.source).slice(0, 300) : existing.source,
    updated_at: at,
  };
}

/** 当前 peer 相关、且允许转述的边，按权重排序。 */
export function relatedEdges(peerId, edges, { limit = 3 } = {}) {
  return (edges || [])
    .filter((edge) => edge && Number(edge.shareable) !== 0)
    .filter((edge) => edge.a_id === peerId || edge.b_id === peerId)
    .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
    .slice(0, limit);
}

/**
 * 注入块。群聊直接返回 null —— 这是最需要守住的一条。
 *
 * @param {string} peerId 当前对话对象
 * @param {object[]} edges
 * @param {{labels?:object, isGroup?:boolean, limit?:number}} opts
 */
export function buildSocialGraphBlock(peerId, edges, { labels = {}, isGroup = false, limit = 3 } = {}) {
  if (isGroup) return null;
  const list = relatedEdges(peerId, edges, { limit });
  if (!list.length) return null;

  const lines = ['【你跟别人的往来】'];
  for (const edge of list) {
    const otherId = edge.a_id === peerId ? edge.b_id : edge.a_id;
    const other = labels[otherId] || '另一个人';
    const label = KIND_LABEL[edge.kind] || '提到过';
    const note = String(edge.note || '').trim();
    const from = edge.a_id === peerId ? '你跟对方提过' : '对方跟你提过';
    if (note) {
      lines.push(`- ${label}${other}：${from}「${note}」`);
    } else {
      lines.push(`- ${label}${other}`);
    }
  }
  lines.push('（这些是别处的对话。对方不问我就不主动说；问了可以照实讲，但别一次全倒出来。）');
  return lines.join('\n');
}
