/**
 * STEP 21 - 诗意填充与无功能比喻（纯函数）
 *
 * 现象：「我在。夜里水很静，光都沉下来啦。这么晚还没睡，是睡不着，还是有事想跟我说？」
 *      对方只发了一句「我在」，她先写了两句环境描写，再回正题。
 *
 * 为什么前面的 cleaner 没拦住：
 *   voice-cleaner 治客服腔（起手、结尾、括号、字数）
 *   voice-rules   治 AI 味（否定平行、假深度、宣传词、意义膨胀、-ing 补语）
 *   两者都没管「**氛围填充**」——它不是套话，也不是膨胀，是**没有功能的意象**。
 *
 * 关键区分：
 *   有功能：对方在聊情绪/环境，她用意象回应 → 保留（这是她的语言）
 *   无功能：对方在说事，她先铺两句景 → 删（这是模型的文学惯性）
 * 判断标准：**删掉这句，对话信息有没有损失？**
 */

export const DEFAULTS = {
  stripOpeningScenery: true,   // 删掉开头的环境描写
  maxMetaphor: 1,              // 一条回复里最多几个比喻（超过只提示，不硬删）
  keepWeatherChange: true,     // 「下雨了/起风了」是信息，不当填充
};

// 环境名词开头
const SCENERY_HEAD = /^(夜里|夜色|窗外|窗外头|天色|月光|灯光|光线|水面|海面|空气|风|雨声|雪|雾|房间|屋子里|街道|城市|外面)/;
// 状态描写（没有事件，只有感觉）
const STATE_WORD = /(很|格外|异常|有点|特别)?(静|安静|温柔|柔软|清澈|沉默|沉下来|漫上来|浮着|散开|亮着|暗下来|轻|凉)/;
// 天气变化：有信息
const WEATHER_EVENT = /(下雨|下雪|起风|打雷|出太阳|变天|降温|升温)(了|啦)/;
// 有人做主语：可能在说人的状态，不算纯填充
const HAS_SUBJECT = /(我|你|他|她|它|咱们|我们|你们)/;
// 比喻标记
const METAPHOR = /(像|仿佛|好像|如同|宛如)[^，。！？]{2,16}(一样|似的|一般)/g;

export function isPoeticFiller(sentence) {
  const s = String(sentence || '').trim();
  if (!s || s.length > 40) return false;              // 太长的不当填充（可能是正文）
  if (WEATHER_EVENT.test(s)) return false;            // 「外面下雨了」是信息
  if (!SCENERY_HEAD.test(s)) return false;
  if (!STATE_WORD.test(s)) return false;
  if (HAS_SUBJECT.test(s)) return false;              // 「我看着夜里」有主体，可能是真实描写
  return true;
}

/**
 * 只扫前 3 句：开头的景最典型。
 * 注意第一句常常是「我在」这类短回答——填充往往在第二句，所以不能只看第一句。
 * 中间（第 4 句以后）出现的景可能是承接对方情绪，不动。
 */
export function stripOpeningScenery(text, { scan = 3 } = {}) {
  const s = String(text || '');
  const segs = s.match(/[^。！？\n]+[。！？\n]?/g) || [];
  if (!segs.length) return { text: s, stripped: [] };

  const stripped = [];
  const kept = [];
  let seen = 0;

  for (const seg of segs) {
    const bare = seg.replace(/[。！？\n]+$/, '').trim();
    if (!bare) continue;
    if (seen < scan && isPoeticFiller(bare)) {
      stripped.push(bare);
      seen += 1;
      continue;
    }
    seen += 1;
    kept.push(seg);
  }

  // 删空了就还原，不能把回复变成空
  const out = kept.join('').trim();
  if (!out) return { text: s, stripped: [] };
  return { text: out, stripped };
}

export function countMetaphors(text) {
  const s = String(text || '');
  return (s.match(METAPHOR) || []).length;
}

/** 自检：返回命中的填充句与比喻数。 */
export function detectPoetic(text) {
  const s = String(text || '');
  const opener = s.match(/^([^。！？\n]+[。！？\n]?)/);
  const first = opener ? opener[1].replace(/[。！？\n]+$/, '') : '';
  return {
    openingFiller: isPoeticFiller(first) ? first : null,
    metaphors: countMetaphors(s),
    clean: !isPoeticFiller(first) && countMetaphors(s) <= 1,
  };
}

/**
 * 处理：开头景删掉；比喻超量只给提示（不硬删——删比喻会把句子弄断）。
 * 返回 { text, stripped, overMetaphor }
 */
export function soften(text, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let s = String(text || '');
  let stripped = [];

  if (cfg.stripOpeningScenery) {
    const r = stripOpeningScenery(s);
    s = r.text;
    stripped = r.stripped;
  }

  const metaphors = countMetaphors(s);
  s = s.replace(/\s{2,}/g, ' ').replace(/^[，,。]\s*/, '').trim();

  return { text: s, stripped, metaphors, overMetaphor: metaphors > cfg.maxMetaphor };
}
