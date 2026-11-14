/**
 * 表情层：按她此刻的心情挑颜文字 / 表情包。
 *
 * 素材全部落在 /root/whale-media（来源见该目录 SOURCES.txt），
 * 不依赖任何外部 Cordis 插件，也不改 cordis.patch.yml。
 * 发图仍走现有 whale_send_file（路径白名单允许 /root/whale-media）。
 *
 * 本模块只产出工具定义；实际注册由 lib/tools.js 用与其它工具完全相同的
 * ctx.effect(() => tools.register(...)) 链路完成，避免出现「注册了但没进工具表」。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = process.env.WHALE_EXPRESSION_ROOT || '/root/whale-media'
const KAOMOJI_FILE = join(ROOT, 'expression/kaomoji-clean.json')
const STICKER_ROOT = join(ROOT, 'stickers')
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

// 心情 -> kaomoji-data 的 by-category 分类名
const MOOD_TO_KAOMOJI = {
  joy: ['ureshii', 'egao', 'kirakira', 'suki', 'ouen'],
  calm: ['cute', 'nadenade', 'tehepero', 'tereru', 'aa'],
  sad: ['cry', 'taoreru', 'nemui', 'chira'],
  angry: ['okoru', 'nageru', 'bikkuri'],
  surprised: ['bikkuri', 'aa', 'copype'],
  neutral: ['cute', 'egao', 'mogumogu', 'otaku'],
}

// 心情 -> dsh-meme 内置图库的子目录名
const MOOD_TO_STICKER = {
  joy: ['happy', 'like', 'meow', 'morning'],
  calm: ['daily', 'see', 'color', 'work'],
  sad: ['sad', 'sigh', 'sleep'],
  angry: ['angry', 'baka', 'fool', 'cpu'],
  surprised: ['surprised', 'confused'],
  neutral: ['daily', 'shy', 'givemoney'],
}

let kaomojiCache = null

function loadKaomoji() {
  if (kaomojiCache) return kaomojiCache
  try {
    kaomojiCache = JSON.parse(readFileSync(KAOMOJI_FILE, 'utf8'))
  } catch {
    kaomojiCache = {}
  }
  return kaomojiCache
}

/** 直接读情绪系统的 cognition:mood；不改动原有情绪逻辑。 */
function readMood(whale) {
  let m = {}
  try {
    m = whale.store.kvGet('cognition:mood', {}) || {}
  } catch {
    m = {}
  }
  const valence = Number(m.valence || 0)
  const arousal = Number(m.arousal ?? 0.3)
  const label = String(m.label || 'neutral')
  const low = label.toLowerCase()
  let bucket = 'neutral'
  // 词典八类都要有落点，别让 tender/anxious/curious/proud 全掉进 neutral。
  if (['joy', 'happy', 'proud', 'positive', '轻快', '开心', '高兴', '得意'].some((k) => low.includes(k))) bucket = 'joy'
  else if (['sad', 'sorrow', '低沉', '难过', '失落', '委屈'].some((k) => low.includes(k))) bucket = 'sad'
  else if (['angry', 'mad', '生气', '烦躁'].some((k) => low.includes(k))) bucket = 'angry'
  else if (['anxious', 'curious', 'surprised', '好奇', '不安', '惊讶'].some((k) => low.includes(k))) bucket = 'surprised'
  else if (['tender', 'calm', '温柔', '平静'].some((k) => low.includes(k))) bucket = 'calm'
  else if (valence > 0.25) bucket = 'joy'
  else if (valence < -0.35) bucket = 'sad'
  else if (arousal > 0.7 && valence < -0.1) bucket = 'angry'
  return { valence, arousal, label, bucket }
}

function pick(list, rand = Math.random) {
  if (!list || !list.length) return null
  return list[Math.floor(rand() * list.length)]
}

function pickKaomoji(bucket, rand) {
  const db = loadKaomoji()
  const cats = MOOD_TO_KAOMOJI[bucket] || MOOD_TO_KAOMOJI.neutral
  const pool = []
  for (const c of cats) for (const t of db[c] || []) pool.push(t)
  return pick(pool, rand)
}

function stickerFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...stickerFiles(p))
    else if (IMG_EXT.has(extname(name).toLowerCase())) out.push(p)
  }
  return out
}

function pickSticker(bucket, rand) {
  const dirs = MOOD_TO_STICKER[bucket] || MOOD_TO_STICKER.neutral
  const pool = []
  for (const d of dirs) pool.push(...stickerFiles(join(STICKER_ROOT, d)))
  // 自制表情包：/root/whale-media/stickers/custom/<bucket>/
  pool.push(...stickerFiles(join(STICKER_ROOT, 'custom', bucket)))
  if (!pool.length) pool.push(...stickerFiles(STICKER_ROOT))
  return pick(pool, rand)
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  },
}

export function createExpressionTool(whale) {
  return {
    name: 'whale_expression',
    description:
      '按她此刻的心情挑一个颜文字和/或表情包。kaomoji 可直接写进回复文本；sticker_path 交给 whale_send_file 发图。不要自己编颜文字。',
    parameters: {
      type: 'object',
      properties: {
        want_sticker: { type: 'boolean', description: '是否也要挑一张表情包图片' },
        mood_hint: { type: 'string', description: '可选 happy/calm/sad/angry/surprised；省略则自动读情绪系统' },
      },
    },
    output,
    isConcurrencySafe: () => false,
    async execute(args) {
      const mood = readMood(whale)
      const hint = String(args?.mood_hint || '').toLowerCase()
      const hit = ['joy', 'happy', 'calm', 'neutral', 'sad', 'angry', 'surprised'].find((k) => hint.includes(k))
      const bucket = hit ? (hit === 'happy' ? 'joy' : hit) : mood.bucket
      const kaomoji = pickKaomoji(bucket)
      const stickerPath = args?.want_sticker ? pickSticker(bucket) : null
      return {
        ok: true,
        mood: { label: mood.label, valence: mood.valence, arousal: mood.arousal, bucket },
        kaomoji,
        sticker_path: stickerPath,
        usage: stickerPath
          ? '把 kaomoji 写进回复文本；再调 whale_send_file 传 sticker_path 发图。发图失败就只发颜文字，别解释。'
          : '把 kaomoji 写进回复文本即可。',
      }
    },
  }
}

/** 供离线自检使用 */
export const __test = { readMood, pickKaomoji, pickSticker }
