import { json, readJson } from './_util.js'
import { guard } from '../lib/web.js'

export const name = 'hello_world-channels'

export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    const route = (kind, path, handler) => child.effect(() => child.webServer.register({ kind, path, handler }))

    route('exact', '/hello-world/api/channels', (req, res) => {
      if (!guard(req, res, 'GET')) return
      json(res, 200, { ok: true, channels: whale.channels?.list?.() || [] })
    })

    route('exact', '/hello-world/api/channels/peers', async (req, res) => {
      if (!guard(req, res)) return
      if (req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          items: whale.peerRegistry?.list({ includeDisabled: true }) || [],
          importedFromConfig: whale.channelAllowlists?.() || { allowUsers: [], allowGroups: [] },
        })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJson(req)
      const result = whale.peerRegistry?.add({
        id: body.id,
        kind: body.kind === 'group' ? 'group' : 'direct',
        displayName: String(body.displayName || ''),
        actor: String(body.actor || 'user'),
        reason: String(body.reason || 'runtime_add'),
        canReply: body.canReply !== false,
        canProactive: body.canProactive === true,
      })
      if (!result?.ok) return json(res, 400, { ok: false, error: result?.reason || 'registry_unavailable' })
      return json(res, 200, { ok: true, row: result.row, unchanged: Boolean(result.unchanged) })
    })

    route('prefix', '/hello-world/api/channels/peers', async (req, res) => {
      if (!guard(req, res)) return
      const url = new URL(req.url, 'http://localhost')
      const tail = url.pathname.slice('/hello-world/api/channels/peers'.length + 1)
      const [rawId, action] = tail.split('/').filter(Boolean)
      const id = decodeURIComponent(rawId || '')
      if (!id) return json(res, 400, { ok: false, error: 'id required' })
      if (req.method === 'DELETE') {
        const result = whale.peerRegistry?.remove(id, { actor: 'user', reason: 'runtime_remove' })
        return result?.ok ? json(res, 200, { ok: true, row: result.row }) : json(res, 404, { ok: false, error: result?.reason || 'not_found' })
      }
      if (req.method === 'POST' && action === 'enable') {
        const result = whale.peerRegistry?.enable(id, { actor: 'user', reason: 'runtime_enable' })
        return result?.ok ? json(res, 200, { ok: true, row: result.row }) : json(res, 404, { ok: false, error: result?.reason || 'not_found' })
      }
      return json(res, 405, { ok: false, error: 'method not allowed' })
    })

    route('exact', '/hello-world/api/channels/audit', (req, res) => {
      if (!guard(req, res, 'GET')) return
      const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit')) || 200
      json(res, 200, { ok: true, items: whale.social?.listChannelAudit?.(limit) || [] })
    })

    route('exact', '/hello-world/api/host/status', (req, res) => {
      if (!guard(req, res, 'GET')) return
      json(res, 200, { ok: true, configured: Boolean(process.env.DSH_HOST_KEY), actions: ['status', 'bridge-health', 'restart-dsh'] })
    })

    route('exact', '/hello-world/api/host/action', async (req, res) => {
      if (!guard(req, res, 'POST')) return
      const body = await readJson(req)
      if (!['status', 'bridge-health'].includes(String(body.action || ''))) {
        return json(res, 400, { ok: false, error: 'only status/bridge-health are enabled from HTTP; restart-dsh requires the manual runbook' })
      }
      const result = await whale.host?.run(String(body.action), { actor: 'web' })
      json(res, 200, { ok: Boolean(result?.ok), result })
    })
  })
}
