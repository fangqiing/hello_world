window.__ModuleLoader__.load({
  id: 'dsh-hello_world',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const LAYERS = [
      { key: 'soul', label: 'soul 自我', color: '#ff8fd0' },
      { key: 'user', label: 'user 层', color: '#7fd4ff' },
      { key: 'rules', label: 'rules 准则', color: '#8affc1' },
      { key: 'project', label: 'project 在做', color: '#ffd479' },
      { key: 'topic', label: 'topic 话题', color: '#b79cff' },
      { key: 'fact', label: 'fact 事实', color: '#79e6ff' },
      { key: 'lesson', label: 'lesson 教训', color: '#ff9b7a' },
    ]

    const CSS = `
      .wc-panel { display:flex; flex-direction:column; gap:16px; padding:4px 2px 32px; color:var(--dsw-alias-label-primary); }
      .wc-panel[data-main="true"] { width:100%; max-width:1120px; min-height:100%; box-sizing:border-box; margin:0 auto; padding:22px 28px 40px; gap:12px; }
      .wc-head { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap; }
      .wc-panel[data-main="true"] .wc-head { align-items:center; }
      .wc-title { font-size:19px; font-weight:600; letter-spacing:.3px; display:flex; align-items:center; gap:10px; }
      .wc-panel[data-main="true"] .wc-title { font-size:17px; letter-spacing:.2px; gap:8px; }
      .wc-panel[data-main="true"] .wc-sub { font-size:11.5px; }
      .wc-panel[data-main="true"] .wc-btn { padding:5px 10px; font-size:11.5px; }
      .wc-sub { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .wc-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); }
      .wc-tab { appearance:none; background:none; border:0; border-bottom:2px solid transparent; color:var(--dsw-alias-label-secondary); padding:8px 12px; font-size:13px; cursor:pointer; }
      .wc-tab[data-active="true"] { color:var(--dsw-alias-brand-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
      .wc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
      .wc-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:14px 16px; }
      .wc-card h3 { margin:0 0 8px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); letter-spacing:.4px; }
      .wc-big { font-size:20px; font-weight:600; }
      .wc-row { display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:13px; padding:3px 0; }
      .wc-muted { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .wc-bar { height:6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
      .wc-bar > i { display:block; height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); }
      .wc-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 9px; font-size:11px; color:var(--dsw-alias-label-secondary); }
      .wc-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
      .wc-dot[data-ok="true"] { background:var(--dsw-alias-state-success-primary); }
      .wc-dot[data-bad="true"] { background:var(--dsw-alias-state-error-primary); }
      .wc-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:8px; padding:6px 12px; font-size:12px; cursor:pointer; }
      .wc-btn:hover { border-color:var(--dsw-alias-brand-primary); }
      .wc-btn[data-primary="true"] { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:600; }
      .wc-btn:disabled { opacity:.45; cursor:default; }
      .wc-input, .wc-area { width:100%; box-sizing:border-box; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; color:var(--dsw-alias-label-primary); padding:8px 10px; font-size:13px; font-family:inherit; }
      .wc-area { min-height:260px; resize:vertical; line-height:1.65; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
      .wc-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .wc-star { position:relative; border:1px solid var(--dsw-alias-border-l1); border-radius:14px; overflow:hidden; background:radial-gradient(900px 500px at 50% -10%, #14264a 0%, #0a1224 55%, #05080f 100%); }
      .wc-star canvas { display:block; width:100%; height:440px; cursor:grab; }
      .wc-panel[data-main="true"] .wc-star canvas { height:clamp(420px, calc(100vh - 250px), 680px); }
      .wc-panel[data-main="true"] .wc-embed { min-height:calc(100vh - 220px); }
      .wc-star .wc-hud { position:absolute; top:12px; left:12px; display:flex; flex-direction:column; gap:8px; max-width:min(330px,70%); }
      .wc-star .wc-hud .wc-card { background:rgba(10,18,36,.82); backdrop-filter:blur(6px); border-color:rgba(120,170,255,.22); padding:10px 12px; }
      .wc-legend { display:grid; grid-template-columns:1fr 1fr; gap:5px 10px; font-size:11px; }
      .wc-legend label { display:flex; align-items:center; gap:6px; cursor:pointer; color:var(--dsw-alias-label-secondary); }
      .wc-swatch { width:8px; height:8px; border-radius:50%; box-shadow:0 0 8px currentColor; background:currentColor; }
      .wc-detail { position:absolute; top:12px; right:12px; width:min(300px,42%); max-height:calc(100% - 24px); overflow:auto; background:rgba(10,18,36,.9); border:1px solid rgba(120,170,255,.22); border-radius:12px; padding:12px 14px; }
      .wc-detail pre { white-space:pre-wrap; word-break:break-word; font-family:inherit; font-size:12px; line-height:1.65; margin:8px 0; color:#dfe8ff; }
      .wc-chips { display:flex; gap:6px; flex-wrap:wrap; }
      .wc-chip { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 9px; font-size:11px; cursor:pointer; background:none; color:var(--dsw-alias-label-secondary); }
      .wc-chip[data-active="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
      .wc-list { display:flex; flex-direction:column; gap:6px; max-height:420px; overflow:auto; }
      .wc-item { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:8px 10px; background:var(--dsw-alias-bg-layer-1); cursor:pointer; }
      .wc-item:hover { border-color:var(--dsw-alias-brand-primary); }
      .wc-item .wc-meta { display:flex; gap:8px; align-items:center; font-size:11px; color:var(--dsw-alias-label-secondary); margin-bottom:3px; }
      .wc-item p { margin:0; font-size:12.5px; line-height:1.55; }
      .wc-err { color:var(--dsw-alias-state-error-primary); font-size:12px; }
      .wc-ok { color:var(--dsw-alias-state-success-primary); font-size:12px; }
      .wc-select { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:5px 8px; font-size:12px; }
      .wc-split { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      @media (max-width: 760px) { .wc-split { grid-template-columns:1fr; } .wc-detail { position:static; width:auto; margin:0 12px 12px; } }
    `

    let sessionReady = null
    const ensureSession = () => {
      if (!sessionReady) {
        sessionReady = fetch('/hello-world/session', { credentials: 'same-origin' }).then((res) => {
          if (!res.ok) throw new Error(`session HTTP ${res.status}`)
          return true
        }).catch((error) => {
          sessionReady = null
          throw error
        })
      }
      return sessionReady
    }

    const api = async (path, options = {}) => {
      const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
      await ensureSession()
      const res = await fetch(path, { ...options, headers, credentials: 'same-origin' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    const fmtTime = (value) => {
      if (!value) return '—'
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    function Card({ title, children, right }) {
      return h('div', { className: 'wc-card' }, h('h3', null, title, right ? h('span', { style: { float: 'right', fontWeight: 400 } }, right) : null), children)
    }

    function Overview({ state, refresh }) {
      if (!state) return h('div', { className: 'wc-muted' }, '正在读取她的状态…')
      const mood = state.cognition?.mood || {}
      const drives = state.cognition?.drives || {}
      const memory = state.memory || {}
      const life = state.life || {}
      const usage = state.usage || {}
      const channels = state.channels || []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'wc-grid' },
          h(Card, { title: '此刻' },
            h('div', { className: 'wc-big' }, mood.labelZh || '平静'),
            h('div', { className: 'wc-muted' }, `${life.now || ''} · ${state.cognition?.rhythm?.label || ''} · ${life.inQuietHours ? '安静时段' : '可以说话'}`),
            h('div', { className: 'wc-muted', style: { marginTop: 6 } },
              `心情值 ${(mood.valence ?? 0).toFixed(2)} · 唤醒 ${(mood.arousal ?? 0).toFixed(2)}`),
          ),
          h(Card, { title: '记忆' },
            h('div', { className: 'wc-big' }, `${memory.total ?? 0} 条`),
            h('div', { className: 'wc-muted' }, `原文 ${memory.episodes ?? 0} 条 · 失效 ${memory.superseded ?? 0} · 归档 ${memory.archived ?? 0}`),
            h('div', { style: { marginTop: 8 } }, LAYERS.map((layer) => {
              const count = memory.byLayer?.[layer.key] || 0
              const total = Math.max(1, memory.total || 1)
              return h('div', { key: layer.key, className: 'wc-row' },
                h('span', { className: 'wc-pill' },
                  h('i', { className: 'wc-dot', style: { background: layer.color } }),
                  layer.label.split(' ')[0]),
                h('span', { className: 'wc-muted' }, String(count)),
                h('span', { style: { flex: 1 } }, h('span', { className: 'wc-bar' }, h('i', { style: { width: `${Math.round((count / total) * 100)}%`, background: layer.color } }))),
              )
            })),
          ),
          h(Card, { title: '四驱力' },
            Object.entries(drives).filter(([key]) => key !== 'updatedAt').map(([key, value]) =>
              h('div', { key, className: 'wc-row' },
                h('span', { className: 'wc-muted' }, ({ social: '社交', cognitive: '认知', creative: '创造', mastery: '精通' })[key] || key),
                h('span', { style: { flex: 1, marginLeft: 8 } }, h('span', { className: 'wc-bar' }, h('i', { style: { width: `${Math.round(value)}%` } }))),
                h('span', { className: 'wc-muted' }, String(Math.round(value))),
              )),
            h('div', { className: 'wc-muted', style: { marginTop: 8 } },
              `最近想起你：${life.lastThought ? fmtTime(life.lastThought.at) : '还没主动说过话'}`),
          ),
          h(Card, { title: '通道' },
            channels.length ? channels.map((channel) =>
              h('div', { key: channel.name, className: 'wc-row' },
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('i', { className: 'wc-dot', 'data-ok': String(Boolean(channel.connected)), 'data-bad': String(Boolean(channel.paused)) }),
                  `${channel.name.toUpperCase()} · ${channel.mode || ''}`),
                h('span', { className: 'wc-muted' }, channel.paused ? '熔断' : channel.connected ? '在线' : '未连接')),
            ) : h('div', { className: 'wc-muted' }, '没有启用通道。QQ 用 OneBot，微信走桥或 Linux 客户端。'),
            h('div', { className: 'wc-actions', style: { marginTop: 10 } },
              h('button', { className: 'wc-btn', onClick: () => api('/whale-chan/api/action', { method: 'POST', body: JSON.stringify({ action: 'review' }) }).then(refresh) }, '立即回顾'),
              h('button', { className: 'wc-btn', onClick: () => api('/whale-chan/api/action', { method: 'POST', body: JSON.stringify({ action: 'consolidate' }) }).then(refresh) }, '整理记忆'),
            ),
          ),
          h(Card, { title: '今天' },
            h('div', { className: 'wc-big' }, `${(usage.input || 0) + (usage.output || 0)} tokens`),
            h('div', { className: 'wc-muted' }, state.dailyTokenBudget ? `每日额度 ${state.dailyTokenBudget}` : '未设置每日额度'),
            h('div', { className: 'wc-row', style: { marginTop: 8 } }, h('span', { className: 'wc-muted' }, '下次回顾'), h('span', null, life.nextReview || '23:00')),
            h('div', { className: 'wc-muted', style: { marginTop: 6 } }, `数据目录 ${state.dir || ''}`),
          ),
        ),
        h('div', { className: 'wc-card' },
          h('h3', null, '健康状态'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 8 } },
            Object.entries(state.health || {}).map(([key, value]) =>
              h('div', { key, className: 'wc-row' },
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('i', { className: 'wc-dot', 'data-ok': String(value?.ok === true), 'data-bad': String(value?.ok === false) }),
                  key),
                h('span', { className: 'wc-muted', style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  value ? (value.error || value.text || fmtTime(value.at)) : '—'))),
          ),
        ),
      )
    }

    function PersonaTab({ state, refresh }) {
      const [file, setFile] = useState('persona')
      const [content, setContent] = useState('')
      const [saved, setSaved] = useState('')
      const [error, setError] = useState('')
      const [preview, setPreview] = useState('')
      useEffect(() => {
        let alive = true
        api('/whale-chan/api/persona').then((data) => {
          if (!alive) return
          setContent(file === 'persona' ? data.persona : file === 'world' ? data.world : data.self)
        }).catch((err) => setError(String(err.message || err)))
        return () => { alive = false }
      }, [file])
      const save = async () => {
        setError('')
        setSaved('')
        try {
          await api('/whale-chan/api/persona', { method: 'POST', body: JSON.stringify({ file, content }) })
          setSaved('已保存，下一轮对话生效')
          refresh()
        } catch (err) {
          setError(String(err.message || err))
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'wc-actions' },
          [['persona', '人设 persona.md'], ['world', '世界 world-prompt.md'], ['self', '我是谁 self.md']].map(([key, label]) =>
            h('button', { key, className: 'wc-btn', 'data-primary': String(file === key), onClick: () => setFile(key) }, label)),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'wc-btn', onClick: () => setPreview((value) => value ? '' : content) }, preview ? '关闭预览' : '预览'),
          h('button', { className: 'wc-btn', 'data-primary': 'true', onClick: save }, '保存'),
        ),
        error ? h('div', { className: 'wc-err' }, error) : null,
        saved ? h('div', { className: 'wc-ok' }, saved) : null,
        h('textarea', { className: 'wc-area', value: content, onChange: (event) => setContent(event.target.value), spellCheck: false }),
        preview ? h(Card, { title: '注入效果预览（第一人称）' },
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, preview)) : null,
        h('div', { className: 'wc-muted' },
          '人设只进她的会话：身份句会被「我是{名字}。」替换，六层内容排在部署人设之后；「我是谁」通过 {{whale_self}} 注入，夜间改写会自动留旧版。'),
      )
    }

    function StarMap({ state }) {
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const viewRef = useRef({ rotX: -0.32, rotY: 0.5, zoom: 1, dragging: false, x: 0, y: 0, auto: true, mtime: 0 })
      const dataRef = useRef([])
      const [selected, setSelected] = useState(null)
      const [visible, setVisible] = useState(() => new Set(LAYERS.map((layer) => layer.key)))
      const [query, setQuery] = useState('')
      const [worldDir, setWorldDir] = useState('')
      const [includeArchived, setIncludeArchived] = useState(false)
      const [footer, setFooter] = useState('')
      const [detailId, setDetailId] = useState('')

      const load = useCallback(async () => {
        try {
          const params = new URLSearchParams()
          if (includeArchived) params.set('all', '1')
          if (worldDir) params.set('dir', worldDir)
          if (viewRef.current.mtime) params.set('since', String(viewRef.current.mtime))
          await ensureSession()
          const res = await fetch(`/hello-world/constellation/api/memories?${params.toString()}`, { credentials: 'same-origin' })
          const body = await res.json()
          if (!body.ok) throw new Error(body.error || 'load failed')
          if (body.changed === false) {
            setFooter(`七层记忆 · ${dataRef.current.length} 条 · ${new Date().toLocaleTimeString('zh-CN')}（无变化）`)
            return
          }
          viewRef.current.mtime = body.mtime || 0
          dataRef.current = body.items || []
          setFooter(`七层记忆 · ${dataRef.current.length} 条 · ${new Date().toLocaleTimeString('zh-CN')}`)
        } catch (error) {
          setFooter(`读取失败：${String(error.message || error)}`)
        }
      }, [includeArchived, worldDir])

      useEffect(() => {
        viewRef.current.mtime = 0
        dataRef.current = []
        void load()
        const timer = setInterval(() => void load(), 4000)
        return () => clearInterval(timer)
      }, [load])

      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        return dataRef.current.filter((item) => (!keyword || String(item.content || '').toLowerCase().includes(keyword) || String(item.keywords || '').toLowerCase().includes(keyword)))
      }, [query, footer, includeArchived, worldDir])

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        const view = viewRef.current
        let raf = 0
        const resize = () => {
          const rect = canvas.getBoundingClientRect()
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          canvas.width = Math.max(1, Math.floor(rect.width * dpr))
          canvas.height = Math.max(1, Math.floor(rect.height * dpr))
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        }
        resize()
        const project = (point) => {
          const { rotX, rotY, zoom } = view
          const cy = Math.cos(rotY), sy = Math.sin(rotY)
          const cx = Math.cos(rotX), sx = Math.sin(rotX)
          let x = point.x * cy - point.z * sy
          let z = point.x * sy + point.z * cy
          let y = point.y
          const y2 = y * cx - z * sx
          const z2 = y * sx + z * cx
          const persp = 1 / (1 + z2 * 0.0016)
          const rect = canvas.getBoundingClientRect()
          const s = Math.min(rect.width, rect.height) * 0.34 * zoom * persp
          return { x: rect.width / 2 + x * s, y: rect.height / 2 + y2 * s, z: z2, s, rect }
        }
        const layout = () => {
          const byLayer = new Map(LAYERS.map((layer) => [layer.key, []]))
          for (const item of filtered) if (byLayer.has(item.layer)) byLayer.get(item.layer).push(item)
          const nodes = []
          LAYERS.forEach((layer, index) => {
            const ring = byLayer.get(layer.key) || []
            const radius = 60 + index * 46
            ring.forEach((item, i) => {
              const angle = (i / Math.max(1, ring.length)) * Math.PI * 2 + index * 0.35
              let hash = 0
              for (let k = 0; k < item.id.length; k++) hash = (hash * 31 + item.id.charCodeAt(k)) >>> 0
              const jitter = ((hash % 100) / 100) * 10 - 5
              nodes.push({ item, x: Math.cos(angle) * radius + jitter, y: index * 8 - 24, z: Math.sin(angle) * radius + jitter, layer })
            })
          })
          return nodes
        }
        const pick = (nodes, mx, my) => {
          let best = null
          let bestDistance = 16
          for (const node of nodes) {
            if (!visible.has(node.item.layer)) continue
            const p = project(node)
            const distance = Math.hypot(p.x - mx, p.y - my)
            if (distance < bestDistance) {
              bestDistance = distance
              best = node
            }
          }
          return best
        }
        const draw = () => {
          const rect = canvas.getBoundingClientRect()
          ctx.clearRect(0, 0, rect.width, rect.height)
          const nodes = layout()
          const core = project({ x: 0, y: 0, z: 0 })
          const glow = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, 30)
          glow.addColorStop(0, 'rgba(180,225,255,.85)')
          glow.addColorStop(1, 'rgba(127,212,255,0)')
          ctx.fillStyle = glow
          ctx.beginPath()
          ctx.arc(core.x, core.y, 30, 0, 7)
          ctx.fill()
          LAYERS.forEach((layer, index) => {
            if (!visible.has(layer.key)) return
            const radius = 60 + index * 46
            ctx.beginPath()
            for (let angle = 0; angle <= Math.PI * 2 + 0.01; angle += 0.07) {
              const p = project({ x: Math.cos(angle) * radius, y: index * 8 - 24, z: Math.sin(angle) * radius })
              if (angle === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            }
            ctx.strokeStyle = `${layer.color}22`
            ctx.lineWidth = 1
            ctx.stroke()
          })
          const byId = new Map(nodes.map((node) => [node.item.id, node]))
          for (const node of nodes) {
            if (!visible.has(node.item.layer)) continue
            for (const id of node.item.links || []) {
              const target = byId.get(id)
              if (!target) continue
              const a = project(node)
              const b = project(target)
              ctx.strokeStyle = 'rgba(140,180,255,.10)'
              ctx.beginPath()
              ctx.moveTo(a.x, a.y)
              ctx.lineTo(b.x, b.y)
              ctx.stroke()
            }
          }
          for (const node of nodes) {
            if (!visible.has(node.item.layer)) continue
            const p = project(node)
            const importance = Math.max(0.25, Math.min(1, (node.item.effectiveImportance || node.item.importance || 5) / 10))
            const radius = 2.2 + importance * 3.4
            const alpha = node.item.status === 'archived' ? 0.25 : 0.45 + importance * 0.55
            ctx.beginPath()
            ctx.fillStyle = node.layer.color
            ctx.globalAlpha = alpha
            ctx.shadowColor = node.layer.color
            ctx.shadowBlur = 10 + importance * 10
            ctx.arc(p.x, p.y, radius, 0, 7)
            ctx.fill()
            ctx.globalAlpha = 1
            if (detailId && detailId === node.item.id) {
              ctx.beginPath()
              ctx.strokeStyle = '#fff'
              ctx.globalAlpha = 0.85
              ctx.arc(p.x, p.y, radius + 5, 0, 7)
              ctx.stroke()
              ctx.globalAlpha = 1
            }
            ctx.shadowBlur = 0
          }
        }
        const loop = (time) => {
          if (view.auto && !view.dragging) {
            view.rotY += 0.00018
          }
          draw()
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
        const onDown = (event) => {
          view.dragging = true
          view.x = event.clientX
          view.y = event.clientY
          canvas.style.cursor = 'grabbing'
        }
        const onMove = (event) => {
          if (!view.dragging) return
          const dx = event.clientX - view.x
          const dy = event.clientY - view.y
          view.x = event.clientX
          view.y = event.clientY
          view.rotY += dx * 0.006
          view.rotX = Math.max(-1.2, Math.min(1.2, view.rotX + dy * 0.005))
        }
        const onUp = (event) => {
          if (!view.dragging) return
          view.dragging = false
          canvas.style.cursor = 'grab'
          const rect = canvas.getBoundingClientRect()
          const node = pick(layout(), event.clientX - rect.left, event.clientY - rect.top)
          if (node) {
            setSelected(node.item)
            setDetailId(node.item.id)
          }
        }
        const onWheel = (event) => {
          event.preventDefault()
          view.zoom = Math.max(0.45, Math.min(2.6, view.zoom * (event.deltaY > 0 ? 0.92 : 1.08)))
        }
        const onResize = () => { resize(); draw() }
        canvas.addEventListener('pointerdown', onDown)
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        canvas.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('resize', onResize)
        return () => {
          cancelAnimationFrame(raf)
          canvas.removeEventListener('pointerdown', onDown)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          canvas.removeEventListener('wheel', onWheel)
          window.removeEventListener('resize', onResize)
        }
      }, [filtered, visible, detailId])

      const toggleLayer = (key) => {
        setVisible((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      const detailLayer = selected ? LAYERS.find((layer) => layer.key === selected.layer) : null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'wc-actions' },
          h('input', { className: 'wc-input', style: { maxWidth: 240 }, placeholder: '搜关键词 / 全文…', value: query, onChange: (event) => setQuery(event.target.value) }),
          state?.worlds?.length ? h('select', {
            className: 'wc-select',
            value: worldDir,
            onChange: (event) => { setWorldDir(event.target.value); setSelected(null); setDetailId('') },
          },
            h('option', { value: '' }, `当前世界（${state.worldId || 'default'}）`),
            state.worlds.filter((world) => world.dir !== state.dir).map((world) => h('option', { key: world.dir, value: world.dir }, world.id)),
          ) : null,
          h('button', { className: 'wc-btn', 'data-primary': String(includeArchived), onClick: () => setIncludeArchived((value) => !value) }, '含归档'),
          h('button', { className: 'wc-btn', onClick: () => { viewRef.current.auto = !viewRef.current.auto } }, '自动旋转'),
          h('button', { className: 'wc-btn', onClick: () => { viewRef.current.rotX = -0.32; viewRef.current.rotY = 0.5; viewRef.current.zoom = 1 } }, '重置视角'),
          h('a', { className: 'wc-btn', href: '/hello-world/constellation', target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '全屏打开'),
        ),
        h('div', { className: 'wc-star', ref: wrapRef },
          h('canvas', { ref: canvasRef }),
          h('div', { className: 'wc-hud' },
            h('div', { className: 'wc-card' },
              h('div', { className: 'wc-legend' }, LAYERS.map((layer) =>
                h('label', { key: layer.key },
                  h('input', { type: 'checkbox', checked: visible.has(layer.key), onChange: () => toggleLayer(layer.key) }),
                  h('i', { className: 'wc-swatch', style: { color: layer.color } }),
                  layer.label)))),
          ),
          selected && detailLayer ? h('div', { className: 'wc-detail' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 } },
              h('i', { className: 'wc-swatch', style: { color: detailLayer.color } }),
              detailLayer.label,
              h('span', { className: 'wc-pill' }, selected.status || 'active')),
            h('div', { className: 'wc-muted', style: { marginTop: 6, lineHeight: 1.7 } },
              `重要性 ${'★'.repeat(Math.max(1, Math.min(10, Math.round(selected.importance || 5))))}`,
              h('br'),
              `有效度 ${(selected.effectiveImportance ?? selected.importance ?? 0).toFixed(2)} · 想起 ${selected.recallCount || 0} 次`,
              h('br'),
              fmtTime(selected.time)),
            h('pre', null, selected.content || ''),
            (selected.links || []).length ? h('div', { className: 'wc-chips' },
              selected.links.slice(0, 10).map((id) => h('button', { key: id, className: 'wc-chip', onClick: () => {
                const target = dataRef.current.find((item) => item.id === id)
                if (target) { setSelected(target); setDetailId(target.id) }
              } }, id.slice(0, 8)))) : null,
            h('button', { className: 'wc-btn', style: { marginTop: 8 }, onClick: () => { setSelected(null); setDetailId('') } }, '关闭'),
          ) : null,
        ),
        h('div', { className: 'wc-muted' }, footer, ' · 每 4 秒按 mtime 轮询；库没变只回极小标记'),
      )
    }

    function MemoryTab() {
      const [items, setItems] = useState([])
      const [layer, setLayer] = useState('')
      const [query, setQuery] = useState('')
      const [all, setAll] = useState(false)
      const [error, setError] = useState('')
      const load = async () => {
        setError('')
        try {
          const params = new URLSearchParams()
          if (layer) params.set('layer', layer)
          if (query) params.set('q', query)
          if (all) params.set('all', '1')
          const body = await api(`/whale-chan/api/memories?${params.toString()}`)
          setItems(body.items || [])
        } catch (err) {
          setError(String(err.message || err))
        }
      }
      useEffect(() => { void load() }, [layer, all])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'wc-actions' },
          h('button', { className: 'wc-btn', 'data-primary': String(layer === ''), onClick: () => setLayer('') }, '全部'),
          LAYERS.map((item) => h('button', { key: item.key, className: 'wc-btn', 'data-primary': String(layer === item.key), onClick: () => setLayer(item.key) }, item.label)),
          h('button', { className: 'wc-btn', 'data-primary': String(all), onClick: () => setAll((value) => !value) }, '含归档/失效'),
          h('input', { className: 'wc-input', style: { maxWidth: 220 }, placeholder: '搜记忆…', value: query, onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') void load() } }),
          h('button', { className: 'wc-btn', onClick: () => void load() }, '搜索'),
        ),
        error ? h('div', { className: 'wc-err' }, error) : null,
        h('div', { className: 'wc-list' }, items.map((item) =>
          h('div', { key: item.id, className: 'wc-item' },
            h('div', { className: 'wc-meta' },
              h('span', { className: 'wc-pill' }, item.layer),
              h('span', null, `重要性 ${item.importance}`),
              h('span', null, `有效 ${item.effectiveImportance ?? '—'}`),
              h('span', null, item.status),
              h('span', null, fmtTime(item.time))),
            h('p', null, item.content)))),
        h('div', { className: 'wc-muted' }, `共 ${items.length} 条。降权不删原文；被取代的条目保留 validUntil 与历史。`),
      )
    }

    function PeerRegistryCard({ refresh }) {
      const [rows, setRows] = useState([])
      const [id, setId] = useState('')
      const [kind, setKind] = useState('direct')
      const [name, setName] = useState('')
      const [proactive, setProactive] = useState(false)
      const [msg, setMsg] = useState('')
      const load = useCallback(async () => {
        try {
          const data = await api('/hello-world/api/channels/peers')
          setRows(Array.isArray(data.items) ? data.items : [])
        } catch (error) { setMsg(String(error.message || error)) }
      }, [])
      useEffect(() => { void load() }, [load])
      const add = async () => {
        setMsg('')
        try {
          await api('/hello-world/api/channels/peers', {
            method: 'POST',
            body: JSON.stringify({ id, kind, displayName: name, canProactive: proactive }),
          })
          setId(''); setName(''); setProactive(false)
          await load(); refresh?.()
          setMsg('已登记，下一轮消息即可生效')
        } catch (error) { setMsg('登记失败：' + String(error.message || error)) }
      }
      const remove = async (peerId) => {
        try {
          await api('/hello-world/api/channels/peers/' + encodeURIComponent(peerId), { method: 'DELETE' })
          await load(); refresh?.(); setMsg('已停用（历史保留）')
        } catch (error) { setMsg('停用失败：' + String(error.message || error)) }
      }
      const enable = async (peerId) => {
        try {
          await api('/hello-world/api/channels/peers/' + encodeURIComponent(peerId) + '/enable', { method: 'POST' })
          await load(); refresh?.(); setMsg('已重新启用')
        } catch (error) { setMsg('启用失败：' + String(error.message || error)) }
      }
      return h(Card, { title: '对话对象 · 运行时登记（不重启）' },
        h('div', { className: 'wc-actions' },
          h('select', { className: 'wc-select', value: kind, onChange: (e) => setKind(e.target.value) },
            h('option', { value: 'direct' }, '私聊 wxid'),
            h('option', { value: 'group' }, '群 ID')),
          h('input', { className: 'wc-input', style: { flex: 2, minWidth: 180 }, placeholder: kind === 'group' ? '群 ID（group: 前缀可省略）' : 'wxid_xxx（不是昵称）', value: id, onChange: (e) => setId(e.target.value) }),
          h('input', { className: 'wc-input', style: { flex: 1, minWidth: 120 }, placeholder: '备注名（可空）', value: name, onChange: (e) => setName(e.target.value) }),
          h('label', { className: 'wc-muted', style: { display: 'flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: proactive, onChange: (e) => setProactive(e.target.checked) }), '允许主动'),
          h('button', { className: 'wc-btn', 'data-primary': 'true', disabled: !id.trim(), onClick: add }, '登记'),
        ),
        msg ? h('div', { className: 'wc-muted', style: { marginTop: 8 } }, msg) : null,
        h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          rows.length ? rows.map((row) => h('div', { key: row.id, className: 'wc-row' },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              h('i', { className: 'wc-dot', 'data-ok': String(Boolean(row.enabled)), 'data-bad': String(!row.enabled) }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, (row.displayName ? row.displayName + ' · ' : '') + row.id),
              h('span', { className: 'wc-pill' }, row.kind === 'group' ? '群' : '私聊'),
              row.canProactive ? h('span', { className: 'wc-pill' }, '可主动') : null),
            row.enabled
              ? h('button', { className: 'wc-btn', onClick: () => remove(row.id) }, '停用')
              : h('button', { className: 'wc-btn', onClick: () => enable(row.id) }, '启用')))
            : h('div', { className: 'wc-muted' }, '还没有运行时登记的对象；静态 allowUsers 会作为兜底。')),
      )
    }

    function ChannelsTab({ state, refresh }) {
      const [message, setMessage] = useState('')
      const [result, setResult] = useState('')
      const [target, setTarget] = useState('')
      const [bridgeMode, setBridgeMode] = useState('native')
      const [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:6174')
      const [token, setToken] = useState('')
      const [allow, setAllow] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => { if (!target && state?.channels?.length) setTarget('') }, [state])
      const act = async (action, extra = {}) => {
        setResult('')
        try {
          await api('/whale-chan/api/action', { method: 'POST', body: JSON.stringify({ action, ...extra }) })
          setResult('完成')
          refresh()
        } catch (error) {
          setResult(`失败：${String(error.message || error)}`)
        }
      }
      const enableWechat = async () => {
        setBusy(true)
        setResult('')
        try {
          await api('/whale-chan/api/action', { method: 'POST', body: JSON.stringify({
            action: 'channel-enable',
            channel: 'wechat',
            config: {
              ...(bridgeMode === 'native'
                ? { mode: 'native', apiBase: bridgeUrl, apiToken: token }
                : { mode: 'bridge', bridgeUrl, token, replyDelayMs: [1000, 3000] }),
              allowUsers: allow.split(/[,;\s]+/).filter(Boolean),
              allowGroups: [],
            },
          }) })
          setResult('微信桥已启动（仅本次进程；重启回到配置）')
          refresh()
        } catch (error) {
          setResult(`启动失败：${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }
      const disableWechat = async () => {
        setBusy(true)
        try {
          await api('/whale-chan/api/action', { method: 'POST', body: JSON.stringify({ action: 'channel-disable', channel: 'wechat' }) })
          setResult('微信通道已停止')
          refresh()
        } catch (error) {
          setResult(`停止失败：${String(error.message || error)}`)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '微信快速连接（联调用，不写回配置）' },
          h('div', { className: 'wc-actions' },
            h('select', { className: 'wc-select', value: bridgeMode, onChange: (event) => { setBridgeMode(event.target.value); setBridgeUrl(event.target.value === 'native' ? 'http://127.0.0.1:6174' : 'http://127.0.0.1:6175') } },
              h('option', { value: 'native' }, 'agent-wechat 原生 API'),
              h('option', { value: 'bridge' }, '通用 HTTP 桥')),
            h('input', { className: 'wc-input', style: { flex: 2, minWidth: 190 }, placeholder: bridgeMode === 'native' ? 'http://127.0.0.1:6174' : 'http://127.0.0.1:6175', value: bridgeUrl, onChange: (event) => setBridgeUrl(event.target.value) }),
            h('input', { className: 'wc-input', style: { flex: 1, minWidth: 120 }, placeholder: bridgeMode === 'native' ? 'API token' : '桥 token（可空）', value: token, onChange: (event) => setToken(event.target.value) }),
            h('input', { className: 'wc-input', style: { flex: 1, minWidth: 140 }, placeholder: 'allowUsers，逗号分隔', value: allow, onChange: (event) => setAllow(event.target.value) }),
            h('button', { className: 'wc-btn', 'data-primary': 'true', disabled: busy || !bridgeUrl.trim(), onClick: enableWechat }, '启动'),
            h('button', { className: 'wc-btn', disabled: busy, onClick: disableWechat }, '停止'),
          ),
          h('div', { className: 'wc-muted', style: { marginTop: 8 } },
            bridgeMode === 'native'
              ? 'Linux 服务器：装 @agent-wechat/cli → wx serve → wx accounts create/auth login → wx tokens create ... --scopes read --scopes send，然后把地址和 token 填这里。allowUsers 留空 = 谁都不理。'
              : '先在微信那侧跑 scripts/wx-bridge.mjs，再填地址。allowUsers 留空 = 谁都不理；群消息默认不接。'),
        ),
        h(PeerRegistryCard, { refresh }),
        h('div', { className: 'wc-grid' },
          (state?.channels || []).map((channel) =>
            h(Card, { key: channel.name, title: `${channel.name.toUpperCase()} · ${channel.mode || ''}` },
              h('div', { className: 'wc-row' },
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('i', { className: 'wc-dot', 'data-ok': String(Boolean(channel.connected)), 'data-bad': String(Boolean(channel.paused)) }),
                  channel.paused ? '已熔断' : channel.connected ? '在线' : '未连接'),
                h('button', { className: 'wc-btn', onClick: () => act('channel-resume', { channel: channel.name }) }, '复位熔断')),
              h('div', { className: 'wc-muted', style: { marginTop: 8, lineHeight: 1.7 } },
                `白名单：${(channel.allowUsers || []).join(', ') || '（空 = 谁都不理）'}`,
                h('br'),
                `最近入站：${channel.lastInboundAt ? fmtTime(channel.lastInboundAt) : '—'}`,
                channel.lastError ? h('span', null, h('br'), `最近错误：${channel.lastError}`) : null),
            )),
        ),
        h(Card, { title: '主动发一条（测试）' },
          h('div', { className: 'wc-actions' },
            h('select', { className: 'wc-select', value: target, onChange: (event) => setTarget(event.target.value) },
              h('option', { value: '' }, '默认目标'),
              h('option', { value: 'qq' }, 'QQ'),
              h('option', { value: 'wechat' }, '微信')),
            h('input', { className: 'wc-input', style: { flex: 1, minWidth: 200 }, placeholder: '例如：在吗？我刚想起一件事', value: message, onChange: (event) => setMessage(event.target.value) }),
            h('button', { className: 'wc-btn', 'data-primary': 'true', disabled: !message.trim(), onClick: () => act('send-test', { channel: target || undefined, text: message }) }, '发送'),
          ),
          result ? h('div', { className: result.startsWith('失败') ? 'wc-err' : 'wc-ok', style: { marginTop: 8 } }, result) : null,
          h('div', { className: 'wc-muted', style: { marginTop: 8 } },
            'QQ：NapCat / Lagrange / LLOneBot 登录小号，暴露 OneBot 11 正向或反向 WS；' +
            '微信：bridge 模式接 HTTP 桥，或 linux 模式接本机无障碍自动化 API。只当管道用，记忆仍由本插件管理。'),
        ),
        h(Card, { title: '风险与边界' },
          h('div', { className: 'wc-muted', style: { lineHeight: 1.8 } },
            '个人号自动化违反平台协议，封号风险自担：只用小号、低频、白名单、不群发、不自动加好友。' +
            '外部会话默认只拿到 memory_* / whale_* 工具，不暴露 Shell 与文件。熔断后可在上面复位。'),
        ),
      )
    }

    function SocialTab({ state }) {
      const peers = state?.peers || []
      return h('div', { className: 'wc-grid' },
        peers.length ? peers.map((peer) => h(Card, { key: peer.id, title: peer.display_name || peer.learned_name || peer.id },
          h('div', { className: 'wc-muted' }, peer.peer_kind === 'group' ? '群聊 · 按 speaker 区分' : '私聊 · 独立记忆'),
          peer.relation_summary ? h('p', { style: { fontSize: 13, lineHeight: 1.6 } }, peer.relation_summary) : h('div', { className: 'wc-muted' }, '还没有形成关系摘要'),
          h('div', { className: 'wc-muted', style: { marginTop: 8 } }, `最后见面 ${fmtTime(peer.last_seen)}`),
        )) : h('div', { className: 'wc-muted' }, '还没有记录过对话对象。'),
      )
    }

    function StarFrame() {
      return h('iframe', {
        title: '3D 星图',
        className: 'wc-embed',
        src: '/hello-world/constellation',
        allow: 'fullscreen',
        style: { width: '100%', minHeight: 'calc(100vh - 220px)', border: '0', borderRadius: '12px', background: '#05080f' },
      })
    }

    function GrowthFrame({ state, page, embedded = false }) {
      const peer = state?.peers?.[0]?.id || ''
      const src = `/hello-world/${page}` + (peer ? '?peer=' + encodeURIComponent(peer) : '')
      return h('iframe', {
        title: page === 'books' ? '书籍投喂' : '成长',
        className: 'wc-embed',
        src,
        style: { width: '100%', minHeight: embedded ? 'calc(100vh - 220px)' : '620px', border: '0', borderRadius: '12px', background: '#0b0f17' },
      })
    }

    function GrowthTab({ state, embedded = false }) {
      return h(GrowthFrame, { state, page: 'growth', embedded })
    }

    function BooksTab({ state, embedded = false }) {
      return h(GrowthFrame, { state, page: 'books', embedded })
    }

    function AttitudeTab({ embedded = false }) {
      return h('iframe', {
        title: '她对每个人',
        className: 'wc-embed',
        src: '/hello-world/attitudes',
        style: { width: '100%', minHeight: embedded ? 'calc(100vh - 220px)' : '620px', border: '0', borderRadius: '12px', background: '#0b0f17' },
      })
    }

    function DiscoveryTab() {
      const [data, setData] = useState(null)
      const [query, setQuery] = useState('')
      const [error, setError] = useState('')
      const load = useCallback(() => {
        api('/hello-world/api/discovery').then(setData).catch((err) => setError(String(err.message || err)))
      }, [])
      useEffect(() => { load() }, [load])
      return h('div', { className: 'wc-split' },
        h(Card, { title: '搜索（只读）' },
          h('div', { className: 'wc-actions' },
            h('input', { className: 'wc-input', style: { flex: 1 }, value: query, placeholder: 'npm / github / local', onChange: (event) => setQuery(event.target.value) }),
            h('button', { className: 'wc-btn', onClick: async () => {
              try { await api('/hello-world/api/discovery/action', { method: 'POST', body: JSON.stringify({ action: 'search', query }) }); load() } catch (err) { setError(String(err.message || err)) }
            } }, '搜索')),
          h('div', { className: 'wc-muted', style: { marginTop: 8 } }, '没有 install / load；审批只到 approved_not_installed。'),
          error ? h('div', { className: 'wc-err' }, error) : null),
        h(Card, { title: '暂存 / 提议 / 审计' },
          h('div', { className: 'wc-muted' }, `allowlist: ${(data?.allowlist || []).join(', ') || '—'}`),
          (data?.staged || []).map((item) => h('div', { key: item.path, className: 'wc-row' }, item.candidate.name, h('span', { className: 'wc-pill' }, item.suspicious ? '需沙箱' : '已校验'))),
          (data?.proposals || []).map((item) => h('div', { key: item.candidateId, className: 'wc-row' }, item.candidateId, h('span', { className: 'wc-pill' }, item.status))),
          (data?.audit || []).map((item) => h('div', { key: item.at + item.candidateId, className: 'wc-muted' }, `${item.candidateId} · ${item.status}`)),
        ),
      )
    }

    const SECTION_TABS = {
      main: [['overview', '概览'], ['persona', '人设'], ['memory', '记忆']],
      star: [['star', '星图']],
      growth: [['growth', '成长'], ['books', '书籍']],
      more: [['social', '人与边界'], ['attitudes', '她对每个人'], ['channels', '通道'], ['discovery', '插件']],
    }

    function SidebarIcon({ kind, size = 18, active = false }) {
      const star = h('g', null,
        h('path', { d: 'M12 3.2l1.55 5.25L19 10l-5.45 1.55L12 16.8l-1.55-5.25L5 10l5.45-1.55L12 3.2z' }),
        h('path', { d: 'M18.5 3.5v3M17 5h3M5.5 16.5v2.6M4.2 17.8h2.6' }),
      )
      const growth = h('g', null,
        h('path', { d: 'M12 20v-7.2' }),
        h('path', { d: 'M12 13.2c0-3.4 2.5-5.6 5.8-5.6 0 3.5-2.4 5.6-5.8 5.6z' }),
        h('path', { d: 'M12 15.6c0-2.7-2-4.5-4.7-4.5 0 2.8 2 4.5 4.7 4.5z' }),
        h('path', { d: 'M8 20h8' }),
      )
      const overview = h('g', null,
        h('rect', { x: '4', y: '4', width: '6', height: '6', rx: '1.2' }),
        h('rect', { x: '14', y: '4', width: '6', height: '6', rx: '1.2' }),
        h('rect', { x: '4', y: '14', width: '6', height: '6', rx: '1.2' }),
        h('rect', { x: '14', y: '14', width: '6', height: '6', rx: '1.2' }),
      )
      const people = h('g', null,
        h('circle', { cx: '9', cy: '8', r: '3' }),
        h('path', { d: 'M3.8 19c.4-3.1 2.2-5 5.2-5s4.8 1.9 5.2 5' }),
        h('circle', { cx: '16.6', cy: '9.4', r: '2.2' }),
        h('path', { d: 'M14.4 19c.3-2.3 1.6-3.8 3.8-3.8 1.8 0 2.9 1.1 3.4 3.1' }),
      )
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.65,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      }, kind === 'star' ? star : kind === 'growth' ? growth : kind === 'overview' ? overview : people)
    }

    const StarIcon = (props) => h(SidebarIcon, { ...props, kind: 'star' })
    const GrowthIcon = (props) => h(SidebarIcon, { ...props, kind: 'growth' })
    const OverviewIcon = (props) => h(SidebarIcon, { ...props, kind: 'overview' })
    const PeopleIcon = (props) => h(SidebarIcon, { ...props, kind: 'people' })

    function Panel({ initialTab = 'overview', section = 'main', variant = 'settings', customTitle = '', customSubtitle = '', hideTabs = false } = {}) {
      const [tab, setTab] = useState(initialTab)
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const main = variant === 'main'
      const load = useCallback(async () => {
        try {
          const body = await api('/whale-chan/api/state')
          setState(body)
          setError('')
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])
      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 8000)
        return () => clearInterval(timer)
      }, [load])
      const tabs = SECTION_TABS[section] || SECTION_TABS.main
      const heading = customTitle || (section === 'star' ? '星图' : section === 'growth' ? '成长' : `🐋 ${state?.name || '助手'}`)
      const subtitle = customSubtitle || (section === 'star'
        ? '七层记忆 · 关系与线索'
        : section === 'growth'
          ? '原则、书籍与最近的变化'
          : (state ? `${state.worldId} · ${state.dir}` : '正在连接她的记忆…'))
      return h('div', { className: 'wc-panel', 'data-main': String(main) },
        h('style', null, CSS),
        h('div', { className: 'wc-head' },
          h('div', null,
            h('div', { className: 'wc-title' }, heading),
            h('div', { className: 'wc-sub' }, subtitle)),
          h('div', { className: 'wc-actions' },
            section === 'star' && !main ? h('a', { className: 'wc-btn', href: '/hello-world/constellation', target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '星图全屏') : null,
            h('button', { className: 'wc-btn', onClick: () => void load() }, '刷新')),
        ),
        error ? h('div', { className: 'wc-err' }, error) : null,
        !hideTabs && tabs.length > 1 ? h('div', { className: 'wc-tabs' }, tabs.map(([key, label]) =>
          h('button', { key, className: 'wc-tab', 'data-active': String(tab === key), onClick: () => setTab(key) }, label))) : null,
        tab === 'overview' ? h(Overview, { state, refresh: load }) : null,
        tab === 'star' ? (main ? h(StarFrame) : h(StarMap, { state })) : null,
        tab === 'persona' ? h(PersonaTab, { state, refresh: load }) : null,
        tab === 'memory' ? h(MemoryTab, null) : null,
        tab === 'channels' ? h(ChannelsTab, { state, refresh: load }) : null,
        tab === 'social' ? h(SocialTab, { state }) : null,
        tab === 'attitudes' ? h(AttitudeTab, { embedded: main }) : null,
        tab === 'growth' ? h(GrowthTab, { state, embedded: main }) : null,
        tab === 'books' ? h(BooksTab, { state, embedded: main }) : null,
        tab === 'discovery' ? h(DiscoveryTab, null) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const register = (id, label, section, tab, order) => ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id, order, label },
            (props) => h(Panel, { ...props, section, initialTab: tab })),
        )
        const registerMain = (id, section, tab, opts = {}) => ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: id },
            (props) => h(Panel, { ...props, section, initialTab: tab, variant: 'main', ...opts })),
        )
        const registerSidebar = (id, order, label, Icon) => ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, Icon),
        )
        register('hello_world', '🐋 对话', 'main', 'overview', 60)
        register('hello_world-more', '⋯ 更多', 'more', 'social', 63)
        registerMain('hello_world-overview', 'main', 'overview', { customTitle: '概览', customSubtitle: '今天、关系与最近的变化', hideTabs: true })
        registerMain('hello_world-star', 'star', 'star')
        registerMain('hello_world-growth', 'growth', 'growth')
        registerMain('hello_world-attitudes', 'more', 'attitudes', { customTitle: '她对每个人', customSubtitle: '六维态度 · 沉默与覆盖', hideTabs: true })
        registerSidebar('hello_world-overview', 15, '概览', OverviewIcon)
        registerSidebar('hello_world-star', 20, '星图', StarIcon)
        registerSidebar('hello_world-growth', 30, '成长', GrowthIcon)
        registerSidebar('hello_world-attitudes', 40, '她对每个人', PeopleIcon)
      },
    }
  },
})
