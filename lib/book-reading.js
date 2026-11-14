/**
 * STEP 16 - 融合版读书管线（压 → 炼 → 回）
 *
 *   压：章摘要 → 全书摘要（book-summarizer，借鉴 RAPTOR 的两层结构）
 *   炼：攒够 N 章再抽原则（借鉴 Generative Agents 的 reflection 节奏）
 *   回：core/fact 分层落位 + sourceQuote 可回溯（借鉴 MemGPT 的分层）
 *
 * 与逐段抽的差别：提炼时看到的是「整本书在说什么」，不是「这一段在说什么」。
 */

import { planSummary, summarizeChapters, summarizeBook, layering, DEFAULTS as SUM } from './book-summarizer.js';

export const DEFAULTS = {
  extractEveryChapters: 6,   // 攒够几章炼一次
  maxPrinciples: 8,
  candidateCap: 0.35,
  minChaptersForFusion: 5,
};

const clamp01 = v => Math.min(1, Math.max(0, Number(v) || 0));

export function normalizeStatement(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 从「全书摘要 + 章摘要」里抽原则。
 * infer 契约：infer({kind:'principle_extraction', bookSummary, chapters, maxCount})
 *          -> [{ statement, quote, chapterIndex }]
 */
export async function extractPrinciples({ bookSummary, chapterSummaries, infer, maxCount = 8 } = {}) {
  if (typeof infer !== 'function') return { principles: [], skipped: true, reason: 'infer_unavailable' };
  try {
    const raw = await infer({
      kind: 'principle_extraction',
      bookSummary: String(bookSummary || ''),
      chapters: chapterSummaries.map(s => ({ index: s.index, title: s.title, summary: s.summary })),
      maxCount,
    });
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const statement = String(item && (item.statement || item.text) || '').trim();
      if (!statement) continue;
      const key = normalizeStatement(statement);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        statement,
        sourceChapter: Number.isFinite(Number(item.chapterIndex)) ? Number(item.chapterIndex) : null,
        sourceQuote: String(item.quote || '').slice(0, 120),
        weight: clamp01(Math.min(maxCount > 0 ? DEFAULTS.candidateCap : 0, Number(item.weight) || DEFAULTS.candidateCap)),
      });
      if (out.length >= maxCount) break;
    }
    return { principles: out, skipped: false };
  } catch (err) {
    return { principles: [], skipped: true, reason: 'infer_failed', error: String(err && err.message || err) };
  }
}

export class BookReading {
  constructor({ infer = null, principles = null, store = null, clock = () => Date.now(), config = {} } = {}) {
    Object.assign(this, { infer, principles, store, clock });
    this.cfg = { ...DEFAULTS, ...config };
  }

  /**
   * chapters: [{ index, title, text }]
   * 返回 {
   *   mode: 'fusion'|'flat',
   *   chapterSummaries, bookSummary,
   *   extractions: [{ at, chapterUpTo, principles }],
   *   layers, stats
   * }
   */
  async read({ title = '', text = '', chapters = [] } = {}) {
    const startedAt = this.clock();
    const plan = planSummary(chapters, { minChaptersForFusion: this.cfg.minChaptersForFusion });
    const stats = { mode: plan.mode, chapters: plan.chapters, inferCalls: 0, principles: 0, deduped: 0 };

    if (plan.mode === 'flat') {
      const r = await this._readFlat({ title, text });
      return { ...r, startedAt, stats: { ...stats, ...r.stats } };
    }

    // 压
    const chapterSummaries = await summarizeChapters(chapters, {
      infer: this.infer,
      onProgress: this.cfg.onProgress,
      cfg: { chapterChars: SUM.chapterChars },
    });
    stats.inferCalls += chapterSummaries.filter(s => s.ok).length;

    const book = await summarizeBook(chapterSummaries, { infer: this.infer, title });
    stats.inferCalls += book.ok ? 1 : 0;

    // 炼：按章累积，攒够 extractEveryChapters 触发一次，最后再补一次
    const step = Math.max(2, this.cfg.extractEveryChapters);
    const extractions = [];
    const repeated = [];
    const existing = await this._existingStatements();
    let cumulative = [];

    for (let i = 0; i < chapterSummaries.length; i += 1) {
      cumulative.push(chapterSummaries[i]);
      const atEnd = i === chapterSummaries.length - 1;
      const due = (i + 1) % step === 0 || atEnd;
      if (!due) continue;

      const got = await extractPrinciples({
        bookSummary: book.summary,
        chapterSummaries: cumulative,
        infer: this.infer,
        maxCount: this.cfg.maxPrinciples,
      });
      stats.inferCalls += got.skipped ? 0 : 1;
      if (got.skipped) continue;

      const fresh = [];
      for (const p of got.principles) {
        const key = normalizeStatement(p.statement);
        if (existing.has(key)) { stats.deduped += 1; repeated.push(p); continue; }
        existing.add(key);
        fresh.push(p);
      }
      if (fresh.length) {
        const ingested = await this._ingest(fresh, { title, at: this.clock() });
        stats.principles += ingested.length;
        extractions.push({ at: this.clock(), chapterUpTo: i, principles: ingested });
      }
    }

    if (repeated.length) {
      const reinforced = await this._reinforce(repeated, { title })
      stats.reinforced = reinforced
    }

    return {
      mode: 'fusion',
      chapterSummaries,
      bookSummary: book.summary,
      bookSummaryOk: book.ok,
      extractions,
      layers: layering({ title, bookSummary: book.summary, chapterSummaries }),
      startedAt,
      stats,
    };
  }

  /** 章数太少时走逐段（沿用旧行为，避免为短文本付摘要成本）。 */
  async _readFlat({ title, text }) {
    const parts = [];
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 6000) parts.push(s.slice(i, i + 6000));
    const got = await extractPrinciples({
      bookSummary: '',
      chapterSummaries: parts.map((t, i) => ({ index: i, title: `段 ${i + 1}`, summary: t })),
      infer: this.infer,
      maxCount: this.cfg.maxPrinciples,
    });
    const ingested = got.skipped ? [] : await this._ingest(got.principles, { title, at: this.clock() });
    return {
      mode: 'flat',
      chapterSummaries: [],
      bookSummary: '',
      extractions: ingested.length ? [{ at: this.clock(), chapterUpTo: parts.length - 1, principles: ingested }] : [],
      layers: { core: [], facts: [], blobs: parts.length },
      stats: { inferCalls: got.skipped ? 0 : 1, principles: ingested.length, deduped: 0 },
    };
  }

  async _reinforce(list, { title }) {
    if (!this.principles || typeof this.principles.addEvidence !== 'function') return 0
    let rows = []
    try {
      rows = (this.store && this.store.listPrinciples) ? await this.store.listPrinciples() : []
    } catch { /* fall through: no lookup, no reinforcement */ }
    const byStatement = new Map(rows.map(p => [normalizeStatement(p.statement || p.text), p.id]))
    let applied = 0
    for (const p of list) {
      const id = byStatement.get(normalizeStatement(p.statement))
      if (!id) continue
      try {
        await this.principles.addEvidence({
          principleId: id,
          kind: 'support',
          evidenceId: `${title || 'book'}#reread:${this.clock()}:${applied}`,
          actor: 'self',
        })
        applied += 1
      } catch { /* one bad row must not abort the re-read */ }
    }
    return applied
  }

  async _existingStatements() {
    const set = new Set();
    if (!this.store || typeof this.store.listPrinciples !== 'function') return set;
    try {
      const list = await this.store.listPrinciples();
      for (const p of (list || [])) set.add(normalizeStatement(p.statement || p.text));
    } catch (err) { /* 读不到就当空，宁可多一条也不丢 */ }
    return set;
  }

  /** 入库：新原则走 ingestCandidate（权重已被封顶）；重复的走 addEvidence。 */
  async _ingest(list, { title, at }) {
    const out = [];
    for (const p of list) {
      const payload = {
        statement: p.statement,
        source: 'book',
        title,
        sourceChapter: p.sourceChapter,
        sourceQuote: p.sourceQuote,
        initialWeight: clamp01(Math.min(p.weight, this.cfg.candidateCap)),
        evidenceId: `${title || 'book'}#ch${p.sourceChapter ?? '?'}`,
        meta: {
          bookTitle: title || '',
          sourceChapter: p.sourceChapter ?? null,
          sourceQuote: p.sourceQuote || '',
        },
      };
      let r = null;
      if (this.principles && typeof this.principles.ingestCandidate === 'function') {
        r = this.principles.ingestCandidate(payload);
      }
      out.push({ ...payload, principleId: r && r.id ? r.id : null, at });
    }
    return out;
  }
}

/** 同一本书读第二遍：不新建原则，只加证据（读三遍才可能 active）。 */
export async function reinforceFromReread({ principles = null, bookTitle = '', statements = [] } = {}) {
  if (!principles || typeof principles.addEvidence !== 'function') return { ok: false, reason: 'no_engine' };
  const applied = [];
  for (const s of statements) {
    try {
      const r = await principles.addEvidence({ kind: 'support', statement: s.statement || s, source: 'book', title: bookTitle });
      applied.push({ statement: s.statement || s, ok: true, result: r });
    } catch (err) {
      applied.push({ statement: s.statement || s, ok: false, error: String(err && err.message || err) });
    }
  }
  return { ok: true, applied };
}
