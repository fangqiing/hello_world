/**
 * STEP 8 / F6 - 每人独立日记（新增自包含模块）
 *
 * step-7 已做到 per-peer 章节，但夜间回顾仍是一天一篇。
 * 本模块把「和每个人不同的故事」补成每个 active peer 各一篇日记。
 *
 * 约束：
 *  - 每篇只使用该 peer 的章节 / episodes + 共享抽象；不合并成一篇。
 *  - 内容不含任何他人私有内容；自我模型净化同 step-7 §3.3。
 *  - infer（LLM）由外部注入，模块内不调模型；失败时退化为章节摘要，不编造情节。
 *  - 模块格式与 step-7 一致（ESM）。
 */

/** 按 peer 分组，保留原始顺序；空 peer 不产出。 */
export function groupByPeer(chapters = []) {
  const map = new Map();
  for (const ch of chapters) {
    if (!ch || !ch.peer_id) continue;
    if (!map.has(ch.peer_id)) map.set(ch.peer_id, []);
    map.get(ch.peer_id).push(ch);
  }
  return map;
}

/** 章节摘要：只用章节自身的 summary / kind / at，不引用其他 peer。 */
export function chapterLines(chapters) {
  return chapters
    .slice()
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map(ch => `- ${ch.kind || 'event'}：${ch.summary || ''}`.trim());
}

export class PeerDiary {
  constructor({ store, clock = () => Date.now(), infer = null, config = {} }) {
    this.store = store; // listActivePeers / listChapters(peerId, {since, until}) / appendDiary(row)
    this.clock = clock;
    this.infer = infer; // async ({ peerId, chapters, since, until }) => string | null
    this.cfg = { fallbackToSummary: true, ...config };
  }

  /** 生成某个 peer 的一篇日记。 */
  async generate(peerId, { since = null, until = this.clock() } = {}) {
    const chapters = this.store.listChapters(peerId, { since, until }) || [];
    if (!chapters.length) return null;

    let content = null;
    if (this.infer) {
      try {
        content = await this.infer({ peerId, chapters, since, until });
      } catch (err) {
        content = null;
      }
    }
    if (!content && this.cfg.fallbackToSummary) {
      content = chapterLines(chapters).join('\n');
    }
    if (!content) return null;

    const row = this.store.appendDiary({
      peer_id: peerId,
      at: until,
      since: since || chapters[0].at,
      content,
      chapter_ids: chapters.map(ch => ch.id).filter(Boolean),
      version: 1,
    });
    return row;
  }

  /** 每个 active peer 各一篇；返回 { peerId, diary } 列表。 */
  async generateAll({ since = null, until = this.clock() } = {}) {
    const out = [];
    for (const peer of this.store.listActivePeers()) {
      const diary = await this.generate(peer.id, { since, until });
      if (diary) out.push({ peerId: peer.id, diary });
    }
    return out;
  }
}
