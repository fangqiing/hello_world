import { PrincipleEngine } from './principle-engine.js'
import { MoodEngine } from './mood-engine.js'
import { DisclosureGate } from './disclosure-gate.js'
import { ProactiveGate } from './proactive-gate.js'
import { pickAssociative, buildAssociativeHint } from './associative.js'
import { todayWorld } from './inner-state.js'
import { LEXICON } from './cognition.js'

const MOOD_LEXICON = Object.fromEntries(LEXICON.map((entry) => [entry.label, entry.words]))

function principleAdapter(social) {
  return {
    get: (id) => social.getPrinciple(id),
    list: () => social.listPrinciples({ status: null, limit: 1000 }),
    insert: (row) => social.addPrinciple({
      statement: row.statement,
      source: row.source,
      sourceRef: row.source_ref || '',
      weight: row.weight,
      status: row.status || 'candidate',
      evidenceCount: row.evidence_count || 0,
      updatedAt: row.updated_at || row.learned_at,
      meta: row.meta || {},
    }),
    update: (id, patch) => social.updatePrinciple(id, patch),
    appendEvent: (row) => social.appendPrincipleEvent(row),
  }
}

function moodAdapter(store, social) {
  return {
    currentMood: () => Number(store.kvGet('cognition:mood', { valence: 0 })?.valence || 0),
    setCurrentMood: (value) => {
      const current = store.kvGet('cognition:mood', { label: 'neutral', valence: 0, arousal: 0.3 })
      store.kvSet('cognition:mood', { ...current, valence: Math.max(-1, Math.min(1, value)), updatedAt: Date.now() })
    },
    appendMoodEvent: (row) => social.appendMoodEvent(row),
    listMoodEvents: (options) => social.listMoodEvents(options),
  }
}

export class Growth {
  constructor({ store, social, config = {}, llm = null, sendProactive = null }) {
    this.store = store
    this.social = social
    this.config = config
    this.llm = llm
    // 主动消息的真实发送端，由 index.js 注入；没接就明确报错，不静默丢。
    this.sendProactive = sendProactive
    this.principle = new PrincipleEngine({
      store: principleAdapter(social),
      config: config.principle || {},
    })
    this.mood = new MoodEngine({
      store: moodAdapter(store, social),
      lexicon: MOOD_LEXICON,
      config: config.mood || {},
    })
    this.disclosure = new DisclosureGate({
      store: social,
      infer: async (context) => {
        if (llm && typeof llm.decideDisclosure === 'function') return llm.decideDisclosure(context)
        return { decision: 'withhold', reason: 'decision_unavailable', principle_ids: [], confidence: 0 }
      },
      enabled: config.disclosureEnabled !== false,
      relevance: config.relevance || {},
    })
    const quiet = (config.quietHours || []).map((value) => {
      const [h, m] = String(value).split(':').map((part) => Number(part))
      return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN
    }).filter(Number.isFinite)
    this.proactive = new ProactiveGate({
      associative: (peerId) => {
        try {
          const rows = store.listEpisodes({ peerId, limit: 200, includeArchived: true });
          const items = rows
            .filter((row) => row.text && String(row.text).trim().length >= 6)
            .map((row) => ({ id: row.id, text: row.text, at: Number(row.createdAt) || 0 }));
          return pickAssociative(items, { now: Date.now() });
        } catch (err) {
          return null;
        }
      },
      store: social,
      peers: { listActive: () => social.listPeers({ status: 'active' }) },
      narratives: social,
      mood: { current: () => Number(store.kvGet('cognition:mood', { valence: 0 })?.valence || 0) },
      sender: {
        send: async (peerId, text) => {
          if (typeof this.sendProactive !== 'function') {
            throw new Error('proactive sender is not wired (sendProactive missing)')
          }
          return this.sendProactive(peerId, text)
        },
      },
      checkDisclosure: async ({ currentPeerId, candidates }) => {
        const context = social.peerContext(currentPeerId)
        return this.disclosure.decide({
          currentPeerId,
          candidates,
          commitments: social.listCommitments(currentPeerId),
          principles: social.listPrinciples({ status: 'active', limit: 20 }),
          relationSummary: context.peer?.relation_summary || '',
          selfSummary: '',
          query: candidates.map((candidate) => candidate.text || '').join('\n'),
          isGroup: String(currentPeerId || '').includes(':group:'),
        })
      },
      infer: async (candidate, allowed = []) => {
        const peerId = candidate.targetPeer

        // 素材一：联想。associative 触发自带一对；别的触发也顺手看看有没有可联想的，
        // 否则只有那一种触发能说话，其余全靠空话。
        const assocReason = (candidate.reasons || []).find((r) => r.trigger === 'associative')
        let pair = assocReason && assocReason.pair
        if (!pair) {
          try {
            const rows = store.listEpisodes({ peerId, limit: 200, includeArchived: true })
            const items = rows
              .filter((row) => row.text && String(row.text).trim().length >= 6)
              .map((row) => ({ id: row.id, text: row.text, at: Number(row.createdAt) || 0 }))
            pair = pickAssociative(items, { now: Date.now() })
          } catch (err) {
            pair = null
          }
        }
        const hint = pair ? buildAssociativeHint(pair, { timeZone: config.timeZone }) : ''

        // 素材二：她的今天。有天气和做过的事，开口才有落点。
        let world = ''
        try {
          const w = todayWorld(store, { worldId: config.worldId || 'default', timeZone: config.timeZone })
          if (w) {
            world = [w.weather ? `外面${w.weather}` : '', w.activity ? `你今天${w.activity}` : '']
              .filter(Boolean).join('，')
          }
        } catch (err) {
          world = ''
        }

        // 素材三：没说完的事。
        let chapters = ''
        try {
          const open = typeof social.openChapters === 'function' ? social.openChapters() : []
          chapters = (open || []).slice(0, 2)
            .map((row) => String(row.summary || row.topic || '')).filter(Boolean).join('；')
        } catch (err) {
          chapters = ''
        }

        // 素材四：最近说过的，避免「同样的话换个说法又说一遍」。
        let avoid = ''
        try {
          const recent = social.listProactive({ peerId, since: Date.now() - 7 * 86400000, order: 'desc', limit: 6 })
          avoid = recent
            .filter((row) => row.decision === 'sent' && row.content_summary)
            .map((row) => String(row.content_summary).slice(0, 40))
            .join('\n')
        } catch (err) {
          avoid = ''
        }

        if (llm && typeof llm.impulse === 'function') {
          try {
            const text = await llm.impulse({
              name: config.name || '助手',
              rhythm: '此刻',
              mood: '平静',
              peerLabel: social.peerLabel(candidate.targetPeer, '对方'),
              memories: allowed.map((item) => `- ${item.text}`).join('\n'),
              previous: '',
              hint,
              world,
              chapters,
              avoid,
            })
            if (text) return text
          } catch (err) {
            // 落到下面的 null
          }
        }

        // 宁可不说，也不拿「刚想起你」这种空话顶上。
        // 返回 null，闸门会记 no_content 并跳过发送。
        return null
      },
      __legacyInfer: llm && typeof llm.impulse === 'function'
        ? async (candidate, allowed = []) => llm.impulse({
          name: config.name || '助手',
          rhythm: '此刻',
          mood: '平静',
          peerLabel: social.peerLabel(candidate.targetPeer, '对方'),
          memories: allowed.map((item) => `- ${item.text}`).join('\n'),
          previous: '',
        })
        : null,
      config: {
        enabled: config.proactiveEnabled !== false,
        minIntervalMs: Math.max(10, Number(config.proactiveCooldownMinutes) || 90) * 60_000,
        dailyLimit: Math.max(0, Number.isFinite(Number(config.proactiveDailyLimit)) ? Number(config.proactiveDailyLimit) : 6),
        quietHours: quiet.length === 2 ? quiet : [23 * 60, 7 * 60],
        timeZone: config.timeZone || 'Asia/Shanghai',
        maxPerPeriod: Math.max(1, Number(config.proactiveMaxPerPeriod) || 1),
        ...(config.proactive || {}),
      },
    })
  }

  currentMood() {
    return Number(this.store.kvGet('cognition:mood', { valence: 0 })?.valence || 0)
  }

  /** Nightly growth pass: weight decay/promotion + mood self-observation. */
  tick({ since = null } = {}) {
    const principleChanges = this.principle.tick()
    const aggregate = this.mood.aggregate({ since })
    if (aggregate) this.social.appendMoodHistory(aggregate)
    return { principleChanges, mood: aggregate }
  }
}
