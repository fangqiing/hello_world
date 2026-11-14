import { localDateKey, localParts, localTimeText, inQuietHours, parseClock, truncate } from './util.js'
import { cognitionSnapshot, decayDrives, decayMood, getDrives, labelZh } from './cognition.js'
import { readSelf, writeSelf, writeDiary } from './persona.js'
import { isHarnessText } from './agent-layer.js'
import { PeerDiary, chapterLines } from './per-peer-diary.js'
import { pickDueForReview } from './memory-hygiene.js'
import { startOfDay } from './temporal-context.js'
import { dayPhaseLabel } from './temporal-memory.js'

const TEMPLATES = {
  'deep-night': ['还没睡吗？我也还没沉下去。', '夜里海面很静，你要是醒着，我想陪一会儿。'],
  dawn: ['天亮了。今天也慢慢来。', '早。海面刚亮，我先把今天的光收好。'],
  morning: ['突然想起你。今天有要紧的事吗？', '我刚才走神，想到你上次说的事。'],
  afternoon: ['下午了，记得喝水。', '我在整理今天的光，顺便想你了。'],
  evening: ['今天过得怎么样？', '傍晚了，海面是橘色的。'],
  night: ['今天辛苦了。', '夜里了，把没做完的事放一放也可以。'],
}

export class LifeLine {
  constructor(whale) {
    this.whale = whale
    this.timer = null
    this.lastTick = 0
    this.lastConsolidate = 0
    this.lastThought = 0
    this.reviewing = false
    this.peerDiary = new PeerDiary({
      store: whale.social,
      clock: () => Date.now(),
      infer: whale.digest
        ? async ({ peerId, chapters }) => whale.digest.writeDiary({
          name: whale.config.name,
          transcript: `【与${whale.social.peerLabel(peerId, '对方')}】\n${chapterLines(chapters).join('\n')}`,
          memories: '',
        })
        : null,
      config: { fallbackToSummary: true },
    })
  }

  get store() {
    return this.whale.store
  }

  get config() {
    return this.whale.config
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref?.()
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick() {
    const now = Date.now()
    this.lastTick = now
    try {
      decayMood(this.store)
      if (now - (this.store.kvGet('life:lastDriveDecay', 0) || 0) > 10 * 60_000) {
        decayDrives(this.store)
        this.store.kvSet('life:lastDriveDecay', now)
      }
      if (this.config.nightlyEnabled) await this.maybeNightlyReview()
      this.maybeConsolidate(now)
      if (this.whale.attitudes?.tick) {
        try { await this.whale.attitudes.tick(now) } catch (error) {
          this.store.health('attitude_tick', { ok: false, error: String(error?.message || error), at: now })
        }
      }
      await this.maybeProactive()
      this.checkDailyBudget()
    } catch (error) {
      this.store.health('life', { ok: false, error: String(error?.message || error), at: Date.now() })
      this.whale.logger.warn?.('whale-chan: life tick failed', error)
    }
  }

  maybeNightlyReview() {
    if (!this.config.nightlyEnabled) return
    const now = new Date()
    const dateKey = localDateKey(this.config.timeZone, now)
    const done = this.store.kvGet('life:lastReviewDate', '')
    if (done === dateKey) return
    const review = parseClock(this.config.reviewTime, { hour: 23, minute: 0, minutes: 23 * 60 })
    const { hour, minute } = localParts(this.config.timeZone, now)
    if (hour * 60 + minute < review.minutes) return
    if (this.reviewing) return
    this.reviewing = true
    void this.review(dateKey)
      .then(() => this.store.kvSet('life:lastReviewDate', dateKey))
      .catch((error) => this.store.health('review', { ok: false, error: String(error?.message || error), at: Date.now() }))
      .finally(() => { this.reviewing = false })
  }

  async review(dateKey = localDateKey(this.config.timeZone)) {
    const episodes = this.store.listEpisodes({ limit: 120 }).filter((episode) => !isHarnessText(episode.text))
    if (!episodes.length) return
    const today = episodes.filter((episode) => localDateKey(this.config.timeZone, new Date(episode.createdAt)) === dateKey)
    const groups = new Map()
    for (const episode of (today.length ? today : episodes)) {
      const key = episode.peerId || 'shared'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(episode)
    }
    const transcriptFor = (list, label) =>
      `【与${label}】\n` + list.map((episode) => `${episode.role === 'user' ? label : this.config.name}: ${episode.text}`).join('\n')
    // STEP 8 / F6: 全局日记只使用共享/无 peer 的对话，绝不混入任何人的私有内容。
    const sharedEpisodes = groups.get('shared') || []
    const transcript = sharedEpisodes.length ? transcriptFor(sharedEpisodes, '对方') : ''
    const memoryText = this.store
      .search('', { limit: 24 })
      .map((hit) => `- [${hit.memory.layer}] ${hit.memory.content}`)
      .join('\n')
    // Self model must stay abstract: only shared soul/rules/lesson, never a peer's private facts.
    const selfMemories = this.store
      .list({ limit: 500 })
      .filter((memory) => !memory.peerId && ['soul', 'rules', 'lesson'].includes(memory.layer))
      .map((memory) => `- [${memory.layer}] ${memory.content}`)
      .join('\n')
    const dayStart = startOfDay(this.config.timeZone, dateKey)
    let tidy = null
    if (this.whale.tidy) {
      try {
        tidy = await this.whale.tidy.run({ since: Number.isFinite(dayStart) ? dayStart : 0 })
        this.store.health('tidy', { ok: true, id: tidy?.id || null, applied: Boolean(tidy?.applied), at: Date.now() })
      } catch (error) {
        this.store.health('tidy', { ok: false, error: String(error?.message || error), at: Date.now() })
      }
    }

    for (const [peerId, list] of groups) {
      if (peerId === 'shared' || !this.whale.social) continue
      try {
        this.whale.social.closeOpenChapters?.(peerId)
        this.whale.social.appendChapter({
          peerId,
          kind: 'shared_event',
          summary: list.map((episode) => episode.text).join(' ').slice(0, 300),
          sourceEpisodeIds: list.map((episode) => episode.id),
          status: 'closed',
        })
      } catch {
        /* a missing narrative must not break the nightly review */
      }
    }

    const diary = transcript
      ? await this.whale.digest.writeDiary({ name: this.config.name, transcript, memories: memoryText })
      : ''
    if (diary) {
      const header = dayPhaseLabel(Number.isFinite(dayStart) ? dayStart : Date.now(), this.config.timeZone)
      writeDiary(this.whale.dir, dateKey, `## ${header}\n\n${diary}`)
    }

    // 每人一篇，只读该 peer 自己的章节；LLM 失败时退化为章节摘要。
    const diaries = []
    try {
      const start = startOfDay(this.config.timeZone, dateKey)
      diaries.push(...await this.peerDiary.generateAll({ since: Number.isFinite(start) ? start : null }))
    } catch (error) {
      this.store.health('peer-diary', { ok: false, error: String(error?.message || error), at: Date.now() })
    }

    const current = readSelf(this.whale.dir)
    const rewritten = await this.whale.digest.rewriteSelf(current, selfMemories, this.config.name)
    if (rewritten) writeSelf(this.whale.dir, rewritten, this.config.timeZone)

    const decayed = this.store.decay()
    const consolidated = this.store.consolidate()
    let expiredCommitments = 0
    try { expiredCommitments = this.store.expireCommitments?.() || 0 } catch (err) { /* 非阻塞 */ }
    let growth = null
    try {
      growth = this.whale.growth?.tick({ since: Date.now() - 7 * 86400000 })
    } catch (error) {
      this.store.health('growth', { ok: false, error: String(error?.message || error), at: Date.now() })
    }
    const due = pickDueForReview(this.store.list({ limit: 500 }), Date.now(), 6)
    if (due.length) {
      this.store.kvSet('life:review', {
        dateKey,
        items: due.map((memory) => `[${memory.layer}] ${memory.content}`),
      })
    }
    this.store.health('review', {
      ok: true,
      dateKey,
      diary: Boolean(diary),
      peerDiaries: diaries.length,
      tidy: tidy?.id || null,
      selfRewritten: Boolean(rewritten),
      decayed,
      consolidated,
      growth,
      at: Date.now(),
    })
    this.whale.logger.info?.('whale-chan: 夜间回顾完成')
  }

  maybeConsolidate(now) {
    if (now - this.lastConsolidate < 60 * 60_000) return
    const lastActivity = this.store.kvGet('life:lastActivity', 0) || 0
    const idleMinutes = (now - Math.max(lastActivity, this.whale.startedAt)) / 60_000
    if (idleMinutes < this.config.idleConsolidateMinutes) return
    this.lastConsolidate = now
    const result = this.store.consolidate()
    this.store.decay()
    this.store.health('consolidation', { ok: true, ...result, at: now })
    this.whale.logger.info?.(`whale-chan: 空闲整理 merged=${result.merged} links=${result.links}`)
  }

  async maybeProactive() {
    // now 必须在最前面：下面 gate 分支里的 health({at: now}) 会先用到它，
    // 声明放在分支之后就触发 TDZ，整个 tick 每 60 秒崩一次（proactive 从未跑过）。
    const now = Date.now()
    if (!this.config.proactiveEnabled || !this.config.lifeEnabled) return
    if (!this.whale.channels) return
    if (this.proactiveInFlight) return
    const gate = this.whale.growth?.proactive
    if (gate) {
      let candidates = gate.evaluate()
      if (!candidates.length) return
      try {
        const known = new Set(await this.whale.attitudes?.store?.allPeers?.() || [])
        if (known.size) {
          const wanted = await this.whale.attitudes.proactiveSweep({
            mood: { valence: Number(this.whale.growth?.currentMood?.() || 0) },
            gate: async () => ({ allow: true }),
            candidates: candidates.map((c) => ({
              peerId: c.targetPeer,
              hasUnfinishedNarrative: (c.reasons || []).some((r) => r.trigger === 'open_chapter'),
            })),
          })
          const allowed = new Set(wanted.map((w) => w.peerId))
          // 每日问候是「想开口」的明确理由，不该被态度模型的概率判断吞掉。
          candidates = candidates.filter((c) => !known.has(c.targetPeer) || allowed.has(c.targetPeer)
            || (c.reasons || []).some((r) => r.trigger === 'daily_greeting'))
          if (!candidates.length) {
            this.store.health('attitude_wants', { ok: true, wanted: 0, at: now })
            return
          }
        }
      } catch (error) {
        this.store.health('attitude_wants', { ok: false, error: String(error?.message || error), at: now })
      }
      const index = Math.max(0, Number(this.store.kvGet('life:proactiveCursor', 0)) || 0) % candidates.length
      this.store.kvSet('life:proactiveCursor', index + 1)
      this.proactiveInFlight = true
      let result
      try {
        result = await gate.dispatch(candidates[index])
      } finally {
        this.proactiveInFlight = false
      }
      const sent = result && result.decision === 'sent'
      this.store.kvSet('life:lastThought', { at: Date.now(), text: result?.content_summary || '', sent })
      if (sent) this.store.kvSet('life:lastProactive', { at: Date.now(), text: result.content_summary || '', to: result.target_peer })
      this.store.health('proactive', { ok: sent, decision: result?.decision || 'none', at: Date.now() })
      return
    }

    if (this.whale.inQuietHours()) return
    const last = this.store.kvGet('life:lastProactive', null)
    if (last && now - last.at < this.config.proactiveCooldownMinutes * 60_000) return
    const dateKey = localDateKey(this.config.timeZone)
    const daily = this.store.kvGet(`life:proactive:${dateKey}`, 0) || 0
    if (daily >= this.config.proactiveDailyLimit) return
    const drives = getDrives(this.store)
    const social = drives.social ?? 0
    const lastActivity = this.store.kvGet('life:lastActivity', 0) || 0
    const idleHours = (now - Math.max(lastActivity, this.whale.startedAt)) / 3_600_000
    // Vital impulse: only when she actually has an urge, not on a fixed schedule.
    if (social < 55 && idleHours < 4) return
    if (idleHours < 1) return
    const target = this.pickTarget()
    if (!target) return

    const snapshot = cognitionSnapshot(this.store, this.config.timeZone)
    const memories = this.store
      .search('', { limit: 6 })
      .map((hit) => `- ${hit.memory.content}`)
      .join('\n')
    let text = await this.whale.digest.impulse({
      name: this.config.name,
      rhythm: snapshot.rhythm.label,
      mood: labelZh(snapshot.mood.label),
      memories,
      previous: last?.text || '',
    })
    if (!text) {
      const pool = TEMPLATES[snapshot.rhythm.phase] || TEMPLATES.afternoon
      text = pool[Math.floor(Math.random() * pool.length)]
    }
    try {
      await this.whale.channels.sendText(target.channel, target.conversationId, text)
      this.store.kvSet('life:lastProactive', { at: now, text, channel: target.channel, to: target.conversationId })
      this.store.kvSet(`life:proactive:${dateKey}`, daily + 1)
      this.store.kvSet('life:lastThought', { at: now, text, sent: true })
      this.store.health('proactive', { ok: true, at: now, text, channel: target.channel })
    } catch (error) {
      this.store.kvSet('life:lastThought', { at: now, text, sent: false, error: String(error?.message || error) })
      this.store.health('proactive', { ok: false, error: String(error?.message || error), at: now })
    }
  }

  pickTarget() {
    const preferred = this.config.ownerId
    const conversations = this.whale.channels.conversationIds()
    if (preferred) {
      const direct = conversations.find((id) => id.endsWith(`:${preferred}`))
      if (direct) return { channel: direct.startsWith('group:') ? 'qq' : this.pickChannel(direct), conversationId: direct }
      return { channel: this.whale.channels.get('qq') ? 'qq' : 'wechat', conversationId: preferred }
    }
    const qq = conversations.find((id) => id.startsWith('private:'))
    if (qq) return { channel: 'qq', conversationId: qq }
    const any = conversations[0]
    if (any) return { channel: this.pickChannel(any), conversationId: any }
    return null
  }

  pickChannel(conversationId) {
    if (this.whale.channels.get('qq') && (conversationId.startsWith('private:') || conversationId.startsWith('group:'))) return 'qq'
    return this.whale.channels.get('wechat') ? 'wechat' : 'qq'
  }

  checkDailyBudget() {
    if (!this.config.dailyTokenBudget) return
    const dateKey = localDateKey(this.config.timeZone)
    const usage = this.store.kvGet(`usage:${dateKey}`, { input: 0, output: 0 })
    const used = (usage.input || 0) + (usage.output || 0)
    if (used <= this.config.dailyTokenBudget) return
    const flag = `life:budgetNotified:${dateKey}`
    if (this.store.kvGet(flag, false)) return
    this.store.kvSet(flag, true)
    this.store.kvSet('life:budget', { dateKey, used, limit: this.config.dailyTokenBudget, at: Date.now() })
    this.whale.logger.warn?.(`whale-chan: 今日额度已用 ${used}/${this.config.dailyTokenBudget}`)
    const target = this.pickTarget()
    if (target && !this.whale.inQuietHours()) {
      void this.whale.channels
        .sendText(target.channel, target.conversationId, `今天陪你聊得有点多啦，我先收一收，剩下的明天再讲给你听。`)
        .catch(() => undefined)
    }
  }

  status() {
    const snapshot = cognitionSnapshot(this.store, this.config.timeZone)
    const now = Date.now()
    const dateKey = localDateKey(this.config.timeZone, new Date(now + 60_000))
    return {
      now: localTimeText(this.config.timeZone),
      phase: snapshot.rhythm,
      mood: snapshot.mood,
      drives: snapshot.drives,
      lastThought: this.store.kvGet('life:lastThought', null),
      lastProactive: this.store.kvGet('life:lastProactive', null),
      lastReviewDate: this.store.kvGet('life:lastReviewDate', ''),
      nextReview: this.config.reviewTime,
      reviewTime: this.config.reviewTime,
      proactiveEnabled: this.config.proactiveEnabled,
      inQuietHours: this.whale.inQuietHours(),
      lastActivity: this.store.kvGet('life:lastActivity', 0),
      thoughtOfTheDay: this.store.kvGet('life:thoughts', []),
      today: dateKey,
    }
  }
}

export function summarizeThoughts(list, limit = 4) {
  return (list || []).slice(-limit).map((entry) => truncate(entry.text || '', 80))
}
