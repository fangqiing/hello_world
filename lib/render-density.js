/**
 * STEP 33 - 星图渲染参数（纯函数，从成品页抽出来，可单测/复用）
 *
 * 解决的问题：247 个发光点如果不按密度缩小，半透明光晕会叠成一整片粉橙色雾，
 * 星点看不见、标签被盖住。节点少时又不能缩得太小，所以要按数量自适应。
 */

export const DEFAULTS = {
  densityTarget: 70,     // 到这个节点数开始衰减
  densityMin: 0.25,
  densityMax: 1,
  alphaScale: 0.7,       // 整体亮度系数
  glowBase: 0.028,
  glowWake: 0.12,
  fitCoverage: 0.88,
  zoomMax: 2.2,
  zoomMin: 0.2,
  labelBase: 10,
  labelPerZoom: 10,
  labelMax: 32,
};

/** 密度衰减：sqrt(target/count)，节点越多每个点越小。 */
export function densityFactor(nodeCount, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const n = Math.max(1, Number(nodeCount) || 1);
  const f = Math.sqrt(c.densityTarget / n);
  return Math.max(c.densityMin, Math.min(c.densityMax, f));
}

/** 节点半径：重要度 × 透视近大远小 × 遗忘 × 密度。 */
export function nodeRadius({ base = 5, near = 1, alpha = 1, isCore = false } = {}, nodeCount = 1, cfg = {}) {
  return (isCore ? base * 1.8 : base) * near * (0.65 + 0.35 * alpha) * densityFactor(nodeCount, cfg);
}

/** 绘制节点时的 globalAlpha。 */
export function nodeAlpha(alpha = 1, near = 1, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return Math.max(0, Math.min(1, alpha * (0.55 + 0.45 * near) * c.alphaScale));
}

/** 中心光晕：醒来动画时短暂增亮。 */
export function glowAlpha(wakeT = 0, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return c.glowBase + Math.min(1, Math.max(0, wakeT)) * c.glowWake;
}

/** 标签预算：缩放越大显示越多，但永远有上限。 */
export function labelBudget(zoom = 1, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return Math.round(Math.min(c.labelMax, c.labelBase + zoom * c.labelPerZoom));
}

/** 标签优先级：选中 > 搜索命中 > 心流邻居 > 重要度 > 近。 */
export function labelPriority({ selected = false, matched = false, neighbor = false, importance = 0.5, scale = 1 } = {}) {
  return (selected ? 100 : 0) + (matched ? 60 : 0) + (neighbor ? 30 : 0)
    + importance * 10 + scale;
}

/** 适配全部：按投影后包围盒算 zoom，不做额外放大。 */
export function fitZoom(points = [], W = 1, H = 1, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!points.length || !W || !H) return 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const s = Math.min(W * c.fitCoverage / w, H * c.fitCoverage / h);
  return Math.min(c.zoomMax, Math.max(c.zoomMin, Number.isFinite(s) ? s : 1));
}
