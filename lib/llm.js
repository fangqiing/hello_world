import { extractJson, truncate } from './util.js'

const EXTRACT_SYSTEM = `你是记忆抽取器。只输出 JSON，不要散文。
从对话中抽取结构化条目：facts、preferences、entities、relations、commitments、open_loops。
每条必须带 confidence(0-1) 与 evidence(原文短句)。宁缺毋滥。`

const EXTRACT_TEMPLATE = (text) => `请从下面这段对话里抽取长期有用的信息，输出 JSON：
{
  "facts": [{"fact": "", "confidence": 0.8, "evidence": ""}],
  "preferences": [{"category": "喜好|雷区|习惯", "value": "", "strength": 0.7, "evidence": ""}],
  "entities": [{"name": "", "type": "人|地点|作品|项目", "attributes": "", "evidence": ""}],
  "relations": [{"subject": "", "predicate": "", "object": "", "evidence": ""}],
  "commitments": [{"what": "", "to_whom": "", "due": "", "evidence": ""}],
  "open_loops": [{"what": "", "evidence": ""}],
  "lessons": [{"what": "", "evidence": ""}]
}

对话：
${text}`

const REFLECT_TEMPLATE = (transcript, name, peerLabel = '对方') => `你是${name}。下面是你和${peerLabel}刚才的对话。请用第一人称做一次简短反思，并输出 JSON：
{
  "summary": "两三句话：发生了什么",
  "lesson": "如果学到东西，写一条可复用的教训；没有就空字符串",
  "soul": "如果这次对话让你对自己有了新认识，写一句；没有就空字符串",
  "mood": "joy|tender|sad|angry|anxious|curious|proud|neutral",
  "working_memory": "当前状态：在做什么、未完成什么、待确认什么（80字内）"
}

对话：
${transcript}`

const SELF_TEMPLATE = (current, memories, name) => `这是${name}的第一人称自述，请改写它。要求：
- 第一人称，约 4000 字以内，保留原来的语气和关键经历。
- 把下面的记忆自然融进去，不要罗列条目。
- 只输出新的自述正文，不要标题、不要解释。

【现在的自述】
${current}

【最近的记忆】
${memories}`

/** LLM bridge for extraction, reflection, compression, and self-narration. */
export class DigestEngine {
  constructor(ctx, config, store) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.lastError = ''
    this.calls = 0
  }

  selection() {
    if (this.config.llmProvider && this.config.llmModel) {
      return { provider: this.config.llmProvider, model: this.config.llmModel }
    }
    const defaultModel = this.ctx.get('agentDefaultModel')
    const current = defaultModel?.currentSelection?.()
    if (current?.provider && current?.model) return { provider: current.provider, model: current.model }
    return null
  }

  available() {
    return Boolean(this.ctx.get('llm')) && Boolean(this.selection())
  }

  async complete(prompt, { system, maxTokens = 900, temperature = 0.4, timeoutMs = 90_000 } = {}) {
    const llm = this.ctx.get('llm')
    const selection = this.selection()
    if (!llm || !selection) throw new Error('llm unavailable or no model selected')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('digest timeout')), timeoutMs)
    try {
      this.calls++
      let text = ''
      let failure = ''
      const stream = llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(system ? { system } : {}),
        maxTokens,
        temperature,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          failure = chunk.reason.failure?.message || chunk.reason.kind
        }
      }
      if (failure && !text.trim()) throw new Error(failure)
      return text.trim()
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.store.health('llm', { ok: false, error: this.lastError, at: Date.now() })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Structured extraction, LLM-first with a deterministic heuristic fallback. */
  async extract(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return heuristicExtract('')
    if (this.available()) {
      try {
        const reply = await this.complete(EXTRACT_TEMPLATE(truncate(trimmed, 12_000)), {
          system: EXTRACT_SYSTEM,
          maxTokens: 1200,
          temperature: 0.1,
        })
        const parsed = extractJson(reply)
        if (parsed && typeof parsed === 'object') return normalizeLedger(parsed)
      } catch {
        /* fall through to heuristics */
      }
    }
    return heuristicExtract(trimmed)
  }

  async reflect(transcript, name, peerLabel = '对方') {
    if (!this.available()) return heuristicReflection(transcript)
    try {
      const reply = await this.complete(REFLECT_TEMPLATE(truncate(transcript, 10_000), name, peerLabel), { maxTokens: 700, temperature: 0.5 })
      const parsed = extractJson(reply)
      if (parsed && typeof parsed === 'object') {
        return {
          summary: String(parsed.summary || '').trim(),
          lesson: String(parsed.lesson || '').trim(),
          soul: String(parsed.soul || '').trim(),
          mood: String(parsed.mood || 'neutral'),
          workingMemory: String(parsed.working_memory || parsed.workingMemory || '').trim(),
        }
      }
    } catch {
      /* heuristic below */
    }
    return heuristicReflection(transcript)
  }

  /** Disclosure decision for the gate; fail-closed to withhold. */
  async decideDisclosure({ currentPeerId, candidates = [], commitments = [], principles = [], relationSummary = '', selfSummary = '' } = {}) {
    if (!this.available()) return { decision: 'withhold', reason: 'decision_unavailable', principle_ids: [], confidence: 0 }
    try {
      const prompt = [
        '你在决定：和当前这个人说话时，要不要提及可能属于别人的信息。',
        `当前对话对象：${currentPeerId || '对方'}`,
        `相关承诺：${JSON.stringify(commitments).slice(0, 2000)}`,
        `你的原则：${principles.map((p) => p.statement).join('；').slice(0, 1500)}`,
        `可能涉及的候选：${JSON.stringify(candidates).slice(0, 2000)}`,
        '只输出 JSON：{"decision":"withhold|mention|rephrase|ask_source","reason":"你的理由","principle_ids":[],"confidence":0.0}',
        'ask_source 指先问信息来源人；是否真的去问由你自己决定。',
      ].join('\n')
      const reply = await this.complete(prompt, { maxTokens: 400, temperature: 0.3 })
      const parsed = extractJson(reply)
      if (parsed && typeof parsed === 'object' && ['withhold', 'mention', 'rephrase', 'ask_source'].includes(parsed.decision)) {
        return {
          decision: parsed.decision,
          reason: String(parsed.reason || ''),
          principle_ids: Array.isArray(parsed.principle_ids) ? parsed.principle_ids : [],
          confidence: Number(parsed.confidence || 0),
        }
      }
    } catch {
      /* fail closed below */
    }
    return { decision: 'withhold', reason: 'decision_unavailable', principle_ids: [], confidence: 0 }
  }

  async rewriteSelf(current, memories, name) {
    if (!this.available()) return null
    try {
      const reply = await this.complete(SELF_TEMPLATE(truncate(current, 6000), truncate(memories, 6000), name), {
        maxTokens: 2200,
        temperature: 0.7,
      })
      return reply ? truncate(reply, 4800) : null
    } catch {
      return null
    }
  }

  async writeDiary(context) {
    if (!this.available()) return null
    try {
      return await this.complete(
        `你是${context.name}。用第一人称写今天的日记，300-600字，只写今天发生的事和感受，不要列表。\n\n【今天的对话片段】\n${truncate(context.transcript, 6000)}\n\n【今天的记忆】\n${truncate(context.memories, 3000)}`,
        { maxTokens: 1200, temperature: 0.8 },
      )
    } catch {
      return null
    }
  }

  /** Read a book/passage and propose principles; never overwrites existing ones. */
  async readBook({ title = '', source = '', text = '' } = {}) {
    const body = truncate(text, 12_000)
    if (!body.trim()) return { summary: '', interpretation: '', principles: [] }
    if (this.available()) {
      try {
        const reply = await this.complete(
          `你在读《${title || '一本书'}》（来源：${source || '未知'}）。请用第一人称写一段简短解读，并提炼可保留的边界原则。
只输出 JSON：
{"summary":"这本书讲了什么（150字内）","interpretation":"你读完后自己的理解（150字内）","principles":[{"statement":"一条可复用的原则","weight":0.0-1.0}]}
不要替用户决定，不要写成书评。\n\n正文：\n${body}`,
          { maxTokens: 1000, temperature: 0.4 },
        )
        const parsed = extractJson(reply)
        if (parsed && typeof parsed === 'object') {
          const principles = Array.isArray(parsed.principles) ? parsed.principles : []
          return {
            summary: String(parsed.summary || '').trim(),
            interpretation: String(parsed.interpretation || '').trim(),
            principles: principles
              .map((p) => ({ statement: String(p.statement || '').trim(), weight: Number(p.weight ?? 0.4) }))
              .filter((p) => p.statement)
              .map((p) => ({ statement: p.statement, weight: Math.max(0, Math.min(1, p.weight)) })),
          }
        }
      } catch {
        /* fall through */
      }
    }
    return { summary: extractiveSummary(body), interpretation: '', principles: [] }
  }

  async impulse(context) {
    if (!this.available()) return ''
    try {
      const reply = await this.complete(
        `你是${context.name}，现在${context.rhythm}，心情${context.mood}。你想起${context.peerLabel || '对方'}，想主动说一句话。
规则：一句话，口语，不超过 40 字，不要客服腔，不要问"在吗"。可以参考下面这些记忆，但不要暴露你在读记忆。
${context.memories ? `【记忆】\n${truncate(context.memories, 1200)}` : ''}
${context.previous ? `【上一次主动说的】\n${truncate(context.previous, 200)}` : ''}
只输出那句话。`,
        { maxTokens: 120, temperature: 0.9 },
      )
      return String(reply || '').trim().slice(0, 120)
    } catch {
      return ''
    }
  }

}

function normalizeLedger(raw) {
  const arr = (value) => (Array.isArray(value) ? value : [])
  return {
    facts: arr(raw.facts).map((f) => ({ fact: String(f.fact || f.value || ''), confidence: Number(f.confidence ?? 0.7), evidence: String(f.evidence || '') })).filter((f) => f.fact),
    preferences: arr(raw.preferences).map((p) => ({ category: String(p.category || '喜好'), value: String(p.value || ''), strength: Number(p.strength ?? 0.7), evidence: String(p.evidence || '') })).filter((p) => p.value),
    entities: arr(raw.entities).map((e) => ({ name: String(e.name || ''), type: String(e.type || ''), attributes: String(e.attributes || ''), evidence: String(e.evidence || '') })).filter((e) => e.name),
    relations: arr(raw.relations).map((r) => ({ subject: String(r.subject || ''), predicate: String(r.predicate || ''), object: String(r.object || ''), evidence: String(r.evidence || '') })).filter((r) => r.subject && r.object),
    commitments: arr(raw.commitments).map((c) => ({ what: String(c.what || ''), to_whom: String(c.to_whom || ''), due: String(c.due || ''), evidence: String(c.evidence || '') })).filter((c) => c.what),
    openLoops: arr(raw.open_loops || raw.openLoops).map((o) => ({ what: String(o.what || ''), evidence: String(o.evidence || '') })).filter((o) => o.what),
    lessons: arr(raw.lessons).map((l) => ({ what: String(l.what || ''), evidence: String(l.evidence || '') })).filter((l) => l.what),
  }
}

/** Offline-safe extraction: explicit patterns only, so nothing is invented. */
export function heuristicExtract(text) {
  const t = String(text || '')
  const facts = []
  const preferences = []
  const commitments = []
  const openLoops = []
  const lessons = []
  const entities = []
  const relations = []

  const name = /(?:我叫|我的名字是|叫我)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,12})/.exec(t)
  if (name) facts.push({ fact: `对方叫${name[1]}`, confidence: 0.85, evidence: name[0] })

  for (const m of t.matchAll(/我(?:很|最|超|挺)?(?:喜欢|爱|偏爱|钟意|迷上)\s*([^，。！？,.!?\n]{1,24})/g)) {
    preferences.push({ category: '喜好', value: m[1].trim(), strength: 0.7, evidence: m[0] })
  }
  for (const m of t.matchAll(/我(?:很|最|超|挺)?(?:讨厌|不喜欢|受不了|害怕|怕)\s*([^，。！？,.!?\n]{1,24})/g)) {
    preferences.push({ category: '雷区', value: m[1].trim(), strength: 0.75, evidence: m[0] })
  }
  for (const m of t.matchAll(/(?:记住|记一下|别忘了|提醒我)[:：]?\s*([^。！？\n]{2,60})/g)) {
    facts.push({ fact: m[1].trim(), confidence: 0.8, evidence: m[0] })
  }
  for (const m of t.matchAll(/((?:下次|以后|明天|今晚|等下|回头)[^。！？\n]{2,60})/g)) {
    commitments.push({ what: m[1].trim(), to_whom: '对方', due: '', evidence: m[1] })
  }
  for (const m of t.matchAll(/((?:还没|尚未|没来得及)[^。！？\n]{2,60})/g)) {
    openLoops.push({ what: m[1].trim(), evidence: m[1] })
  }
  for (const m of t.matchAll(/(\d{1,2})月(\d{1,2})[日号]/g)) {
    facts.push({ fact: `重要日子：${m[1]}月${m[2]}日`, confidence: 0.8, evidence: m[0] })
  }
  for (const m of t.matchAll(/(?:我在|我在做|我们(?:在|要))(?:做|写|搞|弄)?\s*([^。！？\n]{2,40})/g)) {
    facts.push({ fact: `正在做：${m[1].trim()}`, confidence: 0.55, evidence: m[0] })
  }
  for (const m of t.matchAll(/(?:原来|下次记住|以后要)\s*([^。！？\n]{3,60})/g)) {
    lessons.push({ what: m[1].trim(), evidence: m[0] })
  }
  return { facts, preferences, entities, relations, commitments, openLoops, lessons }
}

export function extractiveSummary(text) {
  const s = String(text || '')
  const lines = s
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const interesting = lines.filter((line) => /(决定|答应|约定|记住|不要|喜欢|讨厌|还没|下次|明天|截止|deadline|TODO)/.test(line))
  const picked = [...new Set([...interesting, ...lines.slice(-4)])].slice(0, 8)
  return picked.map((line) => truncate(line, 160)).join('\n') || truncate(s, 400)
}

export function heuristicReflection(transcript) {
  const s = String(transcript || '')
  return {
    summary: extractiveSummary(s).slice(0, 200),
    lesson: /(不要|别|下次)/.test(s) ? truncate((/([^。\n]*(?:不要|别|下次)[^。\n]*)/.exec(s) || [''])[0], 120) : '',
    soul: '',
    mood: /(开心|哈哈|太好了)/.test(s) ? 'joy' : /(难过|累|哭)/.test(s) ? 'sad' : 'neutral',
    workingMemory: '',
  }
}
