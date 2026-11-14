/**
 * STEP 28 - 书籍解析：认得出章节、跳得过前置页、不只截开头
 *
 * 实测两本书：
 *  《理解人性》     「第一部分　人的行为」「第一章　精神」「导读　…」「推荐序一　…」
 *  The Most Human Human  「0. Prologue」「1. Introduction: …」「Contents」「Copyright」
 *
 * 旧 HEAD 只认「第X章 / Chapter N / 中文数字+顿号」，所以：
 *  - 英文书一章都切不出来 → chapters=1 → 单块被截到前 9000 字符（全是版权页）
 *  - 中文书能切章，但前 252 行（出版信息+导读+两篇序）被当成第 0 章一起喂进去
 * 两者都导致提炼看到的是元信息，抽不出原则。
 */

export const LIMITS = {
  maxTitleLen: 45,
  minChapterChars: 200,
  summaryChars: 9000,
};

// 前置页：出现这些开头的标题行，其内容不参与观点提炼（但原文保留）
const FRONT = /^(目录|Contents|版权|Copyright|出版|ISBN|epub|导读|推荐序|序|前言|Preface|Prologue|Epigraph|Dedication|Title\s*Page|Cover|致谢|Acknowledg|扉页|插图|目录页)/i;

// 章节头：中文数字 / 阿拉伯数字 / Chapter / Part
const CHAPTER = new RegExp([
  '^\\s*第[一二三四五六七八九十百千零〇两\\d]{1,8}\\s*[章节卷回篇部]\\s*(?:\\S|\\u3000)*$',
  '^\\s*第[一二三四五六七八九十百千零〇两\\d]{1,8}\\s*部分\\b',
  '^\\s*\\d{1,3}\\s*[.、)]\\s+\\S',
  '^\\s*Chapter\\s+\\d{1,4}\\b',
  '^\\s*CHAPTER\\s+[IVXLCDM]{1,6}\\b',
  '^\\s*Part\\s+(One|Two|Three|Four|Five|[IVXLCDM]{1,6})\\b',
  '^\\s*PART\\s+[IVXLCDM]{1,6}\\b',
].join('|'), 'i');

/** 全角空格分隔的短标题，例如「导读　活出阿德勒心」「第一部分　人的行为」 */
function isSpacedTitle(line) {
  const s = String(line || '').trim();
  return s.length <= LIMITS.maxTitleLen && /[\u3000]{1,}/.test(s) && !/[。！？；]/.test(s);
}

export function classifyLine(line) {
  const s = String(line || '').trim();
  if (!s) return 'blank';
  if (FRONT.test(s) && s.length <= 60) return 'front';
  if (CHAPTER.test(s) && s.length <= LIMITS.maxTitleLen) return 'chapter';
  if (isSpacedTitle(s) && FRONT.test(s)) return 'front';
  if (isSpacedTitle(s)) return 'chapter';
  return 'body';
}

/**
 * 切书。返回 { frontMatter, chapters, chapterCount, frontChars, mode }
 * mode: 'article'（一章且短）| 'book'（多章）
 */
export function splitBook(text, { minChapterChars = LIMITS.minChapterChars } = {}) {
  const s = String(text || '').trim();
  if (!s) return { frontMatter: '', chapters: [], chapterCount: 0, frontChars: 0, mode: 'empty' };

  const lines = s.split('\n');
  const frontLines = [];
  const blocks = [];
  let buf = [];
  let title = '';
  let inFront = true;   // 开头一律当前置页，直到遇到第一个正式章节头
  let inToc = false;    // 目录块：Contents 之后的短条目不是正文章节

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // 目录里的「0. Prologue / 1. Introduction」会被误认成章节，整块收进前置页
    if (/^Contents?\s*$/i.test(trimmed)) {
      inToc = true;
      frontLines.push(trimmed);
      continue;
    }
    if (inToc) {
      // 出现长段落 = 正文开始了；目录条目都是短行
      if (trimmed.length > 90 && !CHAPTER.test(trimmed)) {
        inToc = false;
      } else {
        frontLines.push(trimmed);
        continue;
      }
    }

    const kind = classifyLine(line);
    const isRealChapter = kind === 'chapter' && CHAPTER.test(trimmed);

    if (isRealChapter) {
      // 前置页到这里结束，之前的内容单独收走
      if (inFront) {
        if (buf.length) frontLines.push(buf.join('\n').trim());
        buf = [];
        inFront = false;
      } else if (buf.length) {
        blocks.push({ title, text: buf.join('\n').trim() });
        buf = [];
      }
      title = line.trim().slice(0, 45);
      continue;
    }
    buf.push(line);
  }
  if (buf.length) {
    if (inFront) frontLines.push(buf.join('\n').trim());
    else blocks.push({ title, text: buf.join('\n').trim() });
  }

  // 太短的块并进上一块，避免小标题单独成章
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
    chapterCount: merged.length ? merged.length : 0,
    frontChars: frontMatter.length,
    mode: chapters.length === 1 && s.length <= 12000 ? 'article' : 'book',
  };
}

/**
 * 摘摘要用的取样：**不要只截开头**。
 * 长文本按句子边界，从头/中/尾各取一段，避免只看到版权页或导读。
 */
export function sampleForSummary(text, maxChars = LIMITS.summaryChars) {
  const s = String(text || '').replace(/^[\s\S]{0,0}/, '').trim();
  if (!s || s.length <= maxChars) return s;
  const per = Math.floor(maxChars / 3);
  const take = (from) => {
    const raw = s.slice(from, from + per * 2);
    const cut = Math.max(raw.lastIndexOf('。'), raw.lastIndexOf('. '), raw.lastIndexOf('\n'));
    return (cut > per * 0.5 ? raw.slice(0, cut + 1) : raw.slice(0, per)).trim();
  };
  const parts = [take(0), take(Math.floor(s.length * 0.45)), take(Math.max(0, s.length - per * 2))];
  return parts.filter(Boolean).join('\n…\n').slice(0, maxChars);
}

/** 提炼指令兜底：fusion 路径必须明确禁止返回空数组。 */
export function extractionDirective() {
  return [
    '从下面的章摘要与全书摘要里，提炼 3-8 条她可能记住的想法。',
    '可以是认同、疑问、不认同，或「还不确定」——不要求都是正确结论。',
    '每条一句话，具体、可执行，不要写「要善良」这类空话。',
    '每条附 chapterIndex 与 quote（quote 用原文里 20-40 字）。',
    '**即使材料看起来没有说教，也必须输出至少 3 条；不要返回空数组。**',
  ].join('\n');
}

/** 0 条时的用户可见反馈：给可操作的原因，不要只说「没抽出」。 */
export function emptyResultNote({ chapterCount = 0, frontChars = 0, ocrSuspect = false } = {}) {
  if (ocrSuspect) return '这本像是扫描识别的，字有点乱，我没读明白。换个干净版本？';
  if (chapterCount === 0) return '没认出章节，只看到前面的出版信息。你把正文单独贴给我？';
  if (frontChars > 20000) return '前面的序和导读太长了，正文我还没抓住。再给我一次？';
  return '读了，但没抓住什么。可能是我没读懂，你说说是讲什么的？';
}
