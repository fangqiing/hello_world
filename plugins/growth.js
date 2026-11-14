import { json } from './_util.js'
import { guard, isTrustedToken, trustedRequest } from '../lib/web.js'
import { serializeRegistry } from '../lib/constants-registry.js'
import { buildGrowthView } from '../lib/growth-view-model.js'

export const name = 'hello_world-growth'

function unified(whale, { peerId, limit, offset }) {
  const principleEvents = whale.social.listPrincipleEvents({ limit: 500 }).slice(offset, offset + limit)
  const pendingAsks = whale.social.listPendingAsks({ targetPeer: peerId })
  const openChapters = peerId ? whale.social.openChapters(peerId) : []
  const chapters = peerId ? whale.social.listChapters(peerId, { limit: 100 }) : []
  const disclosures = whale.social.listDisclosures({ peerTo: peerId, limit })
  const proactive = whale.social.listProactive({ peerId, limit })
  const moodHistory = whale.social.listMoodHistory(limit)
  const observations = [
    ...principleEvents.map((e) => ({ at: e.at, kind: 'principle', actor: e.actor || 'self', evidence_id: e.evidence_id || null, before: e.weight_before ?? null, after: e.weight_after ?? e.event, reason: e.reason || e.event, peer_id: null, snapshot_id: null })),
    ...moodHistory.map((e) => ({ at: e.at, kind: 'mood', actor: 'self', evidence_id: e.id, before: null, after: e.statement, reason: 'aggregate', peer_id: null, snapshot_id: null })),
    ...disclosures.map((e) => ({ at: e.decided_at, kind: 'disclosure', actor: 'self', evidence_id: e.id, before: e.decision, after: e.decision, reason: e.reason || '', peer_id: e.peer_to || null, snapshot_id: null })),
    ...proactive.map((e) => ({ at: e.at, kind: 'proactive', actor: 'self', evidence_id: e.id, before: e.trigger, after: e.decision, reason: e.reason || '', peer_id: e.target_peer || null, snapshot_id: null })),
    ...pendingAsks.map((e) => ({ at: e.at, kind: 'pending_ask', actor: 'self', evidence_id: e.id, before: 'open', after: 'pending', reason: e.question || '', peer_id: e.target_peer || null, snapshot_id: null })),
    ...openChapters.map((e) => ({ at: e.at, kind: 'open_chapter', actor: 'self', evidence_id: e.id, before: 'open', after: e.status, reason: e.summary || '', peer_id: e.peer_id || peerId, snapshot_id: null })),
    ...chapters.map((e) => ({ at: e.at, kind: 'chapter', actor: 'self', evidence_id: e.id, before: null, after: e.status || 'closed', reason: e.summary || '', peer_id: e.peer_id || peerId, snapshot_id: null })),
  ].sort((a, b) => b.at - a.at).slice(0, limit)
  return { principleEvents, pendingAsks, openChapters, chapters, disclosures, proactive, moodHistory, observations }
}

export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/growth',
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url, 'http://localhost')
        const ownPeer = whale.defaultPeerId() || null
        const requested = url.searchParams.get('peer') || ownPeer
        if (ownPeer && requested !== ownPeer && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const peerId = requested
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
        const data = unified(whale, { peerId, limit, offset })
        const principles = whale.social.listPrinciples({ status: null, limit: 100 })
        const principleById = new Map(principles.map((p) => [p.id, p]))
        const peerRow = peerId ? whale.social.getPeer(peerId) : null
        const peer = peerRow ? {
          displayName: peerRow.display_name || peerId,
          firstSeenAt: peerRow.first_seen,
          lastSeenAt: peerRow.last_seen,
        } : {}
        const chapters = peerId ? whale.social.listChapters(peerId, { limit: 100 }) : []
        const diaries = peerId ? whale.social.listDiaries(peerId, 30) : []
        const readings = whale.social.listReadings(50).map((reading) => {
          const ids = reading.principle_ids || []
          return {
            ...reading,
            at: reading.read_at,
            candidates: ids.length,
            active: ids.filter((id) => principleById.get(id)?.status === 'active').length,
          }
        })
        const view = buildGrowthView({
          principles, chapters, diaries, peer, now: Date.now(),
          timeZone: whale.config?.timeZone || 'Asia/Shanghai', limit,
        })
        json(res, 200, {
          ok: true,
          timeline: whale.social.growthTimeline({ peerId, limit }),
          ...data,
          constants: serializeRegistry(),
          principles,
          chapters,
          diaries,
          peer,
          readings,
          view,
        })
      },
    }))
  })
}
