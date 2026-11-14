/**
 * STEP 10 / ① - 入站准入判定（零副作用）
 *
 * 插在 ChannelManager.handle 最前面。所有判定 fail-closed：
 * 表异常、id 非法、未登记，一律不放行。
 *
 * registry: PeerRegistry 实例
 * isGroupAddressed: (text, ctx) => boolean（复用 STEP 9 D 的实现）
 * logger: { log(row) }
 */

export const REASON = {
  OK: 'ok',
  INVALID: 'invalid_input',
  PEER_NOT_REGISTERED: 'peer_not_registered',
  SPEAKER_NOT_ALLOWED: 'speaker_not_allowed',
  GROUP_ARCHIVED: 'group_archived',
  REGISTRY_ERROR: 'registry_error',
};

export function admit({ conversationId, senderId, kind = 'direct', text = '',
                        mentioned = false, companionName = '', meta = {} } = {},
                      { registry, isGroupAddressed = null, logger = null, clock = () => Date.now() } = {}) {
  const base = {
    at: clock(),
    conversationId: String(conversationId || ''),
    senderId: String(senderId || ''),
    kind,
  };
  const finish = (allow, reason, extra = {}) => {
    const result = { allow, reason, ...base, ...extra };
    if (logger && typeof logger.log === 'function') logger.log(result);
    return result;
  };

  if (!base.conversationId || !base.senderId) return finish(false, REASON.INVALID);
  if (!registry || typeof registry.isAllowed !== 'function') return finish(false, REASON.REGISTRY_ERROR);

  let peerId;
  let speakerId;
  try {
    const resolved = registry.resolve(base.conversationId, base.senderId, kind);
    peerId = resolved.peerId;
    speakerId = resolved.speakerId;
  } catch (err) {
    return finish(false, REASON.REGISTRY_ERROR);
  }
  if (!peerId) return finish(false, REASON.INVALID, { peerId, speakerId });

  if (kind === 'group') {
    if (!registry.isAllowed(peerId, 'group')) {
      return finish(false, REASON.PEER_NOT_REGISTERED, { peerId, speakerId });
    }
    // 群内逐发言人校验（STEP 9 D）
    if (speakerId && !registry.isAllowed(speakerId, 'direct')) {
      return finish(false, REASON.SPEAKER_NOT_ALLOWED, { peerId, speakerId });
    }
    const addressed = typeof isGroupAddressed === 'function'
      ? !!isGroupAddressed(text, { mentioned, companionName, meta })
      : !!mentioned;
    if (!addressed) {
      // 未被叫到：只归档，不建 agent、不写 user 层、不回复
      return finish(false, REASON.GROUP_ARCHIVED, { peerId, speakerId, needArchive: true });
    }
    return finish(true, REASON.OK, { peerId, speakerId, needArchive: false });
  }

  if (!registry.isAllowed(peerId, 'direct')) {
    return finish(false, REASON.PEER_NOT_REGISTERED, { peerId, speakerId });
  }
  return finish(true, REASON.OK, { peerId, speakerId, needArchive: false });
}

/** 与 STEP 9 D 一致的「被叫到」判定（供 DSH 直接复用或对照）。 */
export function isGroupAddressed(text, { mentioned = false, companionName = '' } = {}) {
  if (mentioned) return true;
  const s = String(text || '');
  if (/\[CQ:at[,\]]/i.test(s)) return true;
  if (/<@[^>]+>/.test(s)) return true;
  if (companionName && s.includes(companionName)) return true;
  return false;
}
