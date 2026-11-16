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
import { extractRelations, extractAliases, buildPersonBlock } from './persons.js';
import { zonedParts } from './temporal-context.js';

/**
 * STEP 42 人物层。
 *
 * 为什么单独建表而不是塞进 peers：peers 是「通道身份」（谁在跟我说话），
 * persons 是「她认识的人」（她脑子里的人物册）。同一个人可能没有 peer 记录
 * （比如她只听说过），也可能一个人有好几个叫法（`-ing` / `岐`）。
 */
export const PERSON_DDL = `
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  peer_id TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'real',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_peer ON persons(peer_id);
CREATE TABLE IF NOT EXISTS person_aliases (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias ON person_aliases(alias);
CREATE TABLE IF NOT EXISTS social_facts (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'relation',
  value REAL NOT NULL DEFAULT 0,
  raw TEXT NOT NULL DEFAULT '',
  source_peer TEXT NOT NULL DEFAULT '',
  source_episode TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_facts_person ON social_facts(person_id, kind);
`;

/** 全局作用域用空串而不是 NULL —— SQLite 的唯一索引不约束 NULL，会导致重复行。 */
const GLOBAL = '';

export function ensureInnerSchema(store) {
  const db = store.db;
  for (const ddl of [PREFERENCE_DDL, STANCE_DDL, CONFLICT_DDL, WORLD_DDL, GRAPH_DDL, PERSON_DDL]) {
    db.exec(ddl);
  }
  try {
    syncPersons(store);
  } catch (err) {
    // 同步失败不该拖垮启动，人物块降级为空即可
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

/**
 * 给主动消息用的当天世界。取不到返回 null，调用方据此少一条素材而不是报错。
 */
export function todayWorld(store, { worldId = 'default', timeZone = 'Asia/Shanghai', now = Date.now() } = {}) {
  try {
    return ensureWorldDay(store, worldId, timeZone, now)
  } catch (err) {
    return null
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

  // 没有起因就不开启摩擦。线上出现过 state=friction 但 cause 为空的情况，
  // 结果是她在什么都没发生的时候闹别扭 —— 比不闹更假。
  if (event && event.type === 'irritation_spike' && !String(cause).trim()) return null;

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

// ------------------------------------------------------------------ persons ---

/** 按 label 或别名找人。别名表让 `-ing` 和 `岐` 落到同一条记录上。 */
function personByAnyLabel(store, label) {
  const direct = store.db.prepare('SELECT * FROM persons WHERE label = ?').get(label);
  if (direct) return direct;
  return store.db
    .prepare('SELECT p.* FROM person_aliases a JOIN persons p ON p.id = a.person_id WHERE a.alias = ?')
    .get(label) || null;
}

/**
 * 把 peers 同步进 persons。每次启动跑一次，幂等。
 * 这是「真人」进人物库的唯一入口 —— 她虚构的人物不走这条路。
 */
export function syncPersons(store) {
  let changed = 0;
  const peers = store.db.prepare('SELECT id, display_name, learned_name FROM peers').all();
  for (const peer of peers) {
    const label = String(peer.learned_name || peer.display_name || peer.id || '').trim();
    if (!label) continue;
    let person = store.db.prepare('SELECT * FROM persons WHERE peer_id = ?').get(peer.id);
    if (!person) {
      store.db
        .prepare('INSERT OR IGNORE INTO persons (id, peer_id, label, kind, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(`ps_${String(peer.id).split(':').pop()}`, peer.id, label, 'real', '', Date.now());
      person = store.db.prepare('SELECT * FROM persons WHERE peer_id = ?').get(peer.id);
      changed += 1;
    } else if (person.label !== label) {
      store.db.prepare('UPDATE persons SET label = ? WHERE id = ?').run(label, person.id);
      changed += 1;
    }
    if (!person) continue;
    for (const alias of [peer.display_name, peer.learned_name]) {
      const text = String(alias || '').trim();
      if (!text) continue;
      store.db
        .prepare('INSERT OR IGNORE INTO person_aliases (id, person_id, alias, created_at) VALUES (?,?,?,?)')
        .run(`pa_${text}`, person.id, text, Date.now());
    }
  }
  return changed;
}

/** 对方自报名字：「我叫某某」「也可以叫我小名」。这是把人名接进人物库的唯一现实入口。 */
function extractSelfIntro(text) {
  const source = String(text || '').replace(/^\[[^\]]*\]\s*/, ''); // 去掉「[来自 微信，-ing]」前缀
  const out = [];
  // 名字 1-6 字，且必须紧跟标点或行尾 —— 没有这个约束，「我是刚才在想」会被当成名字。
  const re = /(?:我是|叫我|我叫|称呼我)([\u4e00-\u9fa5A-Za-z0-9_-]{1,6})(?=[，。！？、,.!?；;：:\s]|$)/g;
  // 虚词开头的基本都是句子碎片：「在调侃你」「什么名字」。
  const bad = /^(谁|什么|那个|这个人|朋友|陌生人|同事|同学|老师|家人|一个人|在|的|了|是|有|这|那|什|怎)/;
  const filler = /[的了着过吗呢吧啊呀哦嘛]/;
  const pronoun = /[你我他她它]/;
  let m = re.exec(source);
  while (m) {
    const name = String(m[1] || '').trim();
    if (name && !bad.test(name) && !filler.test(name) && !pronoun.test(name)) out.push(name);
    m = re.exec(source);
  }
  return out;
}

/**
 * 从她的发言里攒关系与别名。幂等：按会话记游标。
 * 没有对应人物的关系直接丢 —— 不建「来历不明的人」，那只会污染人物页。
 *
 * userRows 用来抓对方的自报名字：没有这一步，人物库里只有微信昵称，
 * 「岐是朋友」里的「岐」永远匹配不上任何人。
 */
export function harvestPersons(store, { peerId, rows = [], userRows = [], selfName = '', now = Date.now() } = {}) {
  const stats = { relations: 0, aliases: 0 };
  if (!peerId) return stats;

  // 先处理对方自报的名字（幂等，不占游标）
  try {
    const current = store.db.prepare('SELECT * FROM persons WHERE peer_id = ?').get(peerId);
    if (current) {
      for (const row of userRows || []) {
        for (const name of extractSelfIntro(row?.text)) {
          if (name === current.label) continue;
          // 她自己的名字不能当别人的别名 —— 线上真出现过「这个人是助手」，
          // 结果「助手」被挂到了对方名下。
          if (selfName && name === selfName) continue;
          store.db
            .prepare('INSERT OR IGNORE INTO person_aliases (id, person_id, alias, created_at) VALUES (?,?,?,?)')
            .run(`pa_${name}`, current.id, name, Number(row.createdAt) || now);
          stats.aliases += 1;
        }
      }
    }
  } catch (err) {
    // 别名登记失败不影响关系抽取
  }

  if (!rows.length) return stats;

  const cursorKey = `persons:cursor:${peerId}`;
  const last = Number(store.kvGet(cursorKey, 0)) || 0;
  const fresh = rows
    .filter((row) => row && row.text && Number(row.createdAt) > last)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  if (!fresh.length) return stats;

  const knownLabels = [...new Set([
    ...store.db.prepare('SELECT label FROM persons').all().map((r) => r.label),
    ...store.db.prepare('SELECT alias FROM person_aliases').all().map((r) => r.alias),
  ])];

  for (const row of fresh) {
    const at = Number(row.createdAt) || now;
    const text = String(row.text);

    for (const rel of extractRelations(text, knownLabels)) {
      const person = personByAnyLabel(store, rel.label);
      if (!person) continue;
      const existing = store.db
        .prepare('SELECT * FROM social_facts WHERE person_id = ? AND kind = ? AND source_peer = ?')
        .get(person.id, 'relation', peerId);
      if (existing) {
        // 同一来源多次提到：往新观测靠一点，置信度升一点，但不推翻已有多来源。
        const value = Number(existing.value) * 0.7 + rel.polarity * 0.3;
        store.db
          .prepare('UPDATE social_facts SET value = ?, confidence = ?, raw = ?, source_episode = ?, updated_at = ? WHERE id = ?')
          .run(value, Math.min(1, Number(existing.confidence || 0.5) + 0.1), rel.evidence, row.id || '', at, existing.id);
      } else {
        store.db
          .prepare(`INSERT INTO social_facts (id, person_id, kind, value, raw, source_peer, source_episode, confidence, visibility, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(`sf_${person.id}_${at.toString(36)}`, person.id, 'relation', rel.polarity,
            rel.evidence, peerId, row.id || '', 0.5, 'shared', at, at);
      }
      stats.relations += 1;
    }

    for (const al of extractAliases(text, knownLabels)) {
      if (al.target === '__self__') continue;
      const person = personByAnyLabel(store, al.target);
      if (!person) continue;
      store.db
        .prepare('INSERT OR IGNORE INTO person_aliases (id, person_id, alias, created_at) VALUES (?,?,?,?)')
        .run(`pa_${al.alias}`, person.id, al.alias, at);
      stats.aliases += 1;
    }
  }

  store.kvSet(cursorKey, Number(fresh[fresh.length - 1].createdAt) || now);
  return stats;
}

/** 拼人物块。没有人物时返回 null，不占 prompt。 */
export function buildPersonBlocks(store, { currentPeerId = null, peerLabels = {}, limit = 6 } = {}) {
  try {
    const persons = store.db.prepare('SELECT * FROM persons ORDER BY created_at ASC LIMIT 20').all();
    if (!persons.length) return null;
    const aliases = store.db.prepare('SELECT person_id, alias FROM person_aliases').all();
    const byPerson = {};
    for (const row of aliases) {
      if (!byPerson[row.person_id]) byPerson[row.person_id] = [];
      byPerson[row.person_id].push(row.alias);
    }
    const facts = store.db.prepare("SELECT * FROM social_facts WHERE kind = 'relation'").all();
    return buildPersonBlock(
      persons.map((person) => ({ ...person, aliases: byPerson[person.id] || [person.label] })),
      facts,
      { peerLabels, currentPeerId, limit },
    );
  } catch (err) {
    return null;
  }
}
