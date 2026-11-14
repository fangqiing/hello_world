/**
 * STEP 8 / 下一批 - 记忆正确性辅助（新增自包含模块，纯函数、零依赖 DB/LLM）
 *
 * 对应 06-NEXT.md P2 的四项里可静态验收的部分。
 * 字段名是契约建议，按运行态真实结构适配；所有函数只给「候选」，不写库、不删除。
 */

import { scoreRelevance } from './relevance.js';

const normalize = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '');

/**
 * 跨层去重：比较规范化文本与字符 bigram 覆盖率。
 * 命中只返回候选，不自动删除 —— 记忆条目是事实记录，静默删会破坏来源与 hash。
 */
export function isCrossLayerDuplicate(a, b, threshold = 0.82) {
  if (!a || !b) return false;
  if (a.layer && b.layer && a.layer === b.layer) return false; // 同层走原路径
  const x = normalize(a.text || a.fact || a.content || '');
  const y = normalize(b.text || b.fact || b.content || '');
  if (!x || !y) return false;
  if (x === y) return true;
  return scoreRelevance(x, y) >= threshold;
}

/**
 * 新事实是否应让旧条目写 validUntil。
 * 同一 subject + 值不同 + 新事实置信度更高 -> 候选。
 * 最终是否失效由抽取 / LLM 判断，并写事件留痕；不要绕开现有 superseded 状态机。
 */
export function shouldSupersede(oldFact, newFact) {
  if (!oldFact || !newFact) return { should: false, reason: 'missing' };
  const subject = oldFact.subject || oldFact.key || null;
  const newSubject = newFact.subject || newFact.key || null;
  if (!subject || subject !== newSubject) return { should: false, reason: 'subject_mismatch' };
  const a = normalize(oldFact.value || oldFact.text || '');
  const b = normalize(newFact.value || newFact.text || '');
  if (a === b) return { should: false, reason: 'same_value' };
  const ca = Number(oldFact.confidence || 0);
  const cb = Number(newFact.confidence || 0);
  if (cb <= ca) return { should: false, reason: 'confidence_not_higher' };
  return { should: true, reason: 'new_fact_supersedes', subject, oldValue: a, newValue: b };
}

/**
 * 复习队列：按 nextReviewAt 升序、过期优先；缺失字段排最后。
 * 不再按 updatedAt 排序取 top N。
 */
export function pickDueForReview(items = [], now = Date.now(), limit = 50) {
  const withTime = items.filter(x => x && Number.isFinite(Number(x.nextReviewAt)));
  const withoutTime = items.filter(x => x && !Number.isFinite(Number(x.nextReviewAt)));
  withTime.sort((a, b) => Number(a.nextReviewAt) - Number(b.nextReviewAt));
  return [...withTime, ...withoutTime].slice(0, limit);
}

/**
 * digest 游标：只取游标之后的新 episode。
 * 首次无游标时标记 firstFull=true，由调用方决定是否分批，避免历史一次性回刷。
 * digest 成功后才推进游标；失败不要推进（本函数不写库）。
 */
export function nextDigestCursor(lastCursor, episodes = []) {
  if (!lastCursor) {
    return { firstFull: true, episodes, nextCursor: episodes.length ? episodes[episodes.length - 1].id : null };
  }
  const index = episodes.findIndex(e => String(e.id) === String(lastCursor));
  const fresh = index >= 0 ? episodes.slice(index + 1) : episodes;
  return {
    firstFull: false,
    episodes: fresh,
    nextCursor: fresh.length ? fresh[fresh.length - 1].id : lastCursor,
  };
}
