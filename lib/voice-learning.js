/**
 * STEP 17 - 从聊天里学「怎么说话」（纯函数，带注入式 infer）
 *
 * 三条路，按性价比排：
 *   ① 文风画像（统计，零成本）：从她自己的历史回复里量出句长、标点、emoji 习惯
 *   ② 认可的回复当例子（few-shot，最有效）：你说「就这样说」的那几句，是金标准
 *   ③ 反馈转规则（一次 LLM 调用）：你说「太客气了」→ 变成一条可执行规则，累积
 *
 * 冲突仲裁借鉴 qu-ai-wei 的分级思路：事实与隐私永远压过风格。
 */

export const PRIORITY = {
  FACT: 1,        // 不编造
  PRIVACY: 2,     // 不越权、不跨 peer
  LENGTH_CAP: 3,  // 硬上限
  USER_FEEDBACK: 4,
  STYLE: 5,
  DEFAULT: 6,
};

/** ① 文风画像：只统计，不调用模型。 */
export function buildStyleProfile(samples = []) {
  const texts = (samples || [])
    .map(s => String(typeof s === 'string' ? s : (s && (s.text || s.content)) || '').trim())
    .filter(Boolean);
  if (!texts.length) return null;

  let chars = 0, questions = 0, emojis = 0, commas = 0, periods = 0, short = 0, bubbles = 0;
  const starts = new Map();

  for (const t of texts) {
    chars += t.length;
    questions += (t.match(/[？?]/g) || []).length;
    emojis += (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
    commas += (t.match(/[，,]/g) || []).length;
    periods += (t.match(/[。.]/g) || []).length;
    if (t.length < 12) short += 1;
    bubbles += t.split(/\n+/).filter(Boolean).length;
    const head = t.slice(0, 2);
    starts.set(head, (starts.get(head) || 0) + 1);
  }

  const n = texts.length;
  const avgLen = chars / n;
  const topStarts = [...starts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ head: k, count: v }));

  return {
    samples: n,
    avgLen: Math.round(avgLen),
    shortRatio: +(short / n).toFixed(2),
    questionRate: +(questions / n).toFixed(2),
    emojiRate: +(emojis / n).toFixed(2),
    commaRate: +(commas / Math.max(1, n)).toFixed(2),
    periodRate: +(periods / Math.max(1, n)).toFixed(2),
    avgBubbles: +(bubbles / n).toFixed(1),
    topStarts,
  };
}

/** 把画像写成一段能进 prompt 的话（只给形容词与范围，不给统计表）。 */
export function styleCard(profile) {
  if (!profile) return '';
  const p = profile;
  const lines = [];
  const rawLo = Math.max(6, Math.round(p.avgLen * 0.7));
  const rawHi = Math.max(rawLo + 2, Math.round(p.avgLen * 1.3));
  const hi = Math.min(80, Math.max(8, rawHi));
  const lo = Math.min(hi - 2, Math.max(6, Math.min(rawLo, 40)));
  lines.push(`你平时一条消息大多很短，偶尔说长也大概 ${lo}–${hi} 个字；大多数时候更短。`);
  lines.push('一半的时候只回几个字到一句话；只有真的有事，才说长。');
  if (p.shortRatio >= 0.4) lines.push('有一半的时候你只回一句话，甚至几个字。');
  if (p.periodRate < 0.5) lines.push('你很少用句号，靠换行和停顿断句。');
  if (p.emojiRate < 0.2) lines.push('你几乎不用 emoji。');
  else if (p.emojiRate > 1) lines.push('你会用 emoji，但一条最多一个。');
  if (p.avgBubbles > 1.5) lines.push('偶尔拆成两条发，但不要超过两条。');
  if (p.topStarts.length) lines.push(`你常用「${p.topStarts[0].head}」开头。`);
  // 短不是目的，能读懂才是。没有这条，画像会把「压缩到不成句」当成风格来学。
  lines.push('短要短得能读懂：一句话的主语、宾语该有就有，别省成电报或暗号。省到别人要猜，比多写几个字更糟。');
  return lines.join('');
}

/** ② 挑 few-shot 例子：近期优先，带正反馈的优先。 */
export function pickExamples({ pool = [], max = 3, now = Date.now(), halfLifeDays = 30 } = {}) {
  const scored = (pool || [])
    .filter(e => e && (e.text || e.content))
    .map(e => {
      const t = Number(e.at || e.createdAt || 0);
      const ageDays = Number.isFinite(t) && t > 0 ? Math.max(0, (now - t) / 86400000) : 999;
      const recency = Math.exp(-ageDays / Math.max(1, halfLifeDays));
      const liked = e.liked === true || e.positive === true ? 1 : 0;
      return { entry: e, score: recency * 0.6 + liked * 1.0 };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(x => ({
    text: String(x.entry.text || x.entry.content || ''),
    at: x.entry.at || x.entry.createdAt || null,
  }));
}

/** ③ 反馈 → 规则。常见反馈走模式匹配，认不出的交给注入的 infer。 */
const FEEDBACK_PATTERNS = [
  [/太长|写太多|简短|短一点|别这么长|少说点/, { scope: 'length', directive: '更短', priority: PRIORITY.USER_FEEDBACK }],
  [/太客气|别这么官方|客服|太正式|别客套|别敬语/, { scope: 'tone', directive: '少客套', priority: PRIORITY.USER_FEEDBACK }],
  [/像?\s*AI|机器味|太假|不像人/, { scope: 'tone', directive: '去AI味', priority: PRIORITY.USER_FEEDBACK + 1 }],
  [/emoji|表情/, { scope: 'format', directive: '少用emoji', priority: PRIORITY.USER_FEEDBACK }],
  [/别用问句|别老问|追问/, { scope: 'format', directive: '少反问', priority: PRIORITY.USER_FEEDBACK }],
  [/多点情绪|太冷静|太平了|有点感情/, { scope: 'tone', directive: '带情绪', priority: PRIORITY.USER_FEEDBACK }],
  [/别分点|别罗列|不要列表/, { scope: 'format', directive: '用句子不用列表', priority: PRIORITY.USER_FEEDBACK }],
];

export async function feedbackToRule(text, { infer = null, now = Date.now() } = {}) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const [re, rule] of FEEDBACK_PATTERNS) {
    if (re.test(s)) return { ...rule, id: `r_${now}`, source: 'user_feedback', raw: s, at: now };
  }
  if (typeof infer !== 'function') return null;
  try {
    const got = await infer({ kind: 'voice_rule', text: s });
    const directive = String(got && got.directive || '').trim();
    if (!directive) return null;
    return {
      scope: String(got.scope || 'tone'),
      directive,
      priority: PRIORITY.USER_FEEDBACK,
      id: `r_${now}`, source: 'inferred', raw: s, at: now,
    };
  } catch (err) {
    return null;
  }
}

/**
 * 冲突仲裁：同 scope 只保留最高优先级；同优先级保留更新的。
 * 事实/隐私类规则永远不参与风格仲裁——它们不是「风格」，是边界。
 */
export function arbitrate(rules = []) {
  const hard = rules.filter(r => r.priority <= PRIORITY.PRIVACY);
  const soft = rules.filter(r => r.priority > PRIORITY.PRIVACY);
  const byScope = new Map();
  for (const r of soft) {
    const cur = byScope.get(r.scope);
    if (!cur) { byScope.set(r.scope, r); continue; }
    if (r.priority < cur.priority) { byScope.set(r.scope, r); continue; }
    if (r.priority === cur.priority && Number(r.at || 0) > Number(cur.at || 0)) byScope.set(r.scope, r);
  }
  return [...hard, ...byScope.values()];
}

/** 把规则写成 prompt 片段。 */
export function rulesToPrompt(rules = []) {
  const ordered = arbitrate(rules);
  if (!ordered.length) return '';
  return ordered.map(r => `- ${r.directive}`).join('\n');
}
