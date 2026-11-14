import { nowMs, uid } from './util.js'
import { peerIdFor as canonicalPeerId, normalizeLegacyPeerId } from './peer-identity.js'
import { STEP31_DDL } from './step31/ensure-schema.js'

/**
 * Social layer: peers, commitments, principles, disclosure decisions, readings.
 *
 * Nothing here hard-filters disclosure. Commitments are recorded as facts and
 * principles are her own, versioned rules; every disclosure decision is logged
 * so the user can audit or override it.
 */

export function peerIdFor(channel, conversationId, peerKind = 'direct') {
  const ch = String(channel || 'local').toLowerCase()
  const raw = String(conversationId || '').trim()
  if (!raw) return null
  const kind = peerKind === 'group' ? 'group' : peerKind === 'console' ? 'console' : 'private'
  const parts = raw.split(':')
  if (parts.length >= 3 && ['private', 'group', 'console'].includes(parts[1])) {
    return canonicalPeerId({ channel: parts[0].toLowerCase(), kind: parts[1], id: parts.slice(2).join(':') })
  }
  if (kind === 'group') {
    if (raw.startsWith('group:')) return canonicalPeerId({ channel: ch, kind: 'group', id: raw.slice(6) })
    if (parts.length === 2 && parts[0] === ch) return canonicalPeerId({ channel: ch, kind: 'group', id: parts[1] })
    return canonicalPeerId({ channel: ch, kind: 'group', id: raw })
  }
  if (raw.startsWith('private:')) return canonicalPeerId({ channel: ch, kind: 'private', id: raw.slice(8) })
  if (parts.length === 2) return canonicalPeerId({ channel: parts[0].toLowerCase(), kind: 'private', id: parts[1] })
  return canonicalPeerId({ channel: ch, kind, id: raw })
}

function parseList(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseMeta(value) {
  if (value && typeof value === 'object') return value
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export class SocialStore {
  constructor(store, config = {}) {
    this.store = store
    this.db = store.db
    this.config = config
    this.ensureSchema()
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL DEFAULT '',
        peer_kind TEXT NOT NULL DEFAULT 'direct',
        display_name TEXT NOT NULL DEFAULT '',
        learned_name TEXT NOT NULL DEFAULT '',
        relation_summary TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status);
      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        peer_id TEXT,
        to_whom TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        promised_at INTEGER NOT NULL,
        source_episode TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_peer ON commitments(peer_id, status);
      CREATE TABLE IF NOT EXISTS principles (
        id TEXT PRIMARY KEY,
        statement TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'experience',
        source_ref TEXT NOT NULL DEFAULT '',
        learned_at INTEGER NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        revision_chain TEXT NOT NULL DEFAULT '[]',
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_principles_status ON principles(status);
      CREATE TABLE IF NOT EXISTS disclosure_log (
        id TEXT PRIMARY KEY,
        peer_from TEXT NOT NULL DEFAULT '',
        peer_to TEXT NOT NULL DEFAULT '',
        commitment_id TEXT,
        decision TEXT NOT NULL,
        principle_ids TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        decided_at INTEGER NOT NULL,
        user_override INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_disclosure_peers ON disclosure_log(peer_from, peer_to);
      CREATE TABLE IF NOT EXISTS readings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        read_at INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        interpretation TEXT NOT NULL DEFAULT '',
        principle_ids TEXT NOT NULL DEFAULT '[]',
        meta TEXT NOT NULL DEFAULT '{}'
      );
    `)
    this.ensureStep7Schema()
    this.ensureStep10Schema()
    this.ensureStep11Schema()
    this.ensureStep31Schema()
    this.migratePeerIdentity()
  }

  /** STEP 11: one schema marker, no standalone SQL migration files. */
  /**
   * STEP 12 / P2: one-time, idempotent peer-id normalization.
   * Old ids: wechat:<wxid> / qq:<id>. New ids: <channel>:<kind>:<id>.
   * Null and already-normalized ids are untouched; a pre-existing target id wins.
   */
  migratePeerIdentity() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS peer_id_map (
      old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, at INTEGER NOT NULL
    )`)
    const insertMap = this.db.prepare('INSERT OR IGNORE INTO peer_id_map(old_id, new_id, at) VALUES(?, ?, ?)')
    const at = nowMs()
    const changes = []
    for (const row of this.db.prepare('SELECT id, channel, peer_kind FROM peers').all()) {
      const newId = normalizeLegacyPeerId(row.id, {
        channel: row.channel || 'wechat',
        kind: row.peer_kind === 'group' ? 'group' : 'private',
      })
      if (!newId || newId === row.id) continue
      insertMap.run(row.id, newId, at)
      const exists = this.db.prepare('SELECT 1 FROM peers WHERE id = ?').get(newId)
      if (exists) continue
      this.db.prepare('UPDATE peers SET id = ? WHERE id = ?').run(newId, row.id)
      changes.push([row.id, newId])
    }
    const columns = [
      ['memories', 'peer_id'], ['episodes', 'peer_id'], ['ledger', 'peer_id'],
      ['commitments', 'peer_id'], ['narratives', 'peer_id'], ['narrative_chapters', 'peer_id'],
      ['peer_diaries', 'peer_id'], ['mood_events', 'peer_id'], ['consolidation_log', 'peer_id'],
      ['disclosure_log', 'peer_from'], ['disclosure_log', 'peer_to'],
      ['pending_asks', 'source_peer'], ['pending_asks', 'target_peer'],
      ['proactive_log', 'target_peer'],
    ]
    for (const [table, column] of columns) {
      const hasTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      if (!hasTable) continue
      const hasColumn = this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
      if (!hasColumn) continue
      for (const [oldId, newId] of changes) {
        this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newId, oldId)
      }
    }
    return changes
  }

  ensureStep31Schema() {
    for (const ddl of STEP31_DDL) this.db.exec(ddl)
    this.db.exec("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('step31','1')")
  }

  ensureStep11Schema() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    const current = '11'
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    if (!row) {
      this.db.prepare("INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)").run(current)
      return
    }
    const found = Number(row.value)
    if (Number.isFinite(found) && found > Number(current)) {
      throw new Error(`whale-chan: schema_version ${found} is newer than supported ${current}`)
    }
    if (String(row.value) !== current) {
      this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(current)
    }
  }

  /** STEP 7 tables + principle evidence columns; idempotent. */
  ensureStep7Schema() {
    const columnsOf = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    for (const [name, ddl] of [['evidence_count', 'INTEGER DEFAULT 0'], ['updated_at', 'INTEGER']]) {
      if (!columnsOf('principles').includes(name)) this.db.exec(`ALTER TABLE principles ADD COLUMN ${name} ${ddl}`)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS principle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principle_id TEXT NOT NULL,
        event TEXT NOT NULL,
        at INTEGER NOT NULL,
        evidence_id TEXT,
        reason TEXT,
        weight_before REAL,
        weight_after REAL,
        actor TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_principle_events_pid ON principle_events(principle_id, at);
      CREATE TABLE IF NOT EXISTS narratives (
        peer_id TEXT PRIMARY KEY,
        relation_summary TEXT,
        updated_at INTEGER,
        revision_chain TEXT
      );
      CREATE TABLE IF NOT EXISTS narrative_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        peer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT,
        source_episode_ids TEXT,
        principle_ids TEXT,
        status TEXT NOT NULL DEFAULT 'closed'
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_pid ON narrative_chapters(peer_id, at);
      CREATE TABLE IF NOT EXISTS mood_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        cause TEXT,
        peer_id TEXT,
        evidence_id TEXT,
        delta REAL,
        mood_before REAL,
        mood_after REAL
      );
      CREATE INDEX IF NOT EXISTS idx_mood_events_at ON mood_events(at);
      CREATE TABLE IF NOT EXISTS mood_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        since INTEGER,
        statement TEXT NOT NULL,
        event_ids TEXT,
        version INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS proactive_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        target_peer TEXT,
        trigger TEXT,
        mood_snapshot REAL,
        decision TEXT,
        content_summary TEXT,
        reason TEXT,
        user_override INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_peer ON proactive_log(target_peer, at);
      CREATE TABLE IF NOT EXISTS pending_asks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source_peer TEXT,
        target_peer TEXT,
        commitment_id TEXT,
        reason TEXT,
        decided_by TEXT DEFAULT 'self',
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS peer_diaries (
        id TEXT PRIMARY KEY,
        peer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        since INTEGER,
        content TEXT NOT NULL,
        chapter_ids TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_peer_diaries_peer ON peer_diaries(peer_id, at);
      CREATE TABLE IF NOT EXISTS digest_cursor (
        scope TEXT PRIMARY KEY,
        last_episode_id TEXT,
        updated_at INTEGER
      );
    `)

    // STEP 8 / F2: 章节的 open/closed 是状态，不是 kind 白名单。
    const chapterColumns = this.db.prepare('PRAGMA table_info(narrative_chapters)').all().map((column) => column.name)
    if (!chapterColumns.includes('status')) {
      this.db.exec("ALTER TABLE narrative_chapters ADD COLUMN status TEXT NOT NULL DEFAULT 'closed'")
    }
    this.db.exec("UPDATE narrative_chapters SET status = 'closed' WHERE status IS NULL OR status = ''")
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_chapters_open ON narrative_chapters(peer_id, status, at)')

    // STEP 8 / F5: 旧 relation_summary 回填到 narratives 后，peer 列只作为兼容投影。
    const peerColumns = this.db.prepare('PRAGMA table_info(peers)').all().map((column) => column.name)
    if (peerColumns.includes('relation_summary')) {
      const rows = this.db
        .prepare("SELECT id, relation_summary FROM peers WHERE relation_summary IS NOT NULL AND relation_summary != ''")
        .all()
      const find = this.db.prepare('SELECT peer_id FROM narratives WHERE peer_id = ?')
      const insert = this.db.prepare('INSERT INTO narratives(peer_id, relation_summary, updated_at, revision_chain) VALUES(?, ?, ?, ?)')
      for (const row of rows) {
        if (!find.get(row.id)) insert.run(row.id, row.relation_summary, nowMs(), '[]')
      }
    }
  }

  /** STEP 10 / ① + ② - runtime channel audit and tidy-run journal. */
  ensureStep10Schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        action TEXT NOT NULL DEFAULT '',
        target_id TEXT,
        kind TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT 'system',
        reason TEXT NOT NULL DEFAULT '',
        conversation_id TEXT,
        sender_id TEXT,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_channel_audit_at ON channel_audit(at);
      CREATE TABLE IF NOT EXISTS tidy_runs (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL DEFAULT 'engine',
        target TEXT NOT NULL DEFAULT 'data',
        dry_run INTEGER NOT NULL DEFAULT 1,
        plan TEXT NOT NULL DEFAULT '{}',
        applied INTEGER NOT NULL DEFAULT 0,
        snapshot_id TEXT,
        stats TEXT NOT NULL DEFAULT '{}',
        rolled_back_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tidy_runs_at ON tidy_runs(at);
    `)
  }

  appendChannelAudit(row = {}) {
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {}
    const info = this.db
      .prepare(`INSERT INTO channel_audit(at, action, target_id, kind, actor, reason, conversation_id, sender_id, meta)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.at || nowMs(), row.action || '', row.id || row.target_id || null, row.kind || '',
        row.actor || 'system', row.reason || '', row.conversationId || null,
        row.senderId || null, JSON.stringify(meta))
    return { ...row, auditId: Number(info.lastInsertRowid) }
  }

  listChannelAudit(limit = 200) {
    return this.db
      .prepare('SELECT * FROM channel_audit ORDER BY at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map((row) => ({ ...row, meta: parseMeta(row.meta) }))
  }

  appendTidyRun(row = {}) {
    this.db
      .prepare(`INSERT OR REPLACE INTO tidy_runs(id, at, actor, target, dry_run, plan, applied, snapshot_id, stats)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.at || nowMs(), row.actor || 'engine', row.target || 'data',
        row.dryRun ? 1 : 0, JSON.stringify(row), row.applied ? 1 : 0,
        row.snapshotId || row.snapshot_id || null, JSON.stringify(row.stats || {}))
    return row
  }

  listTidyRuns(limit = 30) {
    return this.db
      .prepare('SELECT * FROM tidy_runs ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Number(limit) || 30)))
      .map((row) => ({ ...row, plan: parseMeta(row.plan), stats: parseMeta(row.stats), dryRun: Boolean(row.dry_run), applied: Boolean(row.applied) }))
  }

  markTidyRolledBack(id) {
    return this.db.prepare('UPDATE tidy_runs SET rolled_back_at = ? WHERE id = ?').run(nowMs(), id)
  }

  ensurePeer({ id, channel = '', peerKind = 'direct', displayName = '', at = nowMs() }) {
    const existing = this.getPeer(id)
    if (existing) {
      const patch = { last_seen: at }
      if (displayName && displayName !== existing.display_name) patch.display_name = displayName
      const nextKind = peerKind === 'group' ? 'group' : 'direct'
      this.db
        .prepare('UPDATE peers SET last_seen = ?, display_name = COALESCE(NULLIF(?, \'\'), display_name), peer_kind = ?, channel = COALESCE(NULLIF(?, \'\'), channel) WHERE id = ?')
        .run(at, displayName || '', nextKind, channel || '', id)
      return this.getPeer(id)
    }
    const peer = {
      id: String(id),
      channel: String(channel),
      peer_kind: peerKind === 'group' ? 'group' : 'direct',
      display_name: String(displayName || ''),
      learned_name: '',
      relation_summary: '',
      first_seen: at,
      last_seen: at,
      status: 'active',
      meta: {},
    }
    this.db
      .prepare(
        `INSERT INTO peers(id, channel, peer_kind, display_name, learned_name, relation_summary,
          first_seen, last_seen, status, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(peer.id, peer.channel, peer.peer_kind, peer.display_name, peer.learned_name, peer.relation_summary,
        peer.first_seen, peer.last_seen, peer.status, JSON.stringify(peer.meta))
    return peer
  }

  getPeer(id) {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id)
    if (!row) return null
    // STEP 8 / F5: narratives 是唯一写入源；peer.relation_summary 只做读取投影。
    const narrative = this.db.prepare('SELECT relation_summary FROM narratives WHERE peer_id = ?').get(id)
    return {
      ...row,
      relation_summary: narrative?.relation_summary ?? row.relation_summary ?? '',
      meta: parseMeta(row.meta),
    }
  }

  listPeers({ status = 'active' } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM peers WHERE status = ? ORDER BY last_seen DESC').all(status)
      : this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all()
    return rows.map((row) => this.getPeer(row.id))
  }

  updatePeer(id, patch = {}) {
    const current = this.getPeer(id)
    if (!current) return null
    const next = { ...current, ...patch }
    // 允许旧调用方传 relation_summary，但只落到 narratives，绝不写回 peers。
    if (Object.prototype.hasOwnProperty.call(patch, 'relation_summary')) {
      this.upsertNarrative(id, String(patch.relation_summary || ''))
      delete next.relation_summary
    }
    this.db
      .prepare(
        `UPDATE peers SET channel = ?, peer_kind = ?, display_name = ?, learned_name = ?,
          first_seen = ?, last_seen = ?, status = ?, meta = ? WHERE id = ?`,
      )
      .run(
        next.channel,
        next.peer_kind === 'group' ? 'group' : 'direct',
        next.display_name || '',
        next.learned_name || '',
        next.first_seen,
        next.last_seen,
        next.status || 'active',
        JSON.stringify(next.meta || {}),
        id,
      )
    return this.getPeer(id)
  }

  peerLabel(peerId, fallback = '对方') {
    const peer = peerId ? this.getPeer(peerId) : null
    if (!peer) return fallback
    return peer.learned_name || peer.display_name || fallback
  }

  // ------------------------------------------------------------ commitments ----
  recordCommitment({ peerId = null, toWhom = '', content, promisedAt = nowMs(), sourceEpisode = '', meta = {} }) {
    const text = String(content || '').trim()
    if (!text) return null
    const existing = this.db
      .prepare("SELECT * FROM commitments WHERE peer_id IS ? AND content = ? AND status = 'active'")
      .get(peerId, text)
    if (existing) return { ...existing, meta: parseMeta(existing.meta) }
    // 把「明天 / 后天 / 这周 / 3月5日」这类自由文本转成时间戳；解析不出就 0（无期限）。
    const parseDueAt = (due, base = Date.now()) => {
      const s = String(due || '').trim()
      if (!s) return 0
      if (/今天|今日/.test(s)) return base + 12 * 3600_000
      if (/明天|明日/.test(s)) return base + 36 * 3600_000
      if (/后天/.test(s)) return base + 60 * 3600_000
      if (/这周|本周/.test(s)) return base + 5 * 86400_000
      if (/下周/.test(s)) return base + 10 * 86400_000
      const m = /(\d{1,2})\s*月\s*(\d{1,2})/.exec(s)
      if (m) {
        const d = new Date(new Date(base).getFullYear(), Number(m[1]) - 1, Number(m[2]), 20, 0, 0)
        return d.getTime()
      }
      return 0
    }
    const row = {
      id: uid('cmt'),
      peer_id: peerId,
      to_whom: String(toWhom || ''),
      content: text,
      promised_at: promisedAt,
      source_episode: String(sourceEpisode || ''),
      status: 'active',
      due_at: parseDueAt(meta?.due, promisedAt),
      meta,
    }
    try { this.db.exec('ALTER TABLE commitments ADD COLUMN due_at INTEGER DEFAULT 0') } catch (err) { /* 已存在 */ }
    this.db
      .prepare(
        `INSERT INTO commitments(id, peer_id, to_whom, content, promised_at, source_episode, status, due_at, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.peer_id, row.to_whom, row.content, row.promised_at, row.source_episode, row.status, row.due_at, JSON.stringify(row.meta))
    return row
  }

  listCommitments(peerId, { activeOnly = true, limit = 40 } = {}) {
    let rows = []
    try {
      // 有期限的排前面、越近越前；无期限的按承诺时间倒序。
      rows = activeOnly
        ? this.db.prepare("SELECT * FROM commitments WHERE peer_id IS ? AND status = 'active' ORDER BY (due_at > 0) DESC, due_at ASC, promised_at DESC LIMIT ?").all(peerId, limit)
        : this.db.prepare('SELECT * FROM commitments WHERE peer_id IS ? ORDER BY promised_at DESC LIMIT ?').all(peerId, limit)
    } catch (err) {
      rows = activeOnly
        ? this.db.prepare("SELECT * FROM commitments WHERE peer_id IS ? AND status = 'active' ORDER BY promised_at DESC LIMIT ?").all(peerId, limit)
        : this.db.prepare('SELECT * FROM commitments WHERE peer_id IS ? ORDER BY promised_at DESC LIMIT ?').all(peerId, limit)
    }
    return rows.map((row) => ({ ...row, meta: parseMeta(row.meta) }))
  }

  // --------------------------------------------------------------- principles ----
  addPrinciple({ statement, source = 'experience', sourceRef = '', weight = 0.5, revisionOf = null, meta = {}, status = 'active', evidenceCount = 0, updatedAt = null }) {
    const text = String(statement || '').trim()
    if (!text) return null
    let chain = []
    if (revisionOf) {
      const old = this.db.prepare('SELECT * FROM principles WHERE id = ?').get(revisionOf)
      if (old) {
        chain = [revisionOf, ...parseList(old.revision_chain)]
        this.db.prepare("UPDATE principles SET status = 'revised' WHERE id = ?").run(revisionOf)
      }
    }
    const row = {
      id: uid('pr'),
      statement: text,
      source: String(source),
      source_ref: String(sourceRef || ''),
      learned_at: nowMs(),
      weight: Math.max(0, Math.min(1, Number(weight) || 0.5)),
      status: ['candidate', 'active', 'contested', 'revised', 'retired'].includes(status) ? status : 'active',
      evidence_count: Math.max(0, Number(evidenceCount) || 0),
      updated_at: updatedAt || nowMs(),
      revision_chain: chain,
      meta,
    }
    this.db
      .prepare(
        `INSERT INTO principles(id, statement, source, source_ref, learned_at, weight, status,
          evidence_count, updated_at, revision_chain, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.statement, row.source, row.source_ref, row.learned_at, row.weight, row.status,
        row.evidence_count, row.updated_at, JSON.stringify(row.revision_chain), JSON.stringify(row.meta))
    return this.getPrinciple(row.id)
  }

  getPrinciple(id) {
    const row = this.db.prepare('SELECT * FROM principles WHERE id = ?').get(id)
    if (!row) return null
    return { ...row, revision_chain: parseList(row.revision_chain), meta: parseMeta(row.meta) }
  }

  updatePrinciple(id, patch = {}) {
    const current = this.getPrinciple(id)
    if (!current) return null
    const next = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE principles SET statement = ?, source = ?, source_ref = ?, weight = ?, status = ?,
          evidence_count = ?, updated_at = ?, revision_chain = ?, meta = ? WHERE id = ?`,
      )
      .run(
        next.statement,
        next.source,
        next.source_ref,
        Math.max(0, Math.min(1, Number(next.weight) || 0)),
        next.status,
        Math.max(0, Number(next.evidence_count) || 0),
        next.updated_at || nowMs(),
        JSON.stringify(parseList(next.revision_chain)),
        JSON.stringify(next.meta || {}),
        id,
      )
    return this.getPrinciple(id)
  }

  appendPrincipleEvent(row) {
    const info = this.db
      .prepare(
        `INSERT INTO principle_events(principle_id, event, at, evidence_id, reason, weight_before, weight_after, actor)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.principle_id, row.event, row.at || nowMs(), row.evidence_id || null, row.reason || null,
        row.weight_before ?? null, row.weight_after ?? null, row.actor || 'self')
    return { ...row, id: Number(info.lastInsertRowid) }
  }

  listPrincipleEvents({ principleId, limit = 200 } = {}) {
    const rows = principleId
      ? this.db.prepare('SELECT * FROM principle_events WHERE principle_id = ? ORDER BY at DESC LIMIT ?').all(principleId, limit)
      : this.db.prepare('SELECT * FROM principle_events ORDER BY at DESC LIMIT ?').all(limit)
    return rows.map((row) => ({ ...row }))
  }

  listPrinciples({ status = 'active', limit = 50 } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM principles WHERE status = ? ORDER BY weight DESC, learned_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM principles ORDER BY weight DESC, learned_at DESC LIMIT ?').all(limit)
    return rows.map((row) => ({ ...row, revision_chain: parseList(row.revision_chain), meta: parseMeta(row.meta) }))
  }

  revisePrinciple(oldId, { statement, source = 'self-reflection', sourceRef = '', weight } = {}) {
    const old = this.getPrinciple(oldId)
    if (!old) return null
    return this.addPrinciple({
      statement: statement || old.statement,
      source,
      sourceRef: sourceRef || old.source_ref,
      weight: weight ?? old.weight,
      revisionOf: oldId,
    })
  }

  // --------------------------------------------------------------- disclosures ----
  logDisclosure({ peerFrom = '', peerTo = '', commitmentId = null, decision, principleIds = [], reason = '', userOverride = false, meta = {} }) {
    const row = {
      id: uid('dis'),
      peer_from: String(peerFrom || ''),
      peer_to: String(peerTo || ''),
      commitment_id: commitmentId || null,
      decision: String(decision || 'not_mentioned'),
      principle_ids: [...new Set(principleIds || [])],
      reason: String(reason || ''),
      decided_at: nowMs(),
      user_override: userOverride ? 1 : 0,
      meta,
    }
    this.db
      .prepare(
        `INSERT INTO disclosure_log(id, peer_from, peer_to, commitment_id, decision, principle_ids,
          reason, decided_at, user_override, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.peer_from, row.peer_to, row.commitment_id, row.decision,
        JSON.stringify(row.principle_ids), row.reason, row.decided_at, row.user_override, JSON.stringify(row.meta))
    return row
  }

  listDisclosures({ peerFrom, peerTo, limit = 100 } = {}) {
    const where = []
    const args = []
    if (peerFrom) { where.push('peer_from = ?'); args.push(peerFrom) }
    if (peerTo) { where.push('peer_to = ?'); args.push(peerTo) }
    const rows = this.db
      .prepare(`SELECT * FROM disclosure_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY decided_at DESC LIMIT ?`)
      .all(...args, limit)
    return rows.map((row) => ({ ...row, principle_ids: parseList(row.principle_ids), meta: parseMeta(row.meta) }))
  }

  // ------------------------------------------------------------------ readings ----
  addReading({ id = null, at = null, title = '', source = '', summary = '', interpretation = '', principleIds = [], meta = {} }) {
    const row = {
      id: id || uid('read'),
      title: String(title || ''),
      source: String(source || ''),
      read_at: at || nowMs(),
      summary: String(summary || ''),
      interpretation: String(interpretation || ''),
      principle_ids: [...new Set(principleIds || [])],
      meta,
    }
    this.db
      .prepare(
        `INSERT INTO readings(id, title, source, read_at, summary, interpretation, principle_ids, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.title, row.source, row.read_at, row.summary, row.interpretation,
        JSON.stringify(row.principle_ids), JSON.stringify(row.meta))
    return row
  }

  updateReadingPrinciples(id, principleIds = []) {
    const ids = [...new Set((principleIds || []).filter(Boolean))]
    this.db.prepare('UPDATE readings SET principle_ids = ? WHERE id = ?').run(JSON.stringify(ids), id)
    return ids
  }

  updateReadingSummary(id, { summary = '', meta = null } = {}) {
    if (meta && typeof meta === 'object') {
      const row = this.db.prepare('SELECT meta FROM readings WHERE id = ?').get(id)
      const merged = { ...parseMeta(row?.meta), ...meta }
      this.db.prepare('UPDATE readings SET summary = ?, meta = ? WHERE id = ?')
        .run(String(summary || ''), JSON.stringify(merged), id)
    } else {
      this.db.prepare('UPDATE readings SET summary = ? WHERE id = ?').run(String(summary || ''), id)
    }
    return { id, summary: String(summary || '') }
  }

  listReadings(limit = 50) {
    return this.db.prepare('SELECT * FROM readings ORDER BY read_at DESC LIMIT ?').all(limit)
      .map((row) => ({ ...row, principle_ids: parseList(row.principle_ids), meta: parseMeta(row.meta) }))
  }

  deleteReading(id) {
    if (!id) return false
    const result = this.db.prepare('DELETE FROM readings WHERE id = ?').run(String(id))
    return result.changes > 0
  }

  // ------------------------------------------------------- step-7 events ----
  addPendingAsk(row) {
    const info = this.db
      .prepare('INSERT INTO pending_asks(at, source_peer, target_peer, commitment_id, reason, decided_by) VALUES(?, ?, ?, ?, ?, ?)')
      .run(row.at || nowMs(), row.source_peer || null, row.target_peer || null, row.commitment_id || null,
        row.reason || '', row.decided_by || 'self')
    return { ...row, id: Number(info.lastInsertRowid) }
  }

  listPendingAsks({ targetPeer } = {}) {
    const rows = targetPeer
      ? this.db.prepare('SELECT * FROM pending_asks WHERE target_peer = ? AND resolved_at IS NULL ORDER BY at DESC').all(targetPeer)
      : this.db.prepare('SELECT * FROM pending_asks WHERE resolved_at IS NULL ORDER BY at DESC').all()
    return rows.map((row) => ({ ...row }))
  }

  appendMoodEvent(row) {
    const info = this.db
      .prepare('INSERT INTO mood_events(at, kind, cause, peer_id, evidence_id, delta, mood_before, mood_after) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.at || nowMs(), row.kind || 'conversation', row.cause || '', row.peer_id || null,
        row.evidence_id || null, row.delta ?? 0, row.mood_before ?? 0, row.mood_after ?? 0)
    return { ...row, id: Number(info.lastInsertRowid) }
  }

  listMoodEvents({ since = null, until = nowMs(), limit = 500 } = {}) {
    const rows = this.db
      .prepare('SELECT * FROM mood_events WHERE at >= ? AND at <= ? ORDER BY at ASC LIMIT ?')
      .all(since || 0, until, limit)
    return rows.map((row) => ({ ...row }))
  }

  appendMoodHistory(row) {
    const info = this.db
      .prepare('INSERT INTO mood_history(at, since, statement, event_ids, version) VALUES(?, ?, ?, ?, ?)')
      .run(row.at || nowMs(), row.since || null, row.statement || '', JSON.stringify(row.event_ids || []), row.version || 1)
    return { ...row, id: Number(info.lastInsertRowid) }
  }

  listMoodHistory(limit = 30) {
    return this.db.prepare('SELECT * FROM mood_history ORDER BY at DESC LIMIT ?').all(limit)
      .map((row) => ({ ...row, event_ids: parseList(row.event_ids) }))
  }

  appendProactive(row) {
    const info = this.db
      .prepare('INSERT INTO proactive_log(at, target_peer, trigger, mood_snapshot, decision, content_summary, reason, user_override) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.at || nowMs(), row.target_peer || null, row.trigger || '', row.mood_snapshot ?? 0,
        row.decision || 'blocked_disabled', row.content_summary || '', row.reason || '', row.user_override ? 1 : 0)
    return { ...row, id: Number(info.lastInsertRowid) }
  }

  listProactive({ peerId, since = 0, limit = 200, order = 'asc' } = {}) {
    const direction = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const rows = peerId
      ? this.db.prepare(`SELECT * FROM proactive_log WHERE target_peer = ? AND at >= ? ORDER BY at ${direction} LIMIT ?`).all(peerId, since, limit)
      : this.db.prepare(`SELECT * FROM proactive_log WHERE at >= ? ORDER BY at ${direction} LIMIT ?`).all(since, limit)
    return rows.map((row) => ({ ...row }))
  }

  getNarrative(peerId) {
    const row = this.db.prepare('SELECT * FROM narratives WHERE peer_id = ?').get(peerId)
    if (!row) return null
    return { ...row, revision_chain: parseList(row.revision_chain) }
  }

  upsertNarrative(peerId, relationSummary) {
    const current = this.getNarrative(peerId)
    const now = nowMs()
    if (!current) {
      this.db.prepare('INSERT INTO narratives(peer_id, relation_summary, updated_at, revision_chain) VALUES(?, ?, ?, ?)')
        .run(peerId, relationSummary || '', now, '[]')
    } else {
      const chain = [...current.revision_chain, { at: current.updated_at, summary: current.relation_summary }]
      this.db.prepare('UPDATE narratives SET relation_summary = ?, updated_at = ?, revision_chain = ? WHERE peer_id = ?')
        .run(relationSummary || '', now, JSON.stringify(chain.slice(-20)), peerId)
    }
    return this.getNarrative(peerId)
  }

  appendChapter({ peerId, kind = 'shared_event', summary = '', sourceEpisodeIds = [], principleIds = [], status = 'closed' }) {
    const at = nowMs()
    const info = this.db
      .prepare('INSERT INTO narrative_chapters(peer_id, at, kind, summary, source_episode_ids, principle_ids, status) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(peerId, at, kind, summary, JSON.stringify(sourceEpisodeIds), JSON.stringify(principleIds), status === 'open' ? 'open' : 'closed')
    return { id: Number(info.lastInsertRowid), peerId, at, kind, summary, status: status === 'open' ? 'open' : 'closed' }
  }

  listChapters(peerId, options = 100) {
    const { limit = 100, since = null, until = null } = typeof options === 'number' ? { limit: options } : options
    const where = ['peer_id = ?']
    const args = [peerId]
    if (since) { where.push('at >= ?'); args.push(since) }
    if (until) { where.push('at <= ?'); args.push(until) }
    return this.db
      .prepare(`SELECT * FROM narrative_chapters WHERE ${where.join(' AND ')} ORDER BY at ASC LIMIT ?`)
      .all(...args, limit)
      .map((row) => ({
        ...row,
        status: row.status || 'closed',
        source_episode_ids: parseList(row.source_episode_ids),
        principle_ids: parseList(row.principle_ids),
      }))
  }

  openChapters(peerId) {
    return this.listChapters(peerId, 200).filter((chapter) => chapter.status === 'open')
  }

  closeOpenChapters(peerId, { except = null } = {}) {
    const rows = this.db
      .prepare("SELECT id FROM narrative_chapters WHERE peer_id = ? AND status = 'open'")
      .all(peerId)
      .filter((row) => !except || Number(row.id) !== Number(except))
    if (!rows.length) return 0
    const stmt = this.db.prepare("UPDATE narrative_chapters SET status = 'closed' WHERE id = ?")
    for (const row of rows) stmt.run(row.id)
    return rows.length
  }

  appendDiary({ peerId: peerIdIn, peer_id, at = nowMs(), since = null, content = '', chapterIds = [], version = 1 }) {
    const peerId = peerIdIn || peer_id
    if (!peerId || !String(content || '').trim()) return null
    const row = {
      id: uid('pdiary'),
      peer_id: peerId,
      at,
      since,
      content: String(content),
      chapter_ids: [...new Set(chapterIds || [])],
      version: Number(version) || 1,
    }
    this.db
      .prepare('INSERT INTO peer_diaries(id, peer_id, at, since, content, chapter_ids, version) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.peer_id, row.at, row.since, row.content, JSON.stringify(row.chapter_ids), row.version)
    return { ...row }
  }

  listDiaries(peerId, limit = 30) {
    return this.db.prepare('SELECT * FROM peer_diaries WHERE peer_id = ? ORDER BY at DESC LIMIT ?').all(peerId, limit)
      .map((row) => ({ ...row, chapter_ids: parseList(row.chapter_ids) }))
  }

  listActivePeers() {
    return this.listPeers({ status: 'active' })
  }

  getDigestCursor(scope) {
    return this.db.prepare('SELECT * FROM digest_cursor WHERE scope = ?').get(scope) || null
  }

  setDigestCursor(scope, lastEpisodeId) {
    this.db
      .prepare('INSERT INTO digest_cursor(scope, last_episode_id, updated_at) VALUES(?, ?, ?) ON CONFLICT(scope) DO UPDATE SET last_episode_id = excluded.last_episode_id, updated_at = excluded.updated_at')
      .run(scope, lastEpisodeId || null, nowMs())
    return this.getDigestCursor(scope)
  }

  /** STEP 8 / F1: 主动消息的候选；只把“可能夹带他人信息”的条目交给披露闸门。 */
  listProactiveCandidates(targetPeer) {
    const own = this.store
      .listEpisodes({ peerId: targetPeer, limit: 8 })
      .filter((episode) => episode.role === 'user')
      .map((episode) => ({ peer_id: targetPeer, text: episode.text, speaker_id: episode.speakerId || undefined }))
    const crossRows = this.db
      .prepare("SELECT text, peer_id, speaker_id FROM episodes WHERE peer_id IS NOT NULL AND peer_id != ? AND role = 'user' ORDER BY createdAt DESC LIMIT 8")
      .all(targetPeer)
    const cross = crossRows.map((row) => ({ peer_id: row.peer_id, text: row.text, speaker_id: row.speaker_id || undefined }))
    const crossCommitments = this.db
      .prepare("SELECT id, peer_id, content FROM commitments WHERE status = 'active' AND peer_id IS NOT NULL AND peer_id != ? ORDER BY promised_at DESC LIMIT 8")
      .all(targetPeer)
      .map((row) => ({ peer_id: row.peer_id, commitment_id: row.id, text: row.content }))
    return [...own, ...cross, ...crossCommitments]
  }

  growthTimeline({ peerId = null, limit = 200 } = {}) {
    const events = []
    for (const row of this.listPrincipleEvents({ limit })) {
      events.push({ type: 'principle', at: row.at, id: row.id, title: `${row.event}`, detail: row.reason || '', evidence: row.evidence_id })
    }
    for (const row of this.listDisclosures({ limit })) {
      if (peerId && row.peer_to !== peerId && row.peer_from !== peerId) continue
      events.push({ type: 'disclosure', at: row.decided_at, id: row.id, title: row.decision, detail: row.reason, evidence: (row.principle_ids || []).join(',') })
    }
    for (const row of this.listProactive({ since: 0, limit })) {
      if (peerId && row.target_peer !== peerId) continue
      events.push({ type: 'proactive', at: row.at, id: row.id, title: row.decision, detail: row.reason || row.content_summary || '', evidence: row.trigger })
    }
    for (const peer of (peerId ? [this.getPeer(peerId)].filter(Boolean) : this.listPeers({ status: null }))) {
      for (const chapter of this.listChapters(peer.id, limit)) {
        events.push({ type: 'chapter', at: chapter.at, id: chapter.id, title: chapter.kind, detail: chapter.summary, evidence: (chapter.source_episode_ids || []).join(',') })
      }
    }
    return events.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  appendDisclosure(row) {
    return this.logDisclosure({
      peerFrom: row.peer_from || '',
      peerTo: row.peer_to || '',
      commitmentId: row.commitment_id || null,
      decision: row.decision || 'withhold',
      principleIds: row.principle_ids || [],
      reason: row.reason || '',
      meta: { confidence: row.confidence || 0, at: row.at },
    })
  }

  peerContext(peerId) {
    const peer = peerId ? this.getPeer(peerId) : null
    return {
      peer,
      label: peer ? (peer.learned_name || peer.display_name || '对方') : '对方',
      commitments: peerId ? this.listCommitments(peerId) : [],
      principles: this.listPrinciples({ status: 'active', limit: 5 }),
    }
  }
}
