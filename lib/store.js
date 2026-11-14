import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  LAYERS,
  clamp,
  hashUnit,
  nowMs,
  searchText,
  tokenizeSearch,
  trigramSimilarity,
  uid,
} from './util.js'

const DAY = 86_400_000

function parseList(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return String(value)
      .split(/[,;\s]+/)
      .filter(Boolean)
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

function rowToMemory(row) {
  if (!row) return null
  return {
    id: row.id,
    layer: row.layer,
    content: row.content,
    keywords: parseList(row.keywords),
    importance: Number(row.importance),
    trust: Number(row.trust),
    status: row.status,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    validFrom: row.validFrom == null ? null : Number(row.validFrom),
    validUntil: row.validUntil == null ? null : Number(row.validUntil),
    lastRecalledAt: row.lastRecalledAt == null ? null : Number(row.lastRecalledAt),
    recallCount: Number(row.recallCount || 0),
    nextReviewAt: row.nextReviewAt == null ? null : Number(row.nextReviewAt),
    sourceEpisodeIds: parseList(row.sourceEpisodeIds),
    links: parseList(row.links),
    emotion: row.emotion || '',
    heat: Number(row.heat || 0),
    meta: parseMeta(row.meta),
    peerId: row.peer_id || null,
  }
}

export class MemoryStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'memory.db')
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.ensureSchema()
    this.migrate()
    this.stmt = {}
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        content TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 5,
        trust REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        validFrom INTEGER,
        validUntil INTEGER,
        lastRecalledAt INTEGER,
        recallCount INTEGER NOT NULL DEFAULT 0,
        nextReviewAt INTEGER,
        sourceEpisodeIds TEXT NOT NULL DEFAULT '[]',
        links TEXT NOT NULL DEFAULT '[]',
        emotion TEXT NOT NULL DEFAULT '',
        heat REAL NOT NULL DEFAULT 0,
        peer_id TEXT,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updatedAt);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(mem_id UNINDEXED, search_text, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        emotion TEXT NOT NULL DEFAULT '',
        peer_id TEXT,
        speaker_id TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(sessionId, createdAt);
      CREATE TABLE IF NOT EXISTS voice_examples (
        id TEXT PRIMARY KEY,
        peer_id TEXT,
        text TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        liked INTEGER NOT NULL DEFAULT 1,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_voice_examples_peer ON voice_examples(peer_id, at);
      CREATE TABLE IF NOT EXISTS voice_rules (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'tone',
        directive TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 4,
        source TEXT NOT NULL DEFAULT '',
        raw TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_voice_rules_active ON voice_rules(active, at);
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        field TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.6,
        peer_id TEXT,
        sourceEpisodeIds TEXT NOT NULL DEFAULT '[]',
        validFrom INTEGER,
        validUntil INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS read_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        peer_id TEXT,
        channel TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        mode TEXT NOT NULL DEFAULT 'book',
        chapters INTEGER NOT NULL DEFAULT 0,
        done_chapters INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,
        reading_id TEXT,
        principles INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_read_jobs_peer ON read_jobs(peer_id, status);
      CREATE INDEX IF NOT EXISTS idx_read_jobs_created ON read_jobs(created_at);
    `)
  }

  /** Add peer columns to an old database; idempotent and non-destructive. */
  migrate() {
    const columnsOf = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    const ensureColumn = (table, name, ddl) => {
      if (!columnsOf(table).includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
    ensureColumn('memories', 'peer_id', 'peer_id TEXT')
    this.db.exec(`CREATE TABLE IF NOT EXISTS consolidation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      layer TEXT,
      peer_id TEXT,
      keep_id TEXT,
      drop_id TEXT,
      reason TEXT
    )`)
    ensureColumn('episodes', 'peer_id', 'peer_id TEXT')
    ensureColumn('episodes', 'speaker_id', 'speaker_id TEXT')
    ensureColumn('episodes', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')
    ensureColumn('episodes', 'archived_at', 'archived_at INTEGER')
    ensureColumn('episodes', 'kind', "kind TEXT NOT NULL DEFAULT ''")
    ensureColumn('episodes', 'source_media', 'source_media TEXT')
    ensureColumn('episodes', 'media_meta', "media_meta TEXT NOT NULL DEFAULT '{}'")
    ensureColumn('ledger', 'peer_id', 'peer_id TEXT')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_peer ON memories(peer_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_peer ON episodes(peer_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_archived ON episodes(archived, createdAt)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_peer ON ledger(peer_id)')
    // 承诺期限列：老库没有就补上（SQLite 不支持 IF NOT EXISTS，用 try 兜）
    try { this.db.exec('ALTER TABLE commitments ADD COLUMN due_at INTEGER DEFAULT 0') } catch (err) { /* 已存在 */ }
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  mtime() {
    try {
      return statSync(this.file).mtimeMs
    } catch {
      return 0
    }
  }

  // ---------------------------------------------------------------- kv ----
  kvGet(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return fallback
    }
  }

  kvSet(key, value) {
    this.db
      .prepare('INSERT INTO kv(key, value, updatedAt) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt')
      .run(key, JSON.stringify(value), nowMs())
    return value
  }

  // ------------------------------------------------------------- memory ----
  insert(input) {
    const now = input.createdAt || nowMs()
    const memory = {
      id: input.id || uid('mem'),
      layer: LAYERS.includes(input.layer) ? input.layer : 'fact',
      content: String(input.content || '').trim(),
      keywords: parseList(input.keywords),
      importance: clamp(Number(input.importance ?? 5), 1, 10),
      trust: clamp(Number(input.trust ?? 0.5), 0, 1),
      status: input.status || 'active',
      createdAt: now,
      updatedAt: input.updatedAt || now,
      validFrom: input.validFrom ?? now,
      validUntil: input.validUntil ?? null,
      lastRecalledAt: input.lastRecalledAt ?? null,
      recallCount: input.recallCount || 0,
      nextReviewAt: input.nextReviewAt ?? now + 7 * DAY,
      sourceEpisodeIds: parseList(input.sourceEpisodeIds),
      links: parseList(input.links),
      emotion: input.emotion || '',
      heat: input.heat || 0,
      peerId: input.peerId || null,
      meta: parseMeta(input.meta),
    }
    if (!memory.content) throw new Error('memory content is empty')
    this.db
      .prepare(
        `INSERT INTO memories(id, layer, content, keywords, importance, trust, status, createdAt, updatedAt,
          validFrom, validUntil, lastRecalledAt, recallCount, nextReviewAt, sourceEpisodeIds, links, emotion, heat, peer_id, meta)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.layer,
        memory.content,
        JSON.stringify(memory.keywords),
        memory.importance,
        memory.trust,
        memory.status,
        memory.createdAt,
        memory.updatedAt,
        memory.validFrom,
        memory.validUntil,
        memory.lastRecalledAt,
        memory.recallCount,
        memory.nextReviewAt,
        JSON.stringify(memory.sourceEpisodeIds),
        JSON.stringify(memory.links),
        memory.emotion,
        memory.heat,
        memory.peerId,
        JSON.stringify(memory.meta),
      )
    this.indexMemory(memory)
    return memory
  }

  indexMemory(memory) {
    this.db.prepare('DELETE FROM memories_fts WHERE mem_id = ?').run(memory.id)
    const text = searchText([memory.content, memory.keywords.join(' ')].join(' '))
    this.db.prepare('INSERT INTO memories_fts(mem_id, search_text) VALUES(?, ?)').run(memory.id, text)
  }

  get(id) {
    return rowToMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id))
  }

  update(id, patch) {
    const current = this.get(id)
    if (!current) return null
    const next = {
      ...current,
      ...patch,
      keywords: patch.keywords ? parseList(patch.keywords) : current.keywords,
      links: patch.links ? [...new Set([...current.links, ...parseList(patch.links)])] : current.links,
      sourceEpisodeIds: patch.sourceEpisodeIds
        ? [...new Set([...current.sourceEpisodeIds, ...parseList(patch.sourceEpisodeIds)])]
        : current.sourceEpisodeIds,
      updatedAt: patch.updatedAt || nowMs(),
    }
    next.importance = clamp(Number(next.importance), 1, 10)
    next.trust = clamp(Number(next.trust), 0, 1)
    this.db
      .prepare(
        `UPDATE memories SET content = ?, keywords = ?, importance = ?, trust = ?, status = ?, updatedAt = ?,
          validFrom = ?, validUntil = ?, lastRecalledAt = ?, recallCount = ?, nextReviewAt = ?,
          sourceEpisodeIds = ?, links = ?, emotion = ?, heat = ?, peer_id = ?, meta = ? WHERE id = ?`,
      )
      .run(
        next.content,
        JSON.stringify(next.keywords),
        next.importance,
        next.trust,
        next.status,
        next.updatedAt,
        next.validFrom,
        next.validUntil,
        next.lastRecalledAt,
        next.recallCount,
        next.nextReviewAt,
        JSON.stringify(next.sourceEpisodeIds),
        JSON.stringify(next.links),
        next.emotion,
        next.heat,
        next.peerId || null,
        JSON.stringify(next.meta),
        id,
      )
    this.indexMemory(next)
    return next
  }

  /** Supersede an old memory (keep history) and write the replacement. */
  supersede(oldId, patch) {
    const old = this.get(oldId)
    if (!old) return null
    const now = nowMs()
    this.update(oldId, { status: 'superseded', validUntil: now, meta: { ...old.meta, supersededAt: now } })
    return this.insert({ ...patch, layer: patch.layer || old.layer, peerId: patch.peerId ?? old.peerId, meta: { ...patch.meta, supersedes: oldId } })
  }

  list({ layer, layers, status = 'active', limit = 500, offset = 0, query = '', all = false, peerId, includeShared = true } = {}) {
    const where = []
    const args = []
    if (layer) {
      where.push('layer = ?')
      args.push(layer)
    }
    if (layers?.length) {
      where.push(`layer IN (${layers.map(() => '?').join(',')})`)
      args.push(...layers)
    }
    if (!all) {
      where.push("status != 'archived'")
      if (status) {
        where.push('status = ?')
        args.push(status)
      }
    }
    if (peerId !== undefined && peerId !== null) {
      if (includeShared) { where.push('(peer_id = ? OR peer_id IS NULL)'); args.push(peerId) }
      else { where.push('peer_id = ?'); args.push(peerId) }
    }
    if (query) {
      where.push('(content LIKE ? OR keywords LIKE ?)')
      args.push(`%${query}%`, `%${query}%`)
    }
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`
    return this.db.prepare(sql).all(...args, limit, offset).map(rowToMemory)
  }

  countByLayer() {
    const out = Object.fromEntries(LAYERS.map((layer) => [layer, 0]))
    for (const row of this.db.prepare("SELECT layer, COUNT(*) AS n FROM memories WHERE status = 'active' GROUP BY layer").all()) {
      out[row.layer] = Number(row.n)
    }
    return out
  }

  effectiveImportance(memory, now = nowMs()) {
    const ageDays = Math.max(0, (now - memory.updatedAt) / DAY)
    const decay = Math.exp((-Math.LN2 * ageDays) / 60)
    const reinforcement = Math.min(2.4, 0.35 * Math.log(1 + memory.recallCount))
    return clamp(memory.importance * (0.45 + 0.55 * decay) + reinforcement, 0.4, 10)
  }

  /**
   * Hybrid recall: FTS5/BM25 + link-graph expansion + recency × importance,
   * fused with RRF, then MMR-deduplicated. Returns working-memory sized hits.
   */
  search(query, { layers, limit = 8, now = nowMs(), includeSuperseded = false, peerId, includeShared = true } = {}) {
    const q = String(query || '').trim()
    const scoped = peerId !== undefined && peerId !== null
    const scopeWhere = scoped ? (includeShared ? '(m.peer_id = ? OR m.peer_id IS NULL)' : 'm.peer_id = ?') : '1=1'
    const scopeArgs = scoped ? [peerId] : []
    const candidates = new Map()
    if (q) {
      const tokens = tokenizeSearch(q).slice(0, 24)
      if (tokens.length) {
        try {
          const match = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
          const rows = this.db
            .prepare(`SELECT f.mem_id, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.id = f.mem_id WHERE memories_fts MATCH ? AND ${scopeWhere} AND m.status = 'active' ORDER BY rank LIMIT 80`)
            .all(match, ...scopeArgs)
          rows.forEach((row, index) => candidates.set(row.mem_id, { rrf: 1 / (60 + index), rank: index, via: 'fts' }))
        } catch {
          /* malformed FTS query falls back to LIKE below */
        }
      }
      if (candidates.size < 3) {
        const like = `%${q.slice(0, 40)}%`
        const rows = this.db
          .prepare(`SELECT m.id FROM memories m WHERE (m.content LIKE ? OR m.keywords LIKE ?) AND ${scopeWhere} AND m.status = 'active' LIMIT 40`)
          .all(like, like, ...scopeArgs)
        rows.forEach((row, index) => {
          if (!candidates.has(row.id)) candidates.set(row.id, { rrf: 1 / (80 + index), rank: 80 + index, via: 'like' })
        })
      }
    }

    // Graph expansion: memories linked from strong keyword hits reinforce each other.
    const seeds = [...candidates.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, 5)
    for (const [id, info] of seeds) {
      const memory = this.get(id)
      let added = 0
      for (const linkedId of memory?.links || []) {
        if (added >= 3) break
        if (candidates.has(linkedId)) continue
        // STEP 13: a link is its own RRF route, not a weak re-rank of the seed.
        candidates.set(linkedId, { rrf: 1 / (60 + 30 + added), rank: info.rank + 3, via: 'link' })
        added += 1
      }
    }

    // With no query at all, fall back to the most recent / strongest memories.
    if (!candidates.size) {
      const rows = this.db
        .prepare(`SELECT m.* FROM memories m WHERE m.status = 'active' AND ${scopeWhere} ORDER BY m.importance DESC, m.updatedAt DESC LIMIT 120`)
        .all(...scopeArgs)
      rows.forEach((row, index) => candidates.set(row.id, { rrf: 1 / (60 + index), rank: index, via: 'recent' }))
    }

    const scored = []
    const candidateIds = [...candidates.keys()]
    const hydrated = new Map()
    if (candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',')
      const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...candidateIds)
      for (const row of rows) hydrated.set(row.id, rowToMemory(row))
    }
    for (const [id, info] of candidates) {
      const memory = hydrated.get(id)
      if (!memory) continue
      if (!includeSuperseded && memory.status !== 'active') continue
      if (memory.validUntil && memory.validUntil < now) continue
      if (layers?.length && !layers.includes(memory.layer)) continue
      if (peerId !== undefined && peerId !== null) {
        if (memory.peerId && memory.peerId !== peerId) continue
        if (!memory.peerId && !includeShared) continue
      }
      const ageDays = Math.max(0, (now - memory.updatedAt) / DAY)
      const recency = Math.exp(-ageDays / 45)
      const exact = q && memory.content.includes(q.slice(0, Math.min(12, q.length))) ? 0.35 : 0
      const relevance = Math.min(1, Math.exp(-Math.max(0, info.rank) / 6) * (info.via === 'fts' ? 1 : 0.6) + exact)
      const importance = this.effectiveImportance(memory, now) / 10
      // 用 heat 列做对数饱和，避免召回次数线性碾压一切。
      const heat = Math.min(1, Math.log(1 + Number(memory.heat || 0)) / Math.log(12))
      const layerBoost = memory.layer === 'soul' || memory.layer === 'rules' ? 0.04 : memory.layer === 'user' ? 0.03 : 0
      const rrfBoost = Math.min(1, info.rrf * 60)
      const score = 0.48 * relevance + 0.18 * recency + 0.17 * importance + 0.07 * heat + 0.05 * memory.trust + 0.05 * rrfBoost + layerBoost + (info.via === 'link' ? 0.08 : 0)
      scored.push({ memory, score, relevance, via: info.via || 'unknown' })
    }
    scored.sort((a, b) => b.score - a.score)

    // MMR: relevance vs. novelty, so five paraphrases of one fact do not fill the block.
    const picked = []
    const tokenCache = new Map()
    const tokensOf = (m) => {
      if (!tokenCache.has(m.id)) tokenCache.set(m.id, new Set(tokenizeSearch(m.content)))
      return tokenCache.get(m.id)
    }
    const sim = (a, b) => {
      const A = tokensOf(a)
      const B = tokensOf(b)
      if (!A.size || !B.size) return 0
      let inter = 0
      for (const t of A) if (B.has(t)) inter++
      return inter / Math.sqrt(A.size * B.size)
    }
    while (picked.length < limit && scored.length) {
      let best = 0
      let bestScore = -Infinity
      for (let i = 0; i < scored.length; i++) {
        const candidate = scored[i]
        const penalty = picked.length ? Math.max(...picked.map((p) => sim(candidate.memory, p.memory))) : 0
        const mmr = 0.75 * candidate.score - 0.25 * penalty
        if (mmr > bestScore) {
          bestScore = mmr
          best = i
        }
      }
      picked.push(scored.splice(best, 1)[0])
    }
    return picked
  }

  recallBoost(ids) {
    const now = nowMs()
    // 冷却：1 小时内被注入过的记忆不再重复加权，否则被注入过的越来越容易被再注入（回声室）。
    const COOLDOWN = 60 * 60 * 1000
    const stmt = this.db.prepare(
      'UPDATE memories SET recallCount = recallCount + 1, lastRecalledAt = ?, heat = heat + 1, nextReviewAt = ? WHERE id = ?',
    )
    for (const id of ids) {
      const memory = this.get(id)
      if (!memory) continue
      if (memory.lastRecalledAt && now - Number(memory.lastRecalledAt) < COOLDOWN) continue
      stmt.run(now, now + Math.min(60, 7 * Math.pow(1.6, memory.recallCount || 0)) * DAY, id)
    }
  }

  /** Nightly Ebbinghaus pass: due reviews, re-weighting, and fade bookkeeping (never deletes). */
  decay({ now = nowMs(), reviewWindowDays = 7 } = {}) {
    const dueBefore = now + reviewWindowDays * DAY
    const rows = this.db.prepare("SELECT * FROM memories WHERE status = 'active'").all().map(rowToMemory)
    let due = 0
    let faded = 0
    for (const memory of rows) {
      const effective = this.effectiveImportance(memory, now)
      const ageDays = (now - memory.updatedAt) / DAY
      const nextReviewAt = memory.nextReviewAt ?? now + 3 * DAY
      const shouldReview = nextReviewAt <= dueBefore || (effective < 4.2 && ageDays > 21)
      if (shouldReview) {
        due++
        this.db.prepare('UPDATE memories SET nextReviewAt = ? WHERE id = ?').run(now + DAY, memory.id)
      }
      if (effective < 2 && ageDays > 90 && memory.recallCount === 0 && memory.layer !== 'soul') faded++
    }
    return { total: rows.length, due, faded }
  }

  /** STEP 13: wire same-peer, related-but-not-duplicate memories into bidirectional links. */
  linkSimilar(memoryId, { limit = 3, min = 0.55, max = 0.82 } = {}) {
    const source = this.get(memoryId)
    if (!source) return []
    const rows = this.list({ peerId: source.peerId || undefined, limit: 500, status: 'active' })
      .filter((other) => other.peerId === source.peerId)
    const scored = []
    for (const other of rows) {
      if (other.id === source.id || other.layer !== source.layer) continue
      const tri = trigramSimilarity(source.content, other.content)
      const A = new Set(tokenizeSearch(source.content))
      const B = new Set(tokenizeSearch(other.content))
      let overlap = 0
      for (const token of A) if (B.has(token)) overlap++
      const jac = A.size && B.size ? overlap / Math.sqrt(A.size * B.size) : 0
      const sim = Math.max(tri, jac)
      if (sim > min && sim < max) scored.push({ id: other.id, sim })
    }
    scored.sort((a, b) => b.sim - a.sim)
    const picked = scored.slice(0, limit).map((row) => row.id)
    for (const id of picked) {
      this.update(source.id, { links: [id] })
      this.update(id, { links: [source.id] })
    }
    return picked
  }

  /** Sleep-time consolidation: merge near-duplicates, wire co-occurrence links, archive stale. */
  consolidate({ now = nowMs(), threshold = 0.72 } = {}) {
    const all = this.list({ limit: 5000, all: false })
    const byLayer = new Map()
    for (const memory of all) {
      const key = `${memory.layer}|${memory.peerId || 'shared'}`
      if (!byLayer.has(key)) byLayer.set(key, [])
      byLayer.get(key).push(memory)
    }
    let merged = 0
    let links = 0
    const audit = this.db.prepare('INSERT INTO consolidation_log(at, layer, peer_id, keep_id, drop_id, reason) VALUES(?, ?, ?, ?, ?, ?)')
    this.db.exec('BEGIN')
    try {
    for (const group of byLayer.values()) {
      for (let i = 0; i < group.length; i++) {
        const a = group[i]
        if (a.status !== 'active') continue
        for (let j = i + 1; j < group.length; j++) {
          const b = group[j]
          if (b.status !== 'active') continue
          if (trigramSimilarity(a.content, b.content) < threshold) continue
          const keep = a.importance >= b.importance ? a : b
          const drop = keep === a ? b : a
          this.update(keep.id, {
            importance: Math.max(a.importance, b.importance),
            trust: Math.max(a.trust, b.trust),
            recallCount: keep.recallCount + drop.recallCount,
            sourceEpisodeIds: drop.sourceEpisodeIds,
            links: drop.links,
            content: keep.content.length >= drop.content.length ? keep.content : drop.content,
            meta: { ...keep.meta, mergedFrom: [...(keep.meta.mergedFrom || []), drop.id] },
          })
          audit.run(now, keep.layer, keep.peerId || null, keep.id, drop.id, 'near_duplicate')
          this.update(drop.id, { status: 'archived', meta: { ...drop.meta, mergedInto: keep.id } })
          merged++
          if (keep === a) group[i] = this.get(a.id)
        }
      }
    }

    // Hebbian links stay inside one peer's partition; linking across peers
    // would leak one person's memories into another's graph.
    const active = this.list({ limit: 5000 })
    const linkGroups = new Map()
    for (const memory of active) {
      const key = `${memory.layer}|${memory.peerId || 'shared'}`
      if (!linkGroups.has(key)) linkGroups.set(key, [])
      linkGroups.get(key).push(memory)
    }
    for (const group of linkGroups.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const kwA = new Set(group[i].keywords)
          if (!kwA.size) continue
          let shared = 0
          for (const k of group[j].keywords) if (kwA.has(k)) shared++
          if (shared < 2) continue
          if (group[i].links.length >= 10 || group[j].links.length >= 10) continue
          if (group[i].links.includes(group[j].id)) continue
          this.update(group[i].id, { links: [group[j].id] })
          this.update(group[j].id, { links: [group[i].id] })
          links++
        }
      }
    }
    this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
    return { merged, links, scanned: all.length, at: now }
  }

  /** 承诺过期：有明确期限且超过宽限期的自动关闭，避免 active 池只增不减。 */
  expireCommitments(now = nowMs(), graceDays = 14) {
    try {
      const cut = now - graceDays * DAY
      const res = this.db.prepare("UPDATE commitments SET status = 'expired' WHERE status = 'active' AND due_at > 0 AND due_at < ?").run(cut)
      return Number(res.changes || 0)
    } catch (err) { return 0 }
  }

  dueForReview(now = nowMs(), windowDays = 1) {
    return this.list({ limit: 50 }).filter((m) => (m.nextReviewAt ?? 0) <= now + windowDays * DAY)
  }

  stats(now = nowMs()) {
    const byLayer = this.countByLayer()
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get().n
    const superseded = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'superseded'").get().n
    const archived = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'archived'").get().n
    const episodes = this.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n
    const strongest = this.list({ limit: 20 })
      .map((m) => ({ id: m.id, layer: m.layer, content: m.content.slice(0, 60), effective: this.effectiveImportance(m, now) }))
      .sort((a, b) => b.effective - a.effective)
      .slice(0, 5)
    return { total: Number(total), superseded: Number(superseded), archived: Number(archived), episodes: Number(episodes), byLayer, strongest }
  }

  // ------------------------------------------------------------ episodes ----
  addEpisode({ sessionId = '', channel = '', role = 'user', text = '', emotion = '', peerId = null, speakerId = '', createdAt = nowMs(), id = uid('ep'), kind = '', sourceMedia = null, mediaMeta = null }) {
    const meta = mediaMeta && typeof mediaMeta === 'object' ? JSON.stringify(mediaMeta) : (mediaMeta || '{}')
    this.db
      .prepare('INSERT OR REPLACE INTO episodes(id, sessionId, channel, role, text, emotion, peer_id, speaker_id, archived, createdAt, kind, source_media, media_meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT archived FROM episodes WHERE id = ?), 0), ?, ?, ?, ?)')
      .run(id, String(sessionId), String(channel), role, String(text), emotion, peerId || null, speakerId || '', id, createdAt, String(kind || ''), sourceMedia || null, meta)
    return id
  }

  getEpisode(id) {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id)
    return row ? { ...row } : null
  }

  listEpisodes({ sessionId, peerId, limit = 50, before = Number.MAX_SAFE_INTEGER, since = 0, until = Number.MAX_SAFE_INTEGER, includeArchived = false } = {}) {
    const where = ['createdAt < ?', 'createdAt >= ?', 'createdAt <= ?']
    const args = [before, since, until]
    if (!includeArchived) where.push('archived = 0')
    if (sessionId) { where.push('sessionId = ?'); args.push(sessionId) }
    if (peerId) { where.push('peer_id = ?'); args.push(peerId) }
    return this.db
      .prepare(`SELECT * FROM episodes WHERE ${where.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`)
      .all(...args, limit)
      .reverse()
      .map((r) => ({ ...r, peerId: r.peer_id || null, speakerId: r.speaker_id || null, archived: Boolean(r.archived) }))
  }

  // ---------------------------------------------------------- read jobs ----
  createReadJob(row = {}) {
    const at = Number(row.createdAt || row.at || nowMs())
    const job = {
      id: row.id || uid('readjob'),
      title: String(row.title || ''),
      peerId: row.peerId || null,
      channel: String(row.channel || ''),
      status: row.status || 'queued',
      mode: row.mode || 'book',
      chapters: Math.max(0, Number(row.chapters) || 0),
      doneChapters: Math.max(0, Number(row.doneChapters) || 0),
      notified: Boolean(row.notified),
      readingId: row.readingId || null,
      principles: Math.max(0, Number(row.principles) || 0),
      error: row.error == null ? null : String(row.error),
      createdAt: at,
      updatedAt: Number(row.updatedAt || at),
    }
    this.db.prepare(`INSERT INTO read_jobs
      (id, title, peer_id, channel, status, mode, chapters, done_chapters, notified, reading_id, principles, error, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.title, job.peerId, job.channel, job.status, job.mode, job.chapters,
        job.doneChapters, job.notified ? 1 : 0, job.readingId, job.principles, job.error, job.createdAt, job.updatedAt)
    return { ...job }
  }

  updateReadJob(id, patch = {}) {
    const current = this.getReadJob(id)
    if (!current) return null
    const next = { ...current, ...patch, updatedAt: Number(patch.updatedAt || nowMs()) }
    this.db.prepare(`UPDATE read_jobs SET title=?, peer_id=?, channel=?, status=?, mode=?, chapters=?,
      done_chapters=?, notified=?, reading_id=?, principles=?, error=?, updated_at=? WHERE id=?`)
      .run(next.title, next.peerId, next.channel, next.status, next.mode, next.chapters,
        next.doneChapters, next.notified ? 1 : 0, next.readingId, next.principles, next.error, next.updatedAt, id)
    return { ...next }
  }

  getReadJob(id) {
    const row = this.db.prepare('SELECT * FROM read_jobs WHERE id = ?').get(String(id))
    return row ? this._readJobRow(row) : null
  }

  findActiveReadJob(peerId = null) {
    const row = peerId
      ? this.db.prepare("SELECT * FROM read_jobs WHERE peer_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(peerId)
      : this.db.prepare("SELECT * FROM read_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get()
    return row ? this._readJobRow(row) : null
  }

  listReadJobs(limit = 50) {
    return this.db.prepare('SELECT * FROM read_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map((row) => this._readJobRow(row))
  }

  _readJobRow(row) {
    return {
      id: row.id, title: row.title || '', peerId: row.peer_id || null, channel: row.channel || '',
      status: row.status, mode: row.mode, chapters: Number(row.chapters || 0),
      doneChapters: Number(row.done_chapters || 0), notified: Boolean(row.notified),
      readingId: row.reading_id || null, principles: Number(row.principles || 0),
      error: row.error || null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }
  }

  // ------------------------------------------------------- voice learning ----
  addVoiceExample({ id = uid('vex'), peerId = null, text = '', context = '', liked = true, at = nowMs() } = {}) {
    const value = String(text || '').trim()
    if (!value) return null
    this.db.prepare('INSERT OR REPLACE INTO voice_examples(id, peer_id, text, context, liked, at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, peerId || null, value, String(context || ''), liked ? 1 : 0, at)
    return { id, peerId: peerId || null, text: value, context: String(context || ''), liked: Boolean(liked), at }
  }

  listVoiceExamples({ peerId = null, limit = 40, likedOnly = false } = {}) {
    const where = []
    const args = []
    if (peerId) { where.push('(peer_id = ? OR peer_id IS NULL)'); args.push(peerId) }
    if (likedOnly) where.push('liked = 1')
    const sql = `SELECT * FROM voice_examples${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`
    return this.db.prepare(sql).all(...args, limit).map((r) => ({
      id: r.id, peerId: r.peer_id || null, text: r.text, context: r.context || '', liked: Boolean(r.liked), at: r.at,
    }))
  }

  addVoiceRule({ id = uid('vr'), scope = 'tone', directive = '', priority = 4, source = '', raw = '', at = nowMs() } = {}) {
    const value = String(directive || '').trim()
    if (!value) return null
    this.db.prepare('INSERT OR REPLACE INTO voice_rules(id, scope, directive, priority, source, raw, active, at) VALUES(?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, String(scope || 'tone'), value, Number(priority) || 4, String(source || ''), String(raw || ''), at)
    return { id, scope: String(scope || 'tone'), directive: value, priority: Number(priority) || 4, source: String(source || ''), raw: String(raw || ''), at }
  }

  listVoiceRules({ active = true, limit = 100 } = {}) {
    return this.db.prepare(`SELECT * FROM voice_rules${active ? ' WHERE active = 1' : ''} ORDER BY priority ASC, at DESC LIMIT ?`)
      .all(limit)
      .map((r) => ({ id: r.id, scope: r.scope, directive: r.directive, priority: r.priority, source: r.source, raw: r.raw, active: Boolean(r.active), at: r.at }))
  }

  deactivateVoiceRule(id) {
    return Number(this.db.prepare('UPDATE voice_rules SET active = 0 WHERE id = ?').run(id).changes || 0)
  }

  /** STEP 10 / ② - mark-only archive. Original rows stay intact. */
  archiveEpisodes(ids = []) {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length) return 0
    const now = nowMs()
    const stmt = this.db.prepare('UPDATE episodes SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0')
    let n = 0
    for (const id of list) n += Number(stmt.run(now, id).changes || 0)
    return n
  }

  restoreEpisodes(ids = []) {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length) return 0
    const stmt = this.db.prepare('UPDATE episodes SET archived = 0, archived_at = NULL WHERE id = ?')
    let n = 0
    for (const id of list) n += Number(stmt.run(id).changes || 0)
    return n
  }

  archiveMemories(ids = []) {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length) return 0
    const now = nowMs()
    const stmt = this.db.prepare("UPDATE memories SET status = 'archived', validUntil = COALESCE(validUntil, ?), updatedAt = ? WHERE id = ? AND status != 'archived'")
    let n = 0
    for (const id of list) n += Number(stmt.run(now, now, id).changes || 0)
    return n
  }

  restoreMemories(ids = []) {
    const list = [...new Set(ids.filter(Boolean))]
    if (!list.length) return 0
    const now = nowMs()
    const stmt = this.db.prepare("UPDATE memories SET status = 'active', validUntil = NULL, updatedAt = ? WHERE id = ? AND status = 'archived'")
    let n = 0
    for (const id of list) n += Number(stmt.run(now, id).changes || 0)
    return n
  }

  // -------------------------------------------------------------- ledger ----
  upsertLedgerEntry(entry) {
    const now = nowMs()
    const key = `${entry.kind}|${entry.subject || ''}|${entry.field || ''}|${entry.value || ''}`
    const existing = this.db
      .prepare('SELECT * FROM ledger WHERE kind = ? AND subject = ? AND field = ? AND value = ? AND peer_id IS ? AND (validUntil IS NULL OR validUntil > ?)')
      .get(entry.kind, entry.subject || '', entry.field || '', entry.value || '', entry.peer_id || null, now)
    if (existing) return { ...existing, updatedAt: now }
    const row = {
      id: uid('led'),
      kind: entry.kind,
      subject: entry.subject || '',
      field: entry.field || '',
      value: entry.value || '',
      confidence: clamp(Number(entry.confidence ?? 0.6), 0, 1),
      peer_id: entry.peer_id || null,
      sourceEpisodeIds: parseList(entry.sourceEpisodeIds),
      validFrom: entry.validFrom ?? now,
      validUntil: entry.validUntil ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO ledger(id, kind, subject, field, value, confidence, peer_id, sourceEpisodeIds, validFrom, validUntil, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind,
        row.subject,
        row.field,
        row.value,
        row.confidence,
        row.peer_id,
        JSON.stringify(row.sourceEpisodeIds),
        row.validFrom,
        row.validUntil,
        row.createdAt,
        row.updatedAt,
      )
    if (entry.expiresPrevious && entry.kind && entry.subject) {
      this.db
        .prepare('UPDATE ledger SET validUntil = ?, updatedAt = ? WHERE kind = ? AND subject = ? AND peer_id IS ? AND id != ? AND validUntil IS NULL')
        .run(now, now, entry.kind, entry.subject, row.peer_id || null, row.id)
    }
    return row
  }

  ledgerEntries(limit = 100, peerId) {
    const rows = peerId
      ? this.db.prepare('SELECT * FROM ledger WHERE peer_id = ? ORDER BY updatedAt DESC LIMIT ?').all(peerId, limit)
      : this.db.prepare('SELECT * FROM ledger ORDER BY updatedAt DESC LIMIT ?').all(limit)
    return rows.map((r) => ({ ...r, sourceEpisodeIds: parseList(r.sourceEpisodeIds), peerId: r.peer_id || null }))
  }

  health(key, value) {
    return this.kvSet(`health:${key}`, { value, at: nowMs() })
  }

  static openReadOnly(dir) {
    const file = join(dir, 'memory.db')
    if (!existsSync(file)) return null
    const db = new DatabaseSync(file, { readOnly: true })
    return db
  }

  /** Star-map projection: deterministic placement + strength, no writes. */
  constellation(now = nowMs()) {
    const memories = this.list({ limit: 4000, status: null, all: true })
    return memories.map((m) => {
      const angle = hashUnit(m.id, 'a') * Math.PI * 2
      const depth = (hashUnit(m.id, 'z') - 0.5) * 2
      return {
        id: m.id,
        layer: m.layer,
        content: m.content,
        keywords: m.keywords,
        importance: m.importance,
        effective: this.effectiveImportance(m, now),
        trust: m.trust,
        status: m.status,
        emotion: m.emotion,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        validUntil: m.validUntil,
        recallCount: m.recallCount,
        lastRecalledAt: m.lastRecalledAt,
        links: m.links,
        peerId: m.peerId,
        angle,
        depth,
      }
    })
  }
}

export function openStore(dir) {
  return new MemoryStore(dir)
}
