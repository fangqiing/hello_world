/**
 * STEP 16 - 模式确认的措辞与答复解析（纯函数）
 *
 * 原则：不说「是否切换到 agent 模式」这种机器话。
 * 她只是问一句「要我去查一下？」，像人一样。
 */

const YES = [
  /^(好|好的|行|可以|嗯|对|要|来吧|去吧|去看|查吧|弄吧|麻烦你|辛苦|谢谢)[。!！~～\s]*$/,
  /^(嗯+|好+|行+|对对+|可以+)[，,。!！~\s]/,
  /(可以|行|好|对).{0,4}(吧|啊|呀)/,
];
const NO = [
  /^(不用|算了|别|不要|没事|不必|先不|不用了|不用了)[了。!！~～\s]*$/,
  /^(不|不用|算了|先这样|没了|没有了|没别的|就这些|就这|够了)/,
];

/** 确认是否要动手。intent.verb 决定用词。 */
export function confirmPhrase(intent, ctx = {}) {
  const v = (intent && intent.verb) || '';
  const map = {
    查: '要我去查一下？',
    看: '要我看一眼？',
    改: '要我动手改？',
    装: '要我去装？',
    跑: '要我跑一下？',
    删: '要我删掉？',
    写: '要我写？',
  };
  if (map[v]) return map[v];
  return '要我帮你弄？';
}

/** 解析「是 / 否 / 说不清」。 */
export function parseAnswer(text) {
  const s = String(text || '').trim();
  if (!s) return 'unclear';
  if (NO.some(re => re.test(s))) return 'no';
  if (YES.some(re => re.test(s))) return 'yes';
  return 'unclear';
}

/** 任务做完时的收尾（不邀功、不长篇）。 */
export function donePhrase({ summary, ok = true } = {}) {
  if (!ok) return '没弄成。要我再试一次？';
  const tail = summary ? `：${String(summary).slice(0, 40)}` : '';
  return `弄好了${tail}。还有别的吗？`;
}

/** 退出 agent 模式时的收尾。 */
export function exitPhrase() {
  return '好，那先这样。';
}

/** 进入 agent 时的第一句（表示「我开始动手了」）。 */
export function enterPhrase({ verb } = {}) {
  const map = { 查: '我去查。', 看: '我看一下。', 改: '我改。', 装: '我装。', 跑: '我跑一下。', 删: '我删。', 写: '我写。' };
  return map[verb] || '我弄。';
}

/** 超时回退时的一句（可选发送）。 */
export function timeoutPhrase(mode) {
  if (mode === 'agent') return '先不弄了，回头再说。';
  if (mode === 'ask_enter') return '';   // 没回应就不提，避免尴尬
  return '';
}
