/**
 * STEP 10 - 情绪休眠痕迹（借鉴自「情绪系统-决策增补-v3」§3）
 *
 * 问题：某层长期负向（连续 72h 低于 -0.3）会让她一直低沉，纯衰减拉不回来，
 *       因为没有正向事件。
 * 定案：重置 ≠ 删除 —— 把当前状态写入休眠痕迹后回基线，
 *       之后被关键词 / 旧事 / 相似情境 / 同一时段勾起时按 0.6^天数 部分复活。
 *
 * 零副作用：所有持久化由注入 store 完成；模块内不碰 DB / fs / 时钟以外资源。
 */

export const DEFAULTS = {
  negativeThreshold: 0.3,
  consecutiveMs: 72 * 3600 * 1000,
  maxRevives: 3,
  decayBase: 0.6,
  reviveFactor: 0.6,
  baseline: 0,
};

/** 是否达到「长期负漂移」重置条件：连续超时长、|v| 超阈值、方向不变。 */
export function shouldReset(layer = {}, now = Date.now(), cfg = DEFAULTS) {
  const v = Number(layer.value || 0);
  if (v >= -cfg.negativeThreshold) return false;
  if (!Number.isFinite(layer.negativeSince)) return false;
  if (now - layer.negativeSince < cfg.consecutiveMs) return false;
  return layer.direction === 'negative' || layer.direction == null;
}

/** 生成休眠痕迹；不修改传入对象。 */
export function makeTrace(layerKey, layer, { at, cause = '', reviveKeys = [] } = {}, cfg = DEFAULTS) {
  return {
    id: `tr_${at}_${Math.random().toString(36).slice(2, 7)}`,
    layer: layerKey,
    v: Number(layer.value || 0),
    a: Number(layer.arousal || 0),
    cause,
    createdAt: at,
    reviveKeys: reviveKeys.slice(),
    reviveCount: 0,
    strength: Math.abs(Number(layer.value || 0)),
    status: 'dormant',
    lastReviveAt: null,
  };
}

/** 复活强度：strength × decayBase^(距今天数) × reviveFactor，越久越弱。 */
export function reviveDelta(trace, now = Date.now(), cfg = DEFAULTS) {
  if (!trace || trace.status !== 'dormant') return 0;
  if (trace.reviveCount >= cfg.maxRevives) return 0;
  const days = Math.max(0, (now - trace.createdAt) / 86400000);
  return trace.strength * Math.pow(cfg.decayBase, days) * cfg.reviveFactor;
}

/** 复活触发判定：关键词 / 关联旧记忆 / 相似情境 / 同一时段。 */
export function revivalTriggers(trace, ctx = {}) {
  const hits = [];
  const keys = trace.reviveKeys || [];
  const text = String(ctx.text || '');
  if (keys.some(k => k && text.includes(k))) hits.push('keyword');
  if (Array.isArray(ctx.retrievedIds) && ctx.retrievedIds.some(id => keys.includes(String(id)))) {
    hits.push('old_memory');
  }
  if (ctx.similarEvent === true) hits.push('similar_situation');
  if (ctx.timeCoincidence === true) hits.push('time_coincidence');
  return hits;
}

export class DormantTraces {
  constructor({ store = null, clock = () => Date.now(), config = {} } = {}) {
    Object.assign(this, { store, clock });
    this.cfg = { ...DEFAULTS, ...config };
    this.layers = new Map();
    this.traces = (store && typeof store.loadTraces === 'function' ? store.loadTraces() : []) || [];
  }

  _save() {
    if (this.store && typeof this.store.saveTraces === 'function') this.store.saveTraces(this.traces.slice());
  }

  /** 观察某层状态，维护连续负向起点与方向。 */
  observe(layerKey, value, { at = this.clock(), arousal = 0, cause = '', reviveKeys = [] } = {}) {
    const v = Number(value) || 0;
    const prev = this.layers.get(layerKey) || {};
    const negative = v < -this.cfg.negativeThreshold;
    const now = {
      value: v,
      arousal,
      direction: v < 0 ? 'negative' : v > 0 ? 'positive' : (prev.direction || 'neutral'),
      negativeSince: negative
        ? (prev.negativeSince != null && prev.direction === 'negative' ? prev.negativeSince : at)
        : null,
      cause,
      reviveKeys,
      updatedAt: at,
    };
    this.layers.set(layerKey, now);
    return now;
  }

  /** 达到条件则重置该层：写痕迹 → 回基线 → 记录 reset。返回 trace 或 null。 */
  maybeReset(layerKey, { at = this.clock() } = {}) {
    const layer = this.layers.get(layerKey);
    if (!layer || !shouldReset(layer, at, this.cfg)) return null;
    const trace = makeTrace(layerKey, layer,
      { at, cause: layer.cause, reviveKeys: layer.reviveKeys }, this.cfg);
    this.traces.push(trace);
    this._save();
    this.layers.set(layerKey, {
      value: this.cfg.baseline, arousal: 0, direction: 'neutral',
      negativeSince: null, cause: '', reviveKeys: [], updatedAt: at,
      lastResetAt: at,
    });
    return trace;
  }

  /**
   * 按上下文尝试复活。返回 [{ traceId, delta, triggers, expression }]
   * expression：第 1 次可提旧事，2–3 次只影响语气，超过 3 次归档。
   */
  revive(ctx = {}, { at = this.clock() } = {}) {
    const out = [];
    for (const trace of this.traces) {
      if (trace.status !== 'dormant') continue;
      const triggers = revivalTriggers(trace, ctx);
      if (!triggers.length) continue;
      const delta = reviveDelta(trace, at, this.cfg);
      if (delta <= 0) {
        if (trace.reviveCount >= this.cfg.maxRevives) trace.status = 'archived';
        continue;
      }
      trace.reviveCount += 1;
      trace.lastReviveAt = at;
      if (trace.reviveCount >= this.cfg.maxRevives) trace.status = 'archived';
      out.push({
        traceId: trace.id,
        layer: trace.layer,
        delta,
        triggers,
        expression: trace.reviveCount === 1 ? 'mention' : 'tone_only',
      });
    }
    if (out.length) this._save();
    return out;
  }

  list({ includeArchived = false } = {}) {
    return this.traces.filter(t => includeArchived || t.status !== 'archived').map(t => ({ ...t }));
  }

  get(layerKey) {
    const l = this.layers.get(layerKey);
    return l ? { ...l } : null;
  }
}
