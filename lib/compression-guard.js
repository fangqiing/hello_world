/**
 * STEP 9 / A - 压缩摘要 must-keep 校验（零副作用）
 *
 * 不变量：压缩后，决策 / 承诺 / 未决事项三类 id 集合不得缩小。
 * 与 step-6 的 commitments 事实记录、step-7 的 principle_events / pending_asks 对齐。
 * 只按 id 集合比较，不做文本模糊匹配（表述变化不算丢失）。
 */

export const KEEP_KINDS = ['decisions', 'commitments', 'openItems'];

function idsOf(input, kind) {
  const raw = (input && input[kind]) || [];
  return new Set(raw.map(x => (typeof x === 'string' ? x : (x.id || x.commitment_id || x.chapter_id || x.ask_id))).filter(Boolean));
}

/** 从压缩输入抽出必须保留的三类 id 集合。 */
export function mustKeep(input = {}) {
  const out = {};
  for (const kind of KEEP_KINDS) out[kind] = [...idsOf(input, kind)];
  return out;
}

/**
 * before / after 形如 { decisions:[], commitments:[], openItems:[] }
 * 返回缺失项与 ok；ok=false 时调用方应拒绝采用该摘要并退回原摘要。
 */
export function verifySummary(before = {}, after = {}) {
  const missing = {};
  for (const kind of KEEP_KINDS) {
    const b = idsOf(before, kind);
    const a = idsOf(after, kind);
    missing[kind] = [...b].filter(id => !a.has(id));
  }
  const totalMissing = KEEP_KINDS.reduce((n, k) => n + missing[k].length, 0);
  return {
    ok: totalMissing === 0,
    missingDecisions: missing.decisions,
    missingCommitments: missing.commitments,
    missingOpenItems: missing.openItems,
  };
}

/** 压缩前后的承诺集合相等（承诺是正文唯一来源，丢一条就是高危回归）。 */
export function verifyCommitments(recordedIds = [], summaryIds = []) {
  const a = new Set(recordedIds);
  const b = new Set(summaryIds);
  return {
    ok: a.size === b.size && [...a].every(id => b.has(id)),
    missing: [...a].filter(id => !b.has(id)),
    extra: [...b].filter(id => !a.has(id)),
  };
}

/** 事件留痕结构（只返回对象，不写库）。 */
export function guardEvent({ at, actor = 'engine', reason, result }) {
  return {
    at, kind: 'compaction_must_keep', actor, reason,
    ok: result.ok,
    missingCommitments: result.missingCommitments || [],
    missingDecisions: result.missingDecisions || [],
    missingOpenItems: result.missingOpenItems || [],
  };
}
