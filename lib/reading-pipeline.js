/**
 * STEP 10 / ④ - 阅读 → 自进化管线（零副作用）
 *
 * 补齐疑点：readBook 必须真的把原则候选送进 PrincipleEngine.ingestCandidate，
 * 否则「读书进化」只是多了一行 readings 数据。
 * LLM 不可用时只记录 skipped，绝不用 extractiveSummary 编造原则。
 *
 * store: { appendReading(row), appendPrincipleEvent(row), listPrinciples() }
 * infer: async ({kind, text, segmentIndex}) => [{ statement, evidence, weight? }] | null
 * principles: PrincipleEngine 实例（ingestCandidate / addEvidence / tick / listActive）
 */

import { toHealthRecord } from './error-classifier.js'
import { CANDIDATE_CAP, capCandidateWeight } from './principle-weight-cap.js'
import { splitChapters } from './book-detector.js'
import { splitByChapters as splitBookChapters, splitBookDetailed } from './book-chapters.js'
import { BookReading } from './book-reading.js'

/** 按章节 / 空行分段，单段有长度上限。 */
export function splitText(text, maxLen = 1200) {
  const src = String(text || '');
  const chunks = src.split(/\n\s*\n|(?:^|\n)(?:第[一二三四五六七八九十\d]+[章节回]|Chapter\s+\d+)/i);
  const out = [];
  for (const raw of chunks) {
    const s = raw.trim();
    if (!s) continue;
    for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen));
  }
  return out;
}

function normalizeStatement(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 借鉴「画风记忆库：参考图越多，标签权重越高，且封顶」。
 * 一本书对应一条候选原则；同一原则被后续书籍/经历反复印证 = 证据数增长 = 权重上升。
 * 映射到 principles.weight 的 0–1 区间；20 条封顶 0.80，不拉满（避免边界一夜翻转）。
 */
export const WEIGHT_TABLE = [
  { min: 0, max: 3, weight: 0.34 },
  { min: 4, max: 9, weight: 0.46 },
  { min: 10, max: 19, weight: 0.62 },
  { min: 20, max: Infinity, weight: 0.80 },
];

export function evidenceCountToWeight(count) {
  const n = Math.max(0, Number(count) || 0);
  const hit = WEIGHT_TABLE.find(r => n >= r.min && n <= r.max);
  return hit ? hit.weight : 0.80;
}

export class ReadingPipeline {
  constructor({ store, infer = null, principles = null, social = null, clock = () => Date.now(), config = {} } = {}) {
    Object.assign(this, { store, infer, principles, social, clock });
    this.cfg = { maxLen: 1200, dedupeThreshold: 0.82, maxCandidates: 8, candidateCap: CANDIDATE_CAP, fusion: true, fusionMinChapters: 5, ...config };
  }

  /**
   * 投一本书 → readings + 原则候选 → 入状态机 → 事件溯源。
   * 返回 { readingId, candidates, events, skipped, reason? }
   */
  async readBook({ title, source = 'book', text = '', chapters = [], mode = 'book', actor = 'self', peerId = null, onProgress = null } = {}) {
    const at = this.clock();
    const maxCandidates = Math.max(1, Math.min(8, Number(this.cfg.maxCandidates) || 8));
    const readingId = `reading_${at}_${Math.random().toString(36).slice(2, 8)}`;
    const supplied = (Array.isArray(chapters) ? chapters : [])
      .map((row, i) => ({
        index: Number.isFinite(Number(row?.index)) ? Number(row.index) : i,
        title: String(row?.title || '').slice(0, 80),
        text: String(row?.text || '').trim(),
      }))
      .filter((row) => row.text);
    const rawText = String(text || '');
    const fullText = rawText || supplied.map((row) => row.text).join('\n\n');
    const article = mode === 'article';
    const segments = splitText(fullText, this.cfg.maxLen);
    // STEP 26 的 chapters 由前端切；只在“前端只送来 1 章”时用服务端章节表兜底。
    // 不能无条件重切：前端已切好的章节文本不含目录页，重切会把脚注数字当成章。
    const parsed = !article && rawText.trim() ? splitBookDetailed(fullText) : null;
    const repaired = !article && !rawText.trim() && this.cfg.fusion ? splitBookChapters(fullText) : [];
    const chapterRows = article
      ? []
      : (parsed && parsed.chapters.length >= 2
        ? parsed.chapters
        : (supplied.length >= 2
          ? supplied
          : (repaired.length >= 2 ? repaired : (this.cfg.fusion ? splitChapters(fullText, 9000) : []))));
    const frontChars = parsed?.frontChars || 0;
    const ocrSuspect = parsed?.ocrSuspect || false;
    const useFusion = !article && this.cfg.fusion && chapterRows.length >= Number(this.cfg.fusionMinChapters || 5);
    const reading = {
      id: readingId, at, title: String(title || 'untitled'), source,
      segments: useFusion ? chapterRows.length : segments.length, actor,
      mode: article ? 'article' : (useFusion ? 'fusion' : 'flat'),
      chapterCount: chapterRows.length,
      frontChars,
      ocrSuspect,
    };
    if (this.store && this.store.appendReading) await this.store.appendReading(reading);
    if (this.store && this.store.appendEpisode && fullText) {
      await this.store.appendEpisode({
        sessionId: `reading:${readingId}`,
        channel: 'book',
        role: 'user',
        text: fullText,
        peerId,
        at,
      });
    }

    if (!this.infer) {
      return { readingId, reading, candidates: [], events: [], skipped: true, reason: 'infer_unavailable' };
    }

    if (useFusion) {
      const chapters = chapterRows.map((row, i) => {
        const firstLine = String(row.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
        return {
          index: row.index ?? i,
          title: String(row.title || '').slice(0, 40) || firstLine.slice(0, 40) || `第 ${i + 1} 章`,
          text: row.text,
        };
      });
      return this._readBookFused({ title: String(title || 'untitled'), source, text, actor, at, readingId, reading, chapters, onProgress });
    }

    let rawCandidates = [];
    let sawInfer = false
    try {
      for (let i = 0; i < segments.length; i += 1) {
        const got = await this.infer({ kind: 'principle_candidate', text: segments[i], segmentIndex: i });
        if (Array.isArray(got)) {
          sawInfer = true
          rawCandidates.push(...got.map(c => ({ ...c, segmentIndex: i })))
        }
      }
    } catch (err) {
      const record = toHealthRecord(err, { phase: 'infer' });
      if (typeof this.cfg.onError === 'function') {
        try { await this.cfg.onError(record) } catch { /* health must not mask the cause */ }
      }
      return {
        readingId, reading, candidates: [], events: [], skipped: true,
        reason: record.kind === 'fatal' ? 'infer_fatal' : 'infer_degraded',
        error: record,
      };
    }
    if (!rawCandidates.length) {
      return { readingId, reading, candidates: [], events: [], skipped: true, reason: sawInfer ? 'no_candidates' : 'infer_unavailable' };
    }

    // 与既有原则去重（精确 + 简单词面），不追求语义近似
    const existing = new Set(
      ((this.store && this.store.listPrinciples) ? (await this.store.listPrinciples()) : [])
        .map(p => normalizeStatement(p.statement)),
    );
    const candidates = [];
    const seen = new Set();
    for (const c of rawCandidates) {
      const statement = String(c.statement || '').trim();
      const key = normalizeStatement(statement);
      if (!key || existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        statement,
        source: 'book',
        evidenceId: `${readingId}#${c.segmentIndex ?? 0}`,
        evidence: String(c.evidence || segments[c.segmentIndex ?? 0] || '').slice(0, 300),
        initialWeight: capCandidateWeight(c.weight, this.cfg.candidateCap).weight,
        readingId,
      });
      if (candidates.length >= maxCandidates) break;
    }

    const events = [];
    for (const c of candidates) {
      let principle = null;
      if (this.principles && typeof this.principles.ingestCandidate === 'function') {
        principle = this.principles.ingestCandidate({
          statement: c.statement,
          source: c.source,
          evidenceId: c.evidenceId,
          initialWeight: c.initialWeight,
          actor,
        });
      }
      const event = {
        at: this.clock(), kind: 'principle_candidate', actor,
        principleId: principle ? principle.id : null,
        evidenceId: c.evidenceId, readingId, statement: c.statement,
      };
      if (this.store && this.store.appendPrincipleEvent) await this.store.appendPrincipleEvent(event);
      events.push({ ...event, principle });
    }
    const principleIds = events.map(e => e.principle?.id).filter(Boolean)
    if (principleIds.length && this.store && this.store.updateReadingPrinciples) {
      await this.store.updateReadingPrinciples(readingId, principleIds)
      reading.principleIds = principleIds
    }
    return { readingId, reading, candidates, events, skipped: false };
  }

  /** 章数够时走 STEP16 融合：压成章摘要/全书摘要，再按章攒着炼。 */
  async _readBookFused({ title, source, text, actor, at, readingId, reading, chapters, onProgress = null }) {
    const engine = new BookReading({
      infer: this.infer,
      principles: this.principles,
      store: this.store,
      clock: this.clock,
      config: {
        candidateCap: this.cfg.candidateCap,
        minChaptersForFusion: this.cfg.fusionMinChapters,
        onProgress,
      },
    });
    let fused = null;
    try {
      fused = await engine.read({ title, text, chapters });
    } catch (err) {
      const record = toHealthRecord(err, { phase: 'fusion' });
      if (typeof this.cfg.onError === 'function') {
        try { await this.cfg.onError(record); } catch { /* health must not mask the cause */ }
      }
      return {
        readingId, reading, candidates: [], events: [], skipped: true,
        reason: record.kind === 'fatal' ? 'infer_fatal' : 'infer_degraded', error: record, mode: 'fusion',
      };
    }

    const events = [];
    for (const extraction of (fused.extractions || [])) {
      for (const p of (extraction.principles || [])) {
        const event = {
          at: this.clock(), kind: 'principle_candidate', actor,
          principleId: p.principleId, evidenceId: p.evidenceId, readingId,
          statement: p.statement,
        };
        if (this.store && this.store.appendPrincipleEvent) await this.store.appendPrincipleEvent(event);
        events.push({
          ...event,
          principle: p.principleId
            ? { id: p.principleId, statement: p.statement, weight: p.initialWeight }
            : null,
        });
      }
    }
    const principleIds = events.map(e => e.principle?.id).filter(Boolean);
    if (principleIds.length && this.store && this.store.updateReadingPrinciples) {
      await this.store.updateReadingPrinciples(readingId, principleIds);
      reading.principleIds = principleIds;
    }
    reading.bookSummary = fused.bookSummary || '';
    reading.layers = fused.layers;
    reading.stats = fused.stats;
    if (this.store && this.store.updateReadingSummary) {
      await this.store.updateReadingSummary(readingId, {
        summary: reading.bookSummary,
        meta: { mode: 'fusion', stats: fused.stats, layers: fused.layers, chapterCount: reading.chapterCount, frontChars: reading.frontChars, ocrSuspect: reading.ocrSuspect },
      });
    }

    return {
      readingId, reading, candidates: events.map(e => e.principle).filter(Boolean),
      events, skipped: events.length === 0,
      reason: events.length ? '' : 'no_candidates',
      mode: 'fusion', layers: fused.layers, stats: fused.stats, summary: fused.bookSummary || '',
    };
  }

  /**
   * 用户可纠正她提炼的原则标签（借鉴画风库「她提炼偏了，你可以让她重写标签」）。
   * 修订必须走 principles.revisePrinciple 保留 revision_chain，旧版不删。
   */
  async correctStatement({ principleId, newStatement, actor = 'user', reason = '' } = {}) {
    const statement = String(newStatement || '').trim();
    if (!principleId || !statement) return { ok: false, reason: 'invalid' };
    let revised = null;
    const reviser = this.social?.revisePrinciple ? this.social : this.principles;
    if (reviser && typeof reviser.revisePrinciple === 'function') {
      revised = reviser.revisePrinciple(principleId, { statement, actor, reason });
    }
    const event = {
      at: this.clock(), kind: 'principle_corrected', actor,
      principleId, statement, reason, revisionChainKept: true,
    };
    if (this.store && this.store.appendPrincipleEvent) await this.store.appendPrincipleEvent(event);
    return { ok: true, revised, event };
  }

  /** 端到端自检：输入各表快照，逐项定位断点。纯函数。 */
  static verifyEvolution({ readings = [], principles = [], events = [], disclosures = [] } = {}, readingId = null) {
    const mine = readingId ? readings.filter(r => r.id === readingId) : readings;
    const bookPrinciples = principles.filter(p => p.source === 'book');
    const candidateEvents = events.filter(e => (e.kind || e.event) === 'principle_candidate');
    const referenced = new Set(disclosures.flatMap(d => d.principle_ids || []));
    const checks = {
      readingPresent: mine.length > 0,
      principleCandidates: bookPrinciples.length > 0,
      candidateEvents: candidateEvents.length > 0,
      eventHasEvidence: candidateEvents.every(e => !!(e.evidenceId || e.evidence_id)),
      weightEvolved: bookPrinciples.some(p => {
        const initial = p.initialWeight ?? p.initial_weight ?? p.meta?.initialWeight ?? p.meta?.initial_weight
        return initial != null ? Number(p.weight) !== Number(initial) : Number(p.weight) > 0
      }),
      activated: bookPrinciples.some(p => p.status === 'active'),
      referencedInDisclosure: bookPrinciples.some(p => referenced.has(p.id)),
      oldVersionsKept: principles.every(p => p.status !== 'deleted'),
    };
    return { ok: Object.values(checks).every(Boolean), checks, readingId };
  }
}
