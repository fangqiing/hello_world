/**
 * STEP 19 - 书籍输入的切分与长度守卫（纯函数）
 *
 * 修的是「粘贴一篇文章后页面卡死、内容消失」：
 *  1 旧版切分用了零宽前瞻 + 交替断言 `(?=\n\s*第[...]+[章节卷回篇])`，在长文本上会大量回溯；
 *  2 而且它绑在 input 事件上，每输入一次就对全文重算一遍。
 *  3 卡死之后页面状态丢失，所以「就没了」。
 *
 * 这里改成逐行扫描，O(n)、无回溯；长度有硬上限；并提供轻量估算用于输入时预警。
 */

export const LIMITS = {
  maxChars: 300000,     // 30 万字，超过直接截断（一本书常见 20-30 万）
  maxChapters: 200,     // 章数上限，超出并段
  chunkChars: 6000,     // 单次投喂上限
  lightScanChars: 20000,// 超过这个长度，输入时只做轻量估算，不做完整切分
};

// 章节头：只用有界量词 + 简单前缀，避免嵌套量词回溯
const HEAD = /^\s*(第[一二三四五六七八九十百零〇两\d]{1,6}[章节卷回篇]|Chapter\s+\d{1,4}\b|\d{1,3}[.、]\s*\S)/i;

export function isChapterHead(line) {
  return HEAD.test(String(line || ''));
}

/** 长度守卫：超过上限截断，并在最后一个完整段落处切。 */
export function guardLength(text, max = LIMITS.maxChars) {
  const s = String(text || '');
  if (s.length <= max) return { ok: true, text: s, chars: s.length, truncated: false };
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('。'));
  return {
    ok: false,
    text: cut > max * 0.7 ? head.slice(0, cut + 1) : head,
    chars: cut > max * 0.7 ? cut + 1 : max,
    truncated: true,
    dropped: s.length - (cut > max * 0.7 ? cut + 1 : max),
  };
}

/**
 * 轻量估算：只扫一遍行，不建数组、不做二次切分。
 * 用于输入时的实时提示（毫秒级）。
 */
export function estimatePlan(text, max = LIMITS.maxChars) {
  const s = String(text || '');
  const chars = Math.min(s.length, max);
  let heads = 0;
  let lines = 0;
  let start = 0;
  while (start <= chars) {
    const nl = s.indexOf('\n', start);
    const end = nl === -1 || nl > chars ? -1 : nl;
    const line = s.slice(start, end === -1 ? chars : end);
    lines += 1;
    if (isChapterHead(line)) heads += 1;
    if (end === -1) break;
    start = end + 1;
  }
  const chapterCount = Math.max(heads, 1);
  const perChapter = Math.ceil(chars / chapterCount);
  const chunks = Math.max(1, Math.ceil(chars / LIMITS.chunkChars));
  const warn = [];
  if (s.length > max) warn.push(`超过 ${max} 字，会被截断`);
  if (chunks > 40) warn.push(`要投 ${chunks} 段，比较久，建议先投一章试水`);
  return { chars, lines, chapters: chapterCount, chunks, perChapter, warn, heavy: chars > LIMITS.lightScanChars };
}

/**
 * 切分：逐行扫描，遇章节头断开；超长段再按 chunkChars 二次切。
 * O(n)，无正则回溯。返回 [{ index, title, text }]
 */
export function splitChapters(text, { maxLen = LIMITS.chunkChars, maxChapters = LIMITS.maxChapters } = {}) {
  const s = String(text || '');
  if (!s) return [];

  const blocks = [];
  let buf = [];
  let start = 0;
  while (start <= s.length) {
    const nl = s.indexOf('\n', start);
    const end = nl === -1 ? s.length : nl;
    const line = s.slice(start, end);
    if (isChapterHead(line) && buf.length) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
    buf.push(line);
    if (nl === -1) break;
    start = end + 1;
  }
  if (buf.length) blocks.push(buf.join('\n'));

  // 二次切分超长块 + 合并过多块
  const out = [];
  for (const b of blocks) {
    const trimmed = b.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLen) { out.push(trimmed); continue; }
    for (let i = 0; i < trimmed.length; i += maxLen) out.push(trimmed.slice(i, i + maxLen));
  }
  if (out.length <= maxChapters) {
    return out.map((t, i) => ({ index: i, title: `第 ${i + 1} 部分`, text: t }));
  }
  // 章数超限：按比例并段，保证不超过上限
  const per = Math.ceil(out.length / maxChapters);
  const merged = [];
  for (let i = 0; i < out.length; i += per) {
    merged.push(out.slice(i, i + per).join('\n'));
  }
  return merged.map((t, i) => ({ index: i, title: `第 ${i + 1} 部分`, text: t }));
}
