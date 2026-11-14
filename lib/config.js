import { mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { assertTimeZone } from './temporal-context.js'

export const DEFAULTS = {
  enabled: true,
  name: '助手',
  partnerName: '你',
  worldName: '深海',
  worldId: 'default',
  timeZone: 'Asia/Shanghai',
  presetName: 'whale-chan',
  /** 'all' = every new session in this profile; 'workspace' = only cwd under workspaceDir. */
  scope: 'all',
  workspaceDir: '',
  /** Empty = <DSH_HOME>/whale-chan/<worldId> (stable across Workspaces and Sessions). */
  dataDir: '',
  /** Let channel-created agents run shell/file tools. Off by default on purpose. */
  allowExternalTools: false,
  /** 0 disables the daily token allowance. */
  dailyTokenBudget: 0,
  recallTopK: 8,
  workingMemoryTokens: 320,
  idleConsolidateMinutes: 180,
  reviewTime: '23:00',
  nightlyEnabled: true,
  diaryEnabled: true,
  lifeEnabled: true,
  proactiveEnabled: true,
  proactiveCooldownMinutes: 90,
  proactiveDailyLimit: 6,
  /** STEP 14: rhythm-aware proactive quota per time period. */
  proactiveMaxPerPeriod: 1,
  /** STEP 14: temporal prompt projection; no DB rows unless dayChangeEvent. */
  temporal: {
    style: 'normal',
    injectEachTurn: true,
    dayChangeEvent: true,
  },
  /** STEP 15: only short social replies pass through the voice cleaner. */
  voiceCleanEnabled: true,
  voiceCleanMaxChars: 80,
  voiceCleanMaxBubbles: 2,
  /** STEP 18: regex ai-tells layer and structural rewrite trigger. */
  voiceAiTellsEnabled: true,
  voiceRewriteEnabled: true,
  voiceRewriteThreshold: 60,
  /** STEP 21/22: poetic-filler cleanup and outgoing length/emoji style. */
  voicePoeticEnabled: true,
  voiceStyleEnabled: true,
  voiceStyleTypoRate: 0,
  /** STEP 16: per-conversation chat/agent mode timeouts and round cap. */
  agentMode: {
    askEnterTimeoutMs: 300000,
    agentIdleTimeoutMs: 600000,
    askExitTimeoutMs: 300000,
    maxAgentRounds: 20,
  },
  /** Only these direct socket peers may supply proxy headers. */
  trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  quietHours: ['23:30', '08:00'],
  /** Owner identity used as the default target of proactive channel sends. */
  ownerId: '',
  /** Group replies: mention = only when addressed; all = every message. */
  groupReplyMode: 'mention',
  /** STEP 10 / ②: nightly data tidy is dry-run unless explicitly enabled. */
  tidyApply: false,
  tidyEpisodeMax: 40,
  tidyWriteMax: 14,
  tidyDupThreshold: 0.82,
  /** STEP 13: read-only external tools are opt-in and never write memory. */
  tools: {
    weatherEnabled: false,
    visionEnabled: false,
    visionApiKey: '',
    visionModel: 'glm-4.6v-flash',
    timeoutMs: 8000,
    weatherMaxChars: 400,
    visionMaxTokens: 400,
  },
  /** STEP 29: inbound media. Off until bridge and adapters are confirmed. */
  media: {
    enabled: false,
    visionEnabled: false,
    asrEnabled: false,
    maxBytes: 1024 * 1024 * 1024,
    maxTextChars: 0,
    rootDir: '',
    visionModel: 'glm-4.6v-flash',
    visionMaxTokens: 400,
    asrEndpoint: 'http://172.21.0.1:6176/transcribe',
    asrDecoder: 'pilk',
    asrPilkScript: '/opt/asr/pilk_decode.py',
    asrTimeoutMs: 30000,
    asrMaxAudioBytes: 200 * 1024 * 1024,
  },
  llmProvider: '',
  llmModel: '',
  channels: {
    qq: {
      enabled: false,
      mode: 'forward',
      reversePath: '/whale-chan/qq',
      /** NapCat / Lagrange / LLOneBot forward WebSocket, e.g. ws://127.0.0.1:3001 */
      wsUrl: '',
      accessToken: '',
      selfId: '',
      allowUsers: [],
      allowGroups: [],
      groups: true,
      ratePerMinute: 12,
      replyDelayMs: [900, 2600],
      splitLength: 1200,
    },
    wechat: {
      enabled: false,
      mode: 'bridge',
      /** Bridge base URL: GET {base}/inbound?since=, POST {base}/send */
      bridgeUrl: '',
      /** Linux WeChat local API: GET {base}/messages?since=, POST {base}/send */
      linuxApiUrl: '',
      linuxToken: '',
      /** Current agent-wechat native API (v1). */
      apiBase: 'http://127.0.0.1:6174',
      apiToken: '',
      accountId: '',
      pollIntervalMs: 3000,
      /** Legacy single-URL webhook (send-only bridge). */
      webhookUrl: '',
      token: '',
      selfId: '',
      allowUsers: [],
      allowGroups: [],
      ratePerMinute: 8,
      replyDelayMs: [1200, 3400],
      splitLength: 1200,
    },
  },
}

function merge(base, extra) {
  if (extra == null) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    const current = out[key]
    if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (value == null || value === '') return []
  return String(value)
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

export function normalizeConfig(raw = {}) {
  const input = { ...(raw || {}) }
  input.name = input.name || input.companionName || DEFAULTS.name
  input.worldId = input.worldId || DEFAULTS.worldId
  input.partnerName = input.partnerName || DEFAULTS.partnerName
  input.lifeEnabled = input.lifeEnabled ?? input.life ?? DEFAULTS.lifeEnabled
  if (input.dataDir === '' || input.dataDir == null) input.dataDir = ''
  const config = merge(DEFAULTS, input)
  config.name = String(config.name || DEFAULTS.name)
  config.worldName = String(config.worldName || DEFAULTS.worldName).trim() || DEFAULTS.worldName
  config.worldId = String(config.worldId || 'default').replace(/[^a-zA-Z0-9_-]/g, '-') || 'default'
  config.scope = config.scope === 'workspace' ? 'workspace' : 'all'
  config.workspaceDir = config.workspaceDir ? resolve(String(config.workspaceDir)) : ''
  config.dataDir = String(config.dataDir || '').trim()
  config.recallTopK = Math.max(3, Math.min(30, Number(config.recallTopK) || DEFAULTS.recallTopK))
  config.workingMemoryTokens = Math.max(120, Math.min(1200, Number(config.workingMemoryTokens) || 320))
  config.idleConsolidateMinutes = Math.max(10, Number(config.idleConsolidateMinutes) || 180)
  config.dailyTokenBudget = Math.max(0, Number(config.dailyTokenBudget) || 0)
  config.proactiveCooldownMinutes = Math.max(10, Number(config.proactiveCooldownMinutes) || 90)
  config.proactiveDailyLimit = Math.max(0, Number(config.proactiveDailyLimit) || 0)
  config.proactiveMaxPerPeriod = Math.max(1, Number(config.proactiveMaxPerPeriod) || 1)
  const am = config.agentMode || {}
  config.agentMode = {
    askEnterTimeoutMs: Math.max(60000, Number(am.askEnterTimeoutMs) || DEFAULTS.agentMode.askEnterTimeoutMs),
    agentIdleTimeoutMs: Math.max(60000, Number(am.agentIdleTimeoutMs) || DEFAULTS.agentMode.agentIdleTimeoutMs),
    askExitTimeoutMs: Math.max(60000, Number(am.askExitTimeoutMs) || DEFAULTS.agentMode.askExitTimeoutMs),
    maxAgentRounds: Math.max(1, Math.min(100, Number(am.maxAgentRounds) || DEFAULTS.agentMode.maxAgentRounds)),
  }
  config.quietHours = asList(config.quietHours)
  const tz = assertTimeZone(String(config.timeZone || DEFAULTS.timeZone))
  if (!tz.ok) console.warn('[temporal] bad timeZone, fallback Asia/Shanghai:', tz.reason)
  config.timeZone = tz.timeZone
  config.temporal = {
    style: config.temporal?.style === 'detailed' ? 'detailed' : 'normal',
    injectEachTurn: config.temporal?.injectEachTurn !== false,
    dayChangeEvent: config.temporal?.dayChangeEvent !== false,
  }
  config.voiceCleanEnabled = config.voiceCleanEnabled !== false
  config.voiceCleanMaxChars = Math.max(60, Math.min(100, Number(config.voiceCleanMaxChars) || 80))
  config.voiceCleanMaxBubbles = Math.max(1, Math.min(2, Number(config.voiceCleanMaxBubbles) || 2))
  config.voiceAiTellsEnabled = config.voiceAiTellsEnabled !== false
  config.voiceRewriteEnabled = config.voiceRewriteEnabled !== false
  config.voiceRewriteThreshold = Math.max(20, Math.min(95, Number(config.voiceRewriteThreshold) || 60))
  config.voicePoeticEnabled = config.voicePoeticEnabled !== false
  config.voiceStyleEnabled = config.voiceStyleEnabled !== false
  config.voiceStyleTypoRate = Math.max(0, Math.min(0.05, Number(config.voiceStyleTypoRate) || 0))
  const media = config.media || {}
  config.media = {
    enabled: media.enabled === true,
    visionEnabled: media.visionEnabled === true,
    asrEnabled: media.asrEnabled === true,
    maxBytes: Math.max(0, Number(media.maxBytes ?? DEFAULTS.media.maxBytes) || 0),
    maxTextChars: Math.max(0, Number(media.maxTextChars) || 0),
    rootDir: String(media.rootDir || '').trim(),
    visionModel: String(media.visionModel || DEFAULTS.media.visionModel),
    visionMaxTokens: Math.max(100, Math.min(1200, Number(media.visionMaxTokens) || DEFAULTS.media.visionMaxTokens)),
    asrEndpoint: String(media.asrEndpoint || DEFAULTS.media.asrEndpoint),
    asrDecoder: media.asrDecoder === 'silk_v3_decoder' ? 'silk_v3_decoder' : 'pilk',
    asrPilkScript: String(media.asrPilkScript || DEFAULTS.media.asrPilkScript),
    asrTimeoutMs: Math.max(1000, Math.min(120000, Number(media.asrTimeoutMs) || DEFAULTS.media.asrTimeoutMs)),
    asrMaxAudioBytes: Math.max(0, Number(media.asrMaxAudioBytes ?? DEFAULTS.media.asrMaxAudioBytes) || 0),
  }
  config.trustedProxies = asList(config.trustedProxies)
    .map((ip) => String(ip).replace(/^::ffff:/, ''))
    .filter(Boolean)
  for (const name of ['qq', 'wechat']) {
    const ch = config.channels[name]
    ch.mode = name === 'qq' ? (ch.mode === 'reverse' ? 'reverse' : 'forward') : ['bridge', 'linux', 'native'].includes(ch.mode) ? ch.mode : 'bridge'
    const target = name === 'qq'
      ? (ch.mode === 'reverse' ? ch.reversePath : ch.wsUrl)
      : ch.mode === 'native'
        ? ch.apiBase
        : ch.mode === 'linux'
          ? ch.linuxApiUrl
          : ch.bridgeUrl
    ch.enabled = Boolean(ch.enabled) && Boolean(target)
    ch.allowUsers = asList(ch.allowUsers || ch.allowlist)
    ch.allowGroups = asList(ch.allowGroups)
    ch.ratePerMinute = Math.max(1, Number(ch.ratePerMinute) || 10)
    ch.splitLength = Math.max(200, Number(ch.splitLength) || 1200)
    ch.replyDelayMs = Array.isArray(ch.replyDelayMs) && ch.replyDelayMs.length === 2 ? ch.replyDelayMs.map(Number) : [1000, 3000]
  }
  return config
}

export function setConfig(next) {
  return normalizeConfig(next)
}

export function defaultDataDir() {
  const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'whale-chan')
}

export function resolveDataDir(config) {
  const dir = config.dataDir && isAbsolute(config.dataDir) ? config.dataDir : config.dataDir ? resolve(config.dataDir) : join(defaultDataDir(), config.worldId || 'default')
  try {
    ensureDir(dir)
  } catch (error) {
    if (config.dataDir) throw error
    // DSH_HOME may be read-only for the host process in locked-down deployments.
    const fallback = resolve(process.cwd(), '.whale-chan', config.worldId || 'default')
    ensureDir(fallback)
    ensureDir(join(fallback, 'diary'))
    ensureDir(join(fallback, '.history'))
    return fallback
  }
  ensureDir(join(dir, 'diary'))
  ensureDir(join(dir, '.history'))
  return dir
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function isInWorkspace(config, agent) {
  if (config.scope === 'all') return true
  const cwd = agent?.session?.header?.cwd
  if (!config.workspaceDir || !cwd) return false
  const base = resolve(config.workspaceDir)
  const target = resolve(cwd)
  return target === base || target.startsWith(`${base}/`)
}
