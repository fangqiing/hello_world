import { createHash, randomUUID } from 'node:crypto'

export const uid = (prefix = 'mem') => `${prefix}_${randomUUID()}`

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

export const nowMs = () => Date.now()

export function hashString(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

/** Deterministic pseudo-random 0..1 from a string (used for star placement). */
export function hashUnit(text, salt = '') {
  const h = hashString(`${text}::${salt}`)
  return parseInt(h.slice(0, 8), 16) / 0xffffffff
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const LATIN = /[a-z0-9_][a-z0-9_+#.-]*/gi

/**
 * Tokenize for FTS5 unicode61: CJK unigrams + bigrams (so Chinese becomes
 * searchable without an ICU tokenizer) and lowercased Latin/number words.
 */
export function tokenizeSearch(text) {
  const out = []
  const seen = new Set()
  const push = (t) => {
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  const s = String(text || '').toLowerCase()
  for (const run of s.match(CJK_RUN) || []) {
    if (run.length === 1) push(run)
    for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2))
  }
  for (const word of s.match(LATIN) || []) push(word)
  return out
}

export function searchText(text) {
  return tokenizeSearch(text).join(' ')
}

/** Rough model-token estimate: CJK ≈ 1 token/char, Latin ≈ 1.3 tokens/word. */
export function estimateTokens(text) {
  const s = String(text || '')
  let tokens = 0
  for (const ch of s) {
    if (CJK.test(ch)) tokens += 1
    else tokens += 0.28
  }
  return Math.ceil(tokens)
}

export function truncate(text, maxChars) {
  const s = String(text || '')
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function splitText(text, limit = 1400) {
  const s = String(text || '')
  if (s.length <= limit) return [s]
  const parts = []
  let rest = s
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('。', limit)
    if (cut < limit * 0.5) cut = limit
    parts.push(rest.slice(0, cut + 1))
    rest = rest.slice(cut + 1)
  }
  if (rest) parts.push(rest)
  return parts
}

export function localParts(timeZone, at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const get = (type) => Number(fmt.formatToParts(at).find((p) => p.type === type)?.value || 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

export function localDateKey(timeZone, at = new Date()) {
  const p = localParts(timeZone, at)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

export function localTimeText(timeZone, at = new Date()) {
  const p = localParts(timeZone, at)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

export function minutesOfDay(hour, minute) {
  return hour * 60 + minute
}

export function parseClock(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return fallback
  const h = clamp(Number(m[1]), 0, 23)
  const min = clamp(Number(m[2]), 0, 59)
  return { hour: h, minute: min, minutes: h * 60 + min }
}

export function inQuietHours(nowMinutes, quiet) {
  const [start, end] = quiet || []
  if (start == null || end == null) return false
  if (start === end) return false
  if (start < end) return nowMinutes >= start && nowMinutes < end
  return nowMinutes >= start || nowMinutes < end
}

export function isLoopback(req) {
  const addr = req?.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

/** Minimal cosine over character-trigram bags; used for near-duplicate merging. */
export function trigramSimilarity(a, b) {
  const bag = (s) => {
    const text = String(s || '').replace(/\s+/g, '')
    const map = new Map()
    for (let i = 0; i < text.length - 2; i++) {
      const g = text.slice(i, i + 3)
      map.set(g, (map.get(g) || 0) + 1)
    }
    return map
  }
  const A = bag(a)
  const B = bag(b)
  if (A.size === 0 || B.size === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of A.values()) na += v * v
  for (const v of B.values()) nb += v * v
  for (const [k, v] of A) if (B.has(k)) dot += v * B.get(k)
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Extract the first JSON object/array from a model reply (tolerates fences). */
export function extractJson(text) {
  const s = String(text || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const candidate = fenced ? fenced[1] : s
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    const start = candidate.indexOf(open)
    const end = candidate.lastIndexOf(close)
    if (start >= 0 && end > start) {
      const parsed = safeJson(candidate.slice(start, end + 1))
      if (parsed) return parsed
    }
  }
  return null
}

export const LAYERS = ['soul', 'user', 'rules', 'project', 'topic', 'fact', 'lesson']

export const LAYER_LABEL = {
  soul: '灵魂',
  user: '对方',
  rules: '准则',
  project: '长期',
  topic: '话题',
  fact: '事实',
  lesson: '教训',
}

export const LAYER_COLOR = {
  soul: '#7ad7ff',
  user: '#ff9ecb',
  rules: '#ffd479',
  project: '#9be59b',
  topic: '#b79cff',
  fact: '#7fb2ff',
  lesson: '#ff9f7a',
}
