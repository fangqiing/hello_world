/**
 * STEP 36 - 光晕收紧（纯函数）
 *
 * 上一版（35）仍然偏亮偏雾，原因：
 *  1 绘制尺寸是 r×4（核 1r + 光晕外扩 1r），外扩区太大
 *  2 sprite 的 .30 处还有 82% 不透明度，叠 247 个就是一片云
 *  3 整体 alpha 0.7 偏高
 *
 * 本次：外扩收到 0.3r、可见渐变只占内 34%、alpha 降到 0.52，并加一个实心小核。
 */

export const GLOW = {
  drawScale: 2.6,      // 原 4；直径 = r × 2.6
  drawOffset: 1.3,     // 原 2；左上角偏移 = r × 1.3
  alphaScale: 0.52,    // 原 0.7
  coreRatio: 0.34,     // 实心核半径 = r × 0.34
  coreMin: 1.1,
  labelAlpha: 0.82,    // 原 0.95
  labelMaxLen: 14,
};

/** sprite 径向渐变：可见部分只到 34%，外面直接透明。 */
export function spriteStops(rgb = '255,255,255', cfg = {}) {
  const c = { ...GLOW, ...cfg };
  return [
    [0, 'rgba(255,255,255,1)'],
    [0.18, `rgba(${rgb},.92)`],
    [0.34, `rgba(${rgb},.16)`],
    [0.55, `rgba(${rgb},0)`],
    [1, `rgba(${rgb},0)`],
  ];
}

/** 绘制几何：offset 是左上角偏移，size 是边长。 */
export function drawGeometry(r, cfg = {}) {
  const c = { ...GLOW, ...cfg };
  return { offset: r * c.drawOffset, size: r * c.drawScale };
}

/** 光晕的 globalAlpha。 */
export function glowAlpha(alpha = 1, near = 1, cfg = {}) {
  const c = { ...GLOW, ...cfg };
  return Math.max(0, Math.min(1, alpha * (0.55 + 0.45 * near) * c.alphaScale));
}

/** 实心核半径与不透明度。 */
export function coreDot(r, alpha = 1, near = 1, cfg = {}) {
  const c = { ...GLOW, ...cfg };
  return {
    radius: Math.max(c.coreMin, r * c.coreRatio),
    alpha: Math.min(1, alpha * (0.78 + 0.22 * near)),
  };
}

/** 标签文本：wxid / 长 hex / chatroom 统一收成「（某人）」。 */
export function labelText(s, cfg = {}) {
  const c = { ...GLOW, ...cfg };
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^wxid_/i.test(t) || /^[0-9a-f]{16,}$/i.test(t) || /@chatroom$/i.test(t)) return '（某人）';
  return t.length > c.labelMaxLen ? t.slice(0, c.labelMaxLen) + '…' : t;
}
