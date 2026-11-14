/**
 * STEP 11 / P0-4 - 披露门策略（纯函数，零副作用）
 *
 * 修三处：
 *  1. 私聊 own memory 带 speaker_id 不再触发决策。
 *  2. 四种决策各有自己的 allowlist，不再「非 withhold 就全放行」。
 *  3. 失败一律 fail-closed，且不沿用旧状态（由装配层保证 await 成功才落 key）。
 */

export const DECISIONS = ['withhold', 'mention', 'rephrase', 'ask_source'];

/**
 * 触发判定 V2。只在三条之一成立时触发：
 *  - 候选 peer_id 存在且 ≠ 当前 peer；
 *  - 候选带 commitment_id；
 *  - **群聊**且 speaker_id 存在且 ≠ 当前 peer。
 */
export function needsDecisionV2(candidates = [], ctx = {}) {
  const peerId = ctx.peerId ?? null;
  const isGroup = ctx.isGroup === true || String(ctx.kind || '') === 'group';
  return candidates.some(c => {
    const crossPeer = c.peer_id && c.peer_id !== peerId;
    const hasCommitment = !!c.commitment_id;
    const otherSpeaker = isGroup && c.speaker_id && c.speaker_id !== peerId;
    return !!crossPeer || hasCommitment || !!otherSpeaker;
  });
}

/** 承诺用独立集合，不与 memory id 混用（修 P1-5）。 */
export function commitmentIdsOf(candidates = []) {
  const ids = new Set();
  for (const c of candidates) if (c.commitment_id) ids.add(String(c.commitment_id));
  return ids;
}

function isOwn(c, peerId) {
  return !c.peer_id || c.peer_id === peerId;
}

/**
 * per-decision allowlist：返回 { allowed, blocked, action? }
 * - withhold：保留 own；去跨 peer / 承诺 / 群内他人
 * - mention：own 全放；跨 peer 只允许抽象转述（标 redact）
 * - rephrase：own 放；跨 peer 标 redactNeeded，由生成层改写后再用
 * - ask_source：**不放行任何原文**，只返回待问项
 */
export function allowForDecision(decision, candidates = [], ctx = {}) {
  const peerId = ctx.peerId ?? null;
  const own = candidates.filter(c => isOwn(c, peerId));
  const cross = candidates.filter(c => !isOwn(c, peerId));

  if (decision === 'withhold') {
    return { allowed: own.filter(c => !c.commitment_id && !c.speaker_id || c.speaker_id === peerId), blocked: cross };
  }
  if (decision === 'mention') {
    const abstracted = cross.map(c => ({ ...c, redact: 'abstract_only' }));
    return { allowed: [...own, ...abstracted], blocked: [] };
  }
  if (decision === 'rephrase') {
    const needRewrite = cross.map(c => ({ ...c, redactNeeded: true }));
    return { allowed: [...own, ...needRewrite], blocked: [], action: 'rewrite_before_use' };
  }
  if (decision === 'ask_source') {
    // 只产出「去问当事人」，原文一律不进当前上下文
    return {
      allowed: [],
      blocked: cross,
      action: 'create_pending_ask',
      pendingAsks: cross
        .filter(c => c.peer_id && c.peer_id !== peerId)
        .map(c => ({ sourcePeer: c.peer_id, commitmentId: c.commitment_id || null })),
    };
  }
  // 未知决策 → 最保守
  return { allowed: [], blocked: candidates, action: 'unknown_decision' };
}

/**
 * 失败封装：任何异常都落成 withhold，并给出可写 health 的原因。
 * 装配层必须 **await 本函数成功后** 才写 state.disclosureKey。
 */
export function decideOutcome({ raw, error } = {}) {
  if (error) {
    return {
      decision: 'withhold',
      reason: 'decision_unavailable',
      principle_ids: [],
      confidence: 0,
      failed: true,
      error: String(error.message || error),
    };
  }
  const d = DECISIONS.includes(raw?.decision) ? raw.decision : 'withhold';
  return {
    decision: d,
    reason: raw?.reason || (d === 'withhold' ? 'unspecified' : ''),
    principle_ids: raw?.principle_ids || [],
    confidence: Number(raw?.confidence) || 0,
    failed: false,
  };
}

/** 新消息到达时必须清掉上一轮决策，避免沿用旧状态。 */
export function resetDecisionState(state) {
  if (!state) return state;
  state.disclosure = null;
  state.disclosureKey = null;
  return state;
}
