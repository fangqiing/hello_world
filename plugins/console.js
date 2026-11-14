import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guard, isTrustedToken, trustedRequest } from '../lib/web.js'
import { json, readJson } from './_util.js'
import { affinity } from '../lib/step31/peer-attitude.js'

export const name = 'hello_world-console'

function view(memory) {
  return {
    id: memory.id,
    text: memory.content,
    layer: memory.layer,
    importance: memory.importance,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    links: memory.links || [],
    source: (memory.sourceEpisodeIds || []).length,
    peerId: memory.peerId || null,
    status: memory.status,
  }
}

export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    const route = (kind, path, handler) => child.effect(() => child.webServer.register({ kind, path, handler }))
    const peerOf = (url, req) => {
      const own = whale.defaultPeerId()
      const requested = url.searchParams.get('peer') || own
      if (own && requested !== own && !isTrustedToken(req.headers['x-whale-token']) && !trustedRequest(req)) return null
      return requested
    }

    const listMemories = (req, res) => {
      if (!guard(req, res, 'GET')) return
      const url = new URL(req.url, 'http://localhost')
      const peerId = peerOf(url, req)
      if (!peerId) return json(res, 403, { ok: false, error: 'forbidden' })
      const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 600)
      const items = whale.store.list({ peerId, limit, status: 'active' }).map(view)
      json(res, 200, { ok: true, peerId, items })
    }

    const detailMemory = (req, res) => {
      if (!guard(req, res, 'GET')) return
      const url = new URL(req.url, 'http://localhost')
      const prefix = '/hello-world/api/memories'
      const id = decodeURIComponent(url.pathname.slice(prefix.length + 1).split('/')[0] || '')
      const peerId = peerOf(url, req)
      if (!peerId) return json(res, 403, { ok: false, error: 'forbidden' })
      const memory = id ? whale.store.get(id) : null
      if (!memory) return json(res, 404, { ok: false, error: 'not found' })
      if (memory.peerId && memory.peerId !== peerId) return json(res, 403, { ok: false, error: 'peer isolation' })
      json(res, 200, { ok: true, memory: view(memory) })
    }

    const app = (req, res) => {
      if (!guard(req, res, 'GET', { allowHtml: true })) return
      try {
        // 只留 WebGL 版；apiBase 必须指向本宿主的接口前缀，否则页面会请求 /api/memories 直接 404。
        const file = join(whale.packageDir, 'client', 'constellation-webgl.html')
        const cfg = JSON.stringify({ apiBase: '/hello-world/constellation', peer: whale.defaultPeerId(), theme: 'dark', timeZone: whale.config?.timeZone || 'Asia/Shanghai' })
        const html = readFileSync(file, 'utf8')
          .replace('<head>', `<head>\n<script>window.HELLO_WORLD_CONFIG=${cfg}</script>`)
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(html)
      } catch (error) {
        res.statusCode = 500
        res.end(String(error?.message || error))
      }
    }

    route('exact', '/hello-world/session', (req, res) => {
      if (!guard(req, res, 'GET', { allowHtml: true })) return
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end('ok')
    })

    const page = (file, theme = 'dark') => (req, res) => {
      if (!guard(req, res, 'GET', { allowHtml: true })) return
      try {
        const cfg = JSON.stringify({
          apiBase: '',
          peer: whale.defaultPeerId(),
          theme,
          timeZone: whale.config?.timeZone || 'Asia/Shanghai',
        })
        const html = readFileSync(join(whale.packageDir, 'client', file), 'utf8')
          .replace('<head>', `<head>\n<script>window.HELLO_WORLD_CONFIG=${cfg}</script>`)
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(html)
      } catch (error) {
        res.statusCode = 500
        res.end(String(error?.message || error))
      }
    }
    const attitudesPage = page('attitude-panel.html', 'dark')
    const growthPage = page('growth-view.html', 'dark')
    const booksPage = page('book-shelf-v3.html', 'dark')

    // 前端依赖：相对路径 vendor/... 从本页面目录取，避免依赖别的路由前缀
    route('exact', '/hello-world/constellation/vendor/3d-force-graph.min.js', (req, res) => {
      // 公开静态依赖（MIT，无私有数据）：不套 guard，否则 <script src> 会被 401。
      try {
        const file = join(whale.packageDir, 'client', 'vendor', '3d-force-graph.min.js')
        res.statusCode = 200
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.setHeader('cache-control', 'public, max-age=86400')
        res.end(readFileSync(file))
      } catch (error) { res.statusCode = 404; res.end('vendor not found') }
    })
    route('exact', '/hello-world/constellation', app)
    route('exact', '/hello-world/constellation/app', app)
    route('exact', '/hello-world/growth', growthPage)
    route('exact', '/hello-world/books', booksPage)
    route('exact', '/hello-world/attitudes', attitudesPage)
    const listAttitudes = async (req, res) => {
      if (!guard(req, res, 'GET')) return
      const store = whale.attitudes?.store
      if (!store) return json(res, 503, { ok: false, error: 'attitudes not ready' })
      const items = (await store.listAttitudes()).map((item) => ({
        ...item,
        displayName: whale.social.peerLabel(item.peerId, ''),
        affinity: +affinity(item.dims).toFixed(3),
      }))
      json(res, 200, { ok: true, items })
    }

    const listSilences = async (req, res) => {
      if (!guard(req, res, 'GET')) return
      const store = whale.attitudes?.store
      if (!store) return json(res, 503, { ok: false, error: 'attitudes not ready' })
      json(res, 200, { ok: true, items: await store.listSilences(100) })
    }

    const setAttitudeOverride = async (req, res) => {
      if (!guard(req, res, 'POST')) return
      const store = whale.attitudes?.store
      if (!store) return json(res, 503, { ok: false, error: 'attitudes not ready' })
      const body = await readJson(req)
      const peerId = String(body.peerId || '').trim()
      const decision = body.decision === null || body.decision === undefined || body.decision === '' ? null : String(body.decision)
      if (!peerId) return json(res, 400, { ok: false, error: 'peerId required' })
      if (decision !== null && decision !== 'reply' && decision !== 'silent') return json(res, 400, { ok: false, error: 'decision must be reply/silent/null' })
      await store.setOverride(peerId, decision)
      json(res, 200, { ok: true, peerId, decision })
    }

    const rollbackAttitude = async (req, res) => {
      if (!guard(req, res, 'POST')) return
      const store = whale.attitudes?.store
      if (!store) return json(res, 503, { ok: false, error: 'attitudes not ready' })
      const body = await readJson(req)
      const peerId = String(body.peerId || '').trim()
      if (!peerId) return json(res, 400, { ok: false, error: 'peerId required' })
      const result = await store.rollback(peerId)
      json(res, result.ok ? 200 : 409, result)
    }

    route('exact', '/hello-world/constellation/api/memories', listMemories)
    route('exact', '/hello-world/api/attitudes', listAttitudes)
    route('exact', '/hello-world/api/attitudes/silences', listSilences)
    route('exact', '/hello-world/api/attitude/override', setAttitudeOverride)
    route('exact', '/hello-world/api/attitude/rollback', rollbackAttitude)
    route('exact', '/hello-world/api/memories', listMemories)
    route('prefix', '/hello-world/api/memories', detailMemory)
  })
}
