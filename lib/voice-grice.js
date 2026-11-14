/**
 * STEP 23 - Grice 四准则自检（纯函数）
 *
 * 用途：不是改写器，是「这一轮说话得不得体」的判据。
 * 四条准则（Grice 1975）：量、质、关系、方式。
 * 违反它们的代价有量化：满意度 -50~70%、澄清请求 ×3-5、放弃率 +40~60%。
 *
 * 关键：规则要按场景分级——讲步骤时用列表是自然的，讲心事时用列表才怪。
 */

export const SCENES = {
  chat: { maxChars: 60, lists: 'none', expectReply: 'short' },      // 闲聊、深夜
  emotion: { maxChars: 40, lists: 'none', expectReply: 'short' },   // 回应情绪
  task: { maxChars: 400, lists: 'ok', expectReply: 'normal' },      // 讲事、排查
  opinion: { maxChars: 200, lists: 'sparse', expectReply: 'normal' },// 讲观点
  unknown: { maxChars: 30, lists: 'none', expectReply: 'short' },   // 她不懂
};

function splitSentences(s) {
  return String(s || '').split(/[。！？!?\n]+/).map(x => x.trim()).filter(Boolean);
}

function sdRatio(text) {
  const lens = splitSentences(text).map(x => x.length);
  if (lens.length < 2) return 1;   // 单句不判节奏
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const v = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
  return Math.sqrt(v) / Math.max(1, avg);
}

/**
 * 检查一条回复。
 * ctx: { scene, userText, expectShort, answeredAll, allowedNumbers }
 * 返回 { ok, violations:[{rule, why, fix}], score }
 */
export function checkGrice(text, ctx = {}) {
  const s = String(text || '');
  const scene = SCENES[ctx.scene] || SCENES.chat;
  const violations = [];

  // ① 量：说够就好
  if (ctx.expectShort === true && s.length > scene.maxChars) {
    violations.push({ rule: 'quantity', why: `对方只要一句，你写了 ${s.length} 字`, fix: '砍到一句' });
  }
  if (ctx.userText && String(ctx.userText).length <= 6 && s.length > 40) {
    violations.push({ rule: 'quantity', why: `对方只说几个字，你回了 ${s.length} 字`, fix: '先回一句，剩下的等对方问' });
  }

  // ② 质：只说有依据的
  const numbers = s.match(/\d+(\.\d+)?/g) || [];
  if (numbers.length && Array.isArray(ctx.allowedNumbers)) {
    const extra = numbers.filter(n => !ctx.allowedNumbers.includes(n));
    if (extra.length) {
      violations.push({ rule: 'quality', why: `出现了没来源的数字：${extra.slice(0, 3).join(',')}`, fix: '删掉，或说明出处在哪' });
    }
  }
  if (/(肯定|一定|绝对是|必然是)/.test(s) && /(可能|也许|大概|不太确定)/.test(s) === false) {
    // 过度断言只在「没有查过」的场景提示
    if (ctx.verified === false) {
      violations.push({ rule: 'quality', why: '没查过却用了断言口吻', fix: '改成「我猜」「大概是」' });
    }
  }

  // ③ 关系：切题
  // 开口先铺景是最典型的跑题——对方在说事，你在写散文
  const headClauses = s.split(/[。！？\n]+/).slice(0, 2).filter(Boolean);
  const scenery = /^(夜里|夜色|窗外|天色|月光|灯光|光线|空气|风|雨|雪|街上|城市|屋里|房间)/;
  for (const c of headClauses) {
    const t = c.trim();
    if (scenery.test(t) && !/[我你他她]/.test(t)) {
      violations.push({ rule: 'relevance', why: `开头在写环境（${t.slice(0, 10)}），没接对方的话`, fix: '直接回对方' });
      break;
    }
  }
  if (ctx.userText) {
    const keys = String(ctx.userText).replace(/[，。！？\s]/g, '').slice(0, 8);
    const overlap = keys && [...new Set(keys)].some(ch => s.includes(ch));
    if (!overlap && s.length > 30) {
      violations.push({ rule: 'relevance', why: '回复里几乎没有对方说的内容', fix: '先接住对方那句' });
    }
  }

  // ④ 方式：清楚、简洁、有序
  const r = sdRatio(s);
  if (s.length > 40 && r < 0.35) {
    violations.push({ rule: 'manner', why: `句长太均匀（${r.toFixed(2)}），像模板`, fix: '插一句极短的' });
  }
  if (scene.lists === 'none' && /(^|\n)\s*(\d+[.、]|[-*]\s)/m.test(s)) {
    violations.push({ rule: 'manner', why: '这个场景不该用列表', fix: '改成说话' });
  }
  if (scene.lists === 'sparse' && ((s.match(/(^|\n)\s*(\d+[.、]|[-*]\s)/gm) || []).length > 1)) {
    violations.push({ rule: 'manner', why: '观点场景列表太多', fix: '最多保留一处' });
  }
  // 结构词：闲聊里出现「首先/其次/总之」就是模板腔
  const structWords = (s.match(/首先|其次|再次|最后|总之|综上|总的来说/g) || []).length;
  if (scene.lists === 'none' && structWords >= 2) {
    violations.push({ rule: 'manner', why: `用了 ${structWords} 个结构词，像在做汇报`, fix: '删掉，直接说事' });
  }
  // 客服腔起手
  if (/^(当然|非常乐意|很高兴为您|很乐意为您)/.test(s) && scene.lists === 'none') {
    violations.push({ rule: 'manner', why: '客服腔起手', fix: '直接回答' });
  }

  const score = Math.max(0, 100 - violations.length * 22);
  return { ok: violations.length === 0, violations, score, sdRatio: +r.toFixed(2) };
}

/** 从对方那句话推断场景，避免每条都按最高标准要求。 */
export function inferScene(userText, { isLateNight = false } = {}) {
  const s = String(userText || '');
  if (isLateNight && s.length < 20) return 'emotion';
  if (/(累|烦|难受|不开心|崩溃|哭了|压力)/.test(s)) return 'emotion';
  if (/(怎么|如何|报错|为什么|帮我|是不是|能不能)/.test(s)) return 'task';
  if (/(你觉得|好不好|该不该|怎么看)/.test(s)) return 'opinion';
  if (s.length <= 10) return 'chat';
  return 'chat';
}
