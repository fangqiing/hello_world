/**
 * STEP 34 - 好恶沉淀（纯函数 + 轻存储）
 *
 * 问题：人设里写着「喜欢什么、讨厌什么」，但那是文案，不是她长出来的。
 *       真人聊三个月会多出新喜好，也会腻掉旧的。她的偏好是静止的。
 * 定案：从她自己说过的话里抽「我喜欢 X」「受不了 Y」这类明确表述，沉淀成表，
 *       带次数、置信度和时间衰减。重复出现的才算稳定偏好，随口一句不算。
 *
 * 三条纪律：
 *   ① 只认明确句式。反问、假设、引用别人的话都不算（"你是不是喜欢X"不是她的偏好）。
 *   ② 一次不算数。同一对象至少出现两次，置信度才过线。
 *   ③ 长期不提要降温。半衰期 30 天，否则三年前的随口一句会永远挂在她嘴边。
 */

const HALF_LIFE_DAYS = 30;
const DAY = 86400000;

export const PREFERENCE_DDL = `
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  peer_id TEXT,
  scope TEXT NOT NULL DEFAULT 'self',
  target TEXT NOT NULL,
  polarity REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  conflict INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  first_at INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pref_target ON preferences(scope, peer_id, target);
`;

/** 明确句式 → 极性。顺序有讲究：否定的要排在肯定前面，否则「不喜欢」会被「喜欢」先吃掉。
 *  主语「我」可选 —— 实际对话里省略主语极常见（「还是喜欢下雨天」），
 *  调用方只喂她自己的发言，所以无主语也归属她。 */
const PATTERNS = [
  { re: /(?:我)?(?:很|最|特别|超|挺)?(?:不喜欢|讨厌|烦|受不了|忍不了|吃不消)([^，。！？,.!?\n]{1,20})/g, polarity: -0.7 },
  { re: /(?:我)?(?:最|很|特别|有点)?怕([^，。！？,.!?\n]{1,20})/g, polarity: -0.55 },
  { re: /(?:我)?(?:很|最|特别|超|挺)?(?:喜欢|偏爱|中意)([^，。！？,.!?\n]{1,20})/g, polarity: 0.7 },
  { re: /(?:我)?(?:最|就)?想要([^，。！？,.!?\n]{1,20})/g, polarity: 0.4 },
];

/** 反问 / 假设 / 转述 / 泛指：这些句子里出现「喜欢」不代表她的偏好。 */
const NOT_MINE = [
  /你是不是|你有没有|你喜不喜欢|你会不会|要是你|如果你|你想不想/,
  /他说|她说|有人说|别人说|他们说|听说/,
  /什么|为什么|怎么|哪[个里种]/,
  /吗[？?]?|呢[？?]?/,
];

const TAIL_NOISE = /[了的啊吧呢嘛呀哈哦噢]+$/;

export function normalizeTarget(raw) {
  let text = String(raw || '').replace(/^[的地得]+/, '').trim();
  text = text.replace(/[，。！？、,.!?；;：:「」“”"'（）()\s]+$/g, '');
  text = text.replace(TAIL_NOISE, '');
  text = text.trim();
  if (text.length < 2 || text.length > 20) return '';
  return text;
}

/**
 * 从一段话里抽偏好。返回 [{target, polarity, evidence}]。
 * 只处理「她说的」，调用方负责别把对方的话传进来。
 */
export function extractPreferences(text) {
  const source = String(text || '');
  if (!source || source.length < 4) return [];
  if (NOT_MINE.some((re) => re.test(source))) return [];

  const found = new Map();
  for (const { re, polarity } of PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match) {
      const target = normalizeTarget(match[1]);
      if (target && !found.has(target)) {
        found.set(target, { target, polarity, evidence: match[0].trim() });
      }
      match = re.exec(source);
    }
  }
  return [...found.values()];
}

/** 时间衰减：30 天减半，返回 0.1~1。 */
export function recencyWeight(lastAt, now = Date.now()) {
  const age = Math.max(0, now - Number(lastAt || 0));
  if (!Number.isFinite(age)) return 0.1;
  return Math.max(0.1, Math.pow(0.5, age / (HALF_LIFE_DAYS * DAY)));
}

/**
 * 合并一条新观测到已有偏好上。
 * 已有记录形如 {target, polarity, hits, confidence, last_at}。
 */
export function mergePreference(existing, incoming, at = Date.now()) {
  if (!incoming || !incoming.target) return existing;
  if (!existing) {
    return {
      target: incoming.target,
      polarity: incoming.polarity,
      hits: 1,
      confidence: 0.3,
      first_at: at,
      last_at: at,
      reason: incoming.evidence || '',
      conflict: 0,
    };
  }
  const hits = Number(existing.hits || 0) + 1;
  const prior = Number(existing.polarity || 0);
  const next = Number(incoming.polarity || 0);
  // 同向加强，反向削弱：不是简单平均，否则「喜欢」说三次、「不喜欢」说一次会变成中性。
  const sameSide = prior === 0 || Math.sign(prior) === Math.sign(next);
  let polarity = sameSide
    ? (prior * (hits - 1) + next) / hits
    : prior * 0.75 + next * 0.25;
  polarity = Math.max(-1, Math.min(1, polarity));
  return {
    ...existing,
    polarity,
    hits,
    confidence: Math.min(1, 0.3 + 0.12 * hits),
    last_at: at,
    conflict: sameSide ? Number(existing.conflict || 0) : Number(existing.conflict || 0) + 1,
    reason: incoming.evidence || existing.reason || '',
  };
}

/** 稳定性：次数、置信度、新鲜度三者相乘。没过线的进不了 prompt。 */
export function stability(pref, now = Date.now()) {
  const hits = Number(pref.hits || 0);
  if (hits < 2) return 0;
  const conf = Number(pref.confidence || 0);
  const rec = recencyWeight(pref.last_at, now);
  let score = Math.abs(Number(pref.polarity || 0)) * conf * rec;
  if (Number(pref.conflict || 0) > 0) score *= 0.6;
  return score;
}

export function rankPreferences(prefs, { now = Date.now(), minScore = 0.18, limit = 6 } = {}) {
  return (prefs || [])
    .map((pref) => ({ ...pref, score: stability(pref, now) }))
    .filter((pref) => pref.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 注入块。分正负两栏，比混着列更像人自己理过的想法。
 * 没有过线的偏好时返回 null —— 宁可不说，也不拿一次性的随口话当性格。
 */
export function buildPreferenceBlock(prefs, { now = Date.now(), limit = 6 } = {}) {
  const top = rankPreferences(prefs, { now, limit });
  if (!top.length) return null;
  const likes = top.filter((p) => p.polarity > 0).map((p) => p.target);
  const dislikes = top.filter((p) => p.polarity < 0).map((p) => p.target);
  const lines = ['【你自己的好恶】这些是你自己攒出来的，不是别人给你的设定：'];
  if (likes.length) lines.push(`- 喜欢：${likes.slice(0, 5).join('、')}`);
  if (dislikes.length) lines.push(`- 不喜欢：${dislikes.slice(0, 5).join('、')}`);
  lines.push('（相关的时候自然带一句，不相关就别硬塞。别把这张单子念出来。）');
  return lines.join('\n');
}
