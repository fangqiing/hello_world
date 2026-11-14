/**
 * STEP 9 / G - 常量注册表与覆盖校验（零副作用）
 *
 * 值是历史摘要（06-NEXT / step-7/8 报告），**必须以运行态真实代码复核**；
 * 本模块只提供登记、校验、diff 的纯函数，不改任何运行参数。
 */

export const DEFAULT_REGISTRY = {
  'store.score.relevance': { module: 'lib/store.js', value: 0.52, range: [0, 1] },
  'store.score.recency': { module: 'lib/store.js', value: 0.18, range: [0, 1] },
  'store.score.importance': { module: 'lib/store.js', value: 0.18, range: [0, 1] },
  'store.score.heat': { module: 'lib/store.js', value: 0.07, range: [0, 1] },
  'store.score.trust': { module: 'lib/store.js', value: 0.05, range: [0, 1] },
  'store.rrf.k': { module: 'lib/store.js', value: 60, range: [1, 1000] },
  'store.decay.days': { module: 'lib/store.js', value: 45, range: [1, 3650] },
  'store.fts.top': { module: 'lib/store.js', value: 80, range: [1, 10000] },
  'store.like.fallback': { module: 'lib/store.js', value: 40, range: [1, 10000] },
  'store.mmr.relevance': { module: 'lib/store.js', value: 0.75, range: [0, 1] },
  'store.mmr.diversity': { module: 'lib/store.js', value: 0.25, range: [0, 1] },
  'store.consolidate.threshold': { module: 'lib/store.js', value: 0.85, range: [0, 1] },
  'llm.timeout.sec': { module: 'lib/llm.js', value: 90, range: [1, 3600] },
  'llm.extract.tokens': { module: 'lib/llm.js', value: 1200, range: [1, 100000] },
  'llm.reflect.tokens': { module: 'lib/llm.js', value: 700, range: [1, 100000] },
  'llm.self.tokens': { module: 'lib/llm.js', value: 2200, range: [1, 100000] },
  'agent.digest.delay.sec': { module: 'lib/agent-layer.js', value: 30, range: [0, 3600] },
  'agent.reflect.minUser': { module: 'lib/agent-layer.js', value: 2, range: [1, 100] },
  'agent.episode.max': { module: 'lib/agent-layer.js', value: 40, range: [1, 10000], note: 'unused in current digest (200 episodes read); kept for compatibility' },
  'agent.write.max': { module: 'lib/agent-layer.js', value: 14, range: [1, 10000], note: 'unused in current ingest; kept for compatibility' },
  'agent.dedup.trigram': { module: 'lib/agent-layer.js', value: 0.72, range: [0, 1] },
  'agent.dedup.jaccard': { module: 'lib/agent-layer.js', value: 0.6, range: [0, 1] },
  'agent.workingMemory.tokens': { module: 'lib/agent-layer.js', value: 320, range: [1, 100000] },
  'cognition.mood.old': { module: 'lib/cognition.js', value: 0.65, range: [0, 1] },
  'cognition.mood.fresh': { module: 'lib/cognition.js', value: 0.45, range: [0, 1] },
  'prompt.identity.order': { module: 'prompt', value: -1000, range: [-100000, 100000] },
  'prompt.memory.order': { module: 'prompt', value: 9000, range: [-100000, 100000] },
  'prompt.memory.budget': { module: 'prompt', value: 320, range: [1, 100000] },
  'principle.lambda': { module: 'lib/principle-engine.js', value: 0.92, range: [0, 1] },
  'principle.alpha': { module: 'lib/principle-engine.js', value: 0.12, range: [0, 1] },
  'principle.beta': { module: 'lib/principle-engine.js', value: 0.15, range: [0, 1] },
  'principle.gamma': { module: 'lib/principle-engine.js', value: 0.002, range: [0, 1] },
  'principle.thetaActive': { module: 'lib/principle-engine.js', value: 0.62, range: [0, 1] },
  'principle.thetaRetire': { module: 'lib/principle-engine.js', value: 0.18, range: [0, 1] },
  'principle.minEvidence': { module: 'lib/principle-engine.js', value: 3, range: [1, 1000] },
  'relevance.topK': { module: 'lib/relevance.js', value: 3, range: [1, 100] },
  'relevance.minScore': { module: 'lib/relevance.js', value: 0.12, range: [0, 1] },
  'hygiene.dupThreshold': { module: 'lib/memory-hygiene.js', value: 0.82, range: [0, 1] },
  'proactive.moodThreshold': { module: 'lib/proactive-gate.js', value: 0.45, range: [0, 1] },
  'proactive.dailyLimit': { module: 'lib/proactive-gate.js', value: 6, range: [0, 1000], note: 'gate fallback 3; Growth passes config.proactiveDailyLimit (default 6)' },
  'proactive.minIntervalMs': { module: 'lib/proactive-gate.js', value: 7200000, range: [0, 86400000] },
  'proactive.idleDays': { module: 'lib/proactive-gate.js', value: 3, range: [1, 365] },
  'bridge.pollMs': { module: 'wx-bridge.mjs', value: 2500, range: [100, 3600000] },
  'bridge.port': { module: 'wx-bridge.mjs', value: 6175, range: [1, 65535] },
};

/** 覆盖校验：未知 key、类型不符、越界一律拒绝。 */
export function validateOverride(key, value, registry = DEFAULT_REGISTRY) {
  const entry = registry[key];
  if (!entry) return { ok: false, reason: 'unknown_key' };
  if (typeof value !== typeof entry.value) return { ok: false, reason: 'type_mismatch' };
  if (!Number.isFinite(value)) return { ok: false, reason: 'not_finite' };
  const [lo, hi] = entry.range || [-Infinity, Infinity];
  if (value < lo || value > hi) return { ok: false, reason: 'out_of_range', range: [lo, hi] };
  return { ok: true, key, before: entry.value, after: value };
}

/** 只报真正变化的项；顺序不同不算变化。 */
export function diffRegistry(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const b = before[key];
    const a = after[key];
    if (!b) changes.push({ key, kind: 'added', after: a });
    else if (!a) changes.push({ key, kind: 'removed', before: b });
    else if (b.value !== a.value) changes.push({ key, kind: 'changed', before: b.value, after: a.value });
  }
  return changes;
}

export function serializeRegistry(registry = DEFAULT_REGISTRY) {
  return Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({ key, ...e }));
}

export class ConstantRegistry {
  constructor({ registry = DEFAULT_REGISTRY, onChange = null } = {}) {
    this.registry = { ...registry };
    this.history = [];
    this.onChange = onChange;
  }

  set(key, value, { actor = 'user', at = Date.now(), reason = '' } = {}) {
    const check = validateOverride(key, value, this.registry);
    if (!check.ok) return check;
    const before = this.registry[key].value;
    this.registry[key] = { ...this.registry[key], value };
    const record = { at, key, before, after: value, actor, reason };
    this.history.push(record);
    if (this.onChange) this.onChange(record);
    return { ok: true, record };
  }

  list() { return serializeRegistry(this.registry); }
  changes() { return this.history.slice(); }
}
