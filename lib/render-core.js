/**
 * STEP 35 - 核心与节点大小（纯函数）
 *
 * 本次只修两件：
 *  1 核心比普通节点小 —— 核心被 density 和 near 一起压，重要度高的节点反而更大
 *  2 中心出现空心环 —— sprite 三段式渐变放大后露出环带，且核心被画了两次
 */

export const CORE = {
  radius: 26,        // 核心固定半径，不吃 density / near
  wakeBoost: 30,     // 醒来动画加多少
  nodeCap: 13,       // 普通节点半径封顶，永远小于核心
  spriteMid: 0.30,   // sprite 渐变第二段（原 .16，太小会出环）
  spriteFade: 0.62,  // sprite 渐变第三段（原 .45）
};

export function isCoreNode(node) {
  const l = String((node && node.layer) || '').toLowerCase();
  return l === 'soul' || l === 'core' || l === 'self' || l === 'identity';
}

/** 核心半径：不随节点数量、不随透视缩放。 */
export function coreRadius(wakeT = 0, cfg = {}) {
  const c = { ...CORE, ...cfg };
  return c.radius + Math.min(1, Math.max(0, wakeT)) * c.wakeBoost;
}

/** 普通节点半径：保留密度/透视/遗忘，但封顶。 */
export function nodeRadius({ base = 5, near = 1, alpha = 1, density = 1 } = {}, cfg = {}) {
  const c = { ...CORE, ...cfg };
  return Math.min(c.nodeCap, base * near * (0.65 + 0.35 * alpha) * density);
}

/** 核心必须在 nodes 循环里跳过，否则会和末尾的中心绘制叠加出环。 */
export function shouldDrawInNodeLoop(node) {
  return !isCoreNode(node);
}

/** sprite 径向渐变：平滑衰减，放大不出环。 */
export function spriteStops(cfg = {}) {
  const c = { ...CORE, ...cfg };
  return [
    [0, 'rgba(255,255,255,.98)'],
    [c.spriteMid, 'rgba(R,G,B,.82)'],
    [c.spriteFade, 'rgba(R,G,B,.14)'],
    [1, 'rgba(R,G,B,0)'],
  ];
}

/** 核心用的径向渐变：五段平滑，没有突然跳变。 */
export function coreGradientStops() {
  return [
    [0, 'rgba(255,253,245,1)'],
    [0.16, 'rgba(255,244,214,.95)'],
    [0.38, 'rgba(255,228,176,.34)'],
    [0.66, 'rgba(198,212,255,.10)'],
    [1, 'rgba(120,160,255,0)'],
  ];
}
