/**
 * STEP 9 / B - 性能指标纯函数（零副作用）
 * runner / clock 注入；模块不碰 DB、不造数据、不写文件。
 * 模块格式与已发 step-8 包一致（ESM）。
 */

export function percentile(values, p) {
  const xs = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
  return xs[Math.max(0, idx)];
}

export function summarizeLatency(samples) {
  const xs = (samples || []).filter(Number.isFinite);
  if (!xs.length) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    min: Math.min(...xs),
    max: Math.max(...xs),
    mean: sum / xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
  };
}

/** 规模 -> 耗时曲线，用来判断 O(n) / O(n^2) 趋势。 */
export function latencyCurve(points = []) {
  return points
    .filter(p => Number.isFinite(p.n) && Number.isFinite(p.ms))
    .sort((a, b) => a.n - b.n)
    .map((p, i, arr) => ({
      n: p.n,
      ms: p.ms,
      perItem: p.ms / p.n,
      ratioToPrev: i ? p.ms / arr[i - 1].ms : null,
    }));
}

/** 改前/改后/目标/达标表；target 形如 { p95: { max: 50 } } 或 { precision: { min: 0.8 } }。 */
export function metricsTable(rows = [], targets = {}) {
  return rows.map(row => {
    const t = targets[row.key] || null;
    let ok = null;
    if (t && Number.isFinite(row.after)) {
      if (Number.isFinite(t.max)) ok = row.after <= t.max;
      if (Number.isFinite(t.min)) ok = ok === null ? row.after >= t.min : ok && row.after >= t.min;
    }
    return { key: row.key, before: row.before, after: row.after, target: t, ok };
  });
}

export class PerfProbe {
  constructor({ runner = null, clock = () => Date.now(), config = {} }) {
    Object.assign(this, { runner, clock });
    this.cfg = { iterations: 1000, warmup: 20, ...config };
    this.samples = new Map();
  }

  /** fn 由注入的 runner 执行；这里只计时与汇总。 */
  async measure(name, fn, iterations = this.cfg.iterations) {
    const xs = [];
    for (let i = 0; i < this.cfg.warmup + iterations; i += 1) {
      const t0 = this.clock();
      await fn(i);
      const t1 = this.clock();
      if (i >= this.cfg.warmup) xs.push(t1 - t0);
    }
    const summary = summarizeLatency(xs);
    this.samples.set(name, summary);
    return summary;
  }

  report() { return Object.fromEntries(this.samples.entries()); }
}
