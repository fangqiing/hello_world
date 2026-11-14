import { LAYERS } from './util.js'
import { cognitionSnapshot } from './cognition.js'
import { createWeatherTool } from './weather-tool.js'
import { createVisionTool } from './vision-tool.js'
import { readFileSync } from 'node:fs'
import { createExpressionTool } from './expression.js'
import { createGenerationTool, createVideoGenerationTool } from './generation.js'
import { createHostTool, createSendTextFileTool, createJobStatusTool, createJobCancelTool } from './host-tools.js'
import { createAuthorizeTool, createRevokeTool, createGrantStatusTool, startGrantWatcher } from './grant.js'
import { resolve, extname, basename } from 'node:path'

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  },
}

function fail(message) {
  return { ok: false, error: message }
}

function peerOf(whale, exec) {
  const state = whale.agentLayer.states.get(exec?.agent?.id)
  return state?.peerId || null
}

function canSee(memory, peerId) {
  return !memory?.peerId || memory.peerId === peerId
}

export function registerTools(whale) {
  const ctx = whale.ctx
  const store = whale.store
  const tools = ctx.get('tools')
  if (!tools) {
    whale.logger.warn?.('whale-chan: tools service unavailable; memory tools are not registered')
    return
  }

  ctx.effect(() => tools.register(createExpressionTool(whale)))
  ctx.effect(() => tools.register(createGenerationTool(whale)))
  ctx.effect(() => tools.register(createVideoGenerationTool(whale)))
  ctx.effect(() => tools.register(createAuthorizeTool(whale)))
  ctx.effect(() => tools.register(createRevokeTool(whale)))
  ctx.effect(() => tools.register(createGrantStatusTool(whale)))
  ctx.effect(() => tools.register(createHostTool(whale)))
  ctx.effect(() => tools.register(createSendTextFileTool(whale)))
  ctx.effect(() => tools.register(createJobStatusTool(whale)))
  ctx.effect(() => tools.register(createJobCancelTool()))
  ctx.effect(() => startGrantWatcher(whale))

  ctx.effect(() =>
    tools.register({
      name: 'memory_remember',
      description: '把一件值得长期记住的事写进七层记忆。用于偏好、约定、事实、教训、自我认知。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', enum: LAYERS, description: 'soul/user/rules/project/topic/fact/lesson' },
          content: { type: 'string', description: '第一人称或第三人称的一句完整陈述' },
          importance: { type: 'number', description: '1-10，默认 5' },
          trust: { type: 'number', description: '0-1，直接观察约 0.8，推断约 0.5' },
          keywords: { type: 'array', items: { type: 'string' }, description: '可选关键词' },
          source: { type: 'string', description: '来源说明（会话/事件）' },
        },
        required: ['layer', 'content'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const peerId = peerOf(whale, exec)
        if (!peerId) return fail('no peer scope')
        const memory = whale.agentLayer.addMemory({
          layer: args.layer,
          content: String(args.content || ''),
          peerId,
          importance: Number(args.importance ?? 5),
          trust: Number(args.trust ?? 0.8),
          sourceEpisodeIds: [],
          meta: { kind: 'tool', sessionId: exec?.agent?.id || '', source: args.source || '' },
        })
        return { ok: true, id: memory.id, layer: memory.layer, content: memory.content }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_search',
      description: '混合检索她的长期记忆（关键词 FTS + 关联图 + 近因/重要性），返回最相关的几条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          layers: { type: 'array', items: { type: 'string', enum: LAYERS } },
          limit: { type: 'number', description: '默认 8，最多 20' },
        },
        required: ['query'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const peerId = peerOf(whale, exec)
        if (!peerId) return fail('no peer scope')
        const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
        const hits = store.search(String(args.query || ''), { limit, layers: args.layers, peerId })
        store.recallBoost(hits.map((hit) => hit.memory.id))
        return { items: hits.map((hit) => ({
          id: hit.memory.id,
          layer: hit.memory.layer,
          content: hit.memory.content,
          importance: hit.memory.importance,
          effectiveImportance: Number(store.effectiveImportance(hit.memory).toFixed(2)),
          score: Number(hit.score.toFixed(3)),
          status: hit.memory.status,
          updatedAt: new Date(hit.memory.updatedAt).toISOString(),
          links: hit.memory.links,
        })) }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_update',
      description: '修正 / 失效 / 归档一条记忆。冲突时先给旧条目写 validUntil 再写新条目（supersede=true）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          importance: { type: 'number' },
          status: { type: 'string', enum: ['active', 'superseded', 'archived'] },
          validUntil: { type: 'number', description: '毫秒时间戳；0 表示一直有效' },
          supersede: { type: 'boolean', description: '为 true 时把旧条目设为 superseded，并用 content 写入新条目' },
          layer: { type: 'string', enum: LAYERS },
        },
        required: ['id'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const peerId = peerOf(whale, exec)
        if (!peerId) return fail('no peer scope')
        const current = store.get(String(args.id))
        if (!current || !canSee(current, peerId)) return fail(`memory not found: ${args.id}`)
        if (args.supersede && args.content) {
          const replacement = store.supersede(current.id, {
            layer: args.layer || current.layer,
            content: String(args.content),
            keywords: whale.keywordsFor(String(args.content)),
            importance: Number(args.importance ?? current.importance),
            trust: current.trust,
            sourceEpisodeIds: current.sourceEpisodeIds,
            emotion: current.emotion,
          })
          return { ok: true, superseded: current.id, replacement: replacement.id }
        }
        const patch = {}
        if (args.content) {
          patch.content = String(args.content)
          patch.keywords = whale.keywordsFor(String(args.content))
        }
        if (args.importance != null) patch.importance = Number(args.importance)
        if (args.status) patch.status = args.status
        if (args.validUntil != null) patch.validUntil = Number(args.validUntil) || null
        const next = store.update(current.id, patch)
        return { ok: true, id: next.id, status: next.status, content: next.content }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'memory_read',
      description: '按 id 读一条记忆的全文、来源原文（episode）和关联记忆。用于溯源或纠错。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          includeSource: { type: 'boolean', description: '是否返回来源原文，默认 true' },
        },
        required: ['id'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const peerId = peerOf(whale, exec)
        if (!peerId) return fail('no peer scope')
        const memory = store.get(String(args.id))
        if (!memory || !canSee(memory, peerId)) return fail(`memory not found: ${args.id}`)
        const linked = memory.links.map((id) => store.get(id)).filter((m) => m && canSee(m, peerId)).map((m) => ({ id: m.id, layer: m.layer, content: m.content }))
        return { memory, sources: [], linked, sourceRedacted: true }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_status',
      description: '读助手此刻的心情、驱力、当前对话对象档案和记忆统计。',
      parameters: { type: 'object', properties: {} },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute() {
        const snapshot = cognitionSnapshot(store, whale.config.timeZone)
        return { name: whale.config.name, ...snapshot, memory: store.stats(), channels: whale.channels?.list?.() || [] }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_send',
      description: '通过已配置的 QQ / 微信通道，主动给指定的人发一条消息。仅用于她真的有话说时。',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['qq', 'wechat'] },
          to: { type: 'string', description: '外部会话 id，如 private:12345 / group:67890；省略时用 ownerId 或最近会话' },
          text: { type: 'string' },
        },
        required: ['text'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (!whale.channels) return fail('no channel manager')
        const channelName = args.channel || (whale.channels.get('qq') ? 'qq' : whale.channels.get('wechat') ? 'wechat' : '')
        if (!channelName) return fail('no channel configured')
        const target =
          args.to ||
          whale.config.ownerId ||
          whale.channels.conversationIds().find((id) => id.startsWith(channelName === 'qq' ? 'private:' : '')) ||
          whale.channels.conversationIds()[0]
        if (!target) return fail('no known conversation id; set ownerId or wait for an inbound message')
        const group = String(target).startsWith('group:')
        const bare = group ? String(target).slice(6) : String(target).replace(/^private:/, '')
        const registered = whale.peerRegistry?.isAllowed?.(group ? `group:${bare}` : bare, group ? 'group' : 'direct')
        if (!registered && bare !== whale.config.ownerId) return fail('target not allowed')
        if (!whale.config.proactiveEnabled) return fail('proactive sending is disabled by config')
        if (whale.inQuietHours()) return fail('quiet hours: she should not send now')
        await whale.channels.sendText(channelName, target, String(args.text))
        whale.store.kvSet('life:lastProactive', { at: Date.now(), text: String(args.text), channel: channelName, to: target })
        return { ok: true, channel: channelName, to: target }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_send_file',
      description: '通过已配置的通道，主动给指定的人发送一个文件或图片（从服务器本地路径读取后以 base64 发出）。仅用于她真的需要发文件时。',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['qq', 'wechat'] },
          to: { type: 'string', description: '外部会话 id，如 private:wxid_xxx / group:xxx；省略时用 ownerId 或最近会话' },
          path: { type: 'string', description: '服务器上的文件绝对路径，例如 /root/whale-media/foo.png（仅允许 /root/whale-media、插件目录、/tmp 下）' },
          kind: { type: 'string', enum: ['image', 'file'], description: 'image=图片，file=任意文件；省略时按扩展名推断' },
          caption: { type: 'string', description: '可选：随文件附带的文字说明' },
        },
        required: ['path'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (!whale.channels) return fail('no channel manager')
        const channelName = args.channel || (whale.channels.get('qq') ? 'qq' : whale.channels.get('wechat') ? 'wechat' : '')
        if (!channelName) return fail('no channel configured')
        const target = args.to || whale.config.ownerId || whale.channels.conversationIds()[0]
        if (!target) return fail('no known conversation id; set ownerId or wait for an inbound message')
        const group = String(target).startsWith('group:')
        const bare = group ? String(target).slice(6) : String(target).replace(/^private:/, '')
        const registered = whale.peerRegistry?.isAllowed?.(group ? `group:${bare}` : bare, group ? 'group' : 'direct')
        if (!registered && bare !== whale.config.ownerId) return fail('target not allowed')
        if (!whale.config.proactiveEnabled) return fail('proactive sending is disabled by config')
        if (whale.inQuietHours && whale.inQuietHours()) return fail('quiet hours: she should not send now')
        const abs = resolve(String(args.path || ''))
        const roots = ['/root/whale-media', whale.dir, '/tmp'].filter(Boolean)
        const allowed = roots.some((r) => { const rr = resolve(r); return abs === rr || abs.startsWith(rr + '/') })
        if (!allowed) return fail(`path not allowed: must be under ${roots.join(', ')}`)
        let buf
        try { buf = readFileSync(abs) } catch (e) { return fail('read failed: ' + (e?.message || e)) }
        if (buf.length > 50 * 1024 * 1024) return fail('file too large (>50MB)')
        const ext = extname(abs).slice(1).toLowerCase()
        const kind = args.kind || (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) ? 'image' : 'file')
        const base64 = buf.toString('base64')
        await whale.channels.sendMedia(channelName, target, { kind, data: base64, fileName: basename(abs) }, { agentBypass: true })
        if (args.caption) { try { await whale.channels.sendText(channelName, target, String(args.caption)) } catch { /* best effort */ } }
        return { ok: true, channel: channelName, to: target, bytes: buf.length, kind }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_peer',
      description: '读当前对话对象的档案、相关承诺和她的边界原则（可按 peerId 指定）。',
      parameters: {
        type: 'object',
        properties: { peerId: { type: 'string', description: '省略时用当前会话的 peer' } },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const state = whale.agentLayer.states.get(exec?.agent?.id)
        const own = state?.peerId || whale.defaultPeerId()
        if (!own) return fail('no peer scope')
        if (args.peerId && String(args.peerId) !== own) return fail('cross-peer access denied')
        return { ok: true, peerId: own, ...whale.social.peerContext(own) }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_read',
      description: '读一本书或一段材料，形成解读并产生边界原则候选；旧原则不会被删除。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          source: { type: 'string', description: '书名/作者/链接，可空' },
          text: { type: 'string', description: '正文或摘要' },
        },
        required: ['text'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        const title = String(args.title || '')
        const source = String(args.source || '')
        const result = await whale.reading.readBook({ title, source, text: String(args.text || ''), actor: 'user' })
        const principles = (result.events || [])
          .filter((event) => event.principle)
          .map((event) => ({
            id: event.principle.id,
            statement: event.principle.statement,
            weight: event.principle.weight,
          }))
        return {
          ok: true,
          readingId: result.readingId,
          skipped: Boolean(result.skipped),
          reason: result.reason || '',
          summary: '',
          interpretation: '',
          principles,
        }
      },
    }),
  )

  ctx.effect(() =>
    tools.register({
      name: 'whale_disclose',
      description: '记录一次披露决策（提/不提/换说法/先问当事人）及依据的原则与理由；不做硬过滤。',
      parameters: {
        type: 'object',
        properties: {
          peerFrom: { type: 'string', description: '信息原本属于谁' },
          peerTo: { type: 'string', description: '正在和谁说话' },
          commitmentId: { type: 'string' },
          decision: { type: 'string', enum: ['withhold', 'mention', 'rephrase', 'ask_source'] },
          principleIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['decision', 'reason'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const state = whale.agentLayer.states.get(exec?.agent?.id)
        const peerTo = String(args.peerTo || state?.peerId || whale.defaultPeerId())
        const row = whale.social.logDisclosure({
          peerFrom: String(args.peerFrom || ''),
          peerTo,
          commitmentId: args.commitmentId || null,
          decision: String(args.decision),
          principleIds: Array.isArray(args.principleIds) ? args.principleIds : [],
          reason: String(args.reason || ''),
        })
        for (const principleId of (Array.isArray(args.principleIds) ? args.principleIds : [])) {
          whale.growth.principle.addEvidence({ principleId, kind: 'support', evidenceId: row.id, actor: 'self' })
        }
        return { ok: true, id: row.id, peerTo, decision: row.decision }
      },
    }),
  )

  const toolCfg = whale.config.tools || {}
  if (toolCfg.weatherEnabled === true) {
    const weather = createWeatherTool({
      config: { timeoutMs: Number(toolCfg.timeoutMs) || 8000, maxChars: Number(toolCfg.weatherMaxChars) || 400 },
    })
    ctx.effect(() => tools.register({
      name: weather.name,
      description: weather.description,
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名，例如 哈尔滨' } },
        required: ['city'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args) { return weather.run(args) },
    }))
  }
  if (toolCfg.visionEnabled === true) {
    const vision = createVisionTool({
      apiKey: String(toolCfg.visionApiKey || ''),
      config: {
        model: String(toolCfg.visionModel || 'glm-4.6v-flash'),
        timeoutMs: Number(toolCfg.timeoutMs) || 8000,
        maxTokens: Number(toolCfg.visionMaxTokens) || 400,
      },
    })
    ctx.effect(() => tools.register({
      name: vision.name,
      description: vision.description,
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'http(s) 图片链接或 data:image base64' },
          question: { type: 'string', description: '可选问题' },
        },
        required: ['image'],
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args) { return vision.run(args) },
    }))
  }
  whale.logger.info?.('whale-chan: memory tools registered')
}
