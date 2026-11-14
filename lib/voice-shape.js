/**
 * STEP 18 - 结构指标与重写触发器（纯函数）
 *
 * 定位很重要：**它不是改写器，是触发器**。
 * 具体性、立场、过程痕迹都没法自动补——只能测出来，退回生成层再写一遍。
 * 拿正则硬补会变成「删过的 AI」，不是「像人」。
 */

export const THRESHOLDS = {
  sdRatio: 0.55,      // 句长离散度：人 > 0.55
  shortRatio: 0.35,   // 短句比例：人 > 0.35
  maxCharsChat: 80,   // 微信单条上限
  score: 60,          // 低于这个分建议重写
};

const ABSTRACT = /体验|价值|意义|优化|提升|打造|全方位|整体|层面|维度|生态|闭环|赋能|助力/g;
const COMPLETENESS = /此外|同时|另外|综上|总之|值得一提|补充一句|顺便(说|提)|最后再?说/g;
const STANCE = /我觉得|我倾向|我更喜欢|我认为|要我选|我猜|我倒是|说实话/;

function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function measureShape(text) {
  const s = String(text || '');
  const sentences = splitSentences(s);
  const lens = sentences.map(x => x.length);
  const n = Math.max(1, lens.length);
  const avg = lens.reduce((a, b) => a + b, 0) / n;
  const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
  const sd = Math.sqrt(variance);

  return {
    chars: s.length,
    sentences: sentences.length,
    avgLen: +avg.toFixed(1),
    sd: +sd.toFixed(1),
    sdRatio: +(sd / Math.max(1, avg)).toFixed(2),
    shortRatio: +(lens.filter(x => x < 12).length / n).toFixed(2),
    hasNumber: /\d/.test(s),
    hasTime: /今天|昨天|前天|周[一二三四五六日]|\d{1,2}\s*[点:：]\s*\d{0,2}|月|号/.test(s),
    hasName: /[「『"“][^」』"”]{1,8}[」』"”]|@\w+/.test(s),
    hasPath: /\/[\w.\-\/]+|\b[\w\-]+\.(js|py|sh|json|md|log|db|conf|yml)\b/.test(s),
    abstractionHits: (s.match(ABSTRACT) || []).length,
    completenessHits: (s.match(COMPLETENESS) || []).length,
    hasStance: STANCE.test(s),
    questionCount: (s.match(/[？?]/g) || []).length,
  };
}

/** 0–100。不是精度指标，只用来判断「要不要重写」。 */
export function humanLikeScore(shape) {
  if (!shape || !shape.chars) return 0;
  // 极短回复天然像人（「嗯」「好」「行」），不参与节奏评分
  if (shape.chars < 12) return 82;
  let score = 50;

  score += Math.min(20, (Math.min(1.2, shape.sdRatio) / 1.2) * 20);      // 节奏越不均匀越像人
  score += Math.min(15, (Math.min(0.6, shape.shortRatio) / 0.6) * 15);   // 短句越多越像人

  const anchors = [shape.hasNumber, shape.hasTime, shape.hasName, shape.hasPath].filter(Boolean).length;
  score += anchors >= 2 ? 12 : anchors === 1 ? 8 : 0;

  if (shape.hasStance) score += 8;
  score -= Math.min(20, shape.abstractionHits * 6);
  score -= Math.min(24, shape.completenessHits * 8);
  if (shape.chars > THRESHOLDS.maxCharsChat) score -= 10;
  if (shape.questionCount > 1) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 给出「为什么像 AI」和「怎么改」，用于退回生成层。 */
export function suggestFixes(shape) {
  if (!shape || shape.chars < 12) return [];   // 短回复不用改
  const fixes = [];

  if (shape.sdRatio < THRESHOLDS.sdRatio) {
    fixes.push({
      issue: 'rhythm_too_even',
      why: `句长太均匀（离散度 ${shape.sdRatio}，人一般 >0.55）`,
      fix: '拆出一两个极短句，或把某句拉长；别让每句都差不多长',
    });
  }
  if (shape.shortRatio < THRESHOLDS.shortRatio) {
    fixes.push({
      issue: 'no_short_sentences',
      why: `几乎没有短句（${Math.round(shape.shortRatio * 100)}%，人一般 >35%）`,
      fix: '允许只回一句甚至两三个字，不要每条都完整',
    });
  }
  const anchors = [shape.hasNumber, shape.hasTime, shape.hasName, shape.hasPath].filter(Boolean).length;
  if (anchors === 0) {
    fixes.push({
      issue: 'no_concrete_anchor',
      why: '整条没有一个具体东西（数字/时间/名字/路径）',
      fix: '补一个真实的具体点：几点、几个、哪个文件；补不出来就说明这话本来就不该说这么满',
    });
  }
  if (shape.abstractionHits > 1) {
    fixes.push({
      issue: 'too_abstract',
      why: `抽象词 ${shape.abstractionHits} 个（体验/价值/优化/赋能…）`,
      fix: '换成动作和数字：「优化了体验」→「少点两下」',
    });
  }
  if (shape.completenessHits > 0) {
    fixes.push({
      issue: 'completeness_filler',
      why: `有 ${shape.completenessHits} 处「补充型」连接（此外/同时/顺便）`,
      fix: '删掉；删了还成立，说明本来就不该说',
    });
  }
  if (!shape.hasStance) {
    fixes.push({
      issue: 'no_stance',
      why: '没有立场（像在两面都不得罪）',
      fix: '给一句「我觉得 X，因为 Y」；不确定就说「我还没想清楚」',
    });
  }
  if (shape.chars > THRESHOLDS.maxCharsChat) {
    fixes.push({
      issue: 'too_long',
      why: `${shape.chars} 字，超过微信单条上限 ${THRESHOLDS.maxCharsChat}`,
      fix: '砍到一到两句；剩下的等对方问了再说',
    });
  }
  return fixes;
}

/** 一个调用同时给分数、问题、是否建议重写。 */
export function needsRewrite(text, threshold = THRESHOLDS.score) {
  const shape = measureShape(text);
  const score = humanLikeScore(shape);
  const fixes = suggestFixes(shape);
  return { score, shape, fixes, need: score < threshold };
}
