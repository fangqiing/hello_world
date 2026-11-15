/**
 * STEP 41 - 主动消息拆条（纯函数）
 *
 * 用户要的是「看情况」：小念头一两句就够，真有事说清楚。
 * 模型用空行分段表达「这是两口气」，这里负责把它变成两条消息。
 *
 * 上限两条的理由：
 *   ① 超过两条像刷屏，真人不会为一件小事连发五条；
 *   ② 微信连发本身有风控风险，主动消息更不该叠量。
 */

export const MAX_BUBBLES = 2;

/**
 * @param {string} text 模型输出，可能含空行分段
 * @returns {string[]} 至少一条；空输入返回空数组，由调用方决定是否发送
 */
export function splitBubbles(text, { max = MAX_BUBBLES } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const segments = raw
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!segments.length) return [];
  if (segments.length <= max) return segments;
  // 超出上限时，把余下的并进最后一条，不丢内容也不多占一条消息。
  const head = segments.slice(0, max - 1);
  const tail = segments.slice(max - 1).join('\n');
  return [...head, tail];
}
