/**
 * STEP 10 / ③ - 星图布局纯函数（零 DOM 依赖，可单测）
 *
 * 默认完全静止：布局一次算完，前端不施加持续旋转。
 * 确定性：固定种子的伪随机，刷新页面节点不跳位。
 */

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** nodes: [{ id, text, layer, importance, links?, ... }] */
export function buildGraph(nodes = []) {
  const byId = new Map();
  for (const n of nodes) {
    if (!n || n.id == null) continue;
    byId.set(String(n.id), {
      id: String(n.id),
      text: String(n.text || ''),
      layer: String(n.layer || 'fact'),
      importance: Number.isFinite(Number(n.importance)) ? Number(n.importance) : 0.5,
      links: Array.isArray(n.links) ? n.links.map(String) : [],
      raw: n,
    });
  }
  const edges = [];
  const seen = new Set();
  for (const n of byId.values()) {
    for (const target of n.links) {
      if (!byId.has(target) || target === n.id) continue;
      const key = n.id < target ? `${n.id}|${target}` : `${target}|${n.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: n.id, target });
    }
  }
  const degree = new Map([...byId.keys()].map(id => [id, 0]));
  for (const e of edges) {
    degree.set(e.source, degree.get(e.source) + 1);
    degree.set(e.target, degree.get(e.target) + 1);
  }
  return { nodes: [...byId.values()], edges, degree };
}

/**
 * 力导向：斥力 + 弹簧 + 轻微向心。输出世界坐标。
 * 复杂度 O(n^2 * iterations)，由服务端 limit 控制节点数；大图请降低 iterations。
 */
export function forceLayout(graph, { iterations = 180, width = 900, height = 620, seed = 20261107 } = {}) {
  const nodes = graph.nodes;
  if (!nodes.length) return { positions: new Map(), bounds: { minX: 0, minY: 0, maxX: width, maxY: height } };
  const rnd = seeded(seed);
  const pos = new Map(nodes.map(n => [n.id, {
    x: (rnd() - 0.5) * width * 0.8,
    y: (rnd() - 0.5) * height * 0.8,
  }]));
  const k = Math.sqrt((width * height) / Math.max(1, nodes.length));
  const byId = new Map(nodes.map(n => [n.id, n]));

  for (let step = 0; step < iterations; step += 1) {
    const force = new Map(nodes.map(n => [n.id, { x: 0, y: 0 }]));
    // 斥力
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = pos.get(nodes[i].id);
        const b = pos.get(nodes[j].id);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = rnd() - 0.5; dy = rnd() - 0.5; d2 = 0.01; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        const fa = force.get(nodes[i].id);
        const fb = force.get(nodes[j].id);
        fa.x += ux * f; fa.y += uy * f;
        fb.x -= ux * f; fb.y -= uy * f;
      }
    }
    // 弹簧
    for (const e of graph.edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / (k * 8);
      const ux = dx / d;
      const uy = dy / d;
      const fa = force.get(e.source);
      const fb = force.get(e.target);
      fa.x += ux * f; fa.y += uy * f;
      fb.x -= ux * f; fb.y -= uy * f;
    }
    // 向心 + 高中心度靠内
    for (const n of nodes) {
      const p = pos.get(n.id);
      const f = force.get(n.id);
      const deg = graph.degree.get(n.id) || 0;
      const pull = 0.02 + Math.min(0.03, deg * 0.004) + n.importance * 0.01;
      f.x -= p.x * pull;
      f.y -= p.y * pull;
    }
    // 位移（随迭代降温）
    const temp = k * (1 - step / (iterations + 1)) * 0.12;
    for (const n of nodes) {
      const p = pos.get(n.id);
      const f = force.get(n.id);
      const len = Math.max(0.001, Math.hypot(f.x, f.y));
      p.x += (f.x / len) * Math.min(temp, len);
      p.y += (f.y / len) * Math.min(temp, len);
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width * 0.82) / spanX, (height * 0.82) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const positions = new Map();
  for (const [id, p] of pos) {
    positions.set(id, { x: (p.x - cx) * scale, y: (p.y - cy) * scale });
  }
  return { positions, bounds: { minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 }, byId };
}

/** 世界坐标 → 屏幕坐标；view = { scale, offsetX, offsetY, width, height } */
export function project(point, view) {
  return {
    x: point.x * view.scale + view.offsetX + (view.width || 0) / 2,
    y: point.y * view.scale + view.offsetY + (view.height || 0) / 2,
  };
}

/** 小节点最小命中半径 8px，返回最近命中。 */
export function hitTest(nodes, positions, view, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const s = project(p, view);
    const radius = Math.max(4, 3 + n.importance * 7) * Math.max(0.6, Math.min(2, view.scale));
    const dist = Math.hypot(s.x - x, s.y - y);
    const hitRadius = Math.max(8, radius + 3);
    if (dist <= hitRadius && dist < bestDist) { best = n; bestDist = dist; }
  }
  return best;
}

export function neighborsOf(graph, id) {
  const out = new Set();
  for (const e of graph.edges) {
    if (e.source === id) out.add(e.target);
    if (e.target === id) out.add(e.source);
  }
  return [...out];
}
