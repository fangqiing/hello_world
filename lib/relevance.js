/**
 * STEP 8 - 轻量相关度（新增自包含模块，零依赖）
 *
 * 用途：披露决策触发后，只把与当前查询相关的承诺塞进 LLM 上下文，
 * 避免「只要 peer 有承诺就每轮调一次模型」，也避免无关承诺干扰她的判断。
 *
 * 注意：过滤只影响「要不要调 LLM / 塞不塞上下文」，
 * 不改变「有跨 peer 候选就必须先写 disclosure_log」这条不变量。
 */

/** 字符 bigram 集合。中文按字切，不做分词，零依赖。 */
export function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 0..1，取交集对较短一侧的覆盖率；完全无关返回 0。 */
export function scoreRelevance(query, text) {
  const a = bigrams(query);
  const b = bigrams(text);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

/**
 * 按相关度取 topK 条。
 * items 可以是承诺对象、记忆对象等；textOf 决定拿哪个字段参与评分。
 * 默认 topK=3 / minScore=0.12：宁可放宽召回 + 留日志，也不要静默漏判。
 */
export function filterRelevant({
  query,
  items = [],
  textOf = (x) => x.text || x.content || x.what || x.summary || '',
  topK = 3,
  minScore = 0.12,
}) {
  return items
    .map(item => ({ item, score: scoreRelevance(query, textOf(item)) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => x.item);
}
