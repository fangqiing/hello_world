/**
 * STEP 22 - 风格规则的代码侧（纯函数）
 *
 * 分工：
 *   能确定性判定的 → 代码强制（长度档、结尾语气词、emoji 开关）
 *   只能靠语感的 → 写进 persona（不客气、调侃、梗、直说不懂）
 *   纯形容词的 → 必须转成行为描述（「向往自由」写进 prompt 只会得到一句假大空）
 *
 * 这里的函数不做「文采」，只做「约束」。
 */

/** 长度档：权重决定大部分回复应该多短。 */
export const LENGTH_BANDS = [
  { key: 'tiny', max: 8, weight: 0.50 },   // 「嗯」「行」「没有」
  { key: 'short', max: 30, weight: 0.28 },
  { key: 'mid', max: 80, weight: 0.16 },
  { key: 'long', max: 150, weight: 0.06 },
];

export function pickBand(rand = Math.random) {
  const r = rand();
  let acc = 0;
  for (const b of LENGTH_BANDS) {
    acc += b.weight;
    if (r <= acc) return b;
  }
  return LENGTH_BANDS[LENGTH_BANDS.length - 1];
}

/**
 * 在句子边界截断。
 * 原则：**宁可超一点，也不能截出半句**——「我觉得这个方案挺」比长一点更假。
 * 找不到任何标点就不截（说明是一整句话，切开就废了）。
 */
function cutAtSentence(text, max) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, cut: false };

  const head = s.slice(0, max);
  let p = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('，'), head.lastIndexOf('\n'));

  if (p < max * 0.4) {
    // 限定范围内没有合适切点，退到第一个标点（哪怕超出 max 一点）
    const m = s.match(/[。！？，\n]/);
    if (!m) return { text: s, cut: false };   // 整句无标点，不切
    p = m.index;
  }
  if (p <= 0) return { text: s, cut: false };
  return { text: s.slice(0, p + 1).trim(), cut: true };
}

/**
 * 按档位收长度。
 * 注意：**只截不补**。模型写短了就短了，不能为了凑档位硬加内容——那是另一种假。
 */
export function fitLength(text, band) {
  const b = band || LENGTH_BANDS[1];
  const r = cutAtSentence(text, b.max);
  return { text: r.text, cut: r.cut, band: b.key };
}

// 结尾语气词：呢 / 耶 / ~
const TRIM_TAIL = /[呢耶]+([。！？!?]?)$/;
const TRIM_TILDE = /[~～]+([。！？!?]?)$/;

/** 删句尾的「呢」「耶」「~」，保留标点。 */
export function stripTrailingParticles(text) {
  let s = String(text || '').trimEnd();
  let removed = false;
  // 「呢~」这种组合要跑两轮：先删 ~，再删 呢，还要回来看有没有新尾巴
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(TRIM_TILDE, (m, p) => { removed = true; return p || ''; });
    s = s.replace(TRIM_TAIL, (m, p) => { removed = true; return p || ''; });
    if (s === before) break;
  }
  return { text: s.trim(), removed };
}

/** 统计语气词（判断「太多」） */
export function countParticles(text) {
  const s = String(text || '');
  const hits = s.match(/[呢耶呀啦哦噢嘛哈]/g) || [];
  return { total: hits.length, perHundred: Math.round((hits.length / Math.max(1, s.length)) * 100) };
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

export function hasEmoji(text) {
  return (String(text || '').match(EMOJI) || []).length;
}

/**
 * emoji 什么时候允许：
 *  - 对方先用了
 *  - 连着聊了几轮且气氛正向
 *  - 情绪起伏明显
 * 都不满足 → 一个都不带。
 */
export function emojiAllowed(ctx = {}) {
  if (Number(ctx.userEmoji) > 0) return true;
  if (Number(ctx.rounds) >= 3 && ctx.positive === true) return true;
  if (Number(ctx.moodVariance) > 0.3) return true;
  // 情绪明显时放行一个表情；平静时不主动用。
  const m = ctx.mood || {};
  if (Math.abs(Number(m.valence || 0)) > 0.45) return true;
  if (Number(m.arousal ?? 0.3) > 0.7) return true;
  return false;
}

/** 不允许就全删；允许只留一个。 */
export function applyEmojiPolicy(text, ctx = {}) {
  const s = String(text || '');
  const n = hasEmoji(s);
  if (!n) return { text: s, removed: 0 };
  if (!emojiAllowed(ctx)) {
    return { text: s.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim(), removed: n };
  }
  let kept = 0;
  const out = s.replace(EMOJI, (m) => {
    kept += 1;
    return kept === 1 ? m : '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { text: out, removed: n - Math.min(1, n) };
}

/**
 * 口误：低概率。只做「最不伤信息」的一种——重复一个字的尾音，或吞掉一个逗号。
 * 默认关闭（rate=0）；开了也不要超过 0.05，否则像坏了。
 */
export function maybeTypo(text, rand = Math.random, rate = 0) {
  const s = String(text || '');
  if (!s || rate <= 0 || rand() > rate) return { text: s, typo: false };
  // 优先吞一个逗号；没有逗号就重复最后一个字
  if (s.includes('，')) {
    const idx = s.indexOf('，');
    return { text: s.slice(0, idx) + s.slice(idx + 1), typo: true };
  }
  if (s.length > 4) {
    const last = s.slice(-1);
    return { text: s.slice(0, -1) + last + last, typo: true };
  }
  return { text: s, typo: false };
}

/**
 * 组合：按档截 → 去结尾语气词 → emoji 策略 → 可选口误。
 *
 * `fit:false` 用于「已经写好的回复」：只做语气/emoji 约束，不按随机档位截断。
 * 生成阶段用 prompt 控长度；对成品再随机截，会静默吃掉后半句。
 */
export function applyStyle(input, { band = null, fit = true, emojiCtx = {}, typoRate = 0, rand = Math.random } = {}) {
  let s = String(input || '');
  const b = band || pickBand(rand);
  const fitResult = fit ? fitLength(s, b) : { text: s, cut: false, band: b.key };
  s = fitResult.text;
  const tail = stripTrailingParticles(s);
  s = tail.text;
  const em = applyEmojiPolicy(s, emojiCtx);
  s = em.text;
  const ty = maybeTypo(s, rand, typoRate);
  s = ty.text;
  return {
    text: s,
    band: fitResult.band,
    cut: fitResult.cut,
    tailRemoved: tail.removed,
    emojiRemoved: em.removed,
    typo: ty.typo,
  };
}
