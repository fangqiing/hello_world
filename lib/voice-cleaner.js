import { applyAiTells } from './voice-rules.js'
import { soften } from './voice-poetic.js'
import { applyStyle, LENGTH_BANDS } from './voice-style.js'
import { humanizeRepair } from './voice-repair.js'
import { joinShortAck } from './voice-ack.js'
import { splitBubbles } from './voice-bubbles.js'

export { splitBubbles, splitBubblesArray, trimAtSentence } from './voice-bubbles.js'

/**
 * STEP 15 - 说话去人机化（纯函数流水线）
 *
 * 借鉴《20-说话去人机化》：提示词只能压制，代码才是保险。
 * 这是「代码侧」的保险层，按顺序清洗模型输出；提示词侧的规则另见 00-OVERVIEW。
 *
 * 适配微信私聊（不是 QQ 群）：
 *  - 不删信息性状态（除非明显是没人问的自述）
 *  - 技术词默认保留（她常和网安学生聊技术，装傻会更假）
 *  - 字数上限 80（一屏能读完），最多两条；超过条数合并，不静默丢
 */

export const DEFAULTS = {
  maxChars: 80,
  maxQuestions: 1,
  dropPeriods: true,          // 中文句号改换行/直接去掉
  loosePunct: true,           // 随机漏一个标点
  stripParens: true,          // 去（动作）括号
  stripEmojiRuns: true,       // 连续 emoji 只留一个
  maxBubbles: 2,
  splitThreshold: 24,         // 超过这个长度才考虑拆条
  techWords: true,            // true = 不把技术词换成装傻
  poeticEnabled: true,        // STEP 21: 删无功能开头景，比喻只标记
  maxMetaphor: 1,
  styleEnabled: false,        // STEP 22: 频道发送时显式开；纯函数默认不动长度
  styleTypoRate: 0,
  repairHumanize: true,       // STEP 24: 「我不理解，请再试一次」→「你再说一遍」
  ackMerge: true,             // STEP 25: 「嗯\n测出啥了」→「嗯，测出啥了」
  ackMaxJoinLen: 40,          // 后文超过这个长度就删掉应答词
  ackMaxLen: 3,
  seed: 7,
};

// 客服腔起手 / 结尾
const SOCIAL_OPEN = [
  /^(晚上好|早上好|中午好|下午好|嗨|哈喽)[呀啊哦~～]?[，,、\s]*/i,
  /^(好的|收到|明白|了解)[，,。！!\s]*/,
];
// 把话题抛回去（可以出现在句中，不只句尾）
const THROW_BACK = [
  /[，,。！!\s]*你呢[，,]?[^。！!？?]{0,12}[？?]/g,
  /[，,。！!\s]*你觉得呢[？?]?/g,
];

const SOCIAL_TAIL = [
  /[，,。\s]*(你呢|在干嘛|在做什么)[？?]?\s*$/,
  /[，,。\s]*(希望|但愿)(能)?(对你)?(有)?(所)?帮助[。!！]?\s*$/,
  /[，,。\s]*(还有|如果)(需要|什么)(我)?(可以)?(帮你|问我)[^。！!？?]*[。!！？?]?\s*$/,
  /[，,。\s]*有什么(可以|能)(帮|为)你的?[^。！!？?]*[。!？?]?\s*$/,
];

// 书面/傲娇腔 → 更口语
const BOOKISH = [
  [/然而/g, '不过'],
  [/此外/g, '还有'],
  [/因此/g, '所以'],
  [/综上(所述)?[，,]?/g, ''],
  [/首先[，,]?/g, ''],
  [/其次[，,]?/g, ''],
  [/另外[，,]?/g, ''],
  [/总之[，,]?/g, ''],
  [/总的来说[，,]?/g, ''],
  [/值得注意的是[，,]?/g, ''],
  [/不难发现[，,]?/g, ''],
  // 只删「作为一个 AI，」这一小段，不能贪心到句号（否则整句会被吃掉）
  [/作为一个?(AI|人工智能|语言模型)[，,、]?/gi, ''],
  [/我是(一个)?(AI|人工智能|语言模型)[，,、]?/gi, ''],
];

// 自我指代第三人称（把「她」当自己说）
const SELF_THIRD = [
  [/她(觉得|认为|想说)/g, '我$1'],
];

// AI 痕迹
const AI_ARTIFACTS = [
  /^(回复|回答|输出)[：:]\s*/,
  /^「[\s\S]*」\s*$/,
  /\s*→\s*/g,
  /\[(AT|CQ):[^\]]*\]/gi,
];

function rnd(seedRef) {
  // 简单可复现伪随机
  seedRef.s = (seedRef.s * 1664525 + 1013904223) >>> 0;
  return seedRef.s / 4294967296;
}

/** 1. 删客服腔起手/结尾 */
export function stripSocialCrutch(text) {
  let s = String(text || '');
  for (const re of SOCIAL_OPEN) s = s.replace(re, '');
  for (const re of THROW_BACK) s = s.replace(re, '');
  for (const re of SOCIAL_TAIL) s = s.replace(re, '');
  return s.replace(/^[，,。\s]+/, '').trim();
}

/** 2. 书面腔 → 口语 */
export function stripBookish(text) {
  let s = String(text || '');
  for (const [re, rep] of BOOKISH) s = s.replace(re, rep);
  for (const [re, rep] of SELF_THIRD) s = s.replace(re, rep);
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** 3. 技术词处理：默认保留；只把「token/OK」这类无意义夹杂换掉 */
export function deTech(text, { techWords = true } = {}) {
  if (techWords) return String(text || '');
  return String(text || '').replace(/\b(token|prompt|API)\b/gi, '那个');
}

/** 4. 去英文夹杂（只处理语气词式的英文） */
export function deEnglish(text) {
  return String(text || '')
    .replace(/\bOK\b/gi, '行')
    .replace(/\bokay\b/gi, '行')
    .replace(/\bthanks?\b/gi, '谢了');
}

/** 5. AI 痕迹：前缀、箭头、引用标记 */
export function cleanAiArtifacts(text) {
  let s = String(text || '');
  for (const re of AI_ARTIFACTS) s = s.replace(re, '');
  return s.trim();
}

/** 6. 只留 N 个问号 */
export function limitQuestions(text, max = 1) {
  const s = String(text || '');
  let seen = 0;
  return s.replace(/[？?]/g, (m) => {
    seen += 1;
    return seen <= max ? m : '，';
  });
}

/** 7. 去括号（含动作描写、颜文字） */
export function stripParens(text) {
  return String(text || '')
    .replace(/[（(][^）)]{0,20}[）)]/g, '')
    .replace(/[【\[][^】\]]{0,10}[】\]]/g, '')
    .replace(/[（(]/g, '')
    .trim();
}

/** 8. 长度：按句子边界截断，不硬切半个词 */
export function shorten(text, max = 60) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'));
  return (cut > max * 0.5 ? head.slice(0, cut) : head).trim();
}

/** 9. 标点放松：去句号、随机漏一个逗号 */
export function loosePunct(text, seedRef = { s: DEFAULTS.seed }, { dropPeriods = true, loosePunct = true } = {}) {
  let s = String(text || '');
  if (dropPeriods) s = s.replace(/。/g, '\n');
  if (loosePunct) {
    const commas = [...s.matchAll(/，/g)].map(m => m.index);
    if (commas.length) {
      const i = commas[Math.floor(rnd(seedRef) * commas.length)];
      s = s.slice(0, i) + ' ' + s.slice(i + 1);
    }
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 10. 连续 emoji 收成一个 */
export function stripEmojiRuns(text) {
  return String(text || '').replace(/([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])\1+/gu, '$1');
}

/**
 * 11. 拆条：条数上限用合并实现，不静默丢弃。
 * 具体逻辑在 voice-bubbles.js；这里保留旧导出名，返回 { bubbles, dropped }。
 */

function bandFrom(value) {
  if (!value) return null
  if (typeof value === 'object' && value.key) return value
  return LENGTH_BANDS.find((band) => band.key === String(value)) || null
}

/**
 * 全流水线。返回 { bubbles: string[], text: string, changed: boolean, dropped: string }
 * 顺序参考《20-说话去人机化》§3，STEP 22 再接在拆条之前。
 */
export function cleanVoice(input, config = {}, ctx = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const seedRef = { s: cfg.seed };
  let s = String(input || '').trim();
  const before = s;
  let poetic = null;
  let style = null;
  let ack = null;

  // STEP 24: 机器式「无法识别指令」先换成人话，再走后面的清洗。
  if (cfg.repairHumanize !== false) s = humanizeRepair(s);
  s = cleanAiArtifacts(s);
  // STEP 18: run structural ai-tells before the bookish dictionary turns
  // 「此外」into「还有」 (which would leave a dangling fragment).
  if (cfg.aiTells !== false) s = applyAiTells(s, cfg.aiTells || {}).text;
  // 先去括号：否则「（揉了揉眼睛）好的」里「好的」不在句首，删不掉
  if (cfg.stripParens) s = stripParens(s);
  s = stripSocialCrutch(s);
  s = stripBookish(s);
  // STEP 21: 只删开头无功能景，保留有对象/承情的比喻
  if (cfg.poeticEnabled !== false) {
    poetic = soften(s, { maxMetaphor: cfg.maxMetaphor });
    s = poetic.text;
  }
  s = deTech(s, cfg);
  s = deEnglish(s);
  s = limitQuestions(s, cfg.maxQuestions);
  if (cfg.stripEmojiRuns) s = stripEmojiRuns(s);

  // STEP 22: 先定长度档，再拆条。纯函数默认不动长度，频道发送显式开启。
  const styleOn = cfg.styleEnabled === true || Boolean(ctx.band);
  if (styleOn && s.trim()) {
    const explicitBand = bandFrom(ctx.band || cfg.styleBand);
    const applied = applyStyle(s, {
      band: explicitBand,
      // 没有显式档位时只做语气/emoji 约束；随机档位截断成品会静默丢后半句。
      fit: ctx.fitLength === true || Boolean(explicitBand),
      emojiCtx: ctx.emojiCtx || cfg.emojiCtx || {},
      typoRate: Math.max(0, Math.min(0.05, Number(ctx.typoRate ?? cfg.styleTypoRate) || 0)),
      rand: typeof ctx.rand === 'function' ? ctx.rand : Math.random,
    });
    s = applied.text;
    style = applied;
  }

  // STEP 25: 「嗯\n测出啥了」这种应答词单独起一行，在插入换行前压回一句。
  let ackApplied = false;
  if (cfg.ackMerge !== false && s.trim()) {
    ack = joinShortAck(s, {
      maxAckLen: cfg.ackMaxLen,
      maxJoinLen: cfg.ackMaxJoinLen,
    });
    s = ack.text;
    ackApplied = ack.joined || ack.droppedAck;
  }

  s = loosePunct(s, seedRef, cfg);

  // loosePunct 可能把句号换成换行、或把逗号换成空格；再压一次，
  // 保证「嗯，测出啥了」不会重新断成两段。诊断字段不被第二次覆盖。
  if (cfg.ackMerge !== false && s.trim()) {
    const again = joinShortAck(s, {
      maxAckLen: cfg.ackMaxLen,
      maxJoinLen: cfg.ackMaxJoinLen,
    });
    if (again.joined || again.droppedAck) {
      s = again.text;
      if (!ackApplied) ack = again;
    }
  }

  // STEP 20: 不在拆条前截断整段文本；只对单条超过硬上限的部分截，并交回 dropped。
  const split = splitBubbles(s, cfg);
  const bubbles = split.bubbles;
  return {
    bubbles,
    text: bubbles.join('\n'),
    changed: bubbles.join('\n') !== before,
    dropped: split.dropped,
    poetic,
    style,
    ack,
  };
}
