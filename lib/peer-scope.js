/**
 * STEP 11 / P0-2 + P0-3 - peer 作用域（纯函数，零副作用）
 *
 * 原则：作用域从 agent 上下文取，**不接受模型/请求参数**；
 * 过滤下推到 SQL（先过滤再 LIMIT），不在 JS 里后过滤。
 */

/** 从 agent / 请求上下文取作用域。取不到就当「未绑定」，权限最小。 */
export function scopeOf(agent) {
  const peerId = agent?.peerId ?? agent?.state?.peerId ?? null;
  const speakerId = agent?.state?.speakerId ?? null;
  const channel = agent?.state?.channel ?? agent?.channel ?? null;
  const isOwner = agent?.isOwner === true || agent?.state?.isOwner === true;
  return { peerId, speakerId, channel, isOwner, bound: !!peerId };
}

/**
 * 生成 SQL 片段：自己的 + 共享（peer_id IS NULL）。
 * 未绑定时**只返回共享**，绝不返回全库。
 */
export function peerSql(scope, column = 'peer_id') {
  const s = scope || {};
  if (s.isOwner && s.allowOwnerWide) return { where: '1=1', params: [] };
  if (!s.peerId) return { where: `${column} IS NULL`, params: [] };
  return { where: `(${column} = ? OR ${column} IS NULL)`, params: [s.peerId] };
}

/** 跨 peer 访问直接拒绝（读、写、详情都走这一条）。 */
export function assertSamePeer(scope, targetPeerId) {
  const s = scope || {};
  if (!targetPeerId) return { ok: true };                    // 共享项
  if (!s.bound) return { ok: false, reason: 'unbound_scope' };
  if (s.peerId === targetPeerId) return { ok: true };
  if (s.isOwner && s.allowOwnerWide) return { ok: true };    // 仅 console/owner 显式开启
  return { ok: false, reason: 'cross_peer' };
}

/** 读工具默认不返回来源 episode 原文。 */
export function redactSource(memory) {
  if (!memory || typeof memory !== 'object') return memory;
  const out = { ...memory };
  delete out.sourceEpisode;
  delete out.source_episode;
  delete out.evidenceText;
  return out;
}

/** consolidate 分组键：layer + peer，NULL 单独一档；跨 peer 永不合并。 */
export function consolidateGroupKey(row) {
  const layer = String(row?.layer || 'fact');
  const peer = row?.peer_id == null || row.peer_id === '' ? 'shared' : String(row.peer_id);
  return `${layer}|${peer}`;
}

/** 同组内是否允许合并：不同 peer 一律 false。 */
export function canMerge(a, b) {
  if (!a || !b) return false;
  const pa = a.peer_id == null || a.peer_id === '' ? 'shared' : String(a.peer_id);
  const pb = b.peer_id == null || b.peer_id === '' ? 'shared' : String(b.peer_id);
  if (pa !== pb) return false;
  return String(a.layer || '') === String(b.layer || '');
}

/** Web 层：不传 peer 时默认当前作用域，不返回全库。 */
export function resolveWebScope(scope, requestedPeer, { ownerToken = false } = {}) {
  const s = scope || {};
  if (!requestedPeer) return { peerId: s.peerId, wide: false };
  if (requestedPeer === s.peerId) return { peerId: s.peerId, wide: false };
  if (ownerToken && s.isOwner) return { peerId: requestedPeer, wide: true };
  return { peerId: s.peerId, wide: false, denied: true };
}
