/**
 * STEP 25 - 短应答不要单独起一行（纯函数）
 *
 * 现象（截图）：
 *   「嗯
 *     测出啥了」
 *   「在
 *     叫名字了 那我得应」
 * 一个气泡里先扔一个零信息的应答词，另起一行再说正事——读起来像发了两遍。
 *
 * 原因：cleanVoice 的 loosePunct 把句号换换行，voice-bubbles 又按 \n 拆 parts；
 *      极短应答词被当成一个独立段保留下来，后面内容另成一段。
 *
 * 规则：
 *  - 开头是 ≤3 字的应答词且后面还有内容 → 合并成「嗯，后文」，不换行
 *  - 后文太长（>40 字）→ 删掉应答词，直接说后文（长回复开头挂个「嗯」是累赘）
 *  - 只有应答词、没有后文 → 原样保留（「嗯」单独一条是对的）
 */

export const ACK_WORDS = [
  '嗯', '在', '是', '好', '行', '对', '收到', '明白', '懂了',
  '可以', '哦', '诶', '昂', '好嘞', '来了', '没有',
  '知道', '知道了', '晓得了', '我在',
];

export const DEFAULTS = {
  maxAckLen: 3,
  maxJoinLen: 40,     // 后文超过这个长度就丢掉应答词，不合并
};

/**
 * @returns { text, joined, droppedAck, ack }
 */
export function joinShortAck(input, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const s = String(input || '');
  if (!s) return { text: s, joined: false, droppedAck: false, ack: null };

  // 只认「应答词在开头 + 后面换行/空白 + 还有内容」
  const m = s.match(/^([^\s\n]{1,3})[\s\n]+([\s\S]+)$/);
  if (!m) return { text: s, joined: false, droppedAck: false, ack: null };

  const ack = m[1];
  const rest = m[2].trim();
  if (!rest) return { text: ack, joined: false, droppedAck: false, ack };
  if (ack.length > cfg.maxAckLen || !ACK_WORDS.includes(ack)) {
    return { text: s, joined: false, droppedAck: false, ack: null };
  }

  // 后文太长：删掉应答词，避免「嗯，」后面挂一大段
  if (rest.length > cfg.maxJoinLen) {
    return { text: rest, joined: false, droppedAck: true, ack };
  }

  // 合并成一句；后文里已有的换行压成空格
  const flat = rest.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text: `${ack}，${flat}`, joined: true, droppedAck: false, ack };
}

/** 自检：这条回复里有没有「应答词单独成段」的结构。 */
export function detectSplitAck(text) {
  const s = String(text || '');
  const m = s.match(/^([^\s\n]{1,3})[\s\n]+([\s\S]+)$/);
  if (!m) return { hit: false };
  const ack = m[1];
  return {
    hit: ACK_WORDS.includes(ack) && !!m[2].trim(),
    ack,
    rest: m[2].trim().slice(0, 30),
  };
}
