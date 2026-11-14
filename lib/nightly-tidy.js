/**
 * STEP 10 / ② - 夜间复盘整理编排（零副作用）
 *
 * 核心原则：默认 dry-run；只做标记式归档，绝不物理删除；结果可逐项回滚。
 * 所有 DB / LLM 操作由注入的 store / infer / verifySummary 完成。
 *
 * store 接口（按运行态适配）：
 *   listEpisodes({since, until, peerId}) / listMemories({peerId}) / counts()
 *   markArchived(kind, ids) / upsertSummary(kind, id, text) / appendTidyRun(row)
 *   snapshot() -> id
 */

export const TIDY_TARGET = { DATA: 'data', UI: 'ui' };

export class NightlyTidy {
  constructor({ store, infer = null, verifySummary = null, clock = () => Date.now(), config = {} } = {}) {
    Object.assign(this, { store, infer, verifySummary, clock });
    this.cfg = {
      target: TIDY_TARGET.DATA,
      episodeMax: 40,
      writeMax: 14,
      dupThreshold: 0.82,
      apply: false,               // 默认 dry-run
      injectIntoPrompt: false,    // 默认不产生新的模型可见输入
      ...config,
    };
    this.runs = [];
  }

  inventory({ since = 0, until = this.clock() } = {}) {
    const episodes = this.store.listEpisodes({ since, until }) || [];
    const memories = this.store.listMemories({}) || [];
    const byPeer = {};
    for (const e of episodes) {
      const k = e.peer_id || 'shared';
      byPeer[k] = (byPeer[k] || 0) + 1;
    }
    return {
      episodes: episodes.length,
      memories: memories.length,
      byPeer,
      walBytes: this.store.walBytes ? this.store.walBytes() : null,
      counts: this.store.counts ? this.store.counts() : null,
    };
  }

  _episodePlan(episodes) {
    const sorted = episodes.slice().sort((a, b) => (a.at || a.createdAt || 0) - (b.at || b.createdAt || 0));
    const overflow = Math.max(0, sorted.length - this.cfg.episodeMax);
    const archiveIds = sorted.slice(0, overflow).map(e => e.id).filter(Boolean);
    // 长对话摘要候选：只产出候选，不自动替换原文
    const summaryCandidates = sorted
      .filter(e => String(e.text || '').length > 800)
      .slice(0, this.cfg.writeMax)
      .map(e => ({ id: e.id, reason: 'long_transcript' }));
    return { archiveIds, summaryCandidates, kept: sorted.length - archiveIds.length };
  }

  _memoryPlan(memories) {
    const supersedeCandidates = [];
    const duplicateCandidates = [];
    const dueForReview = [];
    const now = this.clock();
    for (const m of memories) {
      if (m.nextReviewAt && Number(m.nextReviewAt) <= now) dueForReview.push(m.id);
      if (m.validUntil && Number(m.validUntil) <= now && m.status !== 'archived') {
        supersedeCandidates.push({ id: m.id, reason: 'valid_until_passed' });
      }
    }
    // 跨 peer 不合并且：只在同一 peer_id 内比较
    const groups = new Map();
    for (const m of memories) {
      const k = `${m.layer || 'fact'}|${m.peer_id || 'shared'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    for (const group of groups.values()) {
      const seen = new Map();
      for (const m of group) {
        const key = String(m.text || m.content || '').replace(/\s+/g, '').toLowerCase();
        if (seen.has(key)) duplicateCandidates.push({ keep: seen.get(key), merge: m.id, reason: 'exact_duplicate' });
        else seen.set(key, m.id);
      }
    }
    return { supersedeCandidates, duplicateCandidates, dueForReview, crossPeerMerges: 0 };
  }

  /** 生成完整计划；apply=false 时零数据变更。 */
  plan({ since = 0, until = this.clock(), peerId = null } = {}) {
    const at = this.clock();
    const snapshotId = `tidy_${at}_${Math.random().toString(36).slice(2, 8)}`;
    const episodes = (this.store.listEpisodes({ since, until, peerId }) || []);
    const memories = (this.store.listMemories({ peerId }) || []);
    const episodePlan = this._episodePlan(episodes);
    const memoryPlan = this._memoryPlan(memories);
    const result = {
      id: snapshotId,
      at,
      target: this.cfg.target,
      dryRun: !this.cfg.apply,
      inventory: this.inventory({ since, until }),
      episodePlan,
      memoryPlan,
      limitsApplied: { episodeMax: this.cfg.episodeMax, writeMax: this.cfg.writeMax },
      maintenanceHints: [
        '索引重建建议（不自动执行）',
        'WAL checkpoint 建议（不自动执行）',
      ],
      promptInjection: this.cfg.injectIntoPrompt
        ? '需对应会话事件或走纯消息投影 deriveMessages()'
        : 'disabled',
      snapshotId: this.store.snapshot ? this.store.snapshot() : snapshotId,
      mustKeep: this.verifySummary
        ? this.verifySummary(
            { decisions: memories.filter(m => (m.kind || m.meta?.kind) === 'decision').map(m => m.id),
              commitments: memories.filter(m => (m.kind || m.meta?.kind) === 'commitment').map(m => m.id),
              openItems: episodes.filter(e => e.status === 'open').map(e => e.id) },
            { decisions: memories.filter(m => (m.kind || m.meta?.kind) === 'decision' && m.status !== 'archived').map(m => m.id),
              commitments: memories.filter(m => (m.kind || m.meta?.kind) === 'commitment' && m.status !== 'archived').map(m => m.id),
              openItems: episodes.filter(e => e.status === 'open').map(e => e.id) },
          )
        : { ok: true, skipped: true, reason: 'verify_unavailable' },
    };
    if (result.mustKeep && !result.mustKeep.ok) result.blocked = 'must_keep_violation';
    return result;
  }

  /** 只有 apply=true 且 must-keep 通过才执行标记式归档。 */
  async run(opts = {}) {
    const p = this.plan(opts);
    if (this.cfg.apply && !this.verifySummary) return { ...p, applied: false, blocked: 'verify_unavailable' };
    if (p.blocked) return { ...p, applied: false, reason: p.blocked };
    if (!this.cfg.apply) {
      this.runs.push({ ...p, applied: false });
      if (this.store.appendTidyRun) await this.store.appendTidyRun({ ...p, applied: false, actor: 'engine' });
      return { ...p, applied: false };
    }
    // 只 markArchived，不删除任何行
    await this.store.markArchived('episodes', p.episodePlan.archiveIds);
    const duplicateIds = p.memoryPlan.duplicateCandidates.map(x => x.merge);
    const memoryIds = [...new Set([...p.memoryPlan.supersedeCandidates.map(x => x.id), ...duplicateIds])];
    await this.store.markArchived('memories', memoryIds);
    // 摘要候选可选生成（失败不阻断）
    if (this.infer) {
      for (const c of p.episodePlan.summaryCandidates) {
        try {
          const text = await this.infer({ kind: 'episode_summary', id: c.id });
          if (text) await this.store.upsertSummary('episodes', c.id, text);
        } catch (err) { /* 降级：跳过该条 */ }
      }
    }
    const row = { ...p, applied: true, actor: 'engine', stats: { episodesArchived: p.episodePlan.archiveIds.length, memoriesArchived: memoryIds.length, duplicatesArchived: duplicateIds.length } };
    if (this.store.appendTidyRun) await this.store.appendTidyRun(row);
    this.runs.push(row);
    return row;
  }

  /** UI 两区域的整理视图（数据层整理之外附带）。 */
  tidyView(p) {
    return {
      dialogueArea: { total: p.inventory.episodes, archived: p.episodePlan.archiveIds.length,
                      kept: p.episodePlan.kept, groupedBy: 'peer' },
      memoryArea: { total: p.inventory.memories,
                    supersedeCandidates: p.memoryPlan.supersedeCandidates.length,
                    duplicateCandidates: p.memoryPlan.duplicateCandidates.length,
                    dueForReview: p.memoryPlan.dueForReview.length,
                    groupedBy: 'layer' },
      collapsible: true,
    };
  }

  history() { return this.runs.slice(); }
}
