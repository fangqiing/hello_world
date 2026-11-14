/**
 * STEP 34-38 - 内在状态的存储适配层
 *
 * 五个能力（好恶 / 立场 / 冲突 / 世界 / 图谱）都写成纯函数，SQL 全部收在这里。
 * 上层只调两个入口：harvestInner（从她的发言里攒数据）和 buildInnerBlocks（拼注入文本）。
 *
 * 为什么单独一层：pure 模块要能单测，带了 db 就测不动；
 * 而 SQL 散进 agent-layer 会让那个文件继续膨胀（已经 800 行）。
 */

import { PREFERENCE_DDL, extractPreferences, mergePreference, buildPreferenceBlock } from './preferences.js';
import { STANCE_DDL, extractStance, applyStance, relatedStances, buildStanceBlock } from './stance.js';
import { CONFLICT_DDL, detectEvent, nextState, buildConflictBlock } from './conflict.js';
import { WORLD_DDL, rollWorld, previousDate, buildWorldBlock } from './world-state.js';
import { GRAPH_DDL, findMentions, mergeEdge, buildSocialGraphBlock } from './social-graph.js';
import { zonedParts } from './temporal-context.js';

/** 全局作用域用空串而不是 NULL —— SQLite 的唯一索引不约束 NULL，会导致重复行。 */
const GLOBAL = '';

export function ensureInnerSchema(store) {
  const db = store.db;
  for (const ddl of [PREFERENCE_DDL, STANCE_DDL, CONFLICT_DDL, WORLD_DDL, GRAPH_DDL]) {
    db.exec(ddl);
  }
}

function todayKey(timeZone) {
  try {
    return zonedParts(timeZone).date;
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

// ------------------------------------------------------------ preferences ---

function loadPreferences(store, scope, peerId) {
  try {
    return store.db
      .prepare('SELECT * FROM preferences WHERE scope = ? AND peer_id = ? ORDER BY last_at DESC LIMIT 60')
      .all(scope, peerId || GLOBAL)
      .map((row) => ({ ...row, target: row.target, polarity: Number(row.polarity), hits: Number(row.hits) }));
  } catch (err) {
    return [];
  }
}

function savePreference(store, scope, peerId, pref) {
  const row = store.db
    .prepare('SELECT * FROM preferences WHERE scope = ? AND peer_id = ? AND target = ?')
    .get(scope, peerId || GLOBAL, pref.target);
  const id = row?.id || `pf_${pref.target.length}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  store.db
    .prepare(`INSERT INTO preferences (id, peer_id, scope, target, polarity, confidence, hits, conflict, reason, first_at, last_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET polarity = excluded.polarity, confidence = excluded.confidence,
                hits = excluded.hits, conflict = excluded.conflict, reason = excluded.reason, last_at = excluded.last_at`)
    .run(id, peerId || GLOBAL, scope, pref.target, pref.polarity, pref.confidence,
      pref.hits, pref.conflict || 0, pref.reason || '', pref.first_at || Date.now(), pref.last_at || Date.now());
}

// ----------------------------------------------------------------- stances ---

function loadStances(store, peerId) {
  try {
    return store.db
      .prepare('SELECT * FROM stances WHERE peer_id = ? ORDER BY updated_at DESC LIMIT 60')
      .all(peerId || GLOBAL);
  } catch (err) {
    return [];
  }
}

function loadStanceHistory(store, stanceIds) {
  if (!stanceIds.length) return {};
  const marks = stanceIds.map(() => '?').join(',');
  try {
    const rows = store.db
      .prepare(`SELECT * FROM stance_history WHERE stance_id IN (${marks}) ORDER BY changed_at ASC`)
      .all(...stanceIds);
    const out = {};
    for (const row of rows) {
      if (!out[row.stance_id]) out[row.stance_id] = [];
      out[row.stance_id].push(row);
    }
    return out;
  } catch (err) {
    return {};
  }
}

function saveStance(store, peerId, stance, history) {
  store.db
    .prepare(`INSERT INTO stances (id, peer_id, topic, polarity, confidence, reason, hits, first_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET polarity = excluded.polarity, confidence = excluded.confidence,
                reason = excluded.reason, hits = excluded.hits, updated_at = excluded.updated_at`)
    .run(stance.id, peerId || GLOBAL, stance.topic, stance.polarity, stance.confidence,
      stance.reason || '', stance.hits, stance.first_at, stance.updated_at);
  if (history) {
    store.db
      .prepare(`INSERT OR REPLACE INTO stance_history (id, stance_id, polarity, confidence, reason, changed_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(history.id, history.stance_id, history.polarity, history.confidence, history.reason || '', history.changed_at);
  }
}

// ---------------------------------------------------------------- conflicts ---

function loadConflict(store, peerId) {
  try {
    return store.db.prepare('SELECT * FROM conflicts WHERE peer_id = ?').get(peerId) || null;
  } catch (err) {
    return null;
  }
}

function saveConflict(store, peerId, conflict) {
  store.db
    .prepare(`INSERT INTO conflicts (id, peer_id, state, cause, opened_at, last_at, closed_at, repair_attempts, unresolved)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(peer_id) DO UPDATE SET state = excluded.state, cause = excluded.cause,
                opened_at = excluded.opened_at, last_at = excluded.last_at, closed_at = excluded.closed_at,
                repair_attempts = excluded.repair_attempts, unresolved = excluded.unresolved`)
    .run(`cf_${peerId}`, peerId, conflict.state, conflict.cause || '',
      conflict.opened_at || 0, conflict.last_at || 0, conflict.closed_at || 0,
      conflict.repair_attempts || 0, conflict.unresolved || 0);
}

// -------------------------------------------------------------------- world ---

/** 确保当天的世界状态存在；没有就滚一个，并把前一天作为天气惯性输入。 */
function ensureWorldDay(store, worldId, timeZone, now = Date.now()) {
  const date = todayKey(timeZone);
  try {
    const hit = store.db.prepare('SELECT * FROM world_state WHERE world_id = ? AND date = ?').get(worldId, date);
    if (hit) return hit;
    const yKey = previousDate(date);
    const prev = store.db.prepare('SELECT weather FROM world_state WHERE world_id = ? AND date = ?').get(worldId, yKey);
    const rolled = rollWorld({ date, worldId, prevWeather: prev?.weather || null });
    store.db
      .prepare(`INSERT OR REPLACE INTO world_state (id, world_id, date, season, weather, activity, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rolled.id, worldId, date, rolled.season, rolled.weather, rolled.activity, rolled.note || '', now);
    return rolled;
  } catch (err) {
    return null;
  }
}

// -------------------------------------------------------------------- edges ---

function loadEdges(store) {
  try {
    return store.db.prepare('SELECT * FROM peer_edges ORDER BY weight DESC LIMIT 200').all();
  } catch (err) {
    return [];
  }
}

function saveEdge(store, edge) {
  store.db
    .prepare(`INSERT INTO peer_edges (id, a_id, b_id, kind, weight, note, source, shareable, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET weight = excluded.weight, note = excluded.note,
                source = excluded.source, updated_at = excluded.updated_at`)
    .run(edge.id, edge.a_id, edge.b_id, edge.kind, edge.weight, edge.note || '',
      edge.source || '', edge.shareable, edge.created_at, edge.updated_at);
}

// ------------------------------------------------------------------ harvest ---

/**
 * 从她自己的发言里攒数据。幂等：用 kv 记游标，只处理新行。
 *
 * @param {object} store
 * @param {{peerId:string, rows:Array<{id:string,text:string,createdAt:number}>, peers:Array, now?:number}} args
 */
export function harvestInner(store, { peerId, rows = [], peers = [], now = Date.now() } = {}) {
  const stats = { prefs: 0, stances: 0, edges: 0 };
  if (!peerId || !rows.length) return stats;

  const cursorKey = `inner:cursor:${peerId}`;
  const last = Number(store.kvGet(cursorKey, 0)) || 0;
  const fresh = rows
    .filter((row) => row && row.text && Number(row.createdAt) > last)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  if (!fresh.length) return stats;

  for (const row of fresh) {
    const at = Number(row.createdAt) || now;
    const text = String(row.text);

    // 好恶：scope=self 表示她自己长出来的，跟谁说的都一样，归到全局。
    for (const found of extractPreferences(text)) {
      const existing = store.db
        .prepare('SELECT * FROM preferences WHERE scope = ? AND peer_id = ? AND target = ?')
        .get('self', GLOBAL, found.target);
      const merged = mergePreference(existing ? {
        ...existing,
        hits: Number(existing.hits),
        confidence: Number(existing.confidence),
        conflict: Number(existing.conflict),
      } : null, found, at);
      savePreference(store, 'self', GLOBAL, merged);
      stats.prefs += 1;
    }

    // 立场：按 peer 分，因为对不同人可能说不同的话。
    const stances = loadStances(store, peerId);
    for (const found of extractStance(text)) {
      const current = stances.find((item) => item.topic === found.topic) || null;
      const { stance, history } = applyStance(current, found, { at });
      saveStance(store, peerId, stance, history);
      stats.stances += 1;
    }

    // 图谱：她提到别人时记一条边。
    for (const mention of findMentions(text, peers, { selfId: peerId })) {
      const existing = store.db
        .prepare('SELECT * FROM peer_edges WHERE a_id = ? AND b_id = ? AND kind = ?')
        .get(peerId, mention.bId, mention.kind);
      const merged = mergeEdge(existing || null, {
        aId: peerId,
        bId: mention.bId,
        kind: mention.kind,
        note: text.slice(0, 120),
        source: text.slice(0, 300),
      }, at);
      saveEdge(store, merged);
      stats.edges += 1;
    }
  }

  store.kvSet(cursorKey, Number(fresh[fresh.length - 1].createdAt) || now);
  return stats;
}

// ------------------------------------------------------------------ advance ---

/**
 * 推进冲突状态。每轮调一次，信号来自当前输入与心情。
 * 返回值只用于调试，不参与 prompt。
 */
export function advanceConflict(store, {
  peerId, lastUserText = '', irritation = 0, idleMs = 0, now = Date.now(),
} = {}) {
  if (!peerId) return null;
  const prev = loadConflict(store, peerId);
  const deltaKey = `inner:irritation:${peerId}`;
  const prevIrritation = Number(store.kvGet(deltaKey, 0)) || 0;
  const irritationDelta = Number(irritation) - prevIrritation;
  store.kvSet(deltaKey, Number(irritation) || 0);

  const text = String(lastUserText || '');
  const userApology = /对不起|抱歉|我错了|别生气|是我不好|我道歉/.test(text);
  const userWarmth = /想你|抱抱|辛苦了|别不开心|我陪你|乖/.test(text);

  const event = detectEvent({
    irritation, irritationDelta, userApology, userWarmth, idleMs, now, conflict: prev,
  });
  const cause = prev?.state && prev.state !== 'normal'
    ? prev.cause
    : (text ? text.slice(0, 40) : '');

  const { conflict, changed } = nextState(prev, event, { now, cause });
  if (changed || !prev) saveConflict(store, peerId, conflict);
  return changed ? { state: conflict.state, note: event?.type || 'timeout' } : null;
}

// ------------------------------------------------------------------- blocks ---

/**
 * 拼所有注入块。顺序即注意力顺序：背景在前，当下情绪在后。
 * 任何一块失败都不影响其它块 —— 这是保证她不至于因为一个模块报错就整轮失忆。
 */
export function buildInnerBlocks(store, {
  peerId, query = '', peers = [], peerLabels = {}, isGroup = false,
  timeZone = 'Asia/Shanghai', worldId = 'default', now = Date.now(),
} = {}) {
  const blocks = [];

  try {
    const world = ensureWorldDay(store, worldId, timeZone, now);
    const text = buildWorldBlock(world);
    if (text) blocks.push(text);
  } catch (err) { /* 世界块失败不影响其它 */ }

  try {
    const text = buildPreferenceBlock(loadPreferences(store, 'self', GLOBAL), { now });
    if (text) blocks.push(text);
  } catch (err) { /* 同上 */ }

  try {
    const all = loadStances(store, peerId);
    const related = relatedStances(query, all);
    if (related.length) {
      const text = buildStanceBlock(related, { historyByStance: loadStanceHistory(store, related.map((s) => s.id)) });
      if (text) blocks.push(text);
    }
  } catch (err) { /* 同上 */ }

  try {
    const text = buildSocialGraphBlock(peerId, loadEdges(store), { labels: peerLabels, isGroup });
    if (text) blocks.push(text);
  } catch (err) { /* 同上 */ }

  try {
    const text = buildConflictBlock(loadConflict(store, peerId), { now });
    if (text) blocks.push(text);
  } catch (err) { /* 同上 */ }

  void peers;
  return blocks;
}
