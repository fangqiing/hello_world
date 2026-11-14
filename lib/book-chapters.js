/**
 * STEP 26 - 按章节标记切分 + 整本一次投喂（纯函数）
 *
 * 用户要求：
 *  ① 按「第一章」「Chapter 1」等提示词切章，不按固定字数硬切
 *  ② 短篇文章不分割
 *  ③ 不要一章一章上传，书是一本一本的
 *
 * 与 STEP 19 的区别：
 *  19 把全文按 6000 字切成 N 段、逐段 POST → 一本书变成 50 条 reading
 *  26 只按章节标记切，**一次请求带齐所有章节**，服务端内部再决定融合还是整篇
 */


export const LIMITS = {
  maxChars: 1000000,       // 100 万字硬上限（中文约 3MB JSON，服务端要把 body 上限提到 5MB）
  articleMaxChars: 12000,  // 无章节标记且短于此 → 当一篇文章，完全不切
  minChapterChars: 200,    // 一个章节少于这个字数，倾向并进上一段（避免把小标题当章）
};

/**
 * 章节头判定。
 * 只认行首，且该行要短（标题行），避免把正文里的「一、」列表项当章。
 */
const HEAD = /^\s*(第[一二三四五六七八九十百千零〇两\d]{1,8}[章节卷回篇部]|Chapter\s+\d{1,4}\b|CHAPTER\s+[IVXLCDM]{1,6}\b|[一二三四五六七八九十]{1,3}[、.]\s*\S)/i;
// OCR/电子书常见的阿拉伯数字标题：「0. Prologue」「12. Epilogue: ...」。
// 正文里的脚注也常以「1. 」开头，所以 split 时会额外要求标题前后是空行。
const NUM_HEAD = /^\d{1,3}[.)]\s+\S/;
const NAMED_HEAD = /^(Prologue|Introduction|Conclusion|Epilogue|Afterword|Appendix)\b.{0,50}$/i;

export function isChapterHead(line, { prev, next } = {}) {
  const s = String(line || '').trim();
  if (!s) return false;
  if (NUM_HEAD.test(s)) {
    if (s.length > 120) return false;
    if (/^\d{1,3}[.)]\s*\(/.test(s)) return false;
    if (prev !== undefined && next !== undefined && !String(prev).trim() && !String(next).trim()) return true;
    if (/^\d{1,3}[.)]\s+(?:Prologue|Introduction|Conclusion|Epilogue)\b/i.test(s)) return true;
    if (/^\d{1,3}[.)]\s+.+:\s*$/.test(s)) return true;
    return false;
  }
  if (s.length <= 80 && NAMED_HEAD.test(s)) return true;
  if (s.length > 40) return false;   // 中文/英文标题行不会很长
  return HEAD.test(s);
}

/**
 * 按章节标记切分。返回 [{ index, title, text }]
 * 没有章节标记 → 只有 1 项（整篇）。
 * 章节太短的会并进上一段，避免「第一章」后面只有一行就切开。
 */
function normTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 书前面的目录：连续的数字标题行。用它当锚点，避免把脚注里的「1. ...」当章。 */
function findToc(lines) {
  const start = lines.findIndex((line) => /^contents$/i.test(String(line).trim()));
  if (start < 0) return null;
  const entries = [];
  let end = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,3})[.)]\s+(.+)$/);
    if (m && line.length <= 120) {
      entries.push({ num: m[1], title: line, line: i });
      end = i;
      continue;
    }
    if (!entries.length) continue; // Cover / Title Page / Copyright...
    if (/^(acknowledgments|notes|index)$/i.test(line)) continue;
    break;
  }
  return entries.length >= 3 ? { entries, end } : null;
}

function findAnchor(lines, entry, from) {
  const target = normTitle(entry.title);
  const bare = target.replace(/^\d{1,3}[.)]\s*/, '');
  for (let i = from; i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    const m = line.match(/^(\d{1,3})[.)]\s+(.+)$/);
    if (!m || m[1] !== entry.num) {
      if (bare.length >= 12 && normTitle(line).startsWith(bare)) return i;
      continue;
    }
    let candidate = normTitle(line);
    if (candidate === target) return i;
    // OCR 常把长标题折成两行：「1. Introduction:」+「The Most Human Human」
    let j = i + 1;
    while (j < lines.length && !String(lines[j] || '').trim()) j += 1;
    if (j < lines.length) {
      candidate = normTitle(`${line} ${lines[j]}`);
      if (candidate === target || candidate.startsWith(target)) return i;
    }
    if (target.startsWith(candidate)) return i;
  }
  return -1;
}

export function splitBookDetailed(text, { minChapterChars = LIMITS.minChapterChars } = {}) {
  const s = String(text || '').trim();
  if (!s) return { frontMatter: '', chapters: [], chapterCount: 0, frontChars: 0, mode: 'empty', ocrSuspect: false };

  const lines = s.split('\n');
  const toc = findToc(lines);
  if (toc) {
    const anchors = [];
    let cursor = toc.end + 1;
    for (const entry of toc.entries) {
      const at = findAnchor(lines, entry, cursor);
      if (at < 0) continue;
      anchors.push({ ...entry, at });
      cursor = at + 1;
    }
    if (anchors.length >= 2) {
      const chapters = anchors.map((entry, i) => {
        let until = i + 1 < anchors.length ? anchors[i + 1].at : lines.length;
        if (i === anchors.length - 1) {
          for (let j = entry.at + 1; j < until; j += 1) {
            if (/^(acknowledgments|notes|index|about the author)\b/i.test(String(lines[j] || '').trim())) {
              until = j;
              break;
            }
          }
        }
        return {
          index: i,
          title: entry.title.slice(0, 80),
          text: lines.slice(entry.at, until).join('\n').trim(),
        };
      }).filter((row) => row.text);
      if (chapters.length >= 2) {
        const frontMatter = lines.slice(0, anchors[0].at).join('\n').trim();
        return {
          frontMatter,
          chapters,
          chapterCount: chapters.length,
          frontChars: frontMatter.length,
          mode: 'book',
          ocrSuspect: /[A-Za-z]/.test(s) && chapters.length > 20,
        };
      }
    }
  }

  const blocks = [];
  const frontLines = [];
  let buf = [];
  let title = '';
  let inFront = true;
  let lastNum = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isChapterHead(line, { prev: lines[i - 1], next: lines[i + 1] })) {
      const numMatch = String(line || '').trim().match(/^(\d{1,3})[.)]\s+/);
      if (numMatch) {
        const n = Number(numMatch[1]);
        const sequential = lastNum === null
          ? (n <= 1 || /^(?:\d+[.)]\s+)?(prologue|introduction|chapter)\b/i.test(String(line || '').trim()))
          : n === lastNum + 1;
        if (!sequential) { buf.push(line); continue; }
        lastNum = n;
      }
      if (inFront) {
        if (buf.length) frontLines.push(buf.join('\n').trim());
        buf = [];
        inFront = false;
      } else if (buf.length) {
        blocks.push({ title, text: buf.join('\n').trim() });
        buf = [];
      }
      title = line.trim().slice(0, 80);
      continue;
    }
    buf.push(line);
  }
  if (buf.length) {
    if (inFront) frontLines.push(buf.join('\n').trim());
    else blocks.push({ title, text: buf.join('\n').trim() });
  }

  const merged = [];
  for (const b of blocks) {
    if (!b.text) continue;
    if (merged.length && b.text.length < minChapterChars) {
      merged[merged.length - 1].text += '\n' + b.text;
      continue;
    }
    merged.push({ ...b });
  }

  const frontMatter = frontLines.join('\n').trim();
  const chapters = merged.length
    ? merged.map((b, i) => ({ index: i, title: b.title || `第 ${i + 1} 部分`, text: b.text }))
    : [{ index: 0, title: '全文', text: frontMatter || s }];

  return {
    frontMatter,
    chapters,
    chapterCount: merged.length,
    frontChars: frontMatter.length,
    mode: chapters.length === 1 && s.length <= 12000 ? 'article' : 'book',
    ocrSuspect: /[A-Za-z]/.test(s) && chapters.length > 20,
  };
}

export function splitByChapters(text, opts = {}) {
  return splitBookDetailed(text, opts).chapters;
}

export function isShortArticle(chapters, text) {
  const n = Array.isArray(chapters) ? chapters.length : 0;
  return n <= 1 && String(text || '').length <= LIMITS.articleMaxChars;
}

/**
 * 构造一次请求要发的 payload。
 * 关键：**chapters 一次性全带**，不是逐章 POST。
 */
export function buildBookPayload(text, { title = '', source = 'book' } = {}) {
  const raw = String(text || '');
  const guarded = raw.length > LIMITS.maxChars ? raw.slice(0, LIMITS.maxChars) : raw;
  const chapters = splitByChapters(guarded);
  const short = isShortArticle(chapters, guarded);

  return {
    action: 'read-book',
    title: String(title || '').trim() || '未命名',
    source,
    mode: short ? 'article' : 'book',
    chapters: short ? [] : chapters,
    text: short ? guarded : undefined,   // 短文走整篇 text，不切
    rawChars: raw.length,
    totalChars: guarded.length,
    chapterCount: short ? 0 : chapters.length,
    truncated: raw.length > LIMITS.maxChars,
    dropped: Math.max(0, raw.length - guarded.length),
  };
}

/** UI 用的一行说明。不再出现「分 N 段投喂」。 */
export function describe(payload) {
  if (!payload) return '';
  if (payload.mode === 'article') {
    return `短文 ${payload.totalChars} 字 · 不切分，整篇一次投喂`;
  }
  return `共 ${payload.chapterCount} 章 · 全书 ${payload.totalChars} 字 · 整本一次投喂`;
}
