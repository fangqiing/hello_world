/**
 * STEP 12 / 补丁 1 - 候选权重封顶与转正判定（纯函数）
 *
 * 问题：infer 返回 weight 0.8，被原样当候选初始权重，而 θ_active=0.62，
 *      候选入库即在阈值之上 → 单本书必然转正，绕过证据累积。
 * 修法：入口封顶 + 转正只看 tick 后的证据与权重（比较 decay 前权重）。
 */

export const CANDIDATE_CAP = 0.35;
export const THETA_ACTIVE = 0.62;
export const THETA_RETIRE = 0.18;
export const MIN_EVIDENCE = 3;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number(v) || 0));

/** 候选入库权重：无论 infer 给多少，都不超过 CANDIDATE_CAP。 */
export function capCandidateWeight(rawWeight, cap = CANDIDATE_CAP) {
  const w = Number(rawWeight);
  if (!Number.isFinite(w)) return { weight: 0.3, capped: false };
  const capped = w > cap;
  return { weight: clamp(capped ? cap : w), capped };
}

/**
 * 转正判定：必须同时满足 权重阈值 与 最少证据数。
 * 传 decay 前权重（避免 post-decay 比较导致「永远差一点」）。
 */
export function promoteDecision({ weightBeforeDecay, evidenceCount, cap = CANDIDATE_CAP } = {}) {
  const w = clamp(weightBeforeDecay);
  const n = Math.max(0, Number(evidenceCount) || 0);
  if (w < THETA_RETIRE) return { status: 'retired', reason: 'below_retire' };
  if (n < MIN_EVIDENCE) return { status: 'candidate', reason: 'evidence_insufficient', need: MIN_EVIDENCE - n };
  if (w < THETA_ACTIVE) return { status: 'candidate', reason: 'weight_below_threshold', need: +(THETA_ACTIVE - w).toFixed(3) };
  // 入口封顶不应直接把候选顶过阈值；若真过了，说明证据也在支撑
  return { status: 'active', reason: 'threshold_and_evidence_met' };
}

/** 按真实天数衰减：λ^dtDays，而不是每个 tick 都乘一次。 */
export function decayWeight(weight, lambda = 0.92, dtDays = 0) {
  const l = clamp(lambda, 0, 1);
  const d = Math.max(0, Number(dtDays) || 0);
  return clamp(clamp(weight) * Math.pow(l, d));
}

/** 供报告用：从入库到转正的代价。 */
export function promotionCost({ ingestWeight, evidenceCount, interactions }) {
  return {
    ingestWeight: Number(ingestWeight) || 0,
    evidenceCount: Number(evidenceCount) || 0,
    interactions: Number(interactions) || 0,
    singleBookActive: Number(evidenceCount) <= 1 && Number(ingestWeight) >= THETA_ACTIVE,
  };
}
