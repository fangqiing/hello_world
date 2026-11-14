/**
 * STEP 12 / 长上下文 - 预算重算与「单摘要器」守卫（纯函数）
 *
 * 用途：billion-context 之类的长上下文方案接入时，用它判断冲突并重算预算。
 * 核心主张：**窗口变大不等于记忆可以多塞**——单次注入的记忆条数要设硬上限，
 * 否则跨 peer 暴露面随窗口线性放大。
 */

export const WINDOW_PRESETS = {
  '8k': 8192,
  '32k': 32768,
  '128k': 131072,
  '1m': 1048576,
};

export const DEFAULTS = {
  memoryShare: 0.12,     // 记忆占窗口比例的上限
  minMemory: 3,
  maxMemory: 20,         // 硬上限：窗口再大也不超过这个条数
  minTokensPerItem: 40,
};

/**
 * 按窗口重算记忆预算。窗口变大时 token 预算增长，但**条数封顶**。
 * 返回 { windowTokens, memoryTokenBudget, memoryMaxItems, perItemTokens }
 */
export function budgetFor(windowTokens, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const w = Math.max(1024, Number(windowTokens) || 8192);
  const share = Math.min(0.3, Math.max(0.02, Number(cfg.memoryShare) || DEFAULTS.memoryShare));
  const budget = Math.floor(w * share);
  const perItem = Math.max(cfg.minTokensPerItem, Math.floor(cfg.minTokensPerItem * 1.5));
  const rawItems = Math.floor(budget / perItem);
  const items = Math.min(cfg.maxMemory, Math.max(cfg.minMemory, rawItems));
  return { windowTokens: w, memoryTokenBudget: budget, memoryMaxItems: items, perItemTokens: perItem };
}

/** 窗口变化前后的预算差异，供报告与回滚用。 */
export function diffBudget(beforeTokens, afterTokens, opts = {}) {
  const b = budgetFor(beforeTokens, opts);
  const a = budgetFor(afterTokens, opts);
  return {
    before: b,
    after: a,
    tokenDelta: a.memoryTokenBudget - b.memoryTokenBudget,
    itemDelta: a.memoryMaxItems - b.memoryMaxItems,
    // 窗口涨 16 倍，条数最多只涨到 maxMemory，不会同倍放大
    amplified: a.memoryMaxItems / Math.max(1, b.memoryMaxItems),
  };
}

/**
 * 单摘要器守卫：同一时刻只允许一个组件产出压缩摘要。
 * 传入 { compactionActive, requested }，两者都非空且不同 → 冲突。
 */
export function singleCompactorGuard({ compactionActive, requested } = {}) {
  const a = compactionActive ? String(compactionActive) : '';
  const r = requested ? String(requested) : '';
  if (a && r && a !== r) {
    return {
      allow: false,
      reason: 'two_compactors',
      active: a,
      requested: r,
      hint: '必须二选一：先停用现有压缩器，或把新方案降级为实验开关',
    };
  }
  return { allow: true, active: a || r || null };
}

/**
 * 冲突检测：按 features 里声明的能力判断 billion-context 落在哪一层。
 * features 形如 { summarizer:'bc', tokenCompressor:false, longWindow:true, vectorStore:false }
 * 返回 { layer, conflicts:[], requires:[] }
 */
export function detectLongContextConflicts(features = {}, ctx = {}) {
  const conflicts = [];
  const requires = [];
  let layer = 'unknown';

  if (features.longWindow || features.ropeScaling || features.sparseAttention || features.kvCacheCompression) {
    layer = 'L1';
    requires.push('peer 过滤必须下推到 SQL（审计 P0-2），否则窗口放大 = 泄露面放大');
  }
  if (features.summarizer) {
    layer = layer === 'unknown' ? 'L2' : layer;
    conflicts.push({
      code: 'double_summarizer',
      with: ctx.compactionActive || 'compaction-basic',
      action: '二选一：同一时刻只允许一个摘要器生效',
    });
  }
  if (features.tokenCompressor) {
    conflicts.push({
      code: 'id_tokens_may_be_dropped',
      with: 'must-keep(id 集合校验)',
      action: '结构化字段（cmt_/chap_/ask_ id）走白名单不参与压缩',
    });
  }
  if (features.vectorStore || features.externalMemory) {
    conflicts.push({
      code: 'dual_memory_store',
      with: 'memories + FTS',
      action: '不能双写；要么替换，要么明确分工',
    });
  }
  return {
    layer,
    conflicts,
    requires,
    safe: conflicts.length === 0,
    note: layer === 'unknown' ? '未识别出能力声明，无法判断层级，先不要接' : '',
  };
}

/** must-keep 白名单拼接：结构化字段原样保留，叙述段才进压缩。 */
export function splitForCompression({ structured = [], narrative = '' } = {}) {
  const keep = structured.filter(Boolean).map(String);
  return {
    keep,                                   // 不参与压缩
    compressible: String(narrative || ''),  // 参与压缩
    join: (compressed) => [...keep, String(compressed || '')].filter(Boolean).join('\n'),
  };
}
