/**
 * STEP 42 - 人物层（纯函数）
 *
 * 问题：她没有「人」这个概念。`-ing`、`岐`、`她` 是同一个人，在她那里是三串字符，
 *       加上记忆按对话隔离，于是同一个问题在两个对话里得到相反答案：
 *       对一个对话说「某人是朋友」，对另一个对话说「不认识这个人」。
 * 定案：把「人」提成全局实体，关系作为带来源的事实挂在人身上。
 *
 * 三条设计约束：
 *   ① 关系是「事实」不是「身份」。同一件事可以有两个来源互相矛盾，都留着，
 *      不硬选一个 —— 硬选必错，而且错得理直气壮。
 *   ② 每个事实带来源对话。跨对话互通之后，不标来源她就会张冠李戴。
 *   ③ 抽不到就不写。宁可人物页空着，也不留一条靠猜的。
 */

/** 关系词。极性用于判断亲疏，不用来判断对错。 */
const RELATIONS = [
  { word: '好朋友', polarity: 0.85 },
  { word: '朋友', polarity: 0.7 },
  { word: '好友', polarity: 0.7 },
  { word: '熟人', polarity: 0.4 },
  { word: '认识的人', polarity: 0.3 },
  { word: '同事', polarity: 0.3 },
  { word: '同学', polarity: 0.3 },
  { word: '老师', polarity: 0.3 },
  { word: '家人', polarity: 0.9 },
  { word: '亲人', polarity: 0.9 },
  { word: '陌生人', polarity: -0.6 },
  { word: '不认识的人', polarity: -0.6 },
  { word: '讨厌的人', polarity: -0.8 },
  { word: '对头', polarity: -0.8 },
];

const NEGATION = /(不是|不算|谈不上|说不上|没什么关系|没关系)/;

/** 引号里的人名：中文引号、双引号都算。 */
const QUOTED = /[「『"“]([\u4e00-\u9fa5A-Za-z0-9_-]{1,12})[」』"”]/g;

function cleanLabel(raw) {
  const text = String(raw || '')
    .replace(/^[的地得]+/, '')
    .replace(/[，。！？、,.!?；;：:\s]+$/g, '')
    .trim();
  if (text.length < 1 || text.length > 12) return '';
  // 代词不当作名字，否则每个人都会被归成同一个「她」
  if (/^(他|她|它|你|我|对方|这个人|那个人|某个人)$/.test(text)) return '';
  return text;
}

/**
 * 从一段话里抽「谁是什么关系」。
 *
 * 输入 herWords：她自己的发言；knownLabels：已经认识的名字（含别名）。
 * 返回 [{label, relation, polarity, negated, evidence}]。
 */
export function extractRelations(herWords, knownLabels = []) {
  const text = String(herWords || '');
  if (!text.trim()) return [];

  // 候选名字：已知人物 + 引号里的名字
  const labels = new Set((knownLabels || []).map(cleanLabel).filter(Boolean));
  let quoted = QUOTED.exec(text);
  while (quoted) {
    const name = cleanLabel(quoted[1]);
    if (name) labels.add(name);
    quoted = QUOTED.exec(text);
  }
  QUOTED.lastIndex = 0;
  if (!labels.size) return [];

  const out = [];
  for (const label of labels) {
    const at = text.indexOf(label);
    if (at < 0) continue;
    // 在名字附近 ±14 字内找关系词，太远就是两句话，不算
    const window = text.slice(Math.max(0, at - 14), Math.min(text.length, at + label.length + 14));
    for (const rel of RELATIONS) {
      if (!window.includes(rel.word)) continue;
      const negated = NEGATION.test(window);
      out.push({
        label,
        relation: rel.word,
        polarity: negated ? -rel.polarity : rel.polarity,
        negated,
        evidence: window.trim().slice(0, 60),
      });
      break; // 一个名字一次只取最靠前的一个关系词，避免一句话抽出五六条
    }
  }
  return out;
}

/**
 * 从一段话里抽「别名」。形如「叫我助手」「我叫岐」「她就是岐」。
 * 用于把同一个人的多个叫法归到一起。
 */
export function extractAliases(herWords, knownLabels = []) {
  const text = String(herWords || '');
  if (!text.trim()) return [];
  const known = (knownLabels || []).map(cleanLabel).filter(Boolean);
  const out = [];

  // 「叫我 X」「我叫 X」：这是她自己的名字，也记，方便她自我介绍一致
  const selfRe = /(?:叫我|我叫|称呼我)([\u4e00-\u9fa5A-Za-z0-9_-]{1,10})/g;
  let m = selfRe.exec(text);
  while (m) {
    const alias = cleanLabel(m[1]);
    if (alias) out.push({ alias, target: '__self__', evidence: m[0] });
    m = selfRe.exec(text);
  }

  // 「X 就是 Y」「X 也叫 Y」：两个已知名字互为别名
  const sameRe = /([\u4e00-\u9fa5A-Za-z0-9_-]{1,10})(?:就是|也叫|又叫)([\u4e00-\u9fa5A-Za-z0-9_-]{1,10})/g;
  m = sameRe.exec(text);
  while (m) {
    const a = cleanLabel(m[1]);
    const b = cleanLabel(m[2]);
    if (a && b && (known.includes(a) || known.includes(b))) out.push({ alias: b, target: a, evidence: m[0] });
    m = sameRe.exec(text);
  }

  return out;
}

/** 关系值 → 中文描述，用于注入。 */
export function describeRelation(polarity) {
  const value = Number(polarity) || 0;
  if (value >= 0.8) return '很亲近';
  if (value >= 0.5) return '是朋友';
  if (value >= 0.2) return '认识';
  if (value <= -0.7) return '有敌意';
  if (value <= -0.4) return '关系不好';
  return '关系说不清';
}

/**
 * 构建人物块。
 *
 * @param {Array} persons [{id,label,kind,aliases:[]}]
 * @param {Array} facts   [{person_id,kind,value,source_peer,confidence}]
 * @param {object} opts   {peerLabels:{peerId:名字}, currentPeerId, limit}
 */
export function buildPersonBlock(persons, facts = [], {
  peerLabels = {}, currentPeerId = null, limit = 6,
} = {}) {
  const list = (persons || []).filter((p) => p && p.label);
  if (!list.length) return null;

  // 只有真人（不是她虚构的人物）才进这张表；虚构人物由世界层负责
  const real = list.filter((p) => p.kind !== 'fictional').slice(0, limit);
  if (!real.length) return null;

  const byPerson = new Map();
  for (const fact of facts || []) {
    if (!byPerson.has(fact.person_id)) byPerson.set(fact.person_id, []);
    byPerson.get(fact.person_id).push(fact);
  }

  const lines = ['【你认识的人】这几个是真在跟你说话的，不是你自己写的人物：'];
  for (const person of real) {
    const aliases = (person.aliases || []).filter(Boolean);
    const aliasText = aliases.length > 1 ? `（也叫${aliases.filter((a) => a !== person.label).join('、')}）` : '';
    const isCurrent = currentPeerId && person.peer_id === currentPeerId;
    const mine = (byPerson.get(person.id) || [])
      .filter((f) => f.kind === 'relation')
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, 2);
    const relText = mine.length
      ? mine.map((f) => {
        const from = f.source_peer && f.source_peer !== currentPeerId
          ? `（${peerLabels[f.source_peer] || '别处'}说的）`
          : '';
        return `${describeRelation(f.value)}${from}`;
      }).join('；')
      : '关系还没记下';
    lines.push(`- ${person.label}${aliasText}${isCurrent ? ' ← 现在跟你说话的就是这个' : ''}：${relText}`);
  }
  lines.push('（这些是真实的人。你在别处听来的关于他们的事，和你在这个对话里听到的，都属于你的记忆——但说的时候要分清是谁说的。）');
  lines.push('（如果上面没写清某个人的关系，就直接说「我这边没记下」，不要断言「不认识」——没记下不等于不存在。）');
  return lines.join('\n');
}
