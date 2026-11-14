/**
 * STEP 12 / 补丁 2 - peer 身份单源（纯函数）
 *
 * 问题：defaultPeerId() 生成 wechat:<ownerId>，入站是 wechat:private:<id> / qq:private:<id>，
 *      同一个人跨通道/console 变成多个 peer；且 peers 表与运行时注册表两套并存。
 * 修法：统一 peerId 规则 + 两表对账（只读检查，不写库）。
 */

export const KINDS = ['private', 'group', 'console'];

/** 唯一规则：<channel>:<kind>:<id>。 */
export function peerIdFor({ channel, kind = 'private', id } = {}) {
  const c = String(channel || '').toLowerCase();
  const k = KINDS.includes(String(kind)) ? String(kind) : 'private';
  const raw = String(id || '').trim();
  if (!c || !raw) return null;
  if (/\s/.test(raw)) return null;
  return `${c}:${k}:${raw}`;
}

/** 兼容历史格式：wechat:<ownerId> / qq:<id> / 裸 id → 统一格式。 */
export function normalizeLegacyPeerId(rawId, { channel = 'wechat', kind = 'private' } = {}) {
  const s = String(rawId || '').trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length >= 3) return peerIdFor({ channel: parts[0], kind: parts[1], id: parts.slice(2).join(':') });
  if (parts.length === 2) return peerIdFor({ channel: parts[0], kind, id: parts[1] });
  return peerIdFor({ channel, kind, id: s });
}

/**
 * 两表对账：registry（准入名单）与 peers（社交档案）。
 * 返回缺失（只在 registry）/ 悬空（只在 peers）与建议动作；不写库。
 */
export function reconcile(registryRows = [], peerRows = []) {
  const reg = new Map();
  for (const r of registryRows) {
    const id = normalizeLegacyPeerId(r.id, { channel: r.channel || 'wechat', kind: r.kind === 'group' ? 'group' : 'private' });
    if (id) reg.set(id, r);
  }
  const peo = new Map();
  for (const p of peerRows) {
    const id = normalizeLegacyPeerId(p.id || p.peer_id, { channel: p.channel || 'wechat' });
    if (id) peo.set(id, p);
  }
  const missingProfiles = [...reg.keys()].filter(id => !peo.has(id));
  const orphanProfiles = [...peo.keys()].filter(id => !reg.has(id));
  return {
    registryCount: reg.size,
    peerCount: peo.size,
    missingProfiles,          // 有准入、没档案 → 应 upsert peers
    orphanProfiles,           // 有档案、没准入 → 默认不可回复（不是错误）
    needsSync: missingProfiles.length > 0,
    ok: reg.size === peo.size && missingProfiles.length === 0 && orphanProfiles.length === 0,
  };
}

/** 从入站消息推导 peer 身份（通道 + 群/私聊 + 发言人）。 */
export function identityOfInbound(msg = {}) {
  const channel = String(msg.channel || 'wechat').toLowerCase();
  const isGroup = msg.kind === 'group' || /group/i.test(String(msg.conversationId || ''));
  const id = isGroup ? msg.conversationId : (msg.senderId || msg.conversationId);
  return {
    peerId: peerIdFor({ channel, kind: isGroup ? 'group' : 'private', id }),
    speakerId: msg.senderId || null,
    isGroup,
    channel,
  };
}
