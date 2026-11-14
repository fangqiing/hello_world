import { localParts } from './util.js'

export const LEXICON = [
  { label: 'joy', valence: 0.8, arousal: 0.6, words: ['开心', '高兴', '喜欢', '爱', '太好了', '哈哈', '好耶', '幸福', '嘿嘿', '棒', '快乐', 'happy', 'love', 'great', 'yay'] },
  { label: 'tender', valence: 0.6, arousal: 0.3, words: ['想你', '抱抱', '陪', '温柔', '晚安', '乖', '摸摸', '亲亲', '乖啦', 'miss', 'hug'] },
  { label: 'sad', valence: -0.7, arousal: 0.3, words: ['难过', '伤心', '哭', '失落', '孤独', '寂寞', '委屈', '累了', '好累', 'sad', 'lonely', 'tired'] },
  { label: 'angry', valence: -0.6, arousal: 0.8, words: ['生气', '讨厌', '烦', '气死', '滚', '别烦', '愤怒', '烦死', 'angry', 'annoyed'] },
  { label: 'anxious', valence: -0.5, arousal: 0.7, words: ['焦虑', '紧张', '害怕', '担心', '怕', '慌', '压力', 'deadline', 'anxious', 'worried'] },
  // 问号不再是情绪词：否则每个问句都把 valence 推高（实测 curious 23 条 vs joy 2 条）。
  { label: 'curious', valence: 0.15, arousal: 0.45, words: ['为什么', '怎么', '是什么', '好奇', '想知道', 'why', 'how', 'what'] },
  { label: 'proud', valence: 0.7, arousal: 0.5, words: ['厉害了', '做成', '完成', '搞定', '成功', '牛', 'done', 'shipped'] },
]

const LABEL_ZH = {
  joy: '开心',
  tender: '温柔',
  sad: '难过',
  angry: '有点生气',
  anxious: '不安',
  curious: '好奇',
  proud: '得意',
  neutral: '平静',
}

export function labelZh(label) {
  return LABEL_ZH[label] || label
}

/** 可调参数（对应 cordis.patch.yml 的 mood 段）。改配置不用改代码。 */
export const MOOD_DEFAULTS = {
  halfLifeMin: 45,
  energyRecoverMin: 90,
  energyDrainPerTurn: 0.015,
  valenceKeep: 0.65,
  valenceNew: 0.45,
  arousalKeep: 0.7,
  arousalNew: 0.3,
  dominanceKeep: 0.8,
  dominanceNew: 0.2,
  neutralThreshold: 0.1,
}
let MOOD_CFG = { ...MOOD_DEFAULTS }
export function configureMood(cfg = {}) {
  MOOD_CFG = { ...MOOD_DEFAULTS, ...(cfg || {}) }
  return MOOD_CFG
}
export function moodConfig() { return { ...MOOD_CFG } }

/**
 * 把 PAD + 精力合成一个更像人话的词，供 prompt 使用。
 * 借鉴 dsh-emotion-memory 的「派生情绪」思路，只保留一条轻量映射，不引入 14 通道。
 */
export function deriveEmotion(mood = {}) {
  const v = Number(mood.valence || 0)
  const a = Number(mood.arousal ?? 0.3)
  const d = Number(mood.dominance ?? 0.5)
  const energy = Number(mood.energy ?? 0.7)
  const base = mood.label || 'neutral'
  if (base === 'tender') return '心软'
  if (base === 'curious') return '好奇'
  if (base === 'proud') return '得意'
  if (base === 'anxious') return d < 0.42 ? '不安' : '紧张'
  if (base === 'angry') return d > 0.55 ? '恼火' : '委屈'
  if (base === 'sad') return d < 0.4 ? '委屈' : '低落'
  if (base === 'joy') return a > 0.6 ? '兴奋' : '开心'
  if (v > 0.4 && a < 0.35) return '安心'
  if (v < -0.3 && d > 0.6) return '不服'
  if (energy < 0.3) return '乏'
  return '平静'
}

export function tagEmotion(text) {
  const s = String(text || '')
  const NEGATORS = ['不', '没', '无', '别', '非', '毫无', '一点都不', '并不', '不太']
  const INTENSIFIERS = ['很', '非常', '特别', '太', '超', '真的', '极其', '巨', '贼']
  const isQuestion = /[?？]/.test(s) || /(吗|呢|吧)[。.!！]?\s*$/.test(s.trim())
  let best = { label: 'neutral', valence: 0, arousal: 0.2, intensity: 0 }
  for (const entry of LEXICON) {
    let hits = 0
    for (const word of entry.words) {
      const index = s.indexOf(word)
      if (index < 0) continue
      const before = s.slice(Math.max(0, index - 6), index)
      if (NEGATORS.some((negator) => before.includes(negator))) continue
      hits++
    }
    if (!hits) continue
    const intensity = Math.min(1, 0.35 + hits * 0.2
      + (s.includes('！') || s.includes('!') ? 0.1 : 0)
      + (INTENSIFIERS.some((k) => s.includes(k)) ? 0.1 : 0))
    if (intensity > best.intensity) best = { label: entry.label, valence: entry.valence, arousal: entry.arousal, intensity }
  }
  if (best.label === 'neutral') best.intensity = 0.15
  best.isQuestion = isQuestion
  // 纯问句不推动心境，只保留好奇标签。
  if (isQuestion && best.label === 'curious') best.valence = 0
  return best
}

/** Emotion modulates how strongly an episode is written into memory. */
export function emotionWeight(emotion) {
  return 0.8 + 0.4 * (emotion?.intensity || 0) + 0.2 * Math.abs(emotion?.valence || 0)
}

export function getMood(store) {
  const stored = store.kvGet('cognition:mood', null)
  if (stored) return stored
  return { label: 'neutral', valence: 0, arousal: 0.3, dominance: 0.5, energy: 0.7, updatedAt: Date.now(), trend: 'flat' }
}

// PAD 第三维 dominance（掌控感）+ 端点收缩，借鉴 affectus / dsh-emotion-memory 的弛豫思路。
const MOOD_BASE = { valence: 0, arousal: 0.3, dominance: 0.5 }
const HALF_LIFE_MIN = 45
const shrink = (x) => Math.tanh(x * 1.2) / Math.tanh(1.2)

export function updateMood(store, emotion, reason = '') {
  const current = getMood(store)
  let valence = current.valence * MOOD_CFG.valenceKeep + (emotion.valence || 0) * MOOD_CFG.valenceNew
  valence = Math.max(-1, Math.min(1, shrink(valence)))
  let arousal = current.arousal * MOOD_CFG.arousalKeep + (emotion.arousal ?? 0.2) * MOOD_CFG.arousalNew
  arousal = Math.max(0, Math.min(1, arousal))
  const dDelta = (emotion.valence || 0) * 0.12
    + (emotion.label === 'proud' ? 0.15 : 0)
    - (emotion.label === 'anxious' ? 0.15 : 0)
  let dominance = (current.dominance ?? MOOD_BASE.dominance) * MOOD_CFG.dominanceKeep + (MOOD_BASE.dominance + dDelta) * MOOD_CFG.dominanceNew
  dominance = Math.max(0, Math.min(1, dominance))
  let label = emotion.label !== 'neutral' ? emotion.label : current.label
  if (emotion.label === 'neutral' && Math.abs(valence) < 0.15) label = 'neutral'
  // 精力：每轮微降，靠时间恢复；只影响话多话少，不参与情绪标签。
  const energy = Math.max(0.1, Math.min(1, Number(current.energy ?? 0.7) - MOOD_CFG.energyDrainPerTurn))
  const prev = Number(current.valence || 0)
  const mood = {
    label, valence, arousal, dominance, energy,
    updatedAt: Date.now(), reason: String(reason || '').slice(0, 60),
    trend: valence > prev + 0.03 ? 'up' : valence < prev - 0.03 ? 'down' : 'flat',
  }
  store.kvSet('cognition:mood', mood)
  return mood
}

export function decayMood(store) {
  const current = getMood(store)
  const idleMin = (Date.now() - (current.updatedAt || 0)) / 60000
  if (idleMin < 5) return current
  // 朝基线按半衰期弛豫，而不是乘一个几乎不变的系数。
  const k = Math.pow(0.5, idleMin / MOOD_CFG.halfLifeMin)
  const ek = Math.pow(0.5, idleMin / MOOD_CFG.energyRecoverMin)
  const toward = (x, base) => base + (Number(x) - base) * k
  const valence = toward(current.valence ?? 0, MOOD_BASE.valence)
  const arousal = toward(current.arousal ?? 0.3, MOOD_BASE.arousal)
  const dominance = toward(current.dominance ?? 0.5, MOOD_BASE.dominance)
  const energy = 0.7 + (Number(current.energy ?? 0.7) - 0.7) * ek
  const mood = {
    ...current, valence, arousal, dominance, energy,
    label: Math.abs(valence) < 0.1 ? 'neutral' : current.label,
    updatedAt: Date.now(), trend: 'flat',
  }
  store.kvSet('cognition:mood', mood)
  return mood
}

const DRIVE_KEYS = ['social', 'cognitive', 'creative', 'mastery']

export function getDrives(store) {
  const stored = store.kvGet('cognition:drives', null)
  return stored || Object.fromEntries(DRIVE_KEYS.map((k) => [k, 35]))
}

export function bumpDrives(store, delta = {}) {
  const current = getDrives(store)
  const next = {}
  for (const key of DRIVE_KEYS) next[key] = Math.max(0, Math.min(100, (current[key] ?? 35) + (delta[key] ?? 0)))
  store.kvSet('cognition:drives', { ...next, updatedAt: Date.now() })
  return next
}

export function decayDrives(store) {
  const current = getDrives(store)
  const next = {}
  for (const key of DRIVE_KEYS) next[key] = Math.max(10, (current[key] ?? 35) * 0.985)
  store.kvSet('cognition:drives', { ...next, updatedAt: Date.now() })
  return next
}

export function getOwner(store) {
  return store.kvGet('cognition:owner', {
    name: '',
    likes: [],
    dislikes: [],
    style: '短句、口语',
    expertise: [],
    mood: '',
    notes: [],
    updatedAt: 0,
  })
}

export function learnOwner(store, patch) {
  const owner = getOwner(store)
  if (patch.name) owner.name = patch.name
  if (patch.style) owner.style = patch.style
  if (patch.mood) owner.mood = patch.mood
  if (patch.like) owner.likes = [...new Set([...owner.likes, patch.like])].slice(-20)
  if (patch.dislike) owner.dislikes = [...new Set([...owner.dislikes, patch.dislike])].slice(-20)
  if (patch.expertise) owner.expertise = [...new Set([...owner.expertise, patch.expertise])].slice(-20)
  if (patch.note) owner.notes = [...owner.notes, patch.note].slice(-30)
  owner.updatedAt = Date.now()
  store.kvSet('cognition:owner', owner)
  return owner
}

/** Circadian rhythm drives tone and where background work may run. */
export function circadian(timeZone, at = new Date()) {
  const { hour } = localParts(timeZone, at)
  if (hour < 5) return { phase: 'deep-night', energy: 0.25, label: '深夜' }
  if (hour < 8) return { phase: 'dawn', energy: 0.45, label: '清晨' }
  if (hour < 12) return { phase: 'morning', energy: 0.85, label: '上午' }
  if (hour < 18) return { phase: 'afternoon', energy: 0.75, label: '下午' }
  if (hour < 23) return { phase: 'evening', energy: 0.6, label: '傍晚' }
  return { phase: 'night', energy: 0.35, label: '夜里' }
}

export function cognitionSnapshot(store, timeZone) {
  const mood = getMood(store)
  const drives = getDrives(store)
  const owner = getOwner(store)
  const rhythm = circadian(timeZone)
  return {
    mood: { ...mood, labelZh: labelZh(mood.label) },
    drives,
    owner,
    rhythm,
  }
}
