/**
 * STEP 7 - 情绪引擎（新增自包含模块）
 *
 * 事件溯源 + 否定辖域检查 + 抽象自我觉察。
 * 只写她自己的状态，绝不拼接他人私有内容（自我模型净化约束）。
 * 模块格式：ESM；CJS 转换方式见 04-INTEGRATION.md。
 */

const NEGATORS = ['不', '没', '无', '别', '非', '毫无', '一点都不', '并不', '不太'];

/**
 * 词典命中前做否定辖域检查。
 * lexicon 形如 { joy: ['开心', '高兴'], sad: ['难过', '失落'] }
 * 返回有效的（未被否定的）命中；被否定的命中保留在调试信息里，便于回查误判。
 */
export function matchEmotion(text, lexicon) {
  const all = [];
  for (const [emotion, words] of Object.entries(lexicon || {})) {
    for (const word of words) {
      const index = text.indexOf(word);
      if (index < 0) continue;
      const before = text.slice(Math.max(0, index - 6), index);
      const negated = NEGATORS.some(n => before.includes(n));
      all.push({ emotion, word, index, negated, effective: !negated });
    }
  }
  return all.filter(h => h.effective);
}

export class MoodEngine {
  constructor({ store, clock = () => Date.now(), lexicon = {}, config = {} }) {
    this.store = store; // currentMood / setCurrentMood / appendMoodEvent / listMoodEvents
    this.clock = clock;
    this.lexicon = lexicon;
    this.cfg = { lexiconStep: 0.05, bucketDays: 7, ...config };
  }

  /** 每条情绪变化都要有来历。 */
  applyEvent({ kind, cause, delta = 0, peerId = null, evidenceId = null, text = '' }) {
    const now = this.clock();
    const before = this.store.currentMood();
    const hits = text ? matchEmotion(text, this.lexicon) : [];
    const lexDelta = hits.length ? Math.sign(delta || 1) * this.cfg.lexiconStep * hits.length : 0;
    const total = delta + lexDelta;
    const after = Math.min(1, Math.max(-1, before + total));
    const row = this.store.appendMoodEvent({
      at: now, kind, cause, peer_id: peerId, evidence_id: evidenceId,
      delta: total, mood_before: before, mood_after: after,
    });
    this.store.setCurrentMood(after);
    return { ...row, hits };
  }

  /**
   * 抽象自我觉察：按时间桶聚合，只输出她自己的状态描述。
   * 严禁把 peer 的具体内容拼进 statement；event_ids 仅供回溯。
   */
  aggregate({ since = null, until = this.clock(), bucketDays = this.cfg.bucketDays } = {}) {
    const events = this.store.listMoodEvents({ since, until });
    if (!events.length) return null;
    const origin = since || events[0].at;
    const buckets = new Map();
    for (const e of events) {
      const key = Math.floor((e.at - origin) / (bucketDays * 86400000));
      const b = buckets.get(key) || { sum: 0, n: 0 };
      b.sum += e.mood_after;
      b.n += 1;
      buckets.set(key, b);
    }
    const parts = [...buckets.values()].map(b => {
      const avg = b.sum / b.n;
      const tone = avg > 0.25 ? '轻快' : avg < -0.25 ? '低沉' : '平静';
      return `这一段时间我大多比较${tone}，共记下 ${b.n} 件事`;
    });
    return {
      at: until,
      since: origin,
      statement: parts.join('；'),
      event_ids: events.map(e => e.id),
      version: 1,
    };
  }
}
