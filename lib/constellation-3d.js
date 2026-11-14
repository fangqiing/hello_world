/**
 * STEP 30 - 识海 3D：布局、投影、深度排序（纯函数）
 *
 * 对齐参考视频的七条标准：
 *  ① 由外向内分层：新经历在外环，越重要越靠内，核心在中心
 *  ② 原意识：所有线向中心汇聚
 *  ③ 心光：此刻激活的节点加亮
 *  ④ 心流：一个念头牵出下一个念头（沿 links 的发光链）
 *  ⑤ 遗忘：旧细节淡去，重要的沉得更深
 *  ⑥ 醒来：中心核爆式发光、放射线铺满
 *  ⑦ 3D：球面分布 + 透视投影 + 可旋转
 */

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export const LAYER_COLOR = {
  soul: '#ffe9b8', core: '#ffe9b8', self: '#ffe9b8',
  user: '#ffb3c8', fact: '#9fc4ff', project: '#ffd48f',
  preference: '#8fe3c0', skill: '#8fd8ff', topic: '#c3a6ff',
  lesson: '#ff9e7d', episode: '#9aa7bd', rule: '#b8d97a',
};

export function colorOf(layer) {
  return LAYER_COLOR[String(layer || '').toLowerCase()] || '#9fc4ff';
}

export function isCore(n) {
  const l = String(n.layer || '').toLowerCase();
  return l === 'soul' || l === 'core' || l === 'self' || l === 'identity';
}

/** 数据适配：兼容 text / content、createdAt / at / ts。 */
export function buildNodes(raw = []) {
  return (raw || []).filter(n => n && n.id != null).map(n => ({
    id: String(n.id),
    text: String(n.text || n.content || '').slice(0, 80),
    layer: String(n.layer || 'fact'),
    importance: Number.isFinite(Number(n.importance)) ? Number(n.importance) : 0.5,
    links: Array.isArray(n.links) ? n.links.map(String) : [],
    createdAt: Number(n.createdAt || n.at || n.ts) || 0,
    peerId: n.peerId || n.peer_id || null,
  }));
}

/**
 * 3D 球面布局。
 * 半径 = 环号：core 在 0，重要度高的靠内，新的在外。
 * 用 Fibonacci 球面分布保证旋转时不会挤成一团。
 */
export function radial3D(nodes = [], { ringGap = 90, rings = 5, seed = 20261108 } = {}) {
  const list = nodes.slice();
  const out = new Map();
  const cores = list.filter(isCore);
  const others = list.filter(n => !isCore(n));
  let s0 = seed >>> 0 || 1;
  const rnd = () => { s0 = (s0 * 1664525 + 1013904223) >>> 0; return s0 / 4294967296; };
  const maxR = rings * ringGap;

  cores.forEach((n, i) => {
    const a = i * GOLDEN;
    out.set(n.id, { x: Math.cos(a) * 8, y: Math.sin(a) * 8, z: 0, ring: 0, core: true });
  });

  // 每层一个方向偏置，让同层大致成团（像星云团块，不是同心圆）
  const layers = [...new Set(others.map(n => n.layer))];
  const dirs = new Map();
  layers.forEach((l, i) => {
    const a = i * GOLDEN;
    dirs.set(l, { x: Math.cos(a), y: Math.sin(a), z: Math.sin(a * 0.7) });
  });

  others.forEach(n => {
    const impF = Math.max(0, Math.min(1, Number(n.importance) || 0.5));
    // 中心留空：最内也有 0.42R，避免重要节点全挤成一团
    const minR = 0.42 * maxR;
    const baseR = minR + (maxR - minR) * (1 - impF) * 0.95;
    const R = Math.max(minR * 0.72, baseR * (0.72 + rnd() * 0.62));
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const d = dirs.get(n.layer) || { x: 0, y: 0, z: 0 };
    const dx = s * Math.cos(phi) + d.x * 0.5;
    const dy = s * Math.sin(phi) + d.y * 0.5;
    const dz = u + d.z * 0.4;
    const len = Math.hypot(dx, dy, dz) || 1;
    out.set(n.id, {
      x: dx / len * R,
      y: dy / len * R,
      z: dz / len * R * 1.25,   // z 放大，拖拽时纵深更明显
      ring: Math.round(R / ringGap),
      core: false,
    });
  });
  return { positions: out, maxR };
}

/** 绕 Y 轴 yaw、绕 X 轴 pitch 旋转。 */
export function rotate(p, yaw = 0, pitch = 0) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const y2 = p.y * cp - z1 * sp;
  const z2 = p.y * sp + z1 * cp;
  return { x: x1, y: y2, z: z2 };
}

/** 透视投影：z 越大（越远）越小越暗。 */
export function project(p, { cx = 0, cy = 0, focal = 600, zoom = 1 } = {}) {
  const s = focal / Math.max(80, focal + p.z);
  return {
    x: cx + p.x * s * zoom,
    y: cy + p.y * s * zoom,
    s,
    depth: p.z,
  };
}

/** 远 → 近，保证近处节点盖在远处之上。 */
export function depthSort(items = []) {
  return items.slice().sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
}

/** 遗忘：21 天半衰，重要度与核心层兜底。 */
export function fadeFactor(node, now = Date.now(), { halfLifeDays = 21, floor = 0.12 } = {}) {
  const t = Number(node && node.createdAt);
  const imp = Number(node && node.importance);
  const impF = Number.isFinite(imp) ? Math.max(0, Math.min(1, imp)) : 0.5;
  if (!Number.isFinite(t) || t <= 0) return Math.min(1, floor + (1 - floor) * (0.5 + 0.5 * impF));
  const age = Math.max(0, (now - t) / 86400000);
  return Math.max(floor, Math.min(1, floor + (1 - floor) * Math.exp(-age / halfLifeDays) * (0.45 + 0.55 * impF)));
}

/** 边：links 双向去重 + 每个节点连向中心（原意识辐射）。 */
export function buildEdges(nodes = [], { radial = true } = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = [];
  const seen = new Set();
  for (const n of nodes) {
    for (const t of n.links) {
      if (!byId.has(t) || t === n.id) continue;
      const k = n.id < t ? `${n.id}|${t}` : `${t}|${n.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ source: n.id, target: t, kind: 'link' });
    }
  }
  if (radial) {
    for (const n of nodes) {
      if (isCore(n)) continue;
      edges.push({ source: n.id, target: '__core__', kind: 'radial' });
    }
  }
  return edges;
}

/** 心流：沿 links 做 BFS，返回一条联想链。 */
export function flowPath(edges = [], startId, { maxDepth = 5, limit = 14 } = {}) {
  const adj = new Map();
  for (const e of edges) {
    if (e.kind !== 'link') continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  const s = String(startId);
  const seen = new Set([s]);
  const path = [s];
  let frontier = [s];
  for (let d = 0; d < maxDepth && frontier.length && path.length < limit; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) || []) {
        if (seen.has(nb)) continue;
        seen.add(nb); path.push(nb); next.push(nb);
        if (path.length >= limit) break;
      }
      if (path.length >= limit) break;
    }
    frontier = next;
  }
  return path;
}

/** 投影后的包围盒 → 适配缩放（解决「247 条只画一个点」）。 */
export function fitView(points = [], W, H, { padding = 0.06, maxZoom = 3.5 } = {}) {
  if (!points.length || !W || !H) return 1;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of points) {
    a = Math.min(a, p.x); c = Math.max(c, p.x);
    b = Math.min(b, p.y); d = Math.max(d, p.y);
  }
  const w = Math.max(1, c - a), h = Math.max(1, d - b);
  const s = Math.min(W * (1 - 2 * padding) / w, H * (1 - 2 * padding) / h);
  return Math.min(maxZoom, Math.max(0.2, Number.isFinite(s) ? s : 1));
}
