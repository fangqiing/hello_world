/**
 * STEP 15 - 对话里判断「这是一本书」（纯函数）
 *
 * 用户可以直接把整段文字发给她，她自己判断要不要当成书来读。
 * 判断靠特征打分，不靠单一关键词——避免把一条长消息误判成书。
 */

import { splitChapters as splitBookInput } from './book-input.js'

const CHAPTER_RE = /(^|\n)\s*(第[一二三四五六七八九十百零〇两\d]{1,6}[章节卷回篇]|Chapter\s+\d{1,4}\b|\d{1,3}[.、]\s*\S{2,})/gi;
const TITLE_RE = /《([^》]{1,40})》/;
const AI_ARTIFACT_RE = /(请|帮我|能不能|可以)?(总结|概括|摘要)一下/i;

export const BOOK_HINTS = [
  /这是一本(书|小说|书稿)/i,
  /(帮我|给我|替我)?(读|看)(一下|一遍)?这(本|篇)/i,
  /你(先)?(读|看)(读|看)?这(本|个)/i,
  /(书稿|正文|全书|全文)如下/i,
  /(以下|下面)是(这)?(本书|正文|第一章)/i,
];

export const NOT_BOOK_HINTS = [
  /(帮我|替我)(写|改|翻译)/,
  /(总结|概括)一下(上面|这段|刚才)/,
  /```[\s\S]*```/,          // 代码块
];

function countMatches(text, re) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

/** 段落规整度：0–1，越接近 1 越像书稿（行长稳定、换行多） */
function paragraphRegularity(text) {
  const lines = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 3) return 0;
  const lens = lines.map(l => l.length);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
  const sd = Math.sqrt(variance);
  const stable = avg > 15 && avg < 120 && sd / Math.max(1, avg) < 0.9 ? 1 : 0;
  return stable;
}

/**
 * 返回 { isBook, score, reasons, title, chapters, needConfirm }
 * score >= 5 判为书；3–4 分「疑似」，让她先问一句再读。
 */
export function looksLikeBook(text, ctx = {}) {
  const s = String(text || '');
  const len = s.length;
  const reasons = [];
  let score = 0;

  // 长度
  if (len > 2000) { score += 3; reasons.push('length>2000'); }
  else if (len > 800) { score += 2; reasons.push('length>800'); }
  else if (len > 400) { score += 1; reasons.push('length>400'); }

  // 章节标记
  const chapters = countMatches(s, CHAPTER_RE);
  if (chapters >= 3) { score += 3; reasons.push(`chapters=${chapters}`); }
  else if (chapters === 1) { score += 1; reasons.push('chapter=1'); }

  // 书名号
  const tm = s.match(TITLE_RE);
  if (tm) { score += 2; reasons.push('title_mark'); }

  // 用户明示
  if (BOOK_HINTS.some(re => re.test(s))) { score += 4; reasons.push('explicit_hint'); }

  // 段落规整
  if (paragraphRegularity(s)) { score += 1; reasons.push('regular_paragraphs'); }

  // 负向
  if (NOT_BOOK_HINTS.some(re => re.test(s))) { score -= 2; reasons.push('not_book_hint'); }
  const questions = countMatches(s, /[？?]/g);
  if (questions > 6) { score -= 1; reasons.push('too_many_questions'); }
  if (/(哈哈|嘿嘿|啊啊|草|笑死)/.test(s) && len < 800) { score -= 2; reasons.push('casual_tone'); }
  if (ctx.isReplyToBookRequest === true) { score += 3; reasons.push('follows_request'); }

  const isBook = score >= 5;
  const needConfirm = !isBook && score >= 3;

  return {
    isBook,
    needConfirm,
    score,
    reasons,
    title: tm ? tm[1].trim() : (ctx.title || ''),
    chapters: chapters,
    length: len,
  };
}

/** 按章节切分；没有章节标记就按空行切。使用无回溯逐行扫描。 */
export function splitChapters(text, maxLen = 6000) {
  return splitBookInput(text, { maxLen }).map((row) => ({ index: row.index, text: row.text }))
}

/** 她收到书时的回应（短、不像客服）。 */
export function bookAck(result, { name = '' } = {}) {
  if (!result || !result.isBook) return '';
  const t = result.title ? `《${result.title}》` : '这段';
  return `我读读${t}。`;
}
