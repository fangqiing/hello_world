import { appendFileSync } from 'node:fs'
import { json } from './_util.js'
export const name = 'hello_world-social'
export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/social',
      handler: (req, res) => {
        appendFileSync('/tmp/social-hit.log', 'hit '+new Date().toISOString()+'\n')
        try {
        const url = new URL(req.url, 'http://localhost')
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
        const peers = whale.social.listPeers({ status: 'active' })
        json(res, 200, {
          ok: true,
          peers,
          principles: whale.social.listPrinciples({ status: 'active', limit: 50 }),
          disclosures: whale.social.listDisclosures({ limit }),
          commitments: peers.flatMap((peer) => whale.social.listCommitments(peer.id)),
          readings: whale.social.listReadings(limit),
        })
        } catch (error) {
          try { appendFileSync('/tmp/social-error.log', new Date().toISOString()+' '+String(error?.stack || error)+'\n') } catch {}
          json(res, 500, { ok: false, error: String(error?.stack || error) })
        }
      },
    }))
  })
}
