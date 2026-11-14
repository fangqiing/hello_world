/**
 * Whale-Chan (助手) — companion layer for DeepSeek Harness.
 *
 * Composition root only: configuration, host wiring (prompt / session / tools /
 * HTTP / channels / timers), and teardown. Memory, persona, cognition, digest,
 * channels and the console API live in ./lib.
 */
import { dirname, extname, join, resolve, basename } from 'node:path'
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { ensurePersonaFiles, readSelf } from './lib/persona.js'
import { normalizeConfig, resolveDataDir, defaultDataDir, isInWorkspace, ensureDir } from './lib/config.js'
import { extractionDirective } from './lib/chapter-detect.js'
import { openStore } from './lib/store.js'
import { DigestEngine } from './lib/llm.js'
import { extractJson } from './lib/util.js'
import { AgentLayer, blocksText } from './lib/agent-layer.js'
import { LifeLine } from './lib/life.js'
import { buildChannels } from './lib/channels.js'
import { registerTools } from './lib/tools.js'
import { registerWeb } from './lib/web.js'
import { configureAuth, ensureApiToken } from './lib/auth-guard.js'
import { SocialStore, peerIdFor } from './lib/social.js'
import { Growth } from './lib/growth.js'
import { PeerRegistry } from './lib/peer-registry.js'
import { NightlyTidy } from './lib/nightly-tidy.js'
import { ReadingPipeline } from './lib/reading-pipeline.js'
import { HostControl } from './lib/host-control.js'
import { MediaIngest } from './lib/media-inbound.js'
import { createAsrAdapter } from './lib/asr-adapter.js'
import { createAttitudeStore } from './lib/step31/store-adapter.js'
import { InboundWiring } from './lib/step31/wire-inbound.js'
import { describeImage, loadProviderConfig, resolveVisionKeys, DEFAULT_VISION_CHAIN, readDshCredential } from './lib/vision-tool.js'

// dsh 的 LLM provider 从环境变量取 key；凭据文件里有就补到 env，修复夜间反思的 "no API key"。
try {
  if (!process.env.DEEPSEEK_API_KEY) {
    const key = readDshCredential('DEEPSEEK_API_KEY')
    if (key) {
      process.env.DEEPSEEK_API_KEY = key
      console.log('[hello_world] DEEPSEEK_API_KEY injected from credentials file')
    }
  }
} catch (err) { /* 不阻塞启动 */ }
import { verifySummary } from './lib/compression-guard.js'
import { assertDeps, toHealthRecord } from './lib/error-classifier.js'
import { execFile } from 'node:child_process'
import { inQuietHours, localTimeText, parseClock, tokenizeSearch } from './lib/util.js'

export const name = 'dsh-hello_world'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm', 'agentDefaultModel']

const packageDir = dirname(fileURLToPath(import.meta.url))

class Whale {
  constructor(ctx, rawConfig) {
    this.ctx = ctx
    this.config = normalizeConfig(rawConfig)
    this.packageDir = packageDir
    this.defaultDataDir = defaultDataDir()
    this.dir = resolveDataDir(this.config)
    ensurePersonaFiles(this.dir, this.config)
    this.apiToken = ensureApiToken(this.dir)
    configureAuth({ token: this.apiToken, trustedProxies: this.config.trustedProxies || [] })
    this.startedAt = Date.now()
    this.lastSessionId = ''
    this.logger = ctx.logger ? ctx.logger : console
    this.store = openStore(this.dir)
    assertDeps({ openStore, normalizeConfig, ensurePersonaFiles, extractJson }, 'Whale.constructor')
    this.social = new SocialStore(this.store, this.config)
    this.attitudes = this.buildAttitudes()
    this.digest = new DigestEngine(ctx, this.config, this.store)
    this.growth = new Growth({
      store: this.store, social: this.social, config: this.config, llm: this.digest,
      // 主动消息：把 peerId（wechat:private:wxid_x）拆成通道 + 会话，走正式发送链路。
      sendProactive: async (peerId, text) => {
        if (!this.channels) throw new Error('channels not ready')
        const parts = String(peerId || '').split(':')
        const channelName = parts.length > 1 ? parts[0] : 'wechat'
        const conversationId = parts[parts.length - 1]
        return this.channels.sendText(channelName, conversationId, text, { agentBypass: true })
      },
    })
    this.agentLayer = new AgentLayer(this)
    this.life = new LifeLine(this)
    this.channels = null
    this.peerRegistry = this.buildPeerRegistry()
    this.tidy = this.buildTidy()
    this.reading = this.buildReading()
    this.host = this.buildHostControl()
    this.media = this.buildMedia()
  }

  channelAllowlists() {
    const channels = this.config.channels || {}
    const pick = (name, key) => Array.isArray(channels[name]?.[key]) ? channels[name][key] : []
    const uniq = (list) => [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))]
    return {
      allowUsers: uniq([...pick('wechat', 'allowUsers'), ...pick('qq', 'allowUsers')]),
      allowGroups: uniq([...pick('wechat', 'allowGroups'), ...pick('qq', 'allowGroups')]),
    }
  }

  buildAttitudes() {
    const attitudeStore = createAttitudeStore(this.social.db, {
      appendEpisode: (row) => this.store.addEpisode({
        id: row.id,
        sessionId: row.conversationId || '',
        channel: '',
        role: row.role || 'user',
        text: row.text || '',
        peerId: row.peer_id || null,
        speakerId: row.speaker_id || '',
        createdAt: Number(row.at) || Date.now(),
      }),
    })
    const wiring = new InboundWiring({
      store: attitudeStore,
      config: this.config,
      logger: (kind, data) => this.logger?.info?.('[attitude]', kind, data),
    })
    wiring.store = attitudeStore
    return wiring
  }

  buildPeerRegistry() {
    const allow = this.channelAllowlists()
    const registry = new PeerRegistry({
      store: {
        load: () => this.store.kvGet('step10:peers', []),
        save: (rows) => {
          this.store.kvSet('step10:peers', rows)
          // STEP 12: registry and peers are one identity source; a registry
          // entry must have a social profile even before the first message.
          for (const row of rows || []) {
            try {
              const kind = row.kind === 'group' ? 'group' : 'direct'
              const id = peerIdFor('wechat', row.id, kind)
              if (id) this.social.ensurePeer({ id, channel: 'wechat', peerKind: kind, displayName: row.displayName || '' })
            } catch { /* registry sync must not block admission */ }
          }
        },
        appendAudit: (row) => this.social.appendChannelAudit(row),
      },
      config: { fallbackAllowUsers: allow.allowUsers, fallbackAllowGroups: allow.allowGroups },
    })
    registry.importFromConfig({ ...allow, actor: 'system' })
    return registry
  }

  buildTidy() {
    return new NightlyTidy({
      store: {
        listEpisodes: ({ since = 0, until = Date.now(), peerId = null } = {}) =>
          this.store.listEpisodes({ since, until, peerId, limit: 100000 }),
        listMemories: ({ peerId = null } = {}) =>
          this.store.list({ all: true, limit: 100000, peerId }).map((memory) => ({
            ...memory,
            text: memory.content,
            at: memory.createdAt,
            peer_id: memory.peerId || null,
            kind: memory.meta?.kind || '',
          })),
        markArchived: (kind, ids) => (kind === 'episodes'
          ? this.store.archiveEpisodes(ids)
          : this.store.archiveMemories(ids)),
        appendTidyRun: (row) => this.social.appendTidyRun(row),
      },
      verifySummary,
      config: {
        apply: Boolean(this.config.tidyApply),
        episodeMax: Number(this.config.tidyEpisodeMax) || 40,
        writeMax: Number(this.config.tidyWriteMax) || 14,
        dupThreshold: Number(this.config.tidyDupThreshold) || 0.82,
      },
    })
  }

  buildMedia() {
    const cfg = this.config.media || {}
    if (cfg.enabled !== true) return null
    const rootDir = resolve(cfg.rootDir || join(this.dir, 'media'))
    ensureDir(rootDir)
    const visionKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || this.config.tools?.visionApiKey || ''
    // 识图走多厂商链：deepseek-flash 主，失败/没看清才降级。key 与链顺序都在 config/providers.json。
    const providerCfg = loadProviderConfig()
    const visionChain = Array.isArray(providerCfg.visionChain) && providerCfg.visionChain.length
      ? providerCfg.visionChain : DEFAULT_VISION_CHAIN
    const visionKeys = resolveVisionKeys({ zhipu: visionKey })
    const textExt = new Set([
      'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml',
      'ini', 'conf', 'xml', 'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb',
      'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'bash', 'ps1', 'sql', 'r', 'lua', 'php',
      'swift', 'kt', 'dart', 'vue', 'svelte',
    ])
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff',
      heic: 'image/heic', avif: 'image/avif',
    }
    const asr = cfg.asrEnabled === true ? createAsrAdapter({
      run: (cmd, args, opts = {}) => new Promise((done) => {
        execFile(cmd, args, { timeout: opts.timeoutMs || cfg.asrTimeoutMs || 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          done({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
      }),
      readHead: (p) => {
        const fd = openSync(p, 'r')
        try {
          const buf = Buffer.alloc(16)
          const n = readSync(fd, buf, 0, buf.length, 0)
          return buf.subarray(0, n)
        } finally {
          closeSync(fd)
        }
      },
      fetchImpl: fetch,
      tmpPath: (p, ext) => join(tmpdir(), `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${basename(p)}${ext}`),
      config: {
        endpoint: cfg.asrEndpoint || 'http://172.21.0.1:6176/transcribe',
        decoder: cfg.asrDecoder || 'pilk',
        pilkScript: cfg.asrPilkScript || '/opt/asr/pilk_decode.py',
        timeoutMs: cfg.asrTimeoutMs || 30000,
        maxAudioBytes: cfg.asrMaxAudioBytes || 200 * 1024 * 1024,
      },
    }) : null
    return new MediaIngest({
      rootDir,
      config: {
        maxBytes: cfg.maxBytes,
        maxTextChars: cfg.maxTextChars,
        lowConfidenceHint: true,
      },
      store: {
        appendEpisode: (row) => this.store.addEpisode({
          id: row.id,
          sessionId: row.sessionId,
          channel: row.channel || 'wechat',
          role: 'user',
          text: row.text,
          peerId: row.peer_id,
          speakerId: row.speaker_id,
          kind: row.kind,
          sourceMedia: row.sourceMedia,
          mediaMeta: {
            vision: Boolean(row.vision),
            asr: Boolean(row.asr),
            file: Boolean(row.file),
            model: row.model || null,
            confidence: row.asrConfidence ?? null,
            truncated: Boolean(row.truncated),
          },
          createdAt: row.at,
        }),
      },
      adapters: {
        stat: (p) => ({ size: statSync(p).size }),
        readAsDataUri: async (p) => {
          const size = statSync(p).size
          if (size > 20 * 1024 * 1024) throw Object.assign(new Error('image too large for vision'), { code: 'vision_too_large' })
          const ext = extname(p).slice(1).toLowerCase()
          const type = mime[ext] || 'application/octet-stream'
          return `data:${type};base64,${readFileSync(p).toString('base64')}`
        },
        vision: async ({ dataUri, question }) => {
          if (cfg.visionEnabled !== true) return { ok: false, error: 'vision_disabled' }
          const out = await describeImage({
            image: dataUri,
            question,
            config: { chain: visionChain, apiKeys: visionKeys, maxTokens: cfg.visionMaxTokens },
          })
          return { ok: out.ok, text: out.text, model: out.source || cfg.visionModel, error: out.error, attempts: out.attempts }
        },
        transcribe: asr
          ? (input) => asr.transcribe(input)
          : async () => ({ ok: false, error: cfg.asrEnabled ? 'asr_adapter_missing' : 'asr_disabled' }),
        extractText: async ({ path: p, ext }) => {
          if (!textExt.has(String(ext || '').toLowerCase())) return { ok: false, error: 'no_text_extractor' }
          if (statSync(p).size > 32 * 1024 * 1024) return { ok: false, error: 'text_too_large' }
          return { ok: true, text: readFileSync(p, 'utf8') }
        },
      },
    })
  }

  buildReading() {
    const infer = async ({ kind = 'principle_candidate', text = '', title = '', chapters = [], targetChars = 300, bookSummary = '', maxCount = 8 } = {}) => {
      if (!this.digest.available()) {
        this.store.health('reading', {
          ok: false,
          available: false,
          llm: Boolean(this.ctx.get('llm')),
          defaultModel: Boolean(this.ctx.get('agentDefaultModel')),
          selection: this.digest.selection ? this.digest.selection() : null,
          provider: this.config.llmProvider || '',
          model: this.config.llmModel || '',
          at: Date.now(),
        })
        return null
      }
      let prompt = ''
      let maxTokens = 500
      if (kind === 'chapter_summary') {
        prompt = `用不超过 ${targetChars} 字概括这一章在说什么。只输出摘要正文，不要标题、不要解释。\n\n《${title}》\n${String(text)}`
        maxTokens = Math.max(300, Math.min(900, Math.ceil(targetChars * 3)))
      } else if (kind === 'book_summary') {
        const body = (chapters || []).map((c) => `第 ${Number(c.index) + 1} 章：${c.summary || ''}`).join('\n')
        prompt = `根据下面这些章摘要，用不超过 ${targetChars} 字概括全书在讲什么。只输出摘要正文，不要解释。\n\n《${title}》\n${body}`
        maxTokens = Math.max(400, Math.min(1000, Math.ceil(targetChars * 3)))
      } else if (kind === 'principle_extraction') {
        const body = (chapters || []).map((c) => `[${Number(c.index)}] ${c.title || ''}\n${c.summary || ''}`).join('\n\n')
        prompt = `${extractionDirective()}

只输出 JSON，不要解释：
{"principles":[{"statement":"一句可检验的原则","quote":"章摘要里的短句","chapterIndex":0,"weight":0.3}]}

全书摘要：
${bookSummary}

章节摘要：
${body}`
        maxTokens = 900
      } else {
        prompt = `从下面这段书摘里提炼 1-3 条可复用的原则候选。每条都必须引用原文短句作为证据。
只输出 JSON，不要解释：
{"principles":[{"statement":"一句可检验的原则","evidence":"原文短句","weight":0.3}]}
如果书摘包含可复用的判断，至少提炼 1 条；确实没有才输出 {"principles":[]}。

书摘：
${text}`
      }
      try {
        const reply = await this.digest.complete(prompt, { maxTokens, temperature: 0.3 })
        if (kind === 'chapter_summary') return String(reply || '').trim().slice(0, Math.max(80, Number(targetChars) || 150))
        if (kind === 'book_summary') return String(reply || '').trim().slice(0, Math.max(120, Number(targetChars) || 300))
        const parsed = extractJson(reply)
        const rows = Array.isArray(parsed?.principles) ? parsed.principles : []
        return rows
          .map((row) => ({
            statement: String(row?.statement || '').trim(),
            evidence: String(row?.evidence || row?.quote || '').slice(0, 300),
            quote: String(row?.quote || row?.evidence || '').slice(0, 120),
            chapterIndex: Number.isFinite(Number(row?.chapterIndex)) ? Number(row.chapterIndex) : null,
            weight: Number(row?.weight) || 0.3,
          }))
          .filter((row) => row.statement)
      } catch (error) {
        const record = toHealthRecord(error, { phase: 'infer', stage: 'complete' })
        this.store.health(record.healthKey, record)
        error.health = record
        throw error
      }
    }
    return new ReadingPipeline({
      store: {
        appendReading: (row) => this.social.addReading({
          id: row.id,
          at: row.at,
          title: row.title,
          source: row.source,
          meta: {
            segments: row.segments,
            actor: row.actor,
            pipeline: 'step10',
            mode: row.mode || 'flat',
            chapterCount: row.chapterCount || 0,
            frontChars: row.frontChars || 0,
            ocrSuspect: Boolean(row.ocrSuspect),
          },
        }),
        updateReadingPrinciples: (id, ids) => this.social.updateReadingPrinciples(id, ids),
        updateReadingSummary: (id, row) => this.social.updateReadingSummary(id, row),
        appendPrincipleEvent: (row) => this.social.appendPrincipleEvent({
          principle_id: row.principleId || row.principle_id,
          event: row.kind || row.event,
          at: row.at,
          evidence_id: row.evidenceId || row.evidence_id,
          reason: row.reason || '',
          weight_before: row.weight_before,
          weight_after: row.weight_after,
          actor: row.actor,
        }),
        listPrinciples: () => this.social.listPrinciples({ status: null, limit: 1000 }),
        appendEpisode: (row) => this.store.addEpisode(row),
      },
      principles: this.growth.principle,
      social: this.social,
      infer,
      config: { onError: (record) => this.store.health(record.healthKey, record) },
    })
  }

  buildHostControl() {
    return new HostControl({
      keyPath: process.env.DSH_HOST_KEY || null,
      exec: ({ command, argv, timeoutMs }) => new Promise((resolve) => {
        execFile(command, argv.slice(1), { timeout: timeoutMs }, (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (Number(error.code) || 1) : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || error?.message || ''),
          })
        })
      }),
      logger: { log: (row) => this.store.kvSet('step10:host:lastAudit', row) },
    })
  }

  keywordsFor(text) {
    return [...new Set(tokenizeSearch(text).filter((token) => token.length > 1 || /[\u4e00-\u9fff]/.test(token)))].slice(0, 14)
  }

  statMtime(path) {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  inScope(agent) {
    if (!this.config.enabled) return false
    return isInWorkspace(this.config, agent)
  }

  defaultPeerId() {
    return this.config.ownerId ? peerIdFor('wechat', this.config.ownerId) : peerIdFor('local', 'console', 'console')
  }

  ensureDefaultPeer(sessionId) {
    const peerId = this.defaultPeerId()
    const channelName = String(peerId).split(':')[0] || 'local'
    this.social.ensurePeer({ id: peerId, channel: channelName, peerKind: 'direct' })
    const state = this.agentLayer.stateFor(sessionId)
    if (!state.peerId) state.peerId = peerId
    return peerId
  }

  inQuietHours() {
    const [start, end] = this.config.quietHours
    if (!start || !end) return false
    const from = parseClock(start, { minutes: 23 * 60 + 30 })
    const to = parseClock(end, { minutes: 8 * 60 })
    const [hour, minute] = localTimeText(this.config.timeZone).split(':').map(Number)
    return inQuietHours(hour * 60 + minute, [from.minutes, to.minutes])
  }

  async ensureChannelAgent(sessionId, channelName, peerInfo = {}) {
    const existing = this.ctx.get('agents')?.get?.(sessionId)
    const state = this.agentLayer.stateFor(sessionId)
    state.channel = channelName
    state.mode = peerInfo.mode || state.mode || 'chat'
    state.peerId = peerInfo.peerId || state.peerId || this.defaultPeerId()
    state.speakerId = peerInfo.speakerId || ''
    this.social.ensurePeer({
      id: state.peerId,
      channel: channelName,
      peerKind: peerInfo.peerKind || (state.peerId.includes(':group:') ? 'group' : 'direct'),
      displayName: peerInfo.displayName || '',
    })
    if (existing) return existing
    const room = join(this.dir, 'room')
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(room, { recursive: true })
    } catch {
      /* room creation is best effort */
    }
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    const options = selection ? { agentOptions: selection } : {}
    const persistence = this.ctx.get('sessionPersistence')
    const stored = persistence ? await persistence.stat(sessionId).catch(() => undefined) : undefined
    let handle
    if (stored) {
      // An idle channel session is disposed but durable; resume instead of re-creating it.
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, ...options, signal: AbortSignal.timeout(30_000) })
    } else {
      handle = await this.ctx.agents.create({ sessionId, ...options, meta: { cwd: room }, signal: AbortSignal.timeout(30_000) })
    }
    this.agentLayer.wire(handle.agent)
    this.logger.info?.(`whale-chan: channel agent ${sessionId} (${channelName}) ready`)
    return handle.agent
  }
}

/**
 * The patch examples use top-level `qq:` / `wechat:`, while `normalizeConfig`
 * (lib/config.js) keeps channels under `channels.*`. lib/config.js is out of
 * scope for this P0 fix, so accept both shapes here.
 */
function withChannelAliases(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const next = { ...raw }
  const channels = { ...(raw.channels || {}) }
  for (const name of ['qq', 'wechat']) {
    const value = raw[name]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      channels[name] = { ...(channels[name] || {}), ...value }
    }
  }
  if (Object.keys(channels).length) next.channels = channels
  return next
}

export async function apply(ctx, rawConfig = {}) {
  let whale
  try {
    whale = new Whale(ctx, withChannelAliases(rawConfig))
  } catch (error) {
    ctx.logger?.error?.('whale-chan: initialization failed', error)
    throw error
  }
  // STEP 8 / S9: sibling plugins resolve the runtime through this service.
  ctx.provide('helloWorld', whale)
  const logger = whale.logger
  logger.info?.(`whale-chan: data dir ${whale.dir}`)

  ctx.effect(
    () => () => {
      try {
        whale.life.stop()
      } catch {
        /* ignore */
      }
      try {
        void whale.channels?.stopAll?.()
      } catch {
        /* ignore */
      }
      whale.agentLayer.disposeAll()
      try {
        whale.store.close()
      } catch {
        /* ignore */
      }
    },
    'whale-chan teardown',
  )

  // ── self-narration variable (per-assembly read, so nightly rewrites land live) ──
  // Boot order: systemPrompt is not guaranteed at apply() time; wait for it.
  ctx.inject(['systemPrompt'], () => {
    const systemPrompt = ctx.get('systemPrompt')
    if (!systemPrompt) return
    ctx.effect(() => systemPrompt.variable('whale_self', () => readSelf(whale.dir) || ' '))
  })

  // ── tools ──
  // Boot order: tools may mount after this row; register once it is available.
  ctx.inject(['tools'], () => registerTools(whale))

  // ── per-agent prompt + memory layer ──
  // Boot order: agents may already exist or be created later; inject covers both.
  ctx.inject(['agents'], (child) => {
    const wire = (agent) => {
      if (!whale.inScope(agent)) return
      whale.lastSessionId = agent.id
      whale.agentLayer.wire(agent)
    }
    child.on('agent/created', ({ agent }) => {
      try {
        wire(agent)
      } catch (error) {
        logger.warn?.('whale-chan: agent wire failed', error)
      }
    })
    for (const agent of child.agents.list()) {
      try {
        wire(agent)
      } catch (error) {
        logger.warn?.('whale-chan: agent wire failed', error)
      }
    }
  })

  // ── live session feed: archive, emotion, digest, compaction ledger ──
  ctx.on('agent/disposed', ({ agent }) => {
    try {
      whale.agentLayer.unwire(agent.id)
    } catch {
      /* ignore */
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'user/message') whale.store.kvSet('life:lastActivity', Date.now())
      whale.lastSessionId = session.id
      whale.agentLayer.onSessionEvent(session, event)
    } catch (error) {
      logger.warn?.('whale-chan: session feed failed', error)
    }
  })

  // ── catch the incoming message before assembly so recall uses the new text ──
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload?.agent
      const state = agent ? whale.agentLayer.states.get(agent.id) : undefined
      if (state && Array.isArray(payload.messages)) {
        const lastUser = [...payload.messages].reverse().find((message) => message?.role === 'user')
        const text = blocksText(lastUser?.content)
        if (text) {
          state.lastUserText = text
          state.blockKey = ''
          state.blockText = ''
        }
      }
      if (payload?.agent) await whale.agentLayer.prepareDisclosure(payload.agent)
    } catch {
      /* never block a step */
    }
    return next()
  })

  // ── chat channels (QQ OneBot 11 / WeChat bridge or Linux WeChat) ──
  whale.channels = buildChannels(whale)
  if (whale.growth && whale.channels) {
    whale.growth.proactive.cfg.enabled = Boolean(whale.config.proactiveEnabled)
    whale.growth.proactive.sender = {
      send: async (peerId, content) => {
        const [channel, ...rest] = String(peerId).split(':')
        if (!channel || !rest.length) throw new Error(`invalid peer id: ${peerId}`)
        await whale.channels.sendText(channel, rest.join(':'), content)
      },
    }
  }
  // Boot order: webServer mounts asynchronously; register routes and start
  // channels (reverse-WS support) only after it exists.
  ctx.inject(['webServer'], (child) => {
    const webServer = child.webServer
    whale.webServer = webServer
    try {
      registerWeb(whale, webServer)
    } catch (error) {
      logger.error?.('whale-chan: console routes failed', error)
    }
    void whale.channels.start(webServer).catch((error) => logger.warn?.('whale-chan: channel start failed', error))
  })

  // ── life line: nightly review, idle consolidation, vital impulse ──
  if (whale.config.lifeEnabled) whale.life.start()

  whale.store.health('boot', { ok: true, at: Date.now(), dir: whale.dir, version: '2.0.0' })
  logger.info?.(`whale-chan: ready — ${whale.config.name} @ ${whale.config.worldName}`)
}

export default { name, inject, apply }
