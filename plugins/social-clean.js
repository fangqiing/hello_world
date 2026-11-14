import { json } from './_util.js'
import { guard, isTrustedToken, trustedRequest } from '../lib/web.js'
export const name = 'hello_world-social'
export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/social',
      handler: (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
        const url = new URL(req.url, 'http://localhost')
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
        const peers = whale.social.listPeers({ status: 'active' })
        const ownPeer = whale.defaultPeerId() || ''
        const requested = url.searchParams.get('peer') || ownPeer
        if (ownPeer && requested !== ownPeer && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const peerId = requested
        json(res, 200, {
          ok: true,
          peers,
          principles: whale.social.listPrinciples({ status: 'active', limit: 50 }),
          disclosures: peerId ? whale.social.listDisclosures({ peerTo: peerId, limit }) : [],
          commitments: peerId ? whale.social.listCommitments(peerId) : [],
          readings: whale.social.listReadings(limit),
        })
        } catch (error) {
          json(res, 500, { ok: false, error: 'internal error' })
        }
      },
    }))
  })
}
