/**
 * STEP 16 - 书的压缩层（借鉴 RAPTOR 的两层摘要 + MemGPT 的分层落位）
 *
 * 只做「章 → 全书」两层，不做聚类：书有天然章节，硬聚类会把不同主题并在一起。
 * 所有 LLM 调用由注入的 infer 完成；失败一律降级，不阻断阅读。
 *
 * infer 契约：
 *   infer({ kind:'chapter_summary', title, index, text }) -> string
 *   infer({ kind:'book_summary', title, chapters:[{index, summary}] }) -> string
 */

import { sampleForSummary } from './chapter-detect.js';

export const DEFAULTS = {
  minChaptersForFusion: 5,   // 少于这个章数，融合不划算，走逐段
  chapterChars: 150,
  bookChars: 300,
  maxChapterChars: 9000,     // 单章超长先截断再摘要
};

/** 判断这本书走融合还是逐段。 */
export function planSummary(chapters = [], cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const list = (chapters || []).filter(ch => String(ch && ch.text || '').trim());
  const totalChars = list.reduce((n, ch) => n + String(ch.text).length, 0);
  const mode = list.length >= c.minChaptersForFusion ? 'fusion' : 'flat';
  return {
    mode,
    chapters: list.length,
    totalChars,
    reason: mode === 'fusion' ? `chapters>=${c.minChaptersForFusion}` : `chapters<${c.minChaptersForFusion}`,
  };
}

function fallbackSummary(text, limit) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.slice(0, limit);
  const p = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('. '));
  return (p > limit * 0.6 ? cut.slice(0, p) : cut) + (s.length > limit ? '…' : '');
}

/** 逐章摘要。返回 [{ index, title, summary, ok, error? }] */
export async function summarizeChapters(chapters = [], { infer = null, onProgress = null, cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const out = [];
  for (const ch of chapters) {
    const index = Number(ch.index) || out.length;
    const title = String(ch.title || `第 ${index + 1} 章`);
    const text = sampleForSummary(String(ch.text || ''), c.maxChapterChars);
    if (typeof infer !== 'function') {
      out.push({ index, title, summary: fallbackSummary(text, c.chapterChars), ok: false, error: 'infer_unavailable' });
      continue;
    }
    try {
      const raw = await infer({ kind: 'chapter_summary', title, index, text, targetChars: c.chapterChars });
      const summary = String(raw || '').trim();
      out.push({
        index, title,
        summary: summary || fallbackSummary(text, c.chapterChars),
        ok: !!summary,
        error: summary ? undefined : 'empty',
      });
    } catch (err) {
      // 单章失败降级，不中断整本
      out.push({ index, title, summary: fallbackSummary(text, c.chapterChars), ok: false, error: String(err && err.message || err) });
    }
    if (typeof onProgress === 'function') onProgress({ done: out.length, total: chapters.length, index });
  }
  return out;
}

/** 全书摘要：输入是章摘要，不是原文。 */
export async function summarizeBook(chapterSummaries = [], { infer = null, title = '', cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const compact = chapterSummaries.map(s => ({ index: s.index, summary: String(s.summary || '').slice(0, c.chapterChars) }));
  if (typeof infer !== 'function') {
    return { summary: fallbackSummary(compact.map(x => x.summary).join(' '), c.bookChars), ok: false, error: 'infer_unavailable' };
  }
  try {
    const raw = await infer({ kind: 'book_summary', title, chapters: compact, targetChars: c.bookChars });
    const summary = String(raw || '').trim();
    if (!summary) throw new Error('empty');
    return { summary: summary.slice(0, c.bookChars), ok: true };
  } catch (err) {
    return { summary: fallbackSummary(compact.map(x => x.summary).join(' '), c.bookChars), ok: false, error: String(err && err.message || err) };
  }
}

/**
 * 分层落位（MemGPT 思路）：
 *   core = 全书摘要（进 core/soul 层，长期）
 *   facts = 章摘要（进 fact 层，可更新）
 * 原文永远留在 episodes，这里不碰。
 */
export function layering({ title = '', bookSummary = '', chapterSummaries = [] } = {}) {
  return {
    core: [{
      layer: 'core',
      kind: 'book_summary',
      title,
      text: bookSummary,
      importance: 0.9,
      source: 'book',
    }],
    facts: chapterSummaries.map((s, i) => ({
      layer: 'fact',
      kind: 'chapter_summary',
      title: `${title || '书'} · ${s.title || `第 ${(s.index || i) + 1} 章`}`,
      text: s.summary,
      chapterIndex: s.index ?? i,
      importance: 0.55,
      source: 'book',
    })),
    blobs: chapterSummaries.length,   // 原文在 episodes，不在这里
  };
}
