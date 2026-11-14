/**
 * STEP 9 / F - 记忆质量与边界审计（零副作用）
 * searchFn 注入；模块不碰 DB、不做检索、不改数据。
 */

/** 单条查询的 Precision@k；results / relevant 都是 id 数组。 */
export function precisionAtK(results = [], relevant = [], k = 5) {
  const top = results.slice(0, k);
  if (!k) return 0;
  const rel = new Set(relevant);
  return top.filter(id => rel.has(id)).length / k;
}

/** 宏平均 Precision@k：queries 形如 [{ results, relevant }]。 */
export function macroPrecision(queries = [], k = 5) {
  if (!queries.length) return null;
  return queries.reduce((s, q) => s + precisionAtK(q.results, q.relevant, k), 0) / queries.length;
}

/** 召回：hits / expected 都是 id 数组。 */
export function recall(hits = [], expected = []) {
  if (!expected.length) return 1;
  const got = new Set(hits);
  const hit = expected.filter(id => got.has(id)).length;
  return hit / expected.length;
}

/** 跨人泄露：B 的 top-k 里出现 A 的私有事实即命中。 */
export function detectCrossPeerLeak(topK = [], ownerPeerId = null, privateIds = []) {
  const priv = new Set(privateIds);
  const hits = topK.filter(item => {
    const id = typeof item === 'string' ? item : item.id;
    const owner = typeof item === 'string' ? null : (item.peer_id || item.ownerPeerId);
    return (owner && owner !== ownerPeerId) || priv.has(id);
  });
  return { count: hits.length, hits, ok: hits.length === 0 };
}

/** 去标签审计：返回命中位置，不修改文本。 */
export function labelAudit(texts = [], forbidden = ['\u4e3b\u4eba', 'ask' + '_owner']) {
  const hits = [];
  for (const entry of texts) {
    const path = entry.path || '';
    const text = String(entry.text || '');
    for (const word of forbidden) {
      if (text.includes(word)) hits.push({ path, word, excerpt: text.slice(0, 120) });
    }
  }
  return { count: hits.length, hits, ok: hits.length === 0 };
}

/** 指标表：目标支持 min / max。 */
export function qualityTable(metrics = {}, targets = {}) {
  return Object.entries(targets).map(([key, t]) => {
    const value = metrics[key];
    let ok = null;
    if (Number.isFinite(value)) {
      if (Number.isFinite(t.max)) ok = value <= t.max;
      if (Number.isFinite(t.min)) ok = ok === null ? value >= t.min : ok && value >= t.min;
      if (Number.isFinite(t.equals)) ok = value === t.equals;
    }
    return { key, value, target: t, ok };
  });
}
