/**
 * STEP 8 - 插件清单与拆分拓扑（新增自包含模块，零副作用）
 *
 * 供 08-IMPLEMENTATION.md 的 S9 拆分步使用。
 * 只做：清单定义、依赖校验、拓扑排序、section 契约、patch 条目模板、legacy 替换说明。
 * 不写 profile、不注册、不装载、不碰 fs。所有真实副作用由 DSH 按运行态完成。
 *
 * 模块格式与 step-7/8 一致（ESM）；CJS 转换同理。
 */

export const MAIN_PLUGIN = 'hello_world';
export const LEGACY_PLUGIN = 'whale-chan';

/** deps 是概念服务名，不是臆造的 ctx.<key>；真实键名由 DSH 按运行态定。 */
export const SUB_PLUGINS = [
  {
    id: 'hello_world-console',
    deps: ['memory', 'events'],
    section: null,
    route: '/whale-constellation',
    role: '星图 / 控制台 / growth API 只读展示',
  },
  {
    id: 'hello_world-growth',
    deps: ['memory', 'events', 'identity'],
    section: { key: 'growth', title: '成长' },
    route: '/whale-chan/api/growth',
    role: '原则演化 / 情绪 / 叙事 / 主动发送 / 成长时间线',
  },
  {
    id: 'hello_world-social',
    deps: ['memory', 'session'],
    section: { key: 'social', title: '人与边界' },
    route: null,
    role: 'peers / 记忆隔离 / 承诺 / 披露决策',
  },
  {
    id: 'hello_world-channels',
    deps: ['session', 'events'],
    section: { key: 'channels', title: '通道' },
    route: null,
    role: '微信 / QQ 桥 / senderId / 发送',
  },
  {
    id: 'hello_world-discovery',
    deps: ['plugin-registry', 'events', 'snapshots'],
    section: null,
    route: '/hello-world/plugins',
    role: '搜索 / 下载暂存 / 校验 / 提议 / 审批 / 审计',
  },
];

/** 主插件自己保留的设置页三项，不再承载全部能力。 */
export const MAIN_SECTIONS = [
  { key: 'identity', title: '身份' },
  { key: 'memory', title: '记忆' },
  { key: 'dialogue', title: '对话' },
];

/** 清单自检：重复 id、空 deps、section 冲突、route 冲突、依赖指向自身。 */
export function validateManifest(plugins = SUB_PLUGINS) {
  const errors = [];
  const ids = new Set();
  const sections = new Set();
  const routes = new Set();
  for (const p of plugins) {
    if (!p.id || ids.has(p.id)) errors.push(`duplicate_or_missing_id:${p.id}`);
    ids.add(p.id);
    if (!Array.isArray(p.deps) || !p.deps.length) errors.push(`empty_deps:${p.id}`);
    if ((p.deps || []).includes(p.id)) errors.push(`self_dep:${p.id}`);
    if (p.section) {
      if (sections.has(p.section.key)) errors.push(`duplicate_section:${p.section.key}`);
      sections.add(p.section.key);
    }
    if (p.route) {
      if (routes.has(p.route)) errors.push(`duplicate_route:${p.route}`);
      routes.add(p.route);
    }
  }
  for (const s of MAIN_SECTIONS) {
    if (sections.has(s.key)) errors.push(`section_collides_with_main:${s.key}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Kahn 拓扑排序：依赖少 / 弱耦合的先拆。返回 id 顺序。 */
export function topologicalOrder(plugins = SUB_PLUGINS) {
  const byId = new Map(plugins.map(p => [p.id, p]));
  const indegree = new Map(plugins.map(p => [p.id, 0]));
  const out = new Map(plugins.map(p => [p.id, []]));
  for (const p of plugins) {
    for (const d of p.deps) {
      if (!byId.has(d)) continue; // 概念服务，不是插件，不计入边
      indegree.set(p.id, indegree.get(p.id) + 1);
      out.get(d).push(p.id);
    }
  }
  const queue = plugins.filter(p => indegree.get(p.id) === 0).map(p => p.id);
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    result.push(id);
    for (const next of out.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  return result.length === plugins.length ? result : null; // null = 有环
}

/** 各插件独立入口契约；主插件只保留三项。 */
export function sectionContracts(plugins = SUB_PLUGINS) {
  return {
    main: { plugin: MAIN_PLUGIN, sections: MAIN_SECTIONS.slice() },
    subs: plugins.map(p => ({
      plugin: p.id,
      sections: p.section ? [p.section] : [],
      route: p.route || null,
    })),
  };
}

/** profile patch 条目模板：只返回结构，不写盘；字段名按运行态调整。 */
export function patchEntryTemplate(plugin) {
  return {
    id: plugin.id,
    // 真实 config / section 注册由 DSH 按现有 patch 结构填，不臆造字段
    config: { enabled: true },
    section: plugin.section || null,
    route: plugin.route || null,
    inject: (plugin.deps || []).slice(),
  };
}

/** 从单体迁移到主+附属的说明；卸载 / 删除 legacy 需按 04 §1 红线确认。 */
export function diffFromLegacy(plugins = SUB_PLUGINS) {
  return {
    replace: { from: LEGACY_PLUGIN, to: MAIN_PLUGIN },
    insert: plugins.map(p => patchEntryTemplate(p)),
    remove: {
      id: LEGACY_PLUGIN,
      requiresConfirmation: true,
      reason: '卸载 / 删 profile 属红线第 3 类；仅停用可记入留痕清单',
    },
    note: '逐层叠加顺序：组合包 → profile patch → home patch → overlay；改错层不生效',
  };
}
