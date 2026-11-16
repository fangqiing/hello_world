function moodCause(emotion) {
  return `user_msg:${emotion?.label || 'neutral'}`
}
function buildMoodLine(m) {
  const word = deriveEmotion(m)
  const strength = Math.abs(Number(m?.valence || 0))
  const degree = strength > 0.55 ? '很' : strength > 0.25 ? '有点' : ''
  const trend = m?.trend === 'up' ? '，比刚才好些' : m?.trend === 'down' ? '，比刚才沉了些' : ''
  const energy = Number(m?.energy ?? 0.7)
  const fatigue = energy < 0.3 ? '，有点乏' : Number(m?.arousal ?? 0.3) > 0.65 ? '，有点坐不住' : ''
  const why = m?.reason ? `（${String(m.reason).slice(0, 30)}）` : ''
  return `你的心情：${degree}${word}${trend}${fatigue}${why}`
}

import { isGranted } from './grant.js'
import { readPersona, renderPersona, readSelf, readText, writeSelf, writeDiary, diaryPath } from './persona.js'
import { estimateTokens, truncate, localDateKey, LAYER_LABEL, trigramSimilarity, tokenizeSearch } from './util.js'
import { tagEmotion, updateMood, getMood, bumpDrives, cognitionSnapshot, labelZh, learnOwner, configureMood, deriveEmotion } from './cognition.js'
import { join } from 'node:path'
import { ensureDir } from './config.js'
import { isCrossLayerDuplicate } from './memory-hygiene.js'
import { verifySummary } from './compression-guard.js'
import { nextDigestCursor } from './memory-hygiene.js'
import { buildTemporalBlock, zonedParts } from './temporal-context.js'
import { buildGapNarrative } from './gap-narrative.js'
import { harvestInner, buildInnerBlocks, advanceConflict, harvestPersons, buildPersonBlocks } from './inner-state.js'
import { buildInterlocutorBlock } from './interlocutors.js'
import { annotateAll, isFutureDated } from './temporal-memory.js'
import { looksLikeBook } from './book-detector.js'
import { buildStyleProfile, styleCard, pickExamples, rulesToPrompt } from './voice-learning.js'

export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

const LAYER_OF_PREFERENCE = { 喜好: 'user', 雷区: 'user', 习惯: 'user' }

/** Harness-injected context is not something the owner said; keep it out of memory. */
export function isHarnessText(text) {
  const s = String(text || '').trim()
  if (!s) return true
  if (s.startsWith('Current runtime context.')) return true
  if (s.startsWith('The approval policy changed')) return true
  if (s.startsWith('Time sampled while preparing')) return true
  if (s.includes('Elapsed since the preceding')) return true
  if (s.includes('This snapshot supersedes earlier runtime-context snapshots')) return true
  if (s.includes('<system-reminder>')) return true
  if (s.startsWith('Tokens prefixed with @')) return true
  if (s.startsWith('You are an AI agent powered by DeepSeek Harness.')) return true
  return false
}

/**
 * Per-agent prompt layer + memory pipeline.
 * Registers scoped prompt sections on the agent's own context, so they vanish
 * with that agent and never leak into other sessions' prompts.
 */
export class AgentLayer {
  constructor(whale) {
    // 情绪参数走 cordis.patch.yml 的 mood 段；缺省用 cognition.js 的 MOOD_DEFAULTS。
    try { configureMood(whale?.config?.mood || {}) } catch (err) { /* 配置失败不影响启动 */ }
    this.whale = whale
    this.states = new Map()
    this.disposers = new Map()
    this.replyListeners = new Set()
    this.turnListeners = new Set()
    this.profileCache = { mtime: 0, view: null }
  }

  get store() {
    return this.whale.store
  }

  get config() {
    return this.whale.config
  }

  get dir() {
    return this.whale.dir
  }

  personaView() {
    const path = join(this.dir, 'persona.md')
    let mtime = 0
    try {
      mtime = this.whale.statMtime(path)
    } catch {
      mtime = 0
    }
    if (this.profileCache.view && this.profileCache.mtime === mtime) return this.profileCache.view
    const profile = readPersona(this.dir)
    const view = renderPersona(profile, this.config)
    view.world = readText(join(this.dir, 'world-prompt.md'), '')
    view.self = readSelf(this.dir)
    this.profileCache = { mtime, view }
    return view
  }

  invalidatePersona() {
    this.profileCache = { mtime: 0, view: null }
  }

  stateFor(sessionId) {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        lastUserText: '',
        lastUserSeq: -1,
        blockKey: '',
        blockText: '',
        digestTimer: null,
        digestRunning: false,
        channel: '',
        mode: 'chat',
        applyToolMode: null,
        bookHint: null,
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  /** Wire one live agent (idempotent). Returns the disposer. */
  wire(agent) {
    if (!agent?.ctx || !agent?.session) return undefined
    if (this.disposers.has(agent.id)) return this.disposers.get(agent.id)
    const whale = this.whale
    if (!whale.inScope(agent)) return undefined
    const state = this.stateFor(agent.id)
    const layer = this
    const dispose = agent.ctx.effect(() => {
      const stops = []
      const sp = agent.ctx.get?.('systemPrompt') ?? agent.ctx.systemPrompt
      if (!sp) return () => {}
      const identity = () => layer.personaView().identity || 'You are an AI agent powered by DeepSeek Harness.'
      // Shadow the harness identity only inside her scope.
      stops.push(sp.section({ name: 'harness:identity', order: -1000, text: identity }))
      stops.push(
        sp.section({
          name: 'whale-chan:persona',
          order: 1,
          text: () => layer.personaView().persona,
        }),
      )
      stops.push(
        sp.section({
          name: 'whale-chan:world',
          order: 2,
          text: () => layer.personaView().world,
        }),
      )
      stops.push(
        sp.section({
          name: 'whale-chan:self',
          order: 3,
          text: '{{whale_self}}',
          interpolate: true,
        }),
      )
      stops.push(
        sp.section({
          name: 'whale-chan:voice',
          order: 4,
          text: () => layer.voiceBlock(agent),
        }),
      )
      stops.push(
        sp.context({
          name: 'whale-chan:memory',
          order: 9000,
          text: () => layer.memoryBlock(agent),
        }),
      )
      return () => {
        for (const stop of stops) {
          try {
            stop()
          } catch {
            /* disposal is best effort */
          }
        }
      }
    }, 'whale-chan agent prompt')
    this.disposers.set(agent.id, dispose)
    this.installToolRestriction(agent, state)
    return dispose
  }

  installToolRestriction(agent, state) {
    try {
      const toolsService = agent.ctx.get?.('tools') ?? agent.ctx.tools
      const restrict = toolsService?.restrict
      if (typeof restrict !== 'function') return
      const allowed = ['memory_remember', 'memory_search', 'memory_update', 'memory_read', 'whale_status', 'whale_send', 'whale_peer', 'whale_disclose', 'whale_expression', 'whale_send_file', 'whale_generate_image', 'whale_generate_video',
        'whale_authorize', 'whale_revoke', 'whale_grant_status',
        'whale_job_status', 'whale_job_cancel', 'whale_send_text_file', 'whale_host']
      let restriction = null
      const apply = (mode) => {
        try {
          if (restriction) {
            restriction()
            restriction = null
          }
          // Agent mode gets the same full toolset as a console agent. Safety is
          // audit + interrupt + pre-operation snapshots, not a reduced toolbox.
          // 未提权时只给低危白名单；用户明确授权（或经确认进入 agent 模式）后解除限制。
          const granted = isGranted(this.whale)
          if (!granted && state.channel && mode !== 'agent') {
            restriction = restrict.call(toolsService, { allow: allowed })
          }
        } catch (error) {
          this.whale.logger?.warn?.('whale-chan: tool mode switch failed', error)
        }
      }
      state.applyToolMode = apply
      apply(state.mode || 'chat')
      agent.ctx.effect(() => () => {
        try {
          restriction?.()
        } catch {
          /* disposal is best effort */
        }
        restriction = null
        if (state.applyToolMode === apply) state.applyToolMode = null
      })
    } catch {
      /* restriction is optional */
    }
  }

  setChannelMode(sessionId, mode) {
    const state = this.states.get(sessionId)
    if (!state) return false
    state.mode = mode || 'chat'
    state.applyToolMode?.(state.mode)
    return true
  }

  unwire(sessionId) {
    const dispose = this.disposers.get(sessionId)
    if (dispose) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    this.disposers.delete(sessionId)
    // Keep the state (and its digest timer): a disposed channel agent may be
    // resumed, and the reflection for its last turn still needs to run.
  }

  disposeAll() {
    for (const sessionId of [...this.states.keys()]) {
      const state = this.states.get(sessionId)
      if (state?.digestTimer) clearTimeout(state.digestTimer)
      this.unwire(sessionId)
    }
    this.states.clear()
  }

  /**
   * Working-memory prompt block: time binding + mood + core layers + hybrid
   * recall + the session's current working state. Recomputed once per user
   * message and cached, so repeated assemblies cost nothing.
   */
  /** Pre-generation disclosure gate: log first, then filter the memory block. */
  async prepareDisclosure(agent) {
    const state = this.states.get(agent.id)
    if (!state || !state.peerId || !this.whale.growth?.disclosure) return
    const query = state.lastUserText || ''
    const key = `${state.lastUserSeq}:${query}`
    if (state.disclosureKey === key) return

    const hits = query ? this.store.search(query, { limit: 8, peerId: state.peerId }) : []
    const commitments = this.whale.social.listCommitments(state.peerId)
    const commitmentById = new Map(commitments.map((commitment) => [commitment.id, commitment]))
    const candidates = hits.map((hit) => {
      const candidate = {
        id: hit.memory.id,
        peer_id: hit.memory.peerId,
        text: hit.memory.content,
        speaker_id: hit.memory.meta?.speakerId || hit.memory.meta?.speaker_id || undefined,
      }
      const pointer = /^承诺记录：(cmt_[A-Za-z0-9_-]+)/.exec(hit.memory.content || '')
      if (pointer && commitmentById.has(pointer[1])) {
        candidate.commitment_id = pointer[1]
        candidate.text = commitmentById.get(pointer[1]).content
      }
      return candidate
    })
    const context = this.whale.social.peerContext(state.peerId)
    const principles = this.whale.social.listPrinciples({ status: 'active', limit: 20 })
    let result
    try {
      result = await this.whale.growth.disclosure.decide({
        currentPeerId: state.peerId,
        candidates,
        commitments,
        principles,
        relationSummary: context.peer?.relation_summary || '',
        selfSummary: this.personaView().self,
        query,
        isGroup: String(state.peerId).includes(':group:'),
      })
    } catch (error) {
      // The gate must fail closed, but the key may advance: retrying the same
      // failed request forever would just keep leaking the old block.
      state.disclosureKey = key
      state.disclosure = {
        gatedIds: new Set(candidates.map((candidate) => candidate.id)),
        allowedIds: new Set(),
        allowedCommitmentIds: new Set(),
        decision: 'withhold',
        failed: true,
      }
      this.whale.store.health?.('disclosure', { ok: false, peerId: state.peerId, error: String(error?.message || error), at: Date.now() })
      return
    }
    state.disclosureKey = key
    if (result.skipped) {
      state.disclosure = null
      return
    }
    const allowed = (result.allowed || []).filter((candidate) => !candidate.redact && !candidate.redactNeeded)
    state.disclosure = {
      gatedIds: new Set(candidates.map((candidate) => candidate.id)),
      allowedIds: new Set(allowed.map((candidate) => candidate.id)),
      allowedCommitmentIds: new Set(result.allowedCommitmentIds || []),
      logId: result.logId,
      decision: result.decision,
      failed: Boolean(result.failed),
    }
  }

  /** STEP 18: generation-time voice constraints, learned examples and rules. */
  voiceBlock(agent) {
    const state = this.stateFor(agent.id)
    // STEP 40：agent 模式不谈语风，只要求说清楚。人设语气在这里是噪声。
    if (state.mode === 'agent' || state.mode === 'ask_exit') {
      return '【怎么说】在办正事：先给结论，再给要点和下一步。不用角色语气，不寒暄，不用梗，不写景物。'
    }
    const peerId = state.peerId || this.whale.defaultPeerId?.() || null
    const recent = this.store.listEpisodes({ peerId, limit: 36 })
      .filter((row) => row.role === 'assistant' && String(row.text || '').trim().length > 1)
    const profile = buildStyleProfile(recent)
    const card = styleCard(profile)
    const saved = this.store.listVoiceExamples({ peerId, limit: 12, likedOnly: true })
    const pool = [
      ...saved.map((row) => ({ text: row.text, at: row.at })),
      ...recent.map((row) => ({ text: row.text, at: row.createdAt })),
    ]
    const examples = pickExamples({ pool, max: 3 })
    const rules = rulesToPrompt(this.store.listVoiceRules({ limit: 20 }))
    const lines = ['【怎么说】像在微信上打字，不像在写说明。']
    if (card) lines.push(card)
    if (examples.length) {
      lines.push('你以前这样回：')
      for (const example of examples) lines.push(`- ${truncate(String(example.text).replace(/\s+/g, ' '), 90)}`)
    }
    lines.push('✗ 首先…其次…最后… / ✓ 先看日志。权限那边我顺手查了。')
    lines.push('✗ 这个方案有优点也有缺点 / ✓ 我倾向用这个。慢一点，但不用改数据结构。')
    lines.push('长度偏短，但不是越短越好：一句话要能独立读懂，主语宾语该有就有，别省成电报。宁可多写五六个字说清，也不留半句让人猜。')
    lines.push('不写环境描写，除非对方正在聊环境、天气或他自己的状态。对方说「我在/在吗/忙吗」时直接回，不要铺景。')
    lines.push('一条最多一个问号；结尾不用「呢」「耶」「~」；emoji 默认不用，对方先用了最多留一个。')
    lines.push('大部分时候语气是平的，不每句都感叹；错了就说「不对，我重说」。')
    lines.push('对方连发几条，只接最要紧的一件；说「算了」「……」就停，不追问。')
    lines.push('能一句说完就一句；允许只回两三个字。能带就带一个真实的数字、时间、名字或路径；没有就直说不知道或还没想好。')
    if (rules) lines.push(`对方明确要求过：\n${rules}`)
    return lines.join('\n')
  }

  /**
   * STEP 40 - agent 模式的最小上下文。
   *
   * 任务模式下不再注入人设、情绪、世界、好恶、立场、冲突、图谱、空档叙事。
   * 这些每轮几百 token，对「把事办成」没有帮助，反而稀释指令、增加跑偏概率。
   * 只留三样：现在几点、跟谁说话、可能相关的旧事（最多三条）。
   */
  taskBlock(agent, state) {
    const key = `${state.lastUserSeq}:task:${this.profileCache.mtime}`
    if (state.blockKey === key && state.blockText) return state.blockText
    const peerId = state.peerId || this.whale.defaultPeerId?.() || null
    const context = this.whale.social?.peerContext(peerId) || { peer: null, label: '对方' }
    const now = new Date()
    const lines = ['【模式】执行任务中。直接给结果、命令、改动点；不确定就说不确定，不要绕。']
    lines.push(`【此刻】${buildTemporalBlock({
      timeZone: this.config.timeZone,
      at: now.getTime(),
      lastTalkAt: context.peer?.last_seen || null,
      firstMeetAt: context.peer?.first_seen || null,
      style: 'normal',
    })}`)
    lines.push(`【对方】${context.label}`)
    const query = state.lastUserText || ''
    if (query) {
      const hits = this.store.search(query, { limit: 3, peerId })
      if (hits.length) {
        lines.push('【可能相关的旧事】')
        for (const hit of hits) lines.push(`- ${truncate(hit.memory.content, 90)}`)
      }
    }
    const block = lines.join('\n')
    state.blockKey = key
    state.blockText = block
    return block
  }


  memoryBlock(agent) {
    const state = this.stateFor(agent.id)
    // STEP 40：agent 模式走精简路径，陪伴类注入全部停用。
    // ask_exit 也算：那是「做完了，还有吗」，仍在任务语境里，
    // 这时候恢复人设和情绪，会让人以为她切回闲聊了。
    if (state.mode === 'agent' || state.mode === 'ask_exit') return this.taskBlock(agent, state)
    const key = `${state.lastUserSeq}:${this.profileCache.mtime}`
    if (state.blockKey === key && state.blockText) return state.blockText
    const config = this.config
    const budget = config.workingMemoryTokens
    const snapshot = cognitionSnapshot(this.store, config.timeZone)
    const peerId = state.peerId || this.whale.defaultPeerId?.() || null
    const context = this.whale.social?.peerContext(peerId) || { peer: null, label: '对方', commitments: [], principles: [] }
    const partner = context.label
    const now = new Date()
    const lines = []
    const temporal = buildTemporalBlock({
      timeZone: config.timeZone,
      at: now.getTime(),
      lastTalkAt: context.peer?.last_seen || null,
      firstMeetAt: context.peer?.first_seen || null,
      style: config.temporal?.style || 'normal',
    })
    lines.push(`【此刻】${temporal}${buildMoodLine(snapshot.mood)}。`)
    if (state.attitudeBlock) lines.push(state.attitudeBlock)
    lines.push(`【当前对话对象】${partner}${context.peer?.relation_summary ? `：${truncate(context.peer.relation_summary, 80)}` : ''}`)
    try {
      const roster = buildInterlocutorBlock(
        this.whale.social?.listPeers?.({ status: 'active' }) || [],
        peerId,
        { timeZone: config.timeZone },
      );
      if (roster) lines.push(roster);
    } catch (err) {
      // 名单失败不影响对话。
    }
    // STEP 32 空档期叙事：她不在对话里的那段时间不是空白。
    try {
      const lastTalk = Number(context.peer?.last_seen) || 0
      if (lastTalk > 0) {
        const ownRows = this.store.listEpisodes({ peerId, since: lastTalk, limit: 60, includeArchived: true });
        const gapItems = ownRows
          .filter((row) => row.role !== 'user' && row.text && String(row.text).trim().length >= 6)
          .slice(-6)
          .map((row) => ({ at: Number(row.createdAt) || 0, kind: 'said', text: row.text }));
        const gap = buildGapNarrative({
          lastTalkAt: lastTalk,
          now: now.getTime(),
          timeZone: config.timeZone,
          items: gapItems,
          maxItems: 3,
        });
        if (gap.text) lines.push(gap.text);
      }
    } catch (err) {
      // 空档叙事失败不阻塞对话。
    }
    // STEP 34-38：世界 / 好恶 / 立场 / 人际 / 冲突。
    try {
      const innerRows = this.store
        .listEpisodes({ peerId, limit: 40, includeArchived: true })
        .filter((row) => row.role !== 'user' && row.text)
        .map((row) => ({ id: row.id, text: row.text, createdAt: Number(row.createdAt) || 0 }));
      const peerList = [];
      const peerLabels = {};
      for (const peer of this.whale.social?.listPeers?.({ status: 'active' }) || []) {
        peerList.push({ id: peer.id, labels: [peer.display_name, peer.learned_name] });
        peerLabels[peer.id] = peer.display_name || peer.learned_name || '';
      }
      harvestInner(this.store, { peerId, rows: innerRows, peers: peerList, now: now.getTime() });
      // STEP 42：把「谁是什么关系」抽进全局人物层，这样两个对话看到的是同一本人物册。
      // userRows 用来抓对方的自报名字，否则人物库里只有微信昵称，「岐」永远匹配不上。
      const userRows = this.store
        .listEpisodes({ peerId, limit: 20, includeArchived: true })
        .filter((row) => row.role === 'user' && row.text)
        .map((row) => ({ id: row.id, text: row.text, createdAt: Number(row.createdAt) || 0 }));
      harvestPersons(this.store, { peerId, rows: innerRows, userRows, selfName: config.name || '', now: now.getTime() });
      advanceConflict(this.store, {
        peerId,
        lastUserText: state.lastUserText || '',
        irritation: Math.max(0, -Number(snapshot.mood?.valence || 0)),
        idleMs: Number(context.peer?.last_seen) ? now.getTime() - Number(context.peer.last_seen) : 0,
        now: now.getTime(),
      });
      for (const block of buildInnerBlocks(this.store, {
        peerId,
        query: state.lastUserText || '',
        peers: peerList,
        peerLabels,
        isGroup: String(peerId || '').includes(':group:'),
        timeZone: config.timeZone,
        worldId: config.worldId || 'default',
        now: now.getTime(),
      })) lines.push(block);
      // 人物册放在最后：它比世界/好恶更贴近「现在跟我说的是谁」，位置靠后记忆更牢。
      const personBlock = buildPersonBlocks(this.store, {
        currentPeerId: peerId,
        peerLabels,
        limit: 6,
      });
      if (personBlock) lines.push(personBlock);
    } catch (err) {
      // 内在状态失败不阻塞对话。
    }
    if (context.principles.length) {
      lines.push('【你的边界原则】')
      for (const principle of context.principles.slice(0, 3)) lines.push(`- ${truncate(principle.statement, 90)}`)
    }
    const visibleCommitments = state.disclosure
      ? context.commitments.filter((commitment) => state.disclosure.allowedCommitmentIds?.has(commitment.id))
      : context.commitments
    if (visibleCommitments.length) {
      lines.push('【相关承诺】')
      for (const commitment of visibleCommitments.slice(0, 4)) {
        lines.push(`- 对${commitment.to_whom || partner}：${truncate(commitment.content, 80)}`)
      }
      lines.push('（涉及这些承诺是否披露，先用 whale_disclose 记下决定与理由。）')
    }
    lines.push('【关于你的记忆】你用第一人称自然地记得这些，不要逐条复述，也不要暴露“记忆库”这个词：')
    // 这条是止血用的：线上她曾经因为「这里没记下」而断然说「我不认识任何叫岐的人」，
    // 而同一个问题在另一个对话里的答案是「岐是朋友」。没记下 ≠ 不存在。
    lines.push('（里面没有的事，不等于没发生。查不到就说「我这边没记下」，不要说「不认识」「没有这个人」。）')

    const query = state.lastUserText || ''
    const hits = query ? this.store.search(query, { limit: config.recallTopK, peerId }) : []
    // STEP 42：完全互通 —— 别处相关的记忆也拉进来，但每条必须标来源。
    // 不标来源她就会把甲说的话当成乙说的，那比记不住更糟。
    const crossFrom = new Map()
    if (query && config.crossPeer !== 'off') {
      try {
        const elsewhere = this.store.search(query, { limit: 4, peerId: null })
        for (const hit of elsewhere) {
          const owner = hit.memory.peerId
          if (!owner || owner === peerId) continue
          if (hits.some((h) => h.memory.id === hit.memory.id)) continue
          crossFrom.set(hit.memory.id, owner)
          hits.push(hit)
        }
      } catch (err) {
        // 跨对话检索失败就当没有，不能连累本对话
      }
    }
    const core = this.store
      .search('', { layers: ['soul', 'rules', 'user'], limit: 6, peerId })
      .filter((hit) => !hits.some((h) => h.memory.id === hit.memory.id))
      .slice(0, 3)
    let chosen = [...core, ...hits].slice(0, config.recallTopK + 3)
    if (state.disclosure?.failed) {
      // Gate crashed: keep only shared memories, never peer-specific ones.
      chosen = chosen.filter((hit) => !hit.memory.peerId)
    } else if (state.disclosure?.gatedIds) {
      chosen = chosen.filter((hit) => !state.disclosure.gatedIds.has(hit.memory.id) || state.disclosure.allowedIds.has(hit.memory.id))
    }

    let used = estimateTokens(lines.join('\n'))
    // 记忆单独给预算：时刻/态度/对象/原则/承诺这些固定块不再挤占记忆额度。
    const memoryBudget = Math.max(260, Math.round(budget * 0.6))
    let memoryUsed = 0
    const fresh = chosen.filter((hit) => !isFutureDated(hit.memory, now.getTime()))
    const annotated = annotateAll(fresh.map((hit) => hit.memory), { now: now.getTime(), timeZone: config.timeZone })
    // 跨对话来的记忆要标上「是谁说的」。拿不到名字就标「别处」，含糊也好过张冠李戴。
    const memPeerNames = {}
    if (crossFrom.size) {
      try {
        for (const peer of this.whale.social?.listPeers?.({ status: 'active' }) || []) {
          memPeerNames[peer.id] = peer.learned_name || peer.display_name || ''
        }
      } catch (err) {
        // 名字取不到不影响标注，退回「别处」
      }
    }
    for (const memory of annotated) {
      const when = memory.when ? `${memory.when}：` : ''
      const owner = crossFrom.get(memory.id)
      const from = owner ? `[${memPeerNames[owner] || '别处'}那边]` : ''
      const text = `- [${LAYER_LABEL[memory.layer] || memory.layer}] ${when}${from}${truncate(memory.content, 110)}`
      const cost = estimateTokens(text)
      if (memoryUsed + cost > memoryBudget) break
      lines.push(text)
      used += cost
      memoryUsed += cost
    }
    const wm = this.store.kvGet(`wm:${agent.id}`, '')
    if (wm) {
      const text = `【手头】${truncate(wm, 160)}`
      if (used + estimateTokens(text) <= budget) lines.push(text)
    }
    if (state.bookHint) {
      const hint = state.bookHint.needConfirm ? '对方发来一段像书稿的文字，还不确定是不是书。' : '对方发来一段像书稿的文字。'
      const text = `【刚收到】${hint}如果你想读，可以用 whale_read 记下来。`
      if (used + estimateTokens(text) <= budget) lines.push(text)
    }
    const block = lines.join('\n')
    state.blockKey = key
    state.blockText = block
    if (chosen.length) {
      this.store.recallBoost(chosen.map((hit) => hit.memory.id).filter((id, i, all) => all.indexOf(id) === i))
    }
    return block
  }

  noteDayChange(state) {
    if (!this.config.temporal?.dayChangeEvent) return
    try {
      const today = zonedParts(this.config.timeZone).date
      const last = this.store.kvGet('temporal:lastDay', null)
      if (last && last !== today) {
        this.store.addEpisode({
          sessionId: state?.sessionId || '',
          channel: state?.channel || '',
          role: 'system',
          text: `temporal/day-changed ${last} -> ${today}`,
          peerId: null,
        })
      }
      this.store.kvSet('temporal:lastDay', today)
    } catch {
      /* day boundary bookkeeping must never break a message */
    }
  }

  /** Called by every `session/event`. */
  onSessionEvent(session, event) {
    const state = this.states.get(session.id)
    const wired = Boolean(state) && this.disposers.has(session.id)
    const isChannel = Boolean(state?.channel)
    if (!wired && !isChannel) {
      // Still archive raw chat from her own sessions only; other sessions stay untouched.
      return
    }
    try {
      if (event.type === 'user/message') {
        const text = blocksText(event.data?.content)
        if (!text || isHarnessText(text)) return
        if (state) {
          state.lastUserText = text
          state.lastUserSeq = event.seq
          state.disclosure = null
          state.disclosureKey = null
          state.blockKey = ''
          state.blockText = ''
          const detected = looksLikeBook(text)
          state.bookHint = detected.isBook || detected.needConfirm ? detected : null
        }
        this.noteDayChange(state)
        const emotion = tagEmotion(text)
        if (state && !state.peerId) this.whale.ensureDefaultPeer?.(session.id)
        const peerId = state?.peerId || null
        const skipUserEpisode = state?.skipUserEpisode === true
        if (state) state.skipUserEpisode = false
        if (!skipUserEpisode) {
          this.store.addEpisode({
            sessionId: session.id,
            channel: state?.channel || '',
            role: 'user',
            text,
            emotion: emotion.label,
            peerId,
            speakerId: state?.speakerId || '',
          })
        }
        // 两套都更新：growth 记事件溯源（cause 只存抽象标签，不拼对方原文），
        // updateMood 维护 label / arousal / dominance。以前 else 分支让三维永久冻结。
        if (this.whale.growth?.mood) {
          this.whale.growth.mood.applyEvent({
            kind: 'conversation', cause: moodCause(emotion),
            delta: (emotion.valence || 0) * 0.15,
            peerId, evidenceId: session.id, text,
          })
        }
        updateMood(this.store, emotion, moodCause(emotion))
        bumpDrives(this.store, { social: 6, cognitive: 2 })
      } else if (event.type === 'assistant/message') {
        const text = blocksText(event.data?.message?.content)
        if (text && !isHarnessText(text)) {
          this.store.addEpisode({
            sessionId: session.id,
            channel: state?.channel || '',
            role: 'assistant',
            text,
            emotion: getMood(this.store).label,
            peerId: state?.peerId || null,
          })
          for (const listener of this.replyListeners) {
            try {
              listener(session.id, text)
            } catch {
              /* listener failures must not break the log feed */
            }
          }
        }
        this.recordUsage(event.data?.usage)
      } else if (event.type === 'turn/end') {
        for (const listener of this.turnListeners) {
          try {
            listener(session.id, event.data)
          } catch {
            /* ignore */
          }
        }
        bumpDrives(this.store, { social: 2 })
        this.scheduleDigest(session.id)
      } else if (event.type === 'compaction/summary') {
        void this.onCompactionSummary(session, event)
      } else if (event.type === 'compaction/end' && event.data?.error) {
        this.store.health('compaction', { ok: false, error: String(event.data.error), at: Date.now(), sessionId: session.id })
        this.whale.logger.warn?.(`whale-chan: 压缩失败 ${event.data.error}`)
      }
    } catch (error) {
      this.whale.logger.warn?.('whale-chan: session event failed', error)
    }
  }

  recordUsage(usage) {
    if (!usage) return
    const date = localDateKey(this.config.timeZone)
    const key = `usage:${date}`
    const current = this.store.kvGet(key, { input: 0, output: 0 })
    this.store.kvSet(key, {
      input: current.input + (usage.inputTokens || 0),
      output: current.output + (usage.outputTokens || 0),
    })
  }

  scheduleDigest(sessionId) {
    const state = this.states.get(sessionId)
    if (!state) return
    if (state.digestTimer) clearTimeout(state.digestTimer)
    state.digestTimer = setTimeout(() => {
      state.digestTimer = null
      void this.runDigest(sessionId)
    }, 30_000)
    state.digestTimer.unref?.()
  }

  async runDigest(sessionId) {
    const state = this.states.get(sessionId)
    if (!state || state.digestRunning) return
    state.digestRunning = true
    try {
      const peerId = state.peerId || this.whale.defaultPeerId?.() || null
      const partner = this.whale.social?.peerLabel(peerId, '对方') || '对方'
      const scope = `session:${sessionId}`
      const cursor = this.whale.social?.getDigestCursor?.(scope)
      const window = this.store
        .listEpisodes({ sessionId, limit: 200, peerId: peerId || undefined })
        .filter((episode) => !isHarnessText(episode.text))
      const { episodes, nextCursor } = nextDigestCursor(cursor?.last_episode_id || null, window)
      if (episodes.filter((episode) => episode.role === 'user').length < 2) return
      const transcript = episodes.map((e) => `${e.role === 'user' ? partner : this.config.name}: ${e.text}`).join('\n')
      const episodeIds = episodes.map((e) => e.id)
      const ledger = await this.whale.digest.extract(transcript)
      const written = this.ingestLedger(ledger, { episodeIds, sessionId, peerId, speakerId: state.speakerId || '' })
      const reflection = await this.whale.digest.reflect(transcript, this.config.name, partner)
      if (reflection.mood) {
        const delta = reflection.mood === 'sad' ? -0.3 : reflection.mood === 'joy' ? 0.3 : 0
        if (this.whale.growth?.mood) {
          this.whale.growth.mood.applyEvent({ kind: 'self_reflection', cause: 'digest', delta, peerId, evidenceId: sessionId })
        } else {
          updateMood(this.store, { label: reflection.mood, valence: delta, arousal: 0.4, intensity: 0.4 })
        }
      }
      if (reflection.lesson) {
        this.addMemory({ layer: 'lesson', content: reflection.lesson, importance: 6, trust: 0.6, sourceEpisodeIds: episodeIds, sessionId, peerId })
      }
      if (reflection.soul) {
        this.addMemory({ layer: 'soul', content: reflection.soul, importance: 7, trust: 0.55, sourceEpisodeIds: episodeIds, sessionId, peerId })
      }
      if (reflection.workingMemory) this.store.kvSet(`wm:${sessionId}`, reflection.workingMemory)
      if (peerId && reflection.summary) {
        // STEP 8 / F5: relation summary 只写 narratives；peer 行是读取投影。
        this.whale.social?.updatePeer(peerId, { last_seen: Date.now() })
        this.whale.social?.upsertNarrative(peerId, reflection.summary)
        this.whale.social?.closeOpenChapters?.(peerId)
        this.whale.social?.appendChapter({ peerId, kind: 'shared_event', summary: reflection.summary, sourceEpisodeIds: episodeIds, status: 'open' })
      }
      if (nextCursor) this.whale.social?.setDigestCursor?.(scope, nextCursor)
      this.store.health('digest', { ok: true, sessionId, peerId, written, at: Date.now() })
    } catch (error) {
      this.store.health('digest', { ok: false, sessionId, error: String(error?.message || error), at: Date.now() })
    } finally {
      state.digestRunning = false
    }
  }

  /** Map one extraction result into the seven layers, deduplicating near-copies. */
  ingestLedger(ledger, { episodeIds = [], sessionId = '', peerId = null, speakerId = '' } = {}) {
    let written = 0
    const partner = this.whale.social?.peerLabel(peerId, '对方') || '对方'
    const add = (layer, content, { importance = 5, confidence = 0.6, kind = 'extract' } = {}) => {
      if (!content?.trim()) return
      if (written >= 14) return
      const existing = this.store.search(content, { layers: [layer], limit: 5, peerId })
      const tokens = new Set(tokenizeSearch(content))
      for (const hit of existing) {
        const other = new Set(tokenizeSearch(hit.memory.content))
        let shared = 0
        for (const token of tokens) if (other.has(token)) shared++
        const jaccard = tokens.size && other.size ? shared / Math.sqrt(tokens.size * other.size) : 0
        if (trigramSimilarity(hit.memory.content, content) > 0.72 || jaccard > 0.6) {
          this.store.recallBoost([hit.memory.id])
          return
        }
      }
      // STEP 8 / P2: 同一事实被抽到另一层时只保留已有条目，避免七层互相复读。
      const crossLayer = this.store.search(content, { limit: 5, peerId })
      for (const hit of crossLayer) {
        if (hit.memory.layer === layer) continue
        if (isCrossLayerDuplicate({ layer, content }, { layer: hit.memory.layer, content: hit.memory.content })) {
          this.store.recallBoost([hit.memory.id])
          return
        }
      }
      const created = this.addMemory({
        layer,
        content: content.trim(),
        importance,
        trust: 0.5 + confidence * 0.4,
        sourceEpisodeIds: episodeIds,
        peerId,
        meta: { kind, sessionId, peerId, speakerId },
      })
      try { this.store.linkSimilar?.(created.id, { limit: 3 }) } catch { /* linking must not block extraction */ }
      written++
    }

    for (const fact of ledger.facts || []) {
      // With a peer, a fact from that conversation belongs to that peer's
      // profile; without one it stays a global fact. No称呼-based rule.
      const layer = peerId ? 'user' : 'fact'
      add(layer, fact.fact, { importance: 4 + Math.round((fact.confidence || 0.6) * 4), confidence: fact.confidence, kind: 'fact' })
    }
    for (const pref of ledger.preferences || []) {
      const layer = LAYER_OF_PREFERENCE[pref.category] || 'user'
      const prefix = pref.category === '雷区' ? `${partner}不喜欢` : `${partner}喜欢`
      add(layer, `${prefix}${pref.value}`, { importance: 5 + Math.round((pref.strength || 0.6) * 3), confidence: pref.strength, kind: 'preference' })
    }
    for (const entity of ledger.entities || []) {
      add('topic', `${entity.type || '实体'}：${entity.name}${entity.attributes ? `（${entity.attributes}）` : ''}`, { importance: 4, confidence: 0.6, kind: 'entity' })
    }
    for (const relation of ledger.relations || []) {
      add('topic', `${relation.subject} ${relation.predicate} ${relation.object}`, { importance: 4, confidence: 0.6, kind: 'relation' })
    }
    for (const commitment of ledger.commitments || []) {
      const toWhom = !commitment.to_whom || commitment.to_whom === '对方'
        ? partner
        : commitment.to_whom
      const record = this.whale.social?.recordCommitment({
        peerId,
        toWhom,
        content: commitment.what,
        promisedAt: Date.now(),
        sourceEpisode: episodeIds[0] || '',
        meta: { due: commitment.due || '', sessionId },
      })
      add('project', record ? `承诺记录：${record.id}（对${toWhom}，正文见承诺事实）` : `对${toWhom}有一个承诺（正文见承诺事实）`, { importance: 5, confidence: 0.7, kind: 'commitment' })
      this.store.upsertLedgerEntry({
        kind: 'commitment',
        subject: toWhom,
        field: 'due',
        value: record ? record.id : 'commitment',
        confidence: 0.7,
        sourceEpisodeIds: episodeIds,
        peer_id: peerId,
      })
    }
    for (const loop of ledger.openLoops || []) {
      add('project', `还没完成：${loop.what}`, { importance: 5, confidence: 0.6, kind: 'open_loop' })
    }
    for (const lesson of ledger.lessons || []) {
      add('lesson', lesson.what, { importance: 5, confidence: 0.6, kind: 'lesson' })
    }
    for (const fact of ledger.facts || []) {
      this.store.upsertLedgerEntry({
        kind: 'fact',
        subject: fact.fact.slice(0, 24),
        field: 'fact',
        value: fact.fact,
        confidence: fact.confidence || 0.7,
        sourceEpisodeIds: episodeIds,
        peer_id: peerId,
        expiresPrevious: false,
      })
    }
    return written
  }

  addMemory({ layer, content, importance = 5, trust = 0.6, sourceEpisodeIds = [], links = [], emotion = '', meta = {}, sessionId = '', peerId = null }) {
    const keywords = this.whale.keywordsFor(content)
    const mood = getMood(this.store)
    // Emotion modulates how strongly the moment is written (amygdala-style weighting).
    const weighted = Math.max(1, Math.min(10, importance * (1 + 0.18 * Math.abs(mood.valence || 0) + 0.08 * (mood.arousal || 0))))
    return this.store.insert({
      layer,
      content,
      keywords,
      importance: weighted,
      trust,
      sourceEpisodeIds,
      links,
      emotion: emotion || mood.label,
      peerId,
      meta: { ...meta, sessionId, peerId },
    })
  }

  compactionMustKeep(text, { peerId, sessionId } = {}) {
    const commitments = (this.whale.social.listCommitments(peerId) || []).map((c) => ({ id: c.id }))
    const openItems = [
      ...(this.whale.social.listChapters(peerId, 200) || []).filter((c) => c.status === 'open').map((c) => ({ id: c.id })),
      ...(this.whale.social.listPendingAsks({ targetPeer: peerId }) || []).map((a) => ({ id: `ask_${a.id}` })),
    ]
    const before = { decisions: [], commitments, openItems }
    const after = {
      decisions: [...String(text).matchAll(/\bdec_[A-Za-z0-9_-]+/g)].map((m) => m[0]),
      commitments: [...String(text).matchAll(/\bcmt_[A-Za-z0-9_-]+/g)].map((m) => m[0]),
      openItems: [...String(text).matchAll(/\b(?:chap|ask)_[A-Za-z0-9_-]+/g)].map((m) => m[0]),
    }
    const result = verifySummary(before, after)
    if (!result.ok) {
      this.store.health('compaction_must_keep_failed', {
        ok: false, sessionId, peerId, at: Date.now(),
        missingCommitments: result.missingCommitments,
        missingOpenItems: result.missingOpenItems,
      })
    }
    return result
  }

  async onCompactionSummary(session, event) {
    try {
      const text = blocksText(event.data?.summary)
      if (!text) return
      const state = this.states.get(session.id)
      const peerId = state?.peerId || this.whale.defaultPeerId?.() || null
      const guard = this.compactionMustKeep(text, { peerId, sessionId: session.id })
      if (!guard.ok) {
        this.store.health('compaction', { ok: false, reason: 'must_keep_missing', sessionId: session.id, peerId, at: Date.now() })
        return
      }
      const episodeIds = []
      const ledger = await this.whale.digest.extract(text)
      const written = this.ingestLedger(ledger, { episodeIds, sessionId: session.id, peerId, speakerId: state?.speakerId || '' })
      this.store.kvSet(`wm:${session.id}`, truncate(text.replace(/\s+/g, ' '), 300))
      this.store.health('compaction', { ok: true, sessionId: session.id, peerId, written, at: Date.now() })
    } catch (error) {
      this.store.health('compaction', { ok: false, sessionId: session.id, error: String(error?.message || error), at: Date.now() })
    }
  }

  onReply(listener) {
    this.replyListeners.add(listener)
    return () => this.replyListeners.delete(listener)
  }

  onTurnEnd(listener) {
    this.turnListeners.add(listener)
    return () => this.turnListeners.delete(listener)
  }
}
