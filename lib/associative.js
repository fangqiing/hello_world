/**
 * STEP 33 - 联想式主动（纯函数，零依赖）
 *
 * 问题：她主动起来像打卡。因为触发她的全是规则 —— 对方没回、承诺到期、日更提醒。
 *       真人的主动常常没有理由：「我刚想到你说的那个」。
 * 定案：从记忆里挑一对「时间隔得远、但确实有点共同点」的条目，作为联想起点
 *       交给她，说要不要说由她自己决定。代码只负责递线索，不负责开口。
 *
 * 为什么不用模型挑：这条链跑在定时器里，没有对话上下文；每次调模型也太贵。
 * 用 bigram 交集 + 时间距离做粗筛，命中的再交给她判断。
 *
 * 两条防呆：
 *   ① 相似度太高 = 两句话在说同一件事，想到也没意思；太低 = 硬凑。
 *      所以只取中间区间。
 *   ② 必须隔开足够天数，否则是「刚才那两件事」，不叫联想。
 */

const CJK = /\p{Script=Han}/u;

/** 中文按二字滑窗，英文/数字按整词。返回 Set。 */
export function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ').trim();
  const out = new Set();
  for (const token of s.split(/\s+/)) {
    if (!token) continue;
    if (!CJK.test(token)) {
      if (token.length >= 3) out.add(token);
      continue;
    }
    if (token.length < 2) continue;
    for (let i = 0; i + 2 <= token.length; i += 1) out.add(token.slice(i, i + 2));
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function shuffle(list, rng) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 挑一对可以联想的记忆。
 *
 * @param {Array<{id:string,text:string,at:number}>} items
 * @returns {{a:object,b:object,shared:string[],score:number,gapDays:number}|null}
 */
export function pickAssociative(items, {
  now = Date.now(),
  minGapDays = 1,
  minShared = 2,
  minScore = 0.10,
  maxScore = 0.55,
  candidates = 60,
  maxPairs = 240,
  rng = Math.random,
} = {}) {
  const usable = (items || [])
    .filter((item) => item && String(item.text || '').trim().length >= 6 && Number.isFinite(Number(item.at)))
    .map((item) => ({ ...item, at: Number(item.at), grams: bigrams(item.text) }))
    .filter((item) => item.grams.size >= 3 && item.at <= now);

  if (usable.length < 2) return null;

  // 记忆多的时候随机抽样，避免 O(n²) 把定时器拖住，也避免总是那几条老记忆被选中。
  const pool = usable.length > candidates ? shuffle(usable, rng).slice(0, candidates) : usable;
  const minGapMs = minGapDays * 86400000;
  const pairs = [];

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const gapMs = Math.abs(pool[i].at - pool[j].at);
      if (gapMs < minGapMs) continue;
      let inter = 0;
      const shared = [];
      for (const gram of pool[i].grams) {
        if (pool[j].grams.has(gram)) {
          inter += 1;
          if (shared.length < 4) shared.push(gram);
        }
      }
      if (inter < minShared) continue;
      const union = pool[i].grams.size + pool[j].grams.size - inter;
      const score = union ? inter / union : 0;
      if (score < minScore || score > maxScore) continue;
      pairs.push({
        a: pool[i],
        b: pool[j],
        shared,
        score,
        gapMs,
        gapDays: Math.round(gapMs / 86400000),
      });
      if (pairs.length >= maxPairs) break;
    }
    if (pairs.length >= maxPairs) break;
  }

  if (!pairs.length) return null;

  // 优先挑时间隔得更开、共同点更实的；同档位里随机，避免每次都是同一对。
  const best = Math.max(...pairs.map((pair) => pair.gapDays));
  const strong = pairs.filter((pair) => pair.gapDays >= best * 0.6 && pair.shared.length >= minShared);
  const bag = strong.length ? strong : pairs;
  const picked = bag[Math.floor(rng() * bag.length)];
  return {
    a: { id: picked.a.id, text: picked.a.text, at: picked.a.at },
    b: { id: picked.b.id, text: picked.b.text, at: picked.b.at },
    shared: picked.shared,
    score: Number(picked.score.toFixed(3)),
    gapDays: picked.gapDays,
  };
}

function shortDate(at, timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(at));
  } catch (err) {
    const d = new Date(at);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
}

/** 把选中的一对接线成给她看的一句话。 */
export function buildAssociativeHint(pair, { timeZone = 'Asia/Shanghai', maxChars = 60 } = {}) {
  if (!pair) return null;
  const cut = (text) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;
  };
  return [
    '【突然想到】你脑子里同时浮起两件事，它们之间有一根线：',
    `- ${shortDate(pair.a.at, timeZone)}：${cut(pair.a.text)}`,
    `- ${shortDate(pair.b.at, timeZone)}：${cut(pair.b.text)}`,
    `共同的线：${pair.shared.slice(0, 3).join('、')}`,
    '这两件事是你自己的记忆，不是对方刚说的。要不要顺着这条线开口，你自己决定；决定说就用一句自然的开场，别把上面这两行念出来。',
  ].join('\n');
}
