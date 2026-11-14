import {
  DEFAULTS,
  EVENT,
  MODE,
  checkTimeout,
  initialState,
  reduce,
  tickAgent,
} from './mode-machine.js'
import { detectIntent, shouldAsk, explicitMode } from './agent-intent.js'
import {
  confirmPhrase,
  donePhrase,
  enterPhrase,
  exitPhrase,
  parseAnswer,
  timeoutPhrase,
} from './mode-confirm.js'

const KV_KEY = 'chat-modes'
const RESET_RE = /^(算了|先这样|停下|停一下|停|不用了|不弄了|结束|退出|取消)[。！!~～\s]*$/
const MORE_RE = /(还有|继续|再来|另外一个|顺便|接着)/

/**
 * Per-conversation chat/agent mode, persisted in kv so a host restart does not
 * silently drop an active task. The state machine itself is pure; this class
 * only owns storage, audit, phrase selection, and the inbound/outbound timing.
 */
export class ChatModes {
  constructor({ store, registry, config, audit, logger, clock, cfg } = {}) {
    this.store = store
    this.registry = registry
    this.config = config || {}
    this.auditSink = audit || (() => {})
    this.logger = logger
    this.clock = clock || (() => Date.now())
    this.cfg = { ...DEFAULTS, ...(cfg || {}) }
    this.all = store?.kvGet?.(KV_KEY, {}) || {}
    if (!this.all || typeof this.all !== 'object' || Array.isArray(this.all)) this.all = {}
  }

  stateFor(conversationId) {
    const id = String(conversationId || '')
    let state = this.all[id]
    if (!state || typeof state !== 'object') {
      state = initialState(id, this.clock())
      this.all[id] = state
    }
    return state
  }

  save() {
    try {
      this.store?.kvSet?.(KV_KEY, this.all)
    } catch (error) {
      this.logger?.warn?.('whale-chan: chat mode persist failed', error)
    }
  }

  authorize({ peerId, senderId, peerKind } = {}) {
    const owner = String(this.config.ownerId || '')
    const raw = String(peerId || '')
    const sender = String(senderId || '')
    if (owner && (raw === owner || sender === owner)) return true
    try {
      return this.registry?.mayProactive?.(raw, peerKind === 'group' ? 'group' : 'direct') === true
    } catch {
      return false
    }
  }

  _context(conversationId, isGroup, authorized) {
    return {
      conversationId,
      isGroup: isGroup === true,
      authorized: authorized === true,
      agentToolsAvailable: true,
    }
  }

  _record(previous, next, event, ctx, actor, reason) {
    try {
      this.auditSink({
        at: this.clock(),
        action: 'mode',
        id: ctx.conversationId,
        kind: ctx.isGroup ? 'group' : 'direct',
        actor,
        reason: reason || event,
        conversationId: ctx.conversationId,
        meta: {
          from: previous.mode,
          to: next.mode,
          event,
          isGroup: ctx.isGroup,
          agentRounds: next.agentRounds || 0,
        },
      })
    } catch {
      /* audit must never block a message */
    }
  }

  _apply(conversationId, event, ctx, { actor = 'user', reason = '' } = {}) {
    const previous = this.stateFor(conversationId)
    const result = reduce(previous, event, ctx, this.clock())
    if (result.changed || result.action === 'blocked') {
      this.all[String(conversationId)] = result.state
      this._record(previous, result.state, event, ctx, actor, reason || result.reason)
      this.save()
    } else if (result.state !== previous) {
      this.all[String(conversationId)] = result.state
      this.save()
    }
    return result
  }

  /**
   * Gate one inbound message. Returns:
   *   {stop, reply?, taskText?, mode?}
   * `stop` means the message was consumed by the mode machine (question,
   * acknowledgement, reset); otherwise the caller forwards `taskText || text`.
   */
  advance({ conversationId, text, isGroup = false, authorized = false, senderId = '' } = {}) {
    const now = this.clock()
    // 每条消息进来先结算一次超时。tick() 原本没有任何调用者，
    // 于是 agent 模式只能靠人开口说「退出」才会结束 —— 忘了说就永久挂着。
    // 这里是最自然的结算点：有新消息，就说明时间已经过去了。
    try {
      this.tick()
    } catch (err) {
      this.logger?.warn?.('whale-chan: chat mode tick failed', err)
    }
    const state = this.stateFor(conversationId)
    state.lastActivityAt = now
    const ctx = this._context(conversationId, isGroup, authorized)
    const raw = String(text || '').trim()

    // RESET wins in every non-chat state, including agent work.
    if (state.mode !== MODE.CHAT && RESET_RE.test(raw)) {
      const result = this._apply(conversationId, EVENT.RESET, ctx, { reason: 'user_reset' })
      return { stop: true, reply: result.changed ? exitPhrase() : '', mode: result.state.mode, reset: result.changed }
    }

    // Group chats are locked to chat before intent detection.
    if (isGroup) {
      if (state.mode !== MODE.CHAT) {
        this._apply(conversationId, EVENT.RESET, ctx, { actor: 'system', reason: 'group_forbidden' })
      }
      return { stop: false, mode: MODE.CHAT }
    }

    // STEP 40 显式指令：「进入 agent 模式」本身就是确认，不再问第二遍。
    // 只有模糊倾向（detectIntent 判 high 但没说清）才走询问。
    const explicit = explicitMode(raw)
    if (explicit === 'exit' && state.mode !== MODE.CHAT) {
      const result = this._apply(conversationId, EVENT.RESET, ctx, { reason: 'explicit_exit' })
      return { stop: true, reply: result.changed ? exitPhrase() : '', mode: result.state.mode, reset: result.changed }
    }
    if (explicit === 'enter' && state.mode === MODE.CHAT) {
      const asked = this._apply(conversationId, EVENT.INTENT, ctx, { reason: 'explicit_enter' })
      if (asked.action === 'blocked') {
        // 进不去要说清楚为什么，否则她一声不吭，人以为没听见。
        const why = asked.reason === 'not_authorized'
          ? '这个号没给我开任务权限。'
          : asked.reason === 'no_agent_tools'
            ? '现在没有可用的工具，做不了。'
            : '群聊里切不了任务模式，私聊我。'
        return { stop: true, reply: why, mode: asked.state.mode, blocked: asked.reason }
      }
      const entered = this._apply(conversationId, EVENT.ACCEPT, ctx, { reason: 'explicit_enter_accept' })
      return { stop: false, mode: entered.state.mode, taskText: raw, entered: entered.action === 'enter_agent' }
    }

    if (state.mode === MODE.ASK_ENTER) {
      const answer = parseAnswer(raw)
      if (answer === 'yes') {
        const pending = state.pendingTask || raw
        const verb = state.verb || ''
        const result = this._apply(conversationId, EVENT.ACCEPT, ctx, { reason: 'user_accept' })
        if (result.changed) {
          return { stop: false, reply: enterPhrase({ verb }), taskText: pending, mode: result.state.mode }
        }
        return { stop: true, reply: '', mode: result.state.mode }
      }
      if (answer === 'no') {
        const result = this._apply(conversationId, EVENT.DECLINE, ctx, { reason: 'user_decline' })
        return { stop: true, reply: exitPhrase(), mode: result.state.mode }
      }
      state.unclear = Number(state.unclear || 0) + 1
      this.save()
      // A second unclear answer is a decline; do not keep interrogating her.
      if (state.unclear >= 2) {
        const result = this._apply(conversationId, EVENT.DECLINE, ctx, { reason: 'unclear_twice' })
        return { stop: true, reply: '', mode: result.state.mode }
      }
      return { stop: true, mode: state.mode }
    }

    if (state.mode === MODE.ASK_EXIT) {
      const answer = parseAnswer(raw)
      const more = MORE_RE.test(raw)
      if (more) {
        const result = this._apply(conversationId, EVENT.MORE, ctx, { reason: 'user_more' })
        return { stop: false, text: raw, mode: result.state.mode }
      }
      if (answer === 'no' || answer === 'yes') {
        // After "还有别的吗", "好/嗯" is an acknowledgement, not a request.
        const result = this._apply(conversationId, EVENT.DECLINE, ctx, { reason: 'user_finished' })
        return { stop: true, reply: exitPhrase(), mode: result.state.mode }
      }
      // A fresh request is not an exit; keep the agent alive and forward it.
      const result = this._apply(conversationId, EVENT.MORE, ctx, { reason: 'user_new_task' })
      return { stop: false, text: raw, mode: result.state.mode }
    }

    if (state.mode === MODE.AGENT) {
      const ticked = tickAgent(state, ctx, now, this.cfg)
      this.all[String(conversationId)] = ticked.state
      if (ticked.forced) {
        this._record(state, ticked.state, EVENT.TIMEOUT, ctx, 'system', 'round_limit')
        this.save()
        return { stop: true, reply: timeoutPhrase(MODE.AGENT), mode: MODE.CHAT, reset: true }
      }
      this.save()
      return { stop: false, mode: MODE.AGENT }
    }

    // chat
    const intent = detectIntent(raw, { isGroup: false, mode: MODE.CHAT })
    if (shouldAsk(intent, { isGroup: false, mode: MODE.CHAT, authorized })) {
      const result = this._apply(conversationId, EVENT.INTENT, ctx, { reason: `intent:${intent.score}` })
      if (result.changed) {
        const next = this.stateFor(conversationId)
        next.pendingTask = raw
        next.verb = intent.verb
        next.unclear = 0
        this.save()
        return { stop: true, reply: confirmPhrase(intent), mode: MODE.ASK_ENTER }
      }
    }
    return { stop: false, mode: MODE.CHAT }
  }

  /** Called after a completed agent turn; appends the one-line check-in. */
  complete(conversationId) {
    const state = this.stateFor(conversationId)
    if (state.mode !== MODE.AGENT) return ''
    const ctx = this._context(conversationId, false, true)
    const result = this._apply(conversationId, EVENT.TASK_DONE, ctx, { actor: 'system', reason: 'turn_end' })
    return result.changed ? donePhrase() : ''
  }

  /** Drop idle ask states and timed-out agent sessions. */
  tick() {
    const now = this.clock()
    const expired = []
    for (const [id, state] of Object.entries(this.all)) {
      const timeout = checkTimeout(state, now, this.cfg)
      if (!timeout.expired) continue
      const ctx = this._context(id, false, true)
      const result = this._apply(id, EVENT.TIMEOUT, ctx, { actor: 'system', reason: timeout.reason })
      if (result.changed) expired.push({ conversationId: id, from: timeout.mode, reason: timeout.reason })
    }
    return expired
  }

  reset(conversationId) {
    const state = this.stateFor(conversationId)
    if (state.mode === MODE.CHAT) return false
    const ctx = this._context(conversationId, false, true)
    const result = this._apply(conversationId, EVENT.RESET, ctx, { actor: 'user', reason: 'manual_reset' })
    return result.changed
  }
}
