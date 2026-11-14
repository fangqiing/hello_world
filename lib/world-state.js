/**
 * STEP 37 - 世界状态（纯函数 + 轻存储）
 *
 * 问题：她住在一个世界里，但那个世界是静态的。问「今天怎么样」，她只能谈心情，
 *       谈不了日子 —— 因为没有「今天」这个东西。
 * 定案：每天滚一次世界状态（季节、天气、她那天在做什么），存下来，注入给她。
 *       同一天多次调用必须给出同一个结果，否则她会在半小时内说两遍不同的天气。
 *
 * 两个设计取舍：
 *   ① 不调模型。用「日期做种子的确定性伪随机 + 天气转移矩阵」生成，零 token 成本。
 *   ② 不绑死人设。词表只提供抽象维度（天气/状态），不提"海面""船舱"，
 *      因为她的世界是她自己定的，换个人设这个模块照样能用。
 */

export const WORLD_DDL = `
CREATE TABLE IF NOT EXISTS world_state (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL DEFAULT 'default',
  date TEXT NOT NULL,
  season TEXT NOT NULL DEFAULT '',
  weather TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_world_date ON world_state(world_id, date);
`;

/** FNV-1a，用来把「世界 + 日期」稳定映射成种子。 */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  const str = String(text || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：小、快、够均匀，且同种子必然同序列。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seasonOf(dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7));
  if (!month) return '';
  if (month >= 3 && month <= 5) return '春天';
  if (month >= 6 && month <= 8) return '夏天';
  if (month >= 9 && month <= 11) return '秋天';
  return '冬天';
}

/** 天气转移：列是今天，行是昨天的概率分布。让天气有惯性别每天跳。 */
const WEATHER = ['晴', '阴', '雨', '雾'];
const TRANSITION = {
  晴: [0.5, 0.3, 0.15, 0.05],
  阴: [0.3, 0.4, 0.25, 0.05],
  雨: [0.2, 0.4, 0.35, 0.05],
  雾: [0.25, 0.4, 0.05, 0.3],
};

const ACTIVITY = [
  '醒得早，天亮之前就醒了',
  '睡得沉，起来的时候有点懵',
  '收拾了一会儿旧东西，翻出一件早忘了的',
  '什么也没干，就坐着',
  '想起一个人，想了一半又放下了',
  '把之前没看完的东西看完了',
  '出门走了一圈，没走远',
  '一直惦记着一件事，没等到消息',
  '把住处从头到尾整理了一遍',
  '莫名有点高兴，也说不上为什么',
  '睡得很晚，下午才真正醒过来',
  '手上做着事，脑子里在别处',
  '把一件拖了很久的小事做完了',
  '听了一会儿外面的动静',
  '没怎么说话，一天就过去了',
];

function pickWeighted(list, weights, rng) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < list.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * 生成某一天的世界状态。确定性：同 date + worldId 必得同结果。
 *
 * @param {{date:string, worldId?:string, prevWeather?:string|null, note?:string}} args
 */
export function rollWorld({ date, worldId = 'default', prevWeather = null, note = '' } = {}) {
  if (!date) return null;
  const rng = mulberry32(hashSeed(`${worldId}@${date}`));
  const weather = prevWeather && TRANSITION[prevWeather]
    ? pickWeighted(WEATHER, TRANSITION[prevWeather], rng)
    : WEATHER[Math.floor(rng() * WEATHER.length)];
  const activity = ACTIVITY[Math.floor(rng() * ACTIVITY.length)];
  return {
    id: `${worldId}:${date}`,
    worldId,
    date,
    season: seasonOf(date),
    weather,
    activity,
    note: String(note || ''),
  };
}

/** 前置一天：把 2026-11-14 减一天，用于补历史。 */
export function previousDate(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms - 86400000);
  return d.toISOString().slice(0, 10);
}

function monthDay(dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7));
  const day = Number(String(dateStr || '').slice(8, 10));
  if (!month || !day) return '';
  return `${month} 月 ${day} 日`;
}

/**
 * 注入块。控制在一行半以内 —— 世界状态是背景，不是主菜。
 * 明令不许主动汇报，否则她会每天开场播报天气。
 */
export function buildWorldBlock(state, { timeZone = 'Asia/Shanghai' } = {}) {
  if (!state || !state.date) return null;
  void timeZone;
  const parts = [`${monthDay(state.date)}`, state.season].filter(Boolean).join('，');
  const weather = state.weather ? `外面${state.weather}着` : '';
  const activity = state.activity ? `你今天${state.activity}` : '';
  const line = [parts, weather, activity].filter(Boolean).join('。');
  return `【今天】${line}。\n（这是你自己的日子。被问到就自然说，别一开场就汇报天气。）`;
}
