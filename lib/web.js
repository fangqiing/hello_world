import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { clamp, localDateKey } from './util.js'
import { readDiary, readPersona, writeSelf, readSelf, readText, writePersonaSection } from './persona.js'
import { cognitionSnapshot } from './cognition.js'
import { guard, isTrustedToken, trustedRequest } from './auth-guard.js'
import { ReadJobRunner } from './read-jobs.js'
import { progressOf } from './read-job.js'
import { LIMITS as BOOK_LIMITS, splitBookDetailed } from './book-chapters.js'
export { guard, isTrustedToken, trustedRequest } from './auth-guard.js'

const MAX_BODY = 5_000_000
const ALLOWED_FILES = new Set(['persona', 'world', 'self'])

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!size) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function localStamp(ms, timeZone = 'Asia/Shanghai') {
  const text = new Date(ms).toLocaleString('sv-SE', { timeZone, hour12: false })
  return text.replace(' ', 'T')
}

function effective(memory, now) {
  const ageDays = Math.max(0, (now - memory.updatedAt) / 86_400_000)
  const decay = Math.exp((-Math.LN2 * ageDays) / 60)
  return clamp(memory.importance * (0.45 + 0.55 * decay) + Math.min(2.4, 0.35 * Math.log(1 + memory.recallCount)), 0.4, 10)
}

/** Read-only SQLite projection for the star map: SELECT only, never opens for write. */
export function readConstellation(dir, { includeArchived = false, since = 0, limit = 4000, timeZone = 'Asia/Shanghai', peerId = null, lean = false } = {}) {
  const file = join(dir, 'memory.db')
  if (!existsSync(file)) return { ok: false, error: 'memory.db not found', items: [], mtime: 0 }
  const mtime = statSync(file).mtimeMs
  if (since && mtime <= since) return { ok: true, changed: false, mtime, items: [] }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const where = []
    const args = []
    if (!includeArchived) where.push("status != 'archived'")
    if (peerId) {
      where.push('(peer_id = ? OR peer_id IS NULL)')
      args.push(peerId)
    }
    args.push(limit)
    const rows = db
      .prepare(
        `SELECT id, layer, content, keywords, importance, trust, status, createdAt, updatedAt, validUntil,
                recallCount, lastRecalledAt, links, emotion
         FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(...args)
    const now = Date.now()
    const items = rows.map((row) => {
      let keywords = ''
      let links = []
      try {
        const parsed = JSON.parse(row.keywords)
        keywords = Array.isArray(parsed) ? parsed.join(' ') : String(row.keywords || '')
      } catch {
        keywords = String(row.keywords || '')
      }
      try {
        const parsed = JSON.parse(row.links)
        links = Array.isArray(parsed) ? parsed : []
      } catch {
        links = []
      }
      // lean：星图只留画图要用的字段，正文/信任度/召回细节留到点开详情再取。
      if (lean) {
        return {
          id: row.id,
          layer: row.layer,
          content: String(row.content || '').slice(0, 120),
          keywords,
          importance: Number(row.importance),
          createdAt: Number(row.createdAt),
          links,
        }
      }
      return {
        id: row.id,
        layer: row.layer,
        content: row.content,
        keywords,
        importance: Number(row.importance),
        effectiveImportance: Number(effective({ ...row, importance: Number(row.importance), recallCount: Number(row.recallCount) }, now).toFixed(2)),
        trust: Number(row.trust),
        status: row.status,
        time: localStamp(Number(row.updatedAt), timeZone),
        createdAt: Number(row.createdAt),
        recallCount: Number(row.recallCount),
        lastRecalledAt: row.lastRecalledAt == null ? null : Number(row.lastRecalledAt),
        links,
        emotion: row.emotion || '',
      }
    })
    return { ok: true, changed: true, mtime, items, total: items.length }
  } finally {
    db.close()
  }
}

function worlds(whale) {
  const out = [{ id: whale.config.worldId || 'default', dir: whale.dir, active: true }]
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : ''
  if (!home) return out
  try {
    for (const entry of readdirSync(join(home, 'whale-chan'))) {
      const dir = join(home, 'whale-chan', entry)
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, 'memory.db')) && !out.some((row) => row.dir === dir)) {
          out.push({ id: entry, dir, active: dir === whale.dir })
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* a fresh installation has no sibling worlds yet */
  }
  return out
}

export function registerWeb(whale, webServer) {
  const ctx = whale.ctx
  const store = whale.store
  const readJobs = new ReadJobRunner({
    store,
    reading: whale.reading,
    social: whale.social,
    channels: whale.channels,
  })

  const route = (kind, path, handler) => ctx.effect(() => webServer.register({ kind, path, handler }))

  route('prefix', '/whale-chan/api', async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.replace(/^\/whale-chan\/api\//, '')
      if (path.startsWith('read-jobs/')) {
        if (!guard(req, res, 'GET')) return
        const id = decodeURIComponent(path.slice('read-jobs/'.length))
        const job = store.getReadJob(id)
        if (!job) return json(res, 404, { ok: false, error: 'job not found' })
        return json(res, 200, { ok: true, job: { ...job, progress: progressOf(job) } })
      }
      if (path === 'state') {
        if (!guard(req, res, 'GET')) return
        const snapshot = cognitionSnapshot(store, whale.config.timeZone)
        const today = localDateKey(whale.config.timeZone)
        return json(res, 200, {
          ok: true,
          name: whale.config.name,
          partnerName: whale.config.partnerName,
          worldId: whale.config.worldId,
          timeZone: whale.config.timeZone,
          dir: whale.dir,
          startedAt: whale.startedAt,
          cognition: snapshot,
          memory: store.stats(),
          channels: whale.channels?.list?.() || [],
          life: whale.life?.status?.() || {},
          usage: store.kvGet(`usage:${today}`, { input: 0, output: 0 }),
          dailyTokenBudget: whale.config.dailyTokenBudget,
          health: {
            llm: store.kvGet('health:llm', null),
            digest: store.kvGet('health:digest', null),
            consolidation: store.kvGet('health:consolidation', null),
            review: store.kvGet('health:review', null),
            channel: store.kvGet('health:channel', null),
            compaction: store.kvGet('health:compaction', null),
          },
          worlds: worlds(whale),
          peers: whale.social?.listPeers?.() || [],
          principles: whale.social?.listPrinciples?.({ status: 'active', limit: 30 }) || [],
          wired: [...whale.agentLayer.disposers.keys()],
          persona: {
            identity: Boolean(whale.agentLayer.personaView().identity),
            personaChars: whale.agentLayer.personaView().persona.length,
            selfChars: whale.agentLayer.personaView().self.length,
          },
          compactionAvailable: Boolean(ctx.get('compaction')),
        })
      }

      if (path === 'memories') {
        if (!guard(req, res, 'GET')) return
        const layer = url.searchParams.get('layer') || undefined
        const query = url.searchParams.get('q') || ''
        const all = url.searchParams.get('all') === '1'
        if (all && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const ownPeer = whale.defaultPeerId() || undefined
        const requested = url.searchParams.get('peer') || ownPeer
        if (requested && ownPeer && requested !== ownPeer && !isTrustedToken(url.searchParams.get('token') || req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const peerId = requested
        const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 300)
        const items = store.list({ layer, query, all, status: all ? null : 'active', limit, peerId }).map((memory) => ({
          ...memory,
          effectiveImportance: Number(store.effectiveImportance(memory).toFixed(2)),
          time: new Date(memory.updatedAt).toISOString(),
        }))
        return json(res, 200, { ok: true, items })
      }

      if (path === 'memory') {
        if (!guard(req, res, 'GET')) return
        const id = url.searchParams.get('id') || ''
        const ownPeer = whale.defaultPeerId() || undefined
        const peerId = url.searchParams.get('peer') || ownPeer
        if (peerId && ownPeer && peerId !== ownPeer && !isTrustedToken(url.searchParams.get('token') || req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const memory = store.get(id)
        if (!memory || (memory.peerId && memory.peerId !== peerId)) return json(res, 404, { ok: false, error: 'not found' })
        return json(res, 200, { ok: true, memory })
      }

      if (path === 'peers') {
        if (!guard(req, res, 'GET')) return
        return json(res, 200, { ok: true, items: whale.social.listPeers({ status: url.searchParams.get('status') || 'active' }) })
      }

      if (path === 'principles') {
        if (!guard(req, res, 'GET')) return
        return json(res, 200, {
          ok: true,
          items: whale.social.listPrinciples({ status: url.searchParams.get('status') || 'active', limit: 100 }),
        })
      }

      if (path === 'readings') {
        if (!guard(req, res, 'GET')) return
        return json(res, 200, { ok: true, items: whale.social.listReadings(100) })
      }

      if (path === 'disclosures') {
        if (!guard(req, res, 'GET')) return
        return json(res, 200, {
          ok: true,
          items: whale.social.listDisclosures({
            peerFrom: url.searchParams.get('from') || undefined,
            peerTo: url.searchParams.get('to') || undefined,
            limit: 100,
          }),
        })
      }

      if (path === 'growth') {
        if (!guard(req, res, 'GET')) return
        const peerId = url.searchParams.get('peer') || whale.defaultPeerId() || null
        return json(res, 200, {
          ok: true,
          timeline: whale.social.growthTimeline({ peerId, limit: 200 }),
          principles: whale.social.listPrinciples({ status: null, limit: 100 }),
          moodHistory: whale.social.listMoodHistory(30),
          proactive: peerId ? whale.social.listProactive({ peerId, limit: 100 }) : [],
          disclosures: peerId ? whale.social.listDisclosures({ peerTo: peerId, limit: 100 }) : [],
          chapters: peerId ? whale.social.listChapters(peerId, { limit: 100 }) : [],
          diaries: peerId ? whale.social.listDiaries(peerId, 30) : [],
        })
      }

      if (path === 'diaries') {
        if (!guard(req, res, 'GET')) return
        const ownPeer = whale.defaultPeerId() || ''
        const peerId = url.searchParams.get('peer') || ownPeer
        if (!peerId) return json(res, 400, { ok: false, error: 'peer required' })
        if (ownPeer && peerId !== ownPeer && !isTrustedToken(url.searchParams.get('token') || req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        return json(res, 200, { ok: true, items: whale.social.listDiaries(peerId, Math.min(100, Number(url.searchParams.get('limit')) || 30)) })
      }

      if (path === 'persona') {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          return json(res, 200, {
            ok: true,
            persona: readText(join(whale.dir, 'persona.md'), ''),
            parsed: readPersona(whale.dir),
            world: readText(join(whale.dir, 'world-prompt.md'), ''),
            self: readSelf(whale.dir),
          })
        }
        if (req.method === 'POST') {
          if (!guard(req, res, 'POST')) return
          const body = await readBody(req)
          const file = String(body.file || 'persona')
          if (!ALLOWED_FILES.has(file)) return json(res, 400, { ok: false, error: 'unknown file' })
          if (file === 'persona' && body.section) {
            writePersonaSection(whale.dir, String(body.section), String(body.content || ''))
          } else if (file === 'persona') {
            writeFileSync(join(whale.dir, 'persona.md'), String(body.content || ''), 'utf8')
          } else if (file === 'world') {
            writeFileSync(join(whale.dir, 'world-prompt.md'), String(body.content || ''), 'utf8')
          } else {
            writeSelf(whale.dir, String(body.content || ''), whale.config.timeZone)
          }
          whale.agentLayer.invalidatePersona()
          return json(res, 200, { ok: true })
        }
        return json(res, 405, { ok: false, error: 'method not allowed' })
      }

      if (path === 'diary') {
        if (!guard(req, res, 'GET')) return
        const date = url.searchParams.get('date') || localDateKey(whale.config.timeZone)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: 'invalid date' })
        return json(res, 200, { ok: true, date, text: readDiary(whale.dir, date) })
      }

      if (path === 'action') {
        if (!guard(req, res, 'POST')) return
        const body = await readBody(req)
        const action = String(body.action || '')
        if (action === 'review') {
          await whale.life.review()
          return json(res, 200, { ok: true })
        }
        if (action === 'consolidate') {
          const result = store.consolidate()
          store.decay()
          return json(res, 200, { ok: true, result })
        }
        if (action === 'digest') {
          const sessionId = String(body.sessionId || whale.lastSessionId || '')
          if (!sessionId) return json(res, 400, { ok: false, error: 'no session' })
          await whale.agentLayer.runDigest(sessionId)
          return json(res, 200, { ok: true })
        }
        if (action === 'compact') {
          const sessionId = String(body.sessionId || whale.lastSessionId || '')
          const compaction = ctx.get('compaction')
          const agents = ctx.get('agents')
          const agent = sessionId ? agents?.get?.(sessionId) : agents?.list?.()[0]
          if (!compaction || !agent) return json(res, 400, { ok: false, error: 'compaction service or live session unavailable' })
          try {
            const outcome = await compaction.compactNow(agent, new AbortController().signal)
            return json(res, 200, { ok: true, outcome })
          } catch (error) {
            // Fall back to a ledger + working-block digest so the console action still helps.
            await whale.agentLayer.runDigest(agent.id)
            return json(res, 200, { ok: true, fallback: true, error: String(error?.message || error) })
          }
        }
        if (action === 'reading-delete') {
          const id = String(body.id || '').trim()
          if (!id) return json(res, 400, { ok: false, error: 'id required' })
          const deleted = whale.social.deleteReading(id)
          if (!deleted) return json(res, 404, { ok: false, error: 'reading not found' })
          return json(res, 200, { ok: true, deleted: true, id })
        }
        if (action === 'read-book') {
          const title = String(body.title || '')
          const source = String(body.source || '')
          const chapters = (Array.isArray(body.chapters) ? body.chapters : [])
            .map((row) => ({ title: String(row?.title || ''), text: String(row?.text || '') }))
            .filter((row) => row.text.trim())
          const text = String(body.text || '')
          const mode = body.mode === 'article' ? 'article' : (body.mode === 'book' ? 'book' : (chapters.length ? 'book' : 'article'))
          const total = text.length || chapters.reduce((n, row) => n + row.text.length, 0)
          if (!total) return json(res, 400, { ok: false, error: 'empty book' })
          if (total > BOOK_LIMITS.maxChars) {
            return json(res, 413, { ok: false, error: 'book too large', maxChars: BOOK_LIMITS.maxChars })
          }
          let jobChapters = chapters
          if (mode === 'book' && text.trim()) {
            const parsed = splitBookDetailed(text)
            if (parsed.chapters.length >= 2) jobChapters = parsed.chapters
          }
          const accepted = readJobs.start({
            title,
            source,
            text,
            chapters: jobChapters,
            mode,
            peerId: whale.defaultPeerId() || null,
          })
          return json(res, accepted.status, accepted.body)
        }
        if (action === 'disclosure') {
          const row = whale.social.logDisclosure({
            peerFrom: String(body.peerFrom || ''),
            peerTo: String(body.peerTo || ''),
            commitmentId: body.commitmentId || null,
            decision: String(body.decision || 'not_mentioned'),
            principleIds: Array.isArray(body.principleIds) ? body.principleIds : [],
            reason: String(body.reason || ''),
            userOverride: Boolean(body.userOverride),
          })
          for (const principleId of (Array.isArray(body.principleIds) ? body.principleIds : [])) {
            whale.growth.principle.addEvidence({ principleId, kind: body.userOverride ? 'conflict' : 'support', evidenceId: row.id, actor: body.userOverride ? 'user' : 'self' })
          }
          return json(res, 200, { ok: true, id: row.id })
        }
        if (action === 'peer-update') {
          const peerId = String(body.peerId || '')
          if (!peerId) return json(res, 400, { ok: false, error: 'peerId required' })
          const peer = whale.social.updatePeer(peerId, {
            ...(body.learned_name !== undefined ? { learned_name: String(body.learned_name) } : {}),
            ...(body.relation_summary !== undefined ? { relation_summary: String(body.relation_summary) } : {}),
            ...(body.display_name !== undefined ? { display_name: String(body.display_name) } : {}),
            ...(body.status !== undefined ? { status: String(body.status) } : {}),
          })
          return json(res, 200, { ok: true, peer })
        }
        if (action === 'principle-revise') {
          const id = String(body.id || '')
          if (!id) return json(res, 400, { ok: false, error: 'id required' })
          const principle = whale.social.revisePrinciple(id, {
            statement: body.statement != null ? String(body.statement) : undefined,
            source: String(body.source || 'self-reflection'),
            weight: body.weight != null ? Number(body.weight) : undefined,
          })
          return json(res, 200, { ok: true, principle })
        }
        if (action === 'growth-tick') {
          const result = whale.growth.tick({ since: body.since ? Number(body.since) : Date.now() - 7 * 86400000 })
          return json(res, 200, { ok: true, result })
        }
        if (action === 'proactive-evaluate') {
          return json(res, 200, { ok: true, candidates: whale.growth.proactive.evaluate(), enabled: whale.growth.proactive.cfg.enabled })
        }
        if (action === 'channel-enable') {
          const next = body.config && typeof body.config === 'object' ? { ...body.config } : {}
          for (const key of ['bridgeUrl', 'wsUrl', 'apiBase', 'linuxApiUrl', 'webhookUrl']) {
            if (next[key] == null || next[key] === '') continue
            let parsed
            try { parsed = new URL(String(next[key])) } catch { parsed = null }
            if (!parsed || !['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
              return json(res, 400, { ok: false, error: 'invalid channel url' })
            }
          }
          const status = await whale.channels.enable(String(body.channel || 'wechat'), next)
          return json(res, 200, { ok: true, status })
        }
        if (action === 'channel-disable') {
          const stopped = await whale.channels.disable(String(body.channel || 'wechat'))
          return json(res, 200, { ok: true, stopped })
        }
        if (action === 'simulate') {
          const text = String(body.text || '在吗').slice(0, 2000)
          const sessionId = 'session-whale-console'
          const agent = await whale.ensureChannelAgent(sessionId, String(body.channel || 'console'))
          const texts = []
          const offReply = whale.agentLayer.onReply((sid, reply) => { if (sid === sessionId) texts.push(reply) })
          let offEnd = () => {}
          const done = new Promise((resolve) => {
            offEnd = whale.agentLayer.onTurnEnd((sid) => { if (sid === sessionId) resolve() })
            const timer = setTimeout(resolve, 90_000)
            timer.unref?.()
          })
          agent.followup({
            role: 'user',
            id: `sim-${Date.now()}`,
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          })
          await done
          offReply()
          offEnd()
          return json(res, 200, { ok: true, sessionId, reply: texts.join('\n') })
        }
        if (action === 'clear-wm') {
          store.kvSet(`wm:${String(body.sessionId || whale.lastSessionId || '')}`, '')
          return json(res, 200, { ok: true })
        }
        if (action === 'channel-resume') {
          whale.channels?.resume(String(body.channel || ''))
          return json(res, 200, { ok: true })
        }
        if (action === 'send-test') {
          const channel = String(body.channel || '')
          if (!['qq', 'wechat'].includes(channel)) return json(res, 400, { ok: false, error: 'invalid channel' })
          const to = String(body.to || whale.config.ownerId || '')
          if (!to) return json(res, 400, { ok: false, error: 'no conversation id' })
          const group = to.startsWith('group:')
          const bare = group ? to.slice(6) : to.replace(/^private:/, '')
          const registered = whale.peerRegistry?.isAllowed?.(group ? `group:${bare}` : bare, group ? 'group' : 'direct')
          if (!registered && bare !== whale.config.ownerId) {
            return json(res, 403, { ok: false, error: 'target not allowed' })
          }
          await whale.channels.sendText(channel, to, String(body.text || '在。'))
          return json(res, 200, { ok: true })
        }
        return json(res, 400, { ok: false, error: `unknown action: ${action}` })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (String(error?.message || '') === 'body too large') {
        return json(res, 413, { ok: false, error: 'body too large', maxBytes: MAX_BODY })
      }
      whale.logger?.warn?.('whale-chan: web action failed', error)
      return json(res, 500, { ok: false, error: 'internal error' })
    }
  })

  // Prompt §6 route names, kept as stable aliases for existing clients/scripts.
  route('exact', '/whale-constellation/api/memories', (req, res) => {
    if (!guard(req, res, 'GET')) return
    const url = new URL(req.url, 'http://localhost')
    const dir = whale.dir
    const peerId = url.searchParams.get('peer') || whale.defaultPeerId()
    if (peerId !== whale.defaultPeerId() && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) {
      return json(res, 403, { ok: false, error: 'cross-peer requires owner token' })
    }
    const result = readConstellation(dir, {
      includeArchived: url.searchParams.get('all') === '1',
      since: Number(url.searchParams.get('since')) || 0,
      limit: Math.min(4000, Number(url.searchParams.get('limit')) || 4000),
      timeZone: whale.config.timeZone,
      peerId,
      lean: url.searchParams.get('lean') === '1',
    })
    return json(res, result.ok ? 200 : 404, result)
  })

  route('exact', '/whale-chan/constellation/api/memories', (req, res) => {
    if (!guard(req, res, 'GET')) return
    const url = new URL(req.url, 'http://localhost')
    const peerId = url.searchParams.get('peer') || whale.defaultPeerId()
    if (peerId !== whale.defaultPeerId() && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) {
      return json(res, 403, { ok: false, error: 'cross-peer requires owner token' })
    }
    const result = readConstellation(whale.dir, {
      includeArchived: url.searchParams.get('all') === '1',
      since: Number(url.searchParams.get('since')) || 0,
      timeZone: whale.config.timeZone,
      peerId,
      lean: url.searchParams.get('lean') === '1',
    })
    return json(res, result.ok ? 200 : 404, result)
  })

  const serveApp = (req, res) => {
    if (!guard(req, res, 'GET', { allowHtml: true })) return
    // 3D 版优先；老的单文件版只作为兜底，避免「改了新版但路由还挂着旧版」。
    const names = ['constellation-webgl.html']
    let file = ''
    for (const name of names) {
      const hit = [join(whale.packageDir, 'client', name), join(process.cwd(), 'client', name)].find((candidate) => existsSync(candidate))
      if (hit) { file = hit; break }
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('constellation page not found')
      return
    }
    let html = readFileSync(file, 'utf8')
    // 页面靠 window.HELLO_WORLD_CONFIG 判断是否走真实数据；不注入它就会落到 demo 假数据。
    // 页面正文里会出现 window.HELLO_WORLD_CONFIG 这个字符串，只能判断有没有「赋值」。
    if (!/window\.HELLO_WORLD_CONFIG\s*=/.test(html)) {
      const peerId = whale.defaultPeerId?.() || ''
      const injected = `<script>window.HELLO_WORLD_CONFIG={apiBase:'/whale-constellation',peer:${JSON.stringify(peerId)}};</script>`
      html = html.includes('</head>') ? html.replace('</head>', `${injected}</head>`) : `${injected}${html}`
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }
  // 前端依赖本地化：不依赖外网 CDN，MIT 许可，见 client/vendor/SOURCES.txt
  route('exact', '/whale-constellation/vendor/3d-force-graph.min.js', (req, res) => {
    // 公开静态依赖（MIT，无私有数据）：不套 guard——浏览器 <script src> 不带 cookie/Accept: html，会被误拦。
    const file = [
      join(whale.packageDir, 'client', 'vendor', '3d-force-graph.min.js'),
      join(process.cwd(), 'client', 'vendor', '3d-force-graph.min.js'),
    ].find((candidate) => existsSync(candidate))
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('vendor not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' })
    res.end(readFileSync(file))
  })
  route('exact', '/whale-constellation/app', serveApp)
  route('exact', '/whale-chan/constellation/app', serveApp)
}
