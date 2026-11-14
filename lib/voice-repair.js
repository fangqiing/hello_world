/**
 * STEP 24 - 修补、L0 闸门、漂移自检（纯函数）
 *
 * 三件事对应这轮搜到的三个发现：
 *  1 23%/54% 的回合含自我修正 → AI 不该说「我不理解，请再试一次」，要确认式修补
 *  2 拟人化评测先过 L0 有效性闸门 → 身份泄露/硬重复/角色矛盾/格式穿帮
 *  3 规则会随会话长度漂回去 → 每 N 轮扫一次 marker
 */

/** ① 确认式修补：说清「我理解的部分」，邀请对方修正。 */
export function repairResponse({ partial = '', unknown = '', kind = 'clarify' } = {}) {
  const p = String(partial || '').trim();
  const u = String(unknown || '').trim();
  if (kind === 'confirm') {
    return p ? `等下，我理解成「${p}」了，是吗` : '等下，我确认一下';
  }
  if (kind === 'uncertain') {
    return '这个我得想想';
  }
  if (p && u) return `我大概懂前半句，${p}。${u}那块你再说一遍`;
  if (p) return `你是说「${p}」？`;
  return '我漏了点，你再说一遍';
}

/** 「我不理解」类机器话 → 人话。 */
const BAD_REPAIRS = [
  [/我不理解[，,]?请再试一次/g, '你再说一遍'],
  [/无法识别(该)?指令/g, '我没跟上'],
  [/我无法回答(这个)?问题/g, '这个我得想想'],
  [/请输入有效(的)?(内容|指令)/g, '没看懂，再说一遍'],
];
export function humanizeRepair(text) {
  let s = String(text || '');
  for (const [re, rep] of BAD_REPAIRS) s = s.replace(re, rep);
  return s;
}

/** ② L0 有效性闸门：不过就直接判失败，不用再打分。 */
export const L0 = {
  identity: /作为\s*(一个)?\s*(AI|人工智能|语言模型)|我是\s*(一个)?\s*(AI|语言模型|智能助手)|作为\s*(一个)?\s*助手/i,
  markdown: /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+[.、]\s)|\*\*[^*]+\*\*/m,
  corporate: /(非常乐意|很乐意|很高兴为您|乐意(为您|帮忙|帮助)|随时(问我|联系)|希望(这|以上).*帮助|如需.*请|不客气[，,])/,
};

export function l0Gate(text, ctx = {}) {
  const s = String(text || '');
  const violations = [];

  if (L0.identity.test(s)) violations.push({ code: 'identity_leak', why: '暴露了 AI 身份或助手口吻' });
  if (ctx.scene !== 'task' && L0.markdown.test(s)) violations.push({ code: 'format_leak', why: '闲聊里出现 Markdown 标题/列表/粗体' });
  if (L0.corporate.test(s)) violations.push({ code: 'corporate', why: '客服腔残留' });

  if (Array.isArray(ctx.recentTexts)) {
    const t = s.trim();
    const hits = ctx.recentTexts.filter(x => String(x || '').trim() === t).length;
    if (t && hits >= 2) violations.push({ code: 'hard_repeat', why: `同一句最近出现 ${hits} 次` });
  }
  if (Array.isArray(ctx.forbidden)) {
    for (const w of ctx.forbidden) {
      if (w && s.includes(String(w))) violations.push({ code: 'persona_conflict', why: `与已定事实冲突：${w}` });
    }
  }

  return { pass: violations.length === 0, violations };
}

/** ③ 漂移 marker：每 100 条大约累积 1 个，静态规则挡不住，所以要周期扫。 */
export const DRIFT_MARKERS = [
  /非常乐意|很高兴为您|希望.*帮助|如需.*请|随时问我/,
  /太棒了|非常出色|太厉害了|太精彩了|令人惊叹/,
  /首先|其次|再次|总之|综上|总的来说|值得注意的是/,
  /标志着|扮演.{0,3}角色|起到.{0,3}作用|是.{0,8}的见证/,
  /让我们|下面我来|在这里我将|接下来我们/,
  /赋能|助力|打造|全方位|抓手|闭环/,
  /作为一个?AI|语言模型/,
];

export function driftScan(recentTexts = [], { threshold = 3 } = {}) {
  const list = (recentTexts || []).slice(-30);
  let hits = 0;
  const detail = [];
  for (const t of list) {
    const s = String(t || '');
    for (const re of DRIFT_MARKERS) {
      const m = s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (m && m.length) { hits += m.length; detail.push({ marker: re.source.slice(0, 14), count: m.length }); }
    }
  }
  return {
    window: list.length,
    hits,
    perHundred: list.length ? Math.round((hits / list.length) * 100) : 0,
    drifted: hits >= threshold,
    detail,
  };
}

/** 每 N 轮做一次自检（CPR 建议 10 条左右一窗口）。 */
export function shouldSelfCheck(round, every = 10) {
  return Number(round) > 0 && Number(round) % every === 0;
}
