/**
 * STEP 35 - 意见演化（纯函数 + 轻存储）
 *
 * 问题：原则会演化，但对具体事的看法不会。「那部电影好看吗」问两次，答案趋同。
 *       真人不是这样：会改主意，而且记得自己以前怎么想 ——「我原来觉得不行，后来改口了」。
 * 定案：对具体话题存一个带时间戳的立场，变了就压一条历史。下次聊到同一件事，
 *       她知道自己站在哪儿，也知道自己是从哪儿挪过来的。
 *
 * 三条纪律：
 *   ① 小波动不算改主意。delta < 0.25 只更新数值不留历史，否则记录全是噪声。
 *   ② 只有强句式才抽取。「我觉得 X 还行」算，「X 应该不差吧」不算。
 *   ③ 相关才注入。聊天气时别把对电影的旧立场塞进来，那是干扰不是记性。
 */

const SHIFT_THRESHOLD = 0.25;

export const STANCE_DDL = `
CREATE TABLE IF NOT EXISTS stances (
  id TEXT PRIMARY KEY,
  peer_id TEXT,
  topic TEXT NOT NULL,
  polarity REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.4,
  reason TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stances_topic ON stances(peer_id, topic);
CREATE TABLE IF NOT EXISTS stance_history (
  id TEXT PRIMARY KEY,
  stance_id TEXT NOT NULL,
  polarity REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  changed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stance_history ON stance_history(stance_id, changed_at);
`;

/** 评价词 → 极性。放在话题后面，说明「怎么看」。 */
const POSITIVE = /(挺好|不错|好看|好听|有意思|值得|喜欢|靠谱|舒服|厉害|行得通)/;
const NEGATIVE = /(没意思|一般|不行|难看|难听|糟糕|离谱|不值|受不了|差劲|挺烂|很烂)/;

/** 强句式：我(觉得|认为|感觉) X 评价词。要求评价词紧跟在 12 字以内。 */
const STRONG = [
  /我(?:一直)?(?:觉得|认为|感觉|看)([^，。！？,.!?\n]{1,16}?)(挺好|不错|好看|好听|有意思|值得|靠谱|舒服|厉害|行得通)/,
  /我(?:一直)?(?:觉得|认为|感觉|看)([^，。！？,.!?\n]{1,16}?)(没意思|一般|不行|难看|难听|糟糕|离谱|不值|差劲|挺烂|很烂)/,
  /([^，。！？,.!?\n]{1,16}?)(?:其实|确实|真的)(挺好|不错|有意思|不行|没意思|一般|差劲)/,
];

const FILLER = /^(?:这个|那个|这件事|那件事|它|他|她|其实|说实话|讲真)/;

export function normalizeTopic(raw) {
  let text = String(raw || '').trim();
  text = text.replace(FILLER, '');
  text = text.replace(/[的地得]$/, '');
  text = text.replace(/[，。！？、,.!?；;：:「」“”"'（）()\s]+$/g, '').trim();
  if (text.length < 2 || text.length > 24) return '';
  return text;
}

/**
 * 从一句话里抽立场。返回 [{topic, polarity}]，通常 0 或 1 条。
 * 保守：宁可漏，不可错 —— 错的立场会让她坚信自己没说过的话。
 */
export function extractStance(text) {
  const source = String(text || '');
  if (!source) return [];
  for (const re of STRONG) {
    const match = re.exec(source);
    if (!match) continue;
    const topic = normalizeTopic(match[1]);
    if (!topic) continue;
    const verdict = match[2];
    const polarity = POSITIVE.test(verdict) ? 0.65 : NEGATIVE.test(verdict) ? -0.65 : 0;
    if (!polarity) continue;
    return [{ topic, polarity, evidence: match[0].trim() }];
  }
  return [];
}

/** 变化是否够大，够大才写历史（否则只是同一立场又说了一遍）。 */
export function shouldShift(current, next, { threshold = SHIFT_THRESHOLD } = {}) {
  if (!current) return false;
  return Math.abs(Number(next || 0) - Number(current.polarity || 0)) >= threshold;
}

function direction(value) {
  const v = Number(value || 0);
  if (v >= 0.35) return '正面';
  if (v <= -0.35) return '负面';
  return '说不清';
}

/**
 * 应用一次观测。返回 {stance, history}，history 为 null 表示只是更新不算改主意。
 * current 形如 {id, topic, polarity, confidence, hits, first_at, updated_at, reason}。
 */
export function applyStance(current, incoming, { at = Date.now(), id = null } = {}) {
  if (!incoming || !incoming.topic) return { stance: current, history: null };

  if (!current) {
    return {
      stance: {
        id: id || `st_${at.toString(36)}`,
        topic: incoming.topic,
        polarity: incoming.polarity,
        confidence: 0.4,
        hits: 1,
        first_at: at,
        updated_at: at,
        reason: incoming.evidence || '',
      },
      history: null,
    };
  }

  const hits = Number(current.hits || 0) + 1;
  const prior = Number(current.polarity || 0);
  const next = Number(incoming.polarity || 0);
  const shifted = shouldShift(current, next);
  const polarity = shifted ? next : (prior * (hits - 1) + next) / hits;

  const stance = {
    ...current,
    polarity: Math.max(-1, Math.min(1, polarity)),
    confidence: Math.min(1, Number(current.confidence || 0.4) + (shifted ? -0.1 : 0.08)),
    hits,
    updated_at: at,
    reason: incoming.evidence || current.reason || '',
  };

  const history = shifted
    ? {
      id: `sh_${at.toString(36)}`,
      stance_id: current.id,
      polarity: prior,
      confidence: Number(current.confidence || 0.4),
      reason: current.reason || '',
      changed_at: at,
      from: direction(prior),
      to: direction(polarity),
    }
    : null;

  return { stance, history };
}

function grams(text) {
  const s = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 只在当前话题相关时挑出立场，避免把旧立场当记性到处撒。 */
export function relatedStances(query, stances, { limit = 3, minOverlap = 1 } = {}) {
  const q = grams(query);
  if (!q.size) return [];
  const scored = [];
  for (const stance of stances || []) {
    const t = grams(stance.topic);
    if (!t.size) continue;
    let overlap = 0;
    for (const g of t) if (q.has(g)) overlap += 1;
    if (overlap >= minOverlap) scored.push({ stance, overlap });
  }
  return scored
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((item) => item.stance);
}

/**
 * 注入块。带「改过口」的立场会多一句说明 —— 这是最容易让人觉得她像人的地方，
 * 因为她有前后，而不是每次都给出同一个答案。
 */
export function buildStanceBlock(stances, { historyByStance = {}, limit = 3 } = {}) {
  const list = (stances || []).slice(0, limit);
  if (!list.length) return null;
  const lines = ['【你对一些事的看法】'];
  for (const stance of list) {
    const now = direction(stance.polarity);
    const history = (historyByStance[stance.id] || []).slice(-1)[0];
    if (history && history.from !== now) {
      lines.push(`- ${stance.topic}：现在觉得${now}，原先觉得${history.from}${history.reason ? `（${history.reason}）` : ''}`);
    } else {
      lines.push(`- ${stance.topic}：${now}`);
    }
  }
  lines.push('（聊到这些事的时候可以按上面的立场说话。改过口的可以自然提一句「我原来不这么想」。）');
  return lines.join('\n');
}
