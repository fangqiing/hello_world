/**
 * STEP 7 - 原则演化引擎（新增自包含模块）
 *
 * 不依赖现有 lib/*.js；存储与时钟由外部注入，接口见 04-INTEGRATION.md。
 * 模块格式：ESM。若运行态是 CJS，把 export 改成 module.exports = { ... }，逻辑不变。
 *
 * 设计要点：
 *  - 候选不因一本书直接转 active：需权重阈值与最少证据数同时满足。
 *  - contested 由她自己表态消解，不需要用户确认（23:06 用户拍板）。
 *  - 每次权重变化都写事件，旧原则永不被硬覆盖。
 */

export const DEFAULTS = {
  lambda: 0.92,        // 惯性（按真实天数 λ^dt）
  candidateCap: 0.35,  // 候选入库封顶
  alpha: 0.12,         // 支持性证据增益
  beta: 0.15,          // 冲突性证据惩罚
  gamma: 0.002,        // 每日衰减
  thetaActive: 0.62,   // 转正阈值
  thetaRetire: 0.18,   // 退役阈值
  minEvidence: 3,      // 最少证据数
};

export const STATUS = {
  CANDIDATE: 'candidate',
  ACTIVE: 'active',
  CONTESTED: 'contested',
  REVISED: 'revised',
  RETIRED: 'retired',
};

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export class PrincipleEngine {
  constructor({ store, clock = () => Date.now(), config = {} }) {
    this.store = store; // get / list / insert / update / appendEvent
    this.clock = clock;
    this.cfg = { ...DEFAULTS, ...config };
  }

  /** 书籍 / 经历 / 自述 -> 候选。只给初值，不直接转 active。 */
  ingestCandidate({ statement, source, evidenceId = null, initialWeight = 0.3, actor = 'self', meta = {} }) {
    const now = this.clock();
    const initial = clamp(initialWeight, 0, Number(this.cfg.candidateCap) || 0.35);
    const p = this.store.insert({
      statement,
      source,
      status: STATUS.CANDIDATE,
      weight: initial,
      evidence_count: evidenceId ? 1 : 0,
      meta: { initialWeight: initial, ...(meta && typeof meta === 'object' ? meta : {}) },
      learned_at: now,
      updated_at: now,
    });
    if (evidenceId) {
      this.store.appendEvent({
        principle_id: p.id, event: 'candidate', at: now, evidence_id: evidenceId,
        weight_before: 0, weight_after: p.weight, actor,
      });
    }
    return p;
  }

  /** 支持 / 冲突证据 -> 权重演化。成长来自她自己的行为。 */
  addEvidence({ principleId, kind, evidenceId, actor = 'self' }) {
    const p = this.store.get(principleId);
    if (!p || p.status === STATUS.RETIRED) return null;
    const before = p.weight;
    const delta = kind === 'support' ? this.cfg.alpha : kind === 'conflict' ? -this.cfg.beta : 0;
    const weight = clamp(before + delta);
    const evidence_count = (p.evidence_count || 0) + (delta !== 0 ? 1 : 0);
    const next = this.store.update(principleId, { weight, evidence_count, updated_at: this.clock() });
    this.store.appendEvent({
      principle_id: principleId, event: kind, at: this.clock(), evidence_id: evidenceId,
      weight_before: before, weight_after: weight, actor,
    });
    return next;
  }

  /**
   * contested -> 由她自己表态消解。
   * stance: { [principleId]: 'support' | 'conflict' }
   * 只登记她的判断，不要求用户确认；用户覆盖走同一条 addEvidence 路径。
   */
  resolveContested({ principleIds, stance, reason, actor = 'self' }) {
    const now = this.clock();
    const evidenceId = `stance:${now}`;
    const out = [];
    for (const id of principleIds) {
      const favoured = stance[id] === 'support';
      const p = this.addEvidence({
        principleId: id, kind: favoured ? 'support' : 'conflict',
        evidenceId, actor,
      });
      const status = favoured ? STATUS.ACTIVE : STATUS.REVISED;
      this.store.update(id, { status, updated_at: now });
      this.store.appendEvent({
        principle_id: id, event: 'contested_resolved', at: now, evidence_id: evidenceId,
        weight_before: p ? p.weight : 0, weight_after: p ? p.weight : 0, actor, reason,
      });
      out.push({ id, status });
    }
    return out;
  }

  /** 时间衰减 + 转正 / 退役判定。转正需阈值与最少证据数同时满足。 */
  tick() {
    const now = this.clock();
    const { lambda, gamma, thetaActive, thetaRetire, minEvidence } = this.cfg;
    const changes = [];
    for (const p of this.store.list()) {
      if (p.status === STATUS.RETIRED || p.status === STATUS.REVISED) continue;
      const last = Number(p.meta?.lastDecayAt || p.updated_at || now);
      const dtDays = Math.max(0, (now - last) / 86400000);
      const weightBeforeDecay = Number(p.weight) || 0;
      const decayed = clamp(weightBeforeDecay * Math.pow(clamp(lambda), dtDays) - gamma * dtDays);
      let status = p.status;
      if (status === STATUS.CANDIDATE && weightBeforeDecay >= thetaActive && (p.evidence_count || 0) >= minEvidence) {
        status = STATUS.ACTIVE;
      }
      if (status === STATUS.ACTIVE && decayed < thetaRetire) status = STATUS.RETIRED;
      if (status !== p.status || decayed !== p.weight || !p.meta?.lastDecayAt) {
        this.store.update(p.id, { weight: decayed, status, updated_at: now, meta: { ...(p.meta || {}), lastDecayAt: now } });
        this.store.appendEvent({
          principle_id: p.id, event: status !== p.status ? `to_${status}` : 'decay',
          at: now, weight_before: p.weight, weight_after: decayed, actor: 'engine',
        });
        changes.push({ id: p.id, from: p.status, to: status, weight: decayed });
      }
    }
    return changes;
  }

  listActive() {
    return this.store.list()
      .filter(p => p.status === STATUS.ACTIVE)
      .sort((a, b) => b.weight - a.weight);
  }
}
