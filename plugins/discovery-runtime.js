import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PluginDiscovery, DEFAULT_ALLOWLIST, sandboxPlan } from '../lib/plugin-discovery-v2.js'
import { SUB_PLUGINS, validateManifest, topologicalOrder, sectionContracts, diffFromLegacy } from '../lib/plugin-manifest.js'
import { json, readJson } from './_util.js'
import { guard } from '../lib/web.js'

export const name = 'hello_world-discovery'

const PAGE = `<!doctype html><meta charset="utf-8"><title>hello_world · 插件发现</title>
<style>body{font:15px/1.6 system-ui;max-width:900px;margin:40px auto;padding:0 20px;background:#0f1720;color:#dbe7f3}code{color:#8fd3ff}button{background:#1f6feb;color:white;border:0;padding:8px 14px;border-radius:6px;cursor:pointer}input{width:70%;padding:7px;border-radius:6px;border:1px solid #35506b;background:#152230;color:#dbe7f3}pre{background:#152230;padding:12px;border-radius:8px;overflow:auto}</style>
<h1>🧩 插件发现</h1><p>只做搜索 / 暂存 / 校验 / 提议 / 审批 / 审计；<b>没有 install / load</b>，审批也不会写入 profile。</p>
<p><input id="q" placeholder="搜索 npm / github / local"><button onclick="search()">搜索</button></p><pre id="out">ready</pre>
<script>
const out=document.getElementById('out');
async function search(){out.textContent='…';const r=await fetch('/hello-world/api/discovery/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'search',query:document.getElementById('q').value})});out.textContent=JSON.stringify(await r.json(),null,2)}
fetch('/hello-world/api/discovery').then(r=>r.json()).then(x=>{out.textContent=JSON.stringify(x,null,2)})
</script>`

export function apply(ctx) {
  ctx.inject(['helloWorld', 'webServer'], (child) => {
    const whale = child.helloWorld
    // The route receives candidate.content, but PluginDiscovery normalizes
    // candidates before calling the fetcher (and normalization intentionally
    // drops payload bytes). Keep the bytes keyed by candidate id for this one
    // request so stage() can still hash exactly what the user supplied.
    const pendingContent = new Map()
    const discovery = new PluginDiscovery({
      allowlist: DEFAULT_ALLOWLIST,
      fetcher: {
        async search() { return [] },
        async download(candidate) {
          const content = pendingContent.get(candidate?.id)
          return content == null ? null : Buffer.from(content)
        },
      },
      hasher: async (payload) => createHash('sha256').update(payload).digest('hex'),
      storage: {
        async write(path, payload) {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, payload)
        },
      },
      config: { stagingRoot: join(process.env.TMPDIR || '/tmp', 'hello-world-staging'), requireChecksum: true },
    })
    const state = () => ({
      ok: true,
      allowlist: discovery.allowlist,
      staged: discovery.listStaged(),
      proposals: discovery.listProposals(),
      audit: discovery.audit(),
      manifest: { plugins: SUB_PLUGINS, validation: validateManifest(), order: topologicalOrder(), sections: sectionContracts(), diff: diffFromLegacy() },
    })
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/discovery',
      handler: (req, res) => { if (!guard(req, res, 'GET')) return; json(res, 200, state()) },
    }))
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/discovery/action',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readJson(req)
        const action = String(body.action || '')
        try {
          if (action === 'search') return json(res, 200, { ok: true, items: await discovery.search(String(body.query || ''), body.source || undefined) })
          if (action === 'stage') {
            const candidate = body.candidate || {}
            const id = String(candidate.id || candidate.name || '')
            if (candidate.content != null && id) pendingContent.set(id, String(candidate.content))
            try {
              return json(res, 200, { ok: true, record: await discovery.stage(candidate) })
            } finally {
              pendingContent.delete(id)
            }
          }
          if (action === 'propose') return json(res, 200, { ok: true, proposal: discovery.propose(String(body.candidateId || ''), { reason: String(body.reason || '') }) })
          if (action === 'approve') return json(res, 200, { ok: true, record: discovery.approve(String(body.candidateId || ''), { note: String(body.note || '') }) })
          if (action === 'sandbox') {
            const record = discovery.listStaged().find(x => x.candidate.id === String(body.candidateId || ''))
            return json(res, 200, { ok: true, plan: sandboxPlan(record) })
          }
          return json(res, 400, { ok: false, error: 'unknown action' })
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    }))
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/plugins',
      handler: (req, res) => { if (!guard(req, res, 'GET', { allowHtml: true })) return; res.statusCode = 200; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE) },
    }))
    child.effect(() => child.webServer.register({
      kind: 'exact', path: '/hello-world/api/manifest',
      handler: (req, res) => { if (!guard(req, res, 'GET')) return; json(res, 200, state().manifest) },
    }))
  })
}
