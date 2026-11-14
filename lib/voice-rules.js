/**
 * STEP 17 - AI 味规则层（补 voice-cleaner 缺的六条）
 *
 * 依据：Wikipedia「Signs of AI writing」（WikiProject AI Cleanup）、
 *      blader/humanizer、Humanizer-zh、MrGeDiao/shuorenhua、qu-ai-wei 的中文规则集。
 *
 * 与 step-16 的 voice-cleaner 分工：
 *   voice-cleaner  去掉「客服味 / 书面味」（起手、结尾、括号、字数、拆条）
 *   本模块         去掉「AI 味」（意义膨胀、假深度、假转折、凑三、-ing 补语）
 * 两种病不一样，都得治。
 */

export const DEFAULTS = {
  negativeParallelism: true,   // 不是 X，而是 Y
  fakeDepth: true,             // 本质上 / 真正的问题是 / 值得注意的是
  inflation: true,             // 赋能 / 助力 / 打造 / 全方位
  significance: true,          // 标志着 / 是…的见证 / 扮演重要角色
  trailingIng: true,           // ，进一步提升了…
  collapseTriples: false,      // 三个一组 → 砍到两个（默认关，容易误伤枚举）
  transitionWords: true,       // 首先 / 其次 / 总之
};

// ① 否定平行：「不是 A，而是 B」→「B」
export function stripNegativeParallelism(text) {
  let s = String(text || '');
  // 保留「是」，否则「这不是工具，而是革命」会变成「这革命」（缺谓语）
  s = s.replace(/不是[^，。！？；]{1,24}[，,]\s*(?:而是|是)\s*([^。！？；]{1,60})/g, '是$1');
  s = s.replace(/并非[^。！？；]{1,24}[，,]\s*(?:而是|是)\s*([^。！？；]{1,60})/g, '是$1');
  return s;
}

// ② 假深度前缀
const FAKE_DEPTH = [
  /(^|[，。！？；\s])(本质上|说到底|归根结底)[，,]?\s*/g,
  /(^|[，。！？；\s])值得注意的是[，,]?\s*/g,
  /(^|[，。！？；\s])换句话说[，,]?\s*/g,
  /(^|[，。！？；\s])从某种意义上(说|讲)[，,]?\s*/g,
  /(^|[，。！？；\s])可以说[，,]?\s*/g,
];
export function stripFakeDepth(text) {
  let s = String(text || '');
  for (const re of FAKE_DEPTH) s = s.replace(re, '$1');
  // Inline forms do not have a leading boundary in Chinese.
  s = s.replace(/(?:本质上|说到底|归根结底)(?=是)/g, '');
  // 「真正的问题是 X」不能整段删（会留下光秃秃的 X），换成「问题是 X」
  s = s.replace(/真正的问题(?:在于|是)/g, '问题是');
  return s.replace(/^[，,]\s*/, '').trim();
}

// ③ 宣传词 → 具体动作
const INFLATION = [
  [/赋能/g, '帮'], [/助力/g, '帮'], [/打造/g, '做'], [/全方位/g, '完整'],
  [/极致/g, '很'], [/焕新/g, '换'], [/闭环/g, '走完一圈'],
  [/抓手/g, '办法'], [/落地/g, '做出来'], [/对齐/g, '说清楚'],
  [/深耕/g, '做'], [/赋予/g, '给'], [/使得我们/g, '让我们'],
];
export function deInflate(text) {
  let s = String(text || '');
  for (const [re, rep] of INFLATION) s = s.replace(re, rep);
  return s;
}

// ④ 意义膨胀 → 「是」
const SIGNIFICANCE = [
  [/标志着([^。！？]{1,30})/g, '是$1'],
  [/([^，。！？]{0,15})是([^，。！？]{1,15})的(?:重要)?见证/g, '$1证明了$2'],
  [/扮演(着)?(重要|关键|核心)的?角色/g, '很关键'],
  [/起到了?(重要|关键|核心)的?作用/g, '有用'],
  [/具有(重要|深远)的意义/g, '有意义'],
  [/为([^。！？]{1,20})奠定了(坚实)?基础/g, '给$1打了底'],
];
export function stripSignificance(text) {
  let s = String(text || '');
  for (const [re, rep] of SIGNIFICANCE) s = s.replace(re, rep);
  return s;
}

// ⑤ 结尾 -ing 补语：「，进一步提升了 X」整段删
const TRAILING = [
  /[，,]\s*(进一步|从而|进而|使得|有效)([^。！？；]{1,40})/g,
  /[，,]\s*(凸显|彰显|体现)了([^。！？；]{1,40})/g,
];
export function stripTrailingIng(text) {
  let s = String(text || '');
  for (const re of TRAILING) s = s.replace(re, '');
  return s;
}

// ⑥ 过渡词
const TRANSITIONS = [
  /(^|[，。！？；\s])首先[，,]?\s*/g,
  /(^|[，。！？；\s])其次[，,]?\s*/g,
  /(^|[，。！？；\s])再次[，,]?\s*/g,
  /(^|[，。！？；\s])(总之|综上(所述)?|总的来说|总而言之)[，,]?\s*/g,
  /(^|[，。！？；\s])(此外|另外|而且|同时)[，,]?\s*/g,
];
export function stripTransitions(text) {
  let s = String(text || '');
  for (const re of TRANSITIONS) s = s.replace(re, '$1');
  return s.replace(/^[，,]\s*/, '').trim();
}

/**
 * ⑦ 三个一组 → 两个（默认关）
 * 只在「A、B、C，」这种纯并列顿号时生效，且不碰「第一、第二、第三」。
 */
export function collapseTriples(text) {
  return String(text || '').replace(
    /([^，。！？；、\s]{2,8})、([^，。！？；、\s]{2,8})、([^，。！？；、\s]{2,8})(?=[，。！？；])/g,
    '$1、$2',
  );
}

/** 全跑。顺序有讲究：先删结构性的，再换词，最后清过渡。 */
export function applyAiTells(input, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let s = String(input || '');
  const before = s;

  if (cfg.negativeParallelism) s = stripNegativeParallelism(s);
  if (cfg.trailingIng) s = stripTrailingIng(s);
  if (cfg.fakeDepth) s = stripFakeDepth(s);
  if (cfg.significance) s = stripSignificance(s);
  if (cfg.inflation) s = deInflate(s);
  if (cfg.collapseTriples) s = collapseTriples(s);
  if (cfg.transitionWords) s = stripTransitions(s);

  s = s.replace(/\s{2,}/g, ' ').replace(/([，,])\s*([，,])/g, '$1').trim();
  return { text: s, changed: s !== before };
}

/** 自检：返回命中了哪些 AI 味（用于「这句话为什么像 AI」的排查）。 */
export function detectAiTells(text) {
  const s = String(text || '');
  const hits = [];
  const probes = [
    ['negative_parallelism', /不是[^。]{1,24}[，,](而是|是)/],
    ['fake_depth', /本质上|真正的问题是|值得注意的是|换句话说/],
    ['inflation', /赋能|助力|打造|全方位|极致|抓手|闭环/],
    ['significance', /标志着|的见证|扮演.{0,3}角色|起到.{0,3}作用/],
    ['trailing_ing', /[，,](进一步|从而|进而|使得)/],
    ['transitions', /首先|其次|总之|综上/],
    ['triple', /[^、，。]{2,8}、[^、，。]{2,8}、[^、，。]{2,8}[，。]/],
  ];
  for (const [id, re] of probes) if (re.test(s)) hits.push(id);
  return { hits, clean: hits.length === 0 };
}
