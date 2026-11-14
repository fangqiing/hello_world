/**
 * STEP 20 - 气泡拆分（修「第三条被吃掉」）
 *
 * 旧实现的 bug：
 *   for (...) {
 *     ...
 *     out.push(buf); buf = p;
 *     if (out.length >= maxBubbles - 1) break;   // break 之后剩余 parts 全部丢失
 *   }
 *
 * 现在条数上限用「合并」实现，不截断；只有单条超过字数硬上限才在句子边界截，
 * 并把截掉的部分作为 dropped 交回调用方，避免静默丢内容。
 */

export const DEFAULTS = {
  splitThreshold: 24,
  maxBubbles: 2,
  maxChars: 80,
};

/** 在句子边界截断，尽量不切半个词。 */
export function trimAtSentence(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, dropped: '' };
  const head = s.slice(0, maxChars);
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('，'), head.lastIndexOf('\n'),
  );
  const keep = Math.min(maxChars, cut > maxChars * 0.5 ? cut + 1 : maxChars);
  return { text: head.slice(0, keep), dropped: s.slice(keep) };
}

/**
 * 拆条。返回 { bubbles, dropped }
 *  - bubbles：要依次发出的文本
 *  - dropped：超硬上限时被截掉的内容（正常为 ''；非空时调用方应记日志）
 */
export function splitBubbles(text, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const maxBubbles = Math.max(1, Number(cfg.maxBubbles) || 1);
  const s = String(text || '').trim();
  if (!s) return { bubbles: [], dropped: '' };

  const parts = s.split(/\n+|(?<=[。！!？?])/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const t = trimAtSentence(s, cfg.maxChars);
    return { bubbles: [t.text], dropped: t.dropped };
  }

  const out = [];
  let buf = '';
  const append = (current, next) => {
    if (!current) return next;
    if (!next) return current;
    // 保留原来的分行结构；合并时用换行隔开，不要直接粘成一坨。
    return /[\n]$/.test(current) ? current + next : `${current}\n${next}`;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // 已经到最后一条额度：剩余全部并入，不 break、不丢。
    if (out.length >= maxBubbles - 1) { buf = append(buf, p); continue; }
    if (!buf) { buf = p; continue; }
    if ((buf + p).length <= cfg.splitThreshold) { buf = append(buf, p); continue; }
    out.push(buf);
    buf = p;
  }
  if (buf) out.push(buf);

  let dropped = '';
  const bubbles = out.map((t) => {
    if (t.length <= cfg.maxChars) return t;
    const r = trimAtSentence(t, cfg.maxChars);
    dropped += r.dropped;
    return r.text;
  }).filter(Boolean);

  return { bubbles, dropped };
}

/** 兼容旧调用：只要数组。但会丢掉 dropped 信息，不推荐新代码用。 */
export function splitBubblesArray(text, config = {}) {
  return splitBubbles(text, config).bubbles;
}
