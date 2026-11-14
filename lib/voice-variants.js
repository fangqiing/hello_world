/**
 * STEP 23 - 变体池与反重复（纯函数）
 *
 * 问题：老用同一句「好的」「嗯」「可以」，两次就暴露模板。
 * 做法：每类准备 3–5 个说法，按「最近没用过」优先挑；不追求真随机，追求不重复。
 */

export const POOLS = {
  ok: ['行', '可以', '嗯', '成', '没问题', '好'],
  no: ['不行', '算了', '别了', '不了'],
  unsure: ['不清楚', '我看看', '得查一下', '说不好', '这个我不懂'],
  understood: ['懂了', '明白了', '嗯嗯', '行吧', '收到'],
  agree: ['是', '对', '确实', '那倒是'],
  doubt: ['真的假的', '不至于吧', '你确定？', '有这事'],
  wait: ['等下', '等会儿', '我瞅瞅'],
  tired: ['困了', '有点累', '顶不住', '想睡了'],
  thanks: ['谢了', '谢啦', '多谢'],
};

/** 简单的使用记录：记最近 N 次用过哪句。 */
export function makeTracker(size = 6) {
  const recent = [];
  return {
    pick(key, rand = Math.random) {
      const pool = POOLS[key];
      if (!pool || !pool.length) return '';
      // 先排除最近用过的，全用过了就放开
      const fresh = pool.filter(x => !recent.includes(key + ':' + x));
      const source = fresh.length ? fresh : pool;
      const choice = source[Math.floor(rand() * source.length)] || source[0];
      recent.push(key + ':' + choice);
      while (recent.length > size) recent.shift();
      return choice;
    },
    recent() { return recent.slice(); },
    reset() { recent.length = 0; },
  };
}

/**
 * 一次性挑选（不带状态）：尽量避开 avoid 里的。
 * 适合无状态调用，代价是「最近用过」要由调用方传进来。
 */
export function pickFrom(key, { avoid = [], rand = Math.random } = {}) {
  const pool = POOLS[key];
  if (!pool || !pool.length) return '';
  const fresh = pool.filter(x => !avoid.includes(x));
  const source = fresh.length ? fresh : pool;
  return source[Math.floor(rand() * source.length)] || source[0];
}

/**
 * 反重复检查：同一句在最近 N 条里出现过几次。
 * 超过阈值就提示换说法（用于自检，不自动改）。
 */
export function repetitionCheck(text, recentTexts = [], threshold = 1) {
  const t = String(text || '').trim();
  if (!t) return { repeated: 0, ok: true };
  const count = recentTexts.filter(x => String(x || '').trim() === t).length;
  return { repeated: count, ok: count <= threshold };
}
