import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './config.js'
import { splitText } from './util.js'
import { peerIdFor } from './social.js'
import { admit } from './channel-admission.js'
import { cleanVoice } from './voice-cleaner.js'
import { hasEmoji } from './voice-style.js'
import { checkGrice, inferScene } from './voice-grice.js'
import { repetitionCheck, pickFrom } from './voice-variants.js'
import { driftScan, l0Gate, shouldSelfCheck } from './voice-repair.js'
import { needsRewrite } from './voice-shape.js'
import { feedbackToRule } from './voice-learning.js'
import { ChatModes } from './chat-modes.js'
import { classifyMedia, fallbackText } from './media-inbound.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Minimal RFC6455 server-side socket: text frames only, no extensions. */
class WsConnection {
  constructor(socket, req) {
    this.socket = socket
    this.req = req
    this.buffer = Buffer.alloc(0)
    this.open = true
    this.handlers = { message: [], close: [] }
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('close', () => this.close())
    socket.on('error', () => this.close())
  }

  static accept(socket, req) {
    const key = req.headers['sec-websocket-key']
    if (!key) return null
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    return new WsConnection(socket, req)
  }

  on(event, handler) {
    this.handlers[event]?.push(handler)
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (this.buffer.length < offset + maskLen + length) return
      const mask = masked ? this.buffer.slice(offset, offset + 4) : null
      const payload = Buffer.from(this.buffer.slice(offset + maskLen, offset + maskLen + length))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      this.buffer = this.buffer.slice(offset + maskLen + length)
      if (opcode === 0x8) {
        this.close()
        return
      }
      if (opcode === 0x9) {
        this.write(0xa, payload)
        continue
      }
      if (opcode === 0x1) {
        const text = payload.toString('utf8')
        for (const handler of this.handlers.message) handler(text)
      }
    }
  }

  write(opcode, payload) {
    if (!this.open) return
    const len = payload.length
    let header
    if (len < 126) header = Buffer.from([0x80 | opcode, len])
    else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    try {
      this.socket.write(Buffer.concat([header, payload]))
    } catch {
      this.close()
    }
  }

  send(text) {
    this.write(0x1, Buffer.from(String(text), 'utf8'))
  }

  close() {
    if (!this.open) return
    this.open = false
    try {
      this.socket.end()
    } catch {
      /* ignore */
    }
    for (const handler of this.handlers.close) handler()
  }
}

/** Group messages only enter generation when addressed; otherwise archive silently. */
export function isGroupAddressed(text, names = []) {
  const s = String(text || '')
  if (/\[CQ:at,qq=|[<@]/.test(s)) return true
  return names.filter(Boolean).some((name) => s.includes(`@${name}`) || s.includes(String(name)))
}

class BaseChannel {
  constructor(name) {
    this.name = name
    this.handler = null
    this.connected = false
    this.lastError = ''
    this.lastInboundAt = 0
    this.dedup = new Map()
    this.rate = new Map()
    this.failures = 0
    this.openUntil = 0
    this.paused = false
  }

  setHandler(handler) {
    this.handler = handler
  }

  allowUser(senderId) {
    const list = this.config?.allowUsers || []
    return list.includes('*') || list.includes(String(senderId))
  }

  allowConversation(conversationId) {
    const list = this.config?.allowGroups || []
    return list.includes('*') || list.includes(String(conversationId))
  }

  rateOk(conversationId) {
    const now = Date.now()
    const arr = (this.rate.get(conversationId) || []).filter((t) => now - t < 60_000)
    if (arr.length >= this.config.ratePerMinute) {
      this.rate.set(conversationId, arr)
      return false
    }
    arr.push(now)
    this.rate.set(conversationId, arr)
    return true
  }

  isDuplicate(messageId) {
    if (!messageId) return false
    const now = Date.now()
    for (const [key, at] of this.dedup) if (now - at > 300_000) this.dedup.delete(key)
    if (this.dedup.has(messageId)) return true
    this.dedup.set(messageId, now)
    return false
  }

  breakerOpen() {
    return this.paused || this.openUntil > Date.now()
  }

  trip(error) {
    this.failures++
    this.lastError = String(error?.message || error)
    if (this.failures >= 5) {
      this.openUntil = Date.now() + 60_000
      this.failures = 0
    }
  }

  reset() {
    this.paused = false
    this.openUntil = 0
    this.failures = 0
    this.lastError = ''
  }

  deliver(msg) {
    this.lastInboundAt = Date.now()
    try {
      this.handler?.(msg)
    } catch {
      /* upper layer owns failure handling */
    }
  }
}

export class OneBotChannel extends BaseChannel {
  constructor(config) {
    super('qq')
    this.config = config
    this.allowList = [...(config.allowUsers || []), ...(config.allowGroups || [])]
    this.socket = null
    this.reverse = null
    this.pending = new Map()
    this.echoSeq = 0
    this.botId = String(config.selfId || '')
    this.attempts = 0
    this.stopped = false
  }

  async start(webServer) {
    this.stopped = false
    if (this.config.mode === 'reverse') {
      this.startReverse(webServer)
      return
    }
    this.connectForward()
  }

  async stop() {
    this.stopped = true
    try {
      this.socket?.close()
    } catch {
      /* ignore */
    }
    this.socket = null
    for (const pending of this.pending.values()) pending.reject(new Error('qq channel closed'))
    this.pending.clear()
    this.reverse?.close?.()
  }

  connectForward() {
    const url = new URL(this.config.wsUrl)
    if (this.config.accessToken) url.searchParams.set('access_token', this.config.accessToken)
    let socket
    try {
      socket = new WebSocket(url.toString())
    } catch (error) {
      this.trip(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.connected = true
      this.attempts = 0
      this.lastError = ''
    })
    socket.addEventListener('message', (event) => this.onRaw(String(event.data)))
    socket.addEventListener('error', () => {
      this.connected = false
    })
    socket.addEventListener('close', () => {
      this.connected = false
      if (!this.stopped) this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (this.stopped || this.config.mode === 'reverse') return
    this.attempts++
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.attempts - 1, 5))
    const timer = setTimeout(() => {
      if (!this.stopped) this.connectForward()
    }, delay)
    timer.unref?.()
  }

  startReverse(webServer) {
    if (!this.config.accessToken) throw new Error('whale-chan/qq: reverse 模式必须配置 accessToken（fail-closed）')
    if (!webServer?.registerUpgrade) throw new Error('whale-chan/qq: 宿主没有 registerUpgrade，reverse 模式不可用')
    const path = this.config.reversePath || '/whale-chan/qq'
    const channel = this
    const dispose = webServer.registerUpgrade({
      path,
      handler(req, socket) {
        let ok = false
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          ok = url.searchParams.get('access_token') === channel.config.accessToken
        } catch {
          ok = false
        }
        if (!ok && String(req.headers.authorization || '') !== `Bearer ${channel.config.accessToken}`) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.end()
          return
        }
        const conn = WsConnection.accept(socket, req)
        if (!conn) {
          socket.end()
          return
        }
        channel.reverse = conn
        channel.connected = true
        conn.on('message', (text) => channel.onRaw(text))
        conn.on('close', () => {
          if (channel.reverse === conn) {
            channel.connected = false
            channel.reverse = null
          }
        })
      },
    })
    this.dispose = dispose
  }

  onRaw(text) {
    let event
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (typeof event?.echo === 'string') {
      const pending = this.pending.get(event.echo)
      if (pending) {
        this.pending.delete(event.echo)
        if (event.status === 'ok' || event.retcode === 0) pending.resolve(event.data)
        else pending.reject(new Error(`onebot action failed: ${event.retcode ?? event.status}`))
      }
      return
    }
    if (event?.post_type === 'meta_event') {
      if (event.self_id) this.botId = String(event.self_id)
      this.connected = true
      return
    }
    if (event?.post_type !== 'message') return
    void this.onMessage(event)
  }

  async onMessage(event) {
    const type = event.message_type
    if (type !== 'private' && type !== 'group') return
    if (event.message_id && this.isDuplicate(String(event.message_id))) return
    const text = this.segmentsToText(event.message, event.raw_message)
    if (!text.trim()) return
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '')
    if (this.botId && senderId === this.botId) return
    if (type === 'group' && !this.config.groups) return
    const conversationId = type === 'private' ? `private:${senderId}` : `group:${event.group_id}`
    if (!this.allowUser(senderId)) return
    if (type === 'group' && !this.allowConversation(event.group_id)) return
    if (!this.rateOk(conversationId)) return
    this.deliver({
      channel: 'qq',
      conversationId,
      conversationType: type,
      senderId,
      senderName: event.sender?.card || event.sender?.nickname || senderId,
      text,
      at: new Date().toISOString(),
      messageId: String(event.message_id || ''),
    })
  }

  segmentsToText(segments, raw) {
    if (Array.isArray(segments)) {
      return segments
        .map((segment) => {
          const data = segment?.data || {}
          switch (segment?.type) {
            case 'text':
              return String(data.text || '')
            case 'at':
              return String(data.qq) === this.botId ? '[@我]' : `@${data.qq || ''} `
            case 'image':
              return '[图片]'
            case 'record':
              return '[语音]'
            case 'face':
              return '[表情]'
            case 'reply':
              return ''
            default:
              return `[${segment?.type}]`
          }
        })
        .join('')
        .trim()
    }
    return this.parseCQ(String(segments || raw || ''))
  }

  parseCQ(raw) {
    let out = ''
    let i = 0
    while (i < raw.length) {
      const start = raw.indexOf('[CQ:', i)
      if (start < 0) {
        out += this.unescapeCQ(raw.slice(i))
        break
      }
      out += this.unescapeCQ(raw.slice(i, start))
      const end = raw.indexOf(']', start)
      if (end < 0) {
        out += raw.slice(start)
        break
      }
      const inner = raw.slice(start + 4, end)
      const name = (inner.split(',')[0] || '').replace(/^CQ:/, '')
      if (name === 'at') {
        const qq = /qq=([^,\]]+)/.exec(inner)?.[1] || ''
        out += qq === this.botId ? '[@我]' : `@${qq} `
      } else if (name === 'image') out += '[图片]'
      else if (name === 'record') out += '[语音]'
      else if (name === 'face') out += '[表情]'
      else if (name !== 'reply') out += `[${name}]`
      i = end + 1
    }
    return out.trim()
  }

  unescapeCQ(text) {
    return text.replace(/&amp;/g, '&').replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']')
  }

  action(action, params, timeoutMs = 15_000) {
    const echo = `w${++this.echoSeq}`
    const payload = JSON.stringify({ action, params, echo })
    const socket = this.config.mode === 'reverse' ? this.reverse : this.socket
    const isOpen = this.config.mode === 'reverse' ? Boolean(socket?.open) : socket?.readyState === 1
    if (!socket || !isOpen) return Promise.reject(new Error('qq: 未连接'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('qq: action 超时'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(echo, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      if (this.config.mode === 'reverse') socket.send(payload)
      else socket.send(payload)
    })
  }

  target(conversationId) {
    const [kind, id] = String(conversationId).split(':')
    if (kind === 'group') return { action: 'send_group_msg', params: { group_id: Number(id) } }
    return { action: 'send_private_msg', params: { user_id: Number(id) } }
  }

  async sendText(conversationId, text) {
    if (this.breakerOpen()) throw new Error('qq: 通道已熔断')
    const { action, params } = this.target(conversationId)
    for (const part of splitText(text, this.config.splitLength)) {
      try {
        await this.action(action, { ...params, message: [{ type: 'text', data: { text: part } }], auto_escape: false })
        this.failures = 0
      } catch (error) {
        this.trip(error)
        throw error
      }
    }
  }

  status() {
    return {
      name: 'qq',
      enabled: true,
      mode: this.config.mode,
      connected: this.connected,
      paused: this.breakerOpen(),
      allowUsers: this.config.allowUsers,
      allowGroups: this.config.allowGroups,
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt,
      botId: this.botId,
    }
  }
}

export class WeChatBridgeChannel extends BaseChannel {
  constructor(config) {
    super('wechat')
    this.config = config
    this.allowList = config.allowUsers || []
    this.cursor = ''
    this.timer = null
    this.polling = false
  }

  async start() {
    this.polling = true
    if (this.config.mode !== 'linux') this.poll()
  }

  async stop() {
    this.polling = false
    if (this.timer) clearTimeout(this.timer)
  }

  poll() {
    if (!this.polling) return
    const run = async () => {
      try {
        await this.pollOnce()
        this.connected = true
        this.lastError = ''
      } catch (error) {
        this.connected = false
        this.trip(error)
      } finally {
        if (this.polling) {
          this.timer = setTimeout(run, Math.max(2000, this.config.pollIntervalMs || 3000))
          this.timer.unref?.()
        }
      }
    }
    void run()
  }

  async pollOnce() {
    const base = this.config.bridgeUrl.replace(/\/$/, '')
    const url = new URL(`${base}/inbound`)
    if (this.cursor) url.searchParams.set('since', this.cursor)
    const res = await fetch(url, {
      headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`wechat bridge ${res.status}`)
    const body = await res.json()
    if (body.cursor) this.cursor = String(body.cursor)
    for (const raw of body.messages || []) {
      const msg = normalizeWechatMessage(raw, 'wechat')
      if (!msg) continue
      if (!this.allowUser(msg.senderId)) continue
      if (msg.conversationType === 'group' && !this.allowConversation(msg.conversationId)) continue
      if (!this.rateOk(msg.conversationId)) continue
      this.deliver(msg)
    }
  }

  async sendText(conversationId, text) {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    const base = this.config.bridgeUrl.replace(/\/$/, '')
    for (const part of splitText(text, this.config.splitLength)) {
      const res = await fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
        body: JSON.stringify({ conversationId, text: part }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        this.trip(new Error(`wechat bridge send ${res.status}`))
        throw new Error(`wechat bridge send ${res.status}`)
      }
    }
    this.failures = 0
  }

  async sendImage(conversationId, base64) {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    const base = this.config.bridgeUrl.replace(/\/$/, '')
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
      body: JSON.stringify({ conversationId, image: String(base64 || '') }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      this.trip(new Error(`wechat bridge send ${res.status}`))
      throw new Error(`wechat bridge send ${res.status}`)
    }
    this.failures = 0
  }

  async sendFile(conversationId, base64, fileName = '') {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    const base = this.config.bridgeUrl.replace(/\/$/, '')
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
      body: JSON.stringify({ conversationId, file: String(base64 || ''), fileName: String(fileName || '') }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      this.trip(new Error(`wechat bridge send ${res.status}`))
      throw new Error(`wechat bridge send ${res.status}`)
    }
    this.failures = 0
  }

  async sendVideo(conversationId, base64, fileName = '') {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    const base = this.config.bridgeUrl.replace(/\/$/, '')
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
      body: JSON.stringify({ conversationId, video: String(base64 || ''), fileName: String(fileName || '') }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      this.trip(new Error(`wechat bridge send ${res.status}`))
      throw new Error(`wechat bridge send ${res.status}`)
    }
    this.failures = 0
  }

  async sendMedia(conversationId, media = {}) {
    const data = String(media?.data ?? media?.base64 ?? '')
    if (!data) throw new Error('wechat: 媒体数据为空')
    const kind = String(media?.kind || 'file')
    if (kind === 'image') return this.sendImage(conversationId, data)
    if (kind === 'video') return this.sendVideo(conversationId, data, media?.fileName || '')
    return this.sendFile(conversationId, data, media?.fileName || '')
  }

  status() {
    return {
      name: 'wechat',
      enabled: true,
      mode: this.config.mode || 'bridge',
      connected: this.connected,
      paused: this.breakerOpen(),
      allowUsers: this.config.allowUsers,
      allowGroups: this.config.allowGroups || [],
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt,
      cursor: this.cursor,
    }
  }
}

export class WechatLinuxChannel extends BaseChannel {
  constructor(config) {
    super('wechat')
    this.config = config
    this.allowList = config.allowUsers || []
    this.cursor = ''
    this.timer = null
    this.polling = false
  }

  async start() {
    this.polling = true
    this.poll()
  }

  async stop() {
    this.polling = false
    if (this.timer) clearTimeout(this.timer)
  }

  poll() {
    const run = async () => {
      try {
        await this.pollOnce()
        this.connected = true
      } catch (error) {
        this.connected = false
        this.trip(error)
      } finally {
        if (this.polling) {
          this.timer = setTimeout(run, Math.max(1500, this.config.pollIntervalMs || 2500))
          this.timer.unref?.()
        }
      }
    }
    void run()
  }

  async pollOnce() {
    const url = new URL(`${this.config.linuxApiUrl.replace(/\/$/, '')}/messages`)
    if (this.cursor) url.searchParams.set('since', this.cursor)
    const res = await fetch(url, {
      headers: this.config.linuxToken ? { authorization: `Bearer ${this.config.linuxToken}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`wechat linux ${res.status}`)
    const body = await res.json()
    if (body.cursor) this.cursor = String(body.cursor)
    for (const raw of body.messages || body.data || []) {
      const msg = normalizeWechatMessage(raw, 'wechat')
      if (!msg) continue
      if (!this.allowUser(msg.senderId)) continue
      if (msg.conversationType === 'group' && !this.allowConversation(msg.conversationId)) continue
      if (!this.rateOk(msg.conversationId)) continue
      this.deliver(msg)
    }
  }

  async sendText(conversationId, text) {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    const res = await fetch(`${this.config.linuxApiUrl.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.linuxToken ? { authorization: `Bearer ${this.config.linuxToken}` } : {}),
      },
      body: JSON.stringify({ conversationId, to: conversationId, text }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`wechat linux send ${res.status}`)
    this.failures = 0
  }

  status() {
    return {
      name: 'wechat',
      enabled: true,
      mode: 'linux',
      connected: this.connected,
      paused: this.breakerOpen(),
      allowUsers: this.config.allowUsers,
      allowGroups: this.config.allowGroups || [],
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt,
      cursor: this.cursor,
    }
  }
}


/**
 * Current agent-wechat native API (2026 upstream): /v1/accounts, /v1/threads,
 * /v1/threads/{id}/messages, /v1/sends. No CLI subprocess, no Xvfb.
 */
export class WechatNativeChannel extends BaseChannel {
  constructor(config) {
    super('wechat')
    this.config = config
    this.allowList = config.allowUsers || []
    this.accountId = String(config.accountId || '')
    this.threads = new Map()
    this.timer = null
    this.polling = false
    this.startedAt = Date.now()
  }

  base() {
    return String(this.config.apiBase || 'http://127.0.0.1:6174').replace(/\/$/, '')
  }

  async api(path, options = {}) {
    const res = await fetch(`${this.base()}/v1${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.config.apiToken || ''}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs || 15_000),
    })
    if (!res.ok) throw new Error(`wx api ${path}: HTTP ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

  async start() {
    this.polling = true
    const health = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(5000) })
    if (!health.ok) throw new Error(`wx daemon health ${health.status}`)
    await this.resolveAccount()
    this.poll()
  }

  async stop() {
    this.polling = false
    if (this.timer) clearTimeout(this.timer)
  }

  async resolveAccount() {
    const data = await this.api('/accounts')
    const items = Array.isArray(data) ? data : data.items || data.accounts || []
    const wanted = this.config.accountId
    const found = wanted ? items.find((item) => String(item.id ?? item.accountId) === String(wanted)) : items[0]
    const id = found?.id ?? found?.accountId ?? wanted
    if (!id) throw new Error('wx: 没有账号，先 wx accounts create + wx auth login')
    this.accountId = String(id)
    return this.accountId
  }

  poll() {
    const run = async () => {
      try {
        if (!this.accountId) await this.resolveAccount()
        await this.pollOnce()
        this.connected = true
        this.lastError = ''
      } catch (error) {
        this.connected = false
        this.trip(error)
      } finally {
        if (this.polling) {
          this.timer = setTimeout(run, Math.max(1000, Number(this.config.pollIntervalMs) || 3000))
          this.timer.unref?.()
        }
      }
    }
    void run()
  }

  async pollOnce() {
    const data = await this.api(`/accounts/${encodeURIComponent(this.accountId)}/threads?limit=50`)
    const items = Array.isArray(data) ? data : data.items || []
    for (const thread of items) {
      const threadId = String(thread.id ?? thread.threadId ?? thread.username ?? '')
      if (!threadId) continue
      const isGroup = thread.kind === 'group' || threadId.endsWith('@chatroom')
      if (isGroup && !this.allowConversation(threadId)) continue
      const last = thread.lastMessage || {}
      const lastId = String(last.id ?? '')
      const lastTime = Date.parse(last.time ?? last.createdAt ?? last.timestamp ?? 0) || 0
      const state = this.threads.get(threadId)
      if (!state) {
        // First sighting: remember the head and mark the whole visible tail as
        // seen, so a later fetch cannot replay stored history.
        this.threads.set(threadId, { lastId, lastTime })
        try {
          const page = await this.api(`/accounts/${encodeURIComponent(this.accountId)}/threads/${encodeURIComponent(threadId)}/messages?limit=20`)
          const seeded = Array.isArray(page) ? page : page.items || []
          for (const message of seeded) {
            const id = String(message.id ?? message.messageId ?? '')
            if (id) this.isDuplicate(id)
          }
        } catch {
          /* a failed seed must not stop the poll loop */
        }
        continue
      }
      if (lastId && lastId === state.lastId) continue
      if (!lastId && lastTime <= state.lastTime) continue
      let messages = []
      try {
        const page = await this.api(`/accounts/${encodeURIComponent(this.accountId)}/threads/${encodeURIComponent(threadId)}/messages?limit=10`)
        messages = Array.isArray(page) ? page : page.items || []
      } catch (error) {
        this.trip(error)
        continue
      }
      for (const message of [...messages].reverse()) this.consider(message, threadId, isGroup)
      this.threads.set(threadId, { lastId: lastId || state.lastId, lastTime: Math.max(lastTime, state.lastTime) })
    }
  }

  consider(message, threadId, isGroup) {
    const id = String(message.id ?? message.messageId ?? '')
    if (!id || this.isDuplicate(id)) return
    const direction = String(message.direction ?? '')
    if (direction === 'outgoing' || direction === 'outbound' || message.isSelf === true) return
    const senderId = String(
      message.senderId ?? message.from?.id ?? message.sender?.id ?? message.username ?? (isGroup ? '' : threadId),
    )
    if (!senderId || !this.allowUser(senderId)) return
    const text = String(message.body ?? message.text ?? message.content ?? '').trim()
    if (!text) return
    const rawTime = message.createdAt ?? message.time ?? message.timestamp
    const at = rawTime ? Date.parse(String(rawTime)) : Date.now()
    if (Number.isFinite(at) && at < this.startedAt - 60_000) return
    if (!this.rateOk(threadId)) return
    this.deliver({
      channel: 'wechat',
      conversationId: threadId,
      conversationType: isGroup ? 'group' : 'private',
      senderId,
      senderName: String(message.senderName ?? message.from?.name ?? message.sender?.name ?? senderId),
      text,
      at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
      messageId: id,
    })
  }

  async sendText(threadId, text) {
    if (this.breakerOpen()) throw new Error('wechat: 通道已熔断')
    for (const part of splitText(text, this.config.splitLength)) {
      const res = await fetch(`${this.base()}/v1/accounts/${encodeURIComponent(this.accountId)}/sends`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken || ''}`,
          'content-type': 'application/json',
          'idempotency-key': `whale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        body: JSON.stringify({ threadId, text: part }),
        signal: AbortSignal.timeout(35_000),
      })
      if (!res.ok && res.status !== 202) throw new Error(`wx send HTTP ${res.status}`)
    }
    this.failures = 0
  }

  status() {
    return {
      name: 'wechat',
      enabled: true,
      mode: 'native',
      connected: this.connected,
      paused: this.breakerOpen(),
      allowUsers: this.config.allowUsers,
      allowGroups: this.config.allowGroups || [],
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt,
      accountId: this.accountId,
      apiBase: this.base(),
      threads: this.threads.size,
    }
  }
}

/** Tolerant normalization for the several Linux-WeChat bridge field spellings. */
export function normalizeWechatMessage(raw, channel) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text ?? raw.content ?? raw.message ?? raw.msg ?? '').trim()
  const fromId = typeof raw.from === 'object' && raw.from ? raw.from.id : undefined
  const fromName = typeof raw.from === 'object' && raw.from ? raw.from.name : undefined
  const chatId = typeof raw.chat === 'object' && raw.chat ? raw.chat.id : undefined
  const chatType = typeof raw.chat === 'object' && raw.chat ? raw.chat.type : undefined
  if (raw.self === true || raw.isSelf === true || raw.fromSelf === true) return null
  const senderId = String(raw.senderId ?? fromId ?? raw.fromUser ?? raw.sender ?? raw.talker ?? raw.from ?? raw.userId ?? raw.wxid ?? '')
  if (!senderId) return null
  const mediaPath = String(raw.mediaPath ?? raw.filePath ?? raw.mediaFilePath ?? raw.path ?? raw.imagePath ?? raw.voicePath ?? raw.file?.path ?? '')
  const fileName = String(raw.fileName ?? raw.filename ?? raw.name ?? raw.file?.name ?? (mediaPath ? mediaPath.split('/').pop() : ''))
  const fileId = String(raw.fileId ?? raw.file_id ?? raw.mediaId ?? raw.file?.id ?? '')
  const url = String(raw.url ?? raw.mediaUrl ?? raw.fileUrl ?? raw.file?.url ?? '')
  const type = String(raw.type ?? raw.messageType ?? raw.msgType ?? raw.mediaType ?? '').toLowerCase()
  if (!text && !mediaPath && !fileId && !url) return null
  const rawConversation = raw.conversationId ?? raw.chatId ?? raw.roomId ?? chatId ?? fromId ?? senderId
  const conversationId = String(typeof rawConversation === 'object' && rawConversation ? rawConversation.id ?? senderId : rawConversation)
  const messageId = String(raw.id ?? raw.messageId ?? raw.msgId ?? '')
  return {
    id: messageId,
    channel,
    conversationId,
    conversationType: raw.isGroup || chatType === 'group' || String(conversationId).endsWith('@chatroom') || raw.chatType === 'group' ? 'group' : 'private',
    senderId,
    senderName: String(raw.senderName ?? raw.fromName ?? fromName ?? raw.nickname ?? senderId),
    text,
    type,
    mediaPath,
    fileName,
    fileId,
    url,
    size: Number(raw.size ?? raw.fileSize ?? raw.file?.size ?? 0) || 0,
    duration: Number(raw.duration ?? raw.voiceDuration ?? 0) || 0,
    at: new Date().toISOString(),
    messageId: String(raw.id ?? raw.messageId ?? raw.msgId ?? ''),
  }
}

export class ChannelManager {
  constructor(whale) {
    this.whale = whale
    this.channels = new Map()
    this.mapping = new Map()
    this.mappingPath = join(whale.dir, 'channel-sessions.json')
    this.load()
    this.chatModes = new ChatModes({
      store: whale.store,
      registry: whale.peerRegistry,
      config: whale.config,
      cfg: whale.config.agentMode,
      logger: whale.logger,
      audit: (row) => whale.social.appendChannelAudit(row),
    })
    this.onReply = whale.agentLayer.onReply((sessionId, text) => this.collectReply(sessionId, text))
    this.onTurnEnd = whale.agentLayer.onTurnEnd((sessionId) => this.flushReply(sessionId))
    this.pendingReplies = new Map()
    this.recentReplies = new Map()
    this.rounds = new Map()
    this.webServer = null
  }

  async start(webServer) {
    this.webServer = webServer
    if (!this.modeTimer) {
      this.modeTimer = setInterval(() => {
        const expired = this.chatModes.tick()
        for (const item of expired) {
          if (item.from !== 'agent') continue
          const sessionId = this.sessionFor(item.conversationId)
          const running = sessionId ? this.whale.ctx.get('agents')?.get?.(sessionId) : null
          try { running?.cancel?.({ kind: 'timeout' }) } catch { /* best effort */ }
        }
      }, 60_000)
      this.modeTimer.unref?.()
    }
    for (const channel of this.channels.values()) {
      try {
        await channel.start(webServer)
        if (channel.dispose) this.whale.ctx.effect(() => channel.dispose)
      } catch (error) {
        channel.trip(error)
        this.whale.logger.warn?.('whale-chan: channel start failed', error)
      }
    }
  }

  register(channel) {
    this.channels.set(channel.name, channel)
    channel.setHandler((msg) => void this.handle(channel.name, msg))
  }

  async handle(name, msg) {
    const channel = this.channels.get(name)
    if (!channel) return
    const peerKind = msg.conversationType === 'group' ? 'group' : 'direct'
    const mediaInfo = classifyMedia(msg)
    const hasMedia = mediaInfo.kind !== 'unsupported'
    if (hasMedia && !String(msg.text || '').trim()) {
      msg.text = fallbackText(mediaInfo.kind, 'pending')
    }
    let admission = null
    if (this.whale.peerRegistry) {
      const names = [this.whale.config.companionName].filter(Boolean)
      admission = admit({
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        kind: peerKind,
        text: msg.text,
        mentioned: msg.mentioned === true,
        companionName: this.whale.config.companionName,
        meta: { channel: name, senderName: msg.senderName || '' },
      }, {
        registry: this.whale.peerRegistry,
        isGroupAddressed: (text) => isGroupAddressed(text, names),
        logger: {
          log: (row) => {
            try {
              this.whale.social.appendChannelAudit({
                at: row.at,
                action: 'admission',
                id: row.peerId || row.conversationId,
                kind: row.kind,
                actor: 'system',
                reason: row.reason,
                conversationId: row.conversationId,
                senderId: row.senderId,
                meta: { allow: row.allow, channel: name },
              })
            } catch { /* audit must never block a message */ }
          },
        },
      })
      if (!admission.allow) {
        if (admission.needArchive) {
          const archivedPeer = peerIdFor(name, admission.peerId || msg.conversationId, peerKind)
          this.whale.store.addEpisode({
            sessionId: '', channel: name, role: 'user', text: msg.text,
            peerId: archivedPeer, speakerId: msg.senderId || '',
          })
        }
        this.whale.store.health('channel_admission', {
          ok: false, channel: name, reason: admission.reason, at: Date.now(),
        })
        return
      }
    }
    const rawPeerId = admission?.peerId || msg.conversationId
    const authorized = this.chatModes.authorize({
      peerId: rawPeerId,
      senderId: msg.senderId,
      peerKind,
    })
    let mediaEpisode = null
    if (hasMedia) {
      const mediaSessionId = this.sessionFor(msg.conversationId) || this.newSessionId(msg)
      this.bind(msg.conversationId, mediaSessionId)
      msg.sessionId = mediaSessionId
      msg.mediaType = mediaInfo.kind
      if (this.whale.media) {
        const result = await this.whale.media.ingest({
          ...msg,
          peerId: peerIdFor(name, rawPeerId, peerKind),
        })
        if (result.ok && result.episode) mediaEpisode = result.episode
        msg.text = String(result.text || fallbackText(mediaInfo.kind, 'extract_failed')).trim()
      } else {
        msg.text = fallbackText(mediaInfo.kind, 'media_disabled')
      }
    }
    const modeResult = this.chatModes.advance({
      conversationId: msg.conversationId,
      text: msg.text,
      isGroup: peerKind === 'group',
      authorized,
      senderId: msg.senderId,
    })
    if (modeResult.reset) {
      const runningSession = this.sessionFor(msg.conversationId)
      const running = runningSession ? this.whale.ctx.get('agents')?.get?.(runningSession) : null
      try {
        running?.cancel?.({ kind: 'user' })
      } catch (error) {
        this.whale.logger?.warn?.('whale-chan: cancel on reset failed', error)
      }
    }
    if (modeResult.reply) {
      try {
        await this.sendText(name, msg.conversationId, modeResult.reply)
      } catch (error) {
        this.whale.logger?.warn?.('whale-chan: mode reply failed', error)
      }
    }
    if (modeResult.stop) return
    const effectiveText = modeResult.taskText || msg.text
    const peerId = peerIdFor(name, rawPeerId, peerKind)
    const round = (this.rounds.get(msg.conversationId) || 0) + 1
    this.rounds.set(msg.conversationId, round)
    if (shouldSelfCheck(round)) {
      const drift = driftScan(this.recentReplies.get(msg.conversationId) || [])
      try {
        this.whale.store.health('voice_drift', {
          ok: !drift.drifted, channel: name, conversationId: msg.conversationId,
          round, hits: drift.hits, perHundred: drift.perHundred, at: Date.now(),
        })
      } catch { /* health is best effort */ }
    }
    if (authorized && peerKind === 'direct') {
      if (effectiveText.length <= 40) this.captureVoiceFeedback(effectiveText)
      if (/(就这样说|这句好|以后就这么说|记住这个语气|这个语气好)/.test(effectiveText)) {
        this.captureVoiceExample(peerId)
      }
    }
    this.whale.social.ensurePeer({
      id: peerId,
      channel: name,
      peerKind,
      displayName: msg.senderName || '',
      at: Date.now(),
    })
    if (peerKind === 'group' && this.whale.config.groupReplyMode !== 'all') {
      const names = [this.whale.config.companionName].filter(Boolean)
      if (!isGroupAddressed(msg.text, names)) {
        this.whale.store.addEpisode({
          sessionId: '', channel: name, role: 'user', text: msg.text,
          peerId, speakerId: msg.senderId || '',
        })
        this.whale.store.health('group_archived', { ok: true, channel: name, peerId, speakerId: msg.senderId || '', at: Date.now() })
        return
      }
    }
    let attitudeResult = null
    if (this.whale.attitudes && authorized) {
      try {
        const groupNames = [this.whale.config.companionName].filter(Boolean)
        const context = this.whale.social.peerContext(peerId) || { commitments: [] }
        attitudeResult = await this.whale.attitudes.handle({
          id: msg.id || `in-${Date.now()}`,
          conversationId: msg.conversationId,
          senderId: msg.senderId || '',
          peerId,
          text: effectiveText,
          at: Date.now(),
        }, {
          isGroup: peerKind === 'group',
          isAddressed: peerKind === 'group' ? isGroupAddressed(effectiveText, groupNames) : true,
          hasCommitment: (context.commitments || []).length > 0,
          hasUnfinishedNarrative: (this.whale.social.listOpenChapters?.(peerId) || []).length > 0,
          mood: { valence: Number(this.whale.growth?.currentMood?.() || 0) },
          skipEpisode: Boolean(mediaEpisode),
        })
      } catch (error) {
        this.whale.logger?.warn?.('whale-chan: attitude handling failed', error)
        attitudeResult = null
      }
      if (attitudeResult?.action === 'silent') {
        this.whale.store.health('attitude_silent', {
          ok: true, channel: name, peerId, reason: attitudeResult.reason, at: Date.now(),
        })
        return
      }
    }
    const sessionId = this.sessionFor(msg.conversationId) || this.newSessionId(msg)
    this.bind(msg.conversationId, sessionId)
    this.pendingReplies.set(sessionId, {
      channel: name,
      conversationId: msg.conversationId,
      peerId,
      texts: [],
      at: Date.now(),
      attitudeBlock: attitudeResult?.promptBlock || '',
      voiceCtx: {
        emojiCtx: {
          userEmoji: hasEmoji(effectiveText) ? 1 : 0,
          mood: (() => {
            try { return this.whale.store?.kvGet?.('cognition:mood', {}) || {} } catch (err) { return {} }
          })(),
        },
        scene: inferScene(effectiveText),
        userText: effectiveText,
      },
    })
    try {
      const agentMode = this.chatModes.stateFor(msg.conversationId).mode
      const agent = await this.whale.ensureChannelAgent(sessionId, name, {
        peerId,
        peerKind,
        displayName: msg.senderName || '',
        speakerId: msg.senderId || '',
        mode: agentMode,
      })
      this.whale.agentLayer.setChannelMode(sessionId, agentMode)
      {
        const state = this.whale.agentLayer.states.get(sessionId)
        if (state) {
          if (mediaEpisode || attitudeResult) state.skipUserEpisode = true
          state.attitudeBlock = attitudeResult?.promptBlock || ''
        }
      }
      const prefix = msg.conversationType === 'group' ? `[来自 QQ 群聊，${msg.senderName}]` : `[来自 ${name === 'qq' ? 'QQ' : '微信'}，${msg.senderName}]`
      agent.followup({
        role: 'user',
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        content: [{ type: 'text', text: `${prefix} ${effectiveText}` }],
        source: { kind: 'user' },
      })
    } catch (error) {
      channel.trip(error)
      this.whale.store.health('channel', { ok: false, channel: name, error: String(error?.message || error), at: Date.now() })
    }
  }

  collectReply(sessionId, text) {
    const pending = this.pendingReplies.get(sessionId)
    if (!pending) return
    pending.texts.push(text)
  }

  flushReply(sessionId) {
    const pending = this.pendingReplies.get(sessionId)
    if (!pending) return
    this.pendingReplies.delete(sessionId)
    let text = pending.texts.join('\n').trim()
    const checkin = this.chatModes?.complete(pending.conversationId) || ''
    if (checkin) text = text ? `${text}\n${checkin}` : checkin
    if (!text) return
    const channel = this.channels.get(pending.channel)
    if (!channel) return
    const [min, max] = channel.config.replyDelayMs || [800, 2000]
    const delay = min + Math.random() * Math.max(0, max - min)
    setTimeout(() => {
      void this.deliverReply(pending, text).catch((error) => {
        channel.trip(error)
        this.whale.store.health('channel', { ok: false, channel: pending.channel, error: String(error?.message || error), at: Date.now() })
      })
    }, delay).unref?.()
  }

  captureVoiceExample(peerId) {
    const last = this.whale.store.listEpisodes({ peerId, limit: 8 })
      .filter((row) => row.role === 'assistant' && String(row.text || '').trim().length > 1)
      .pop()
    if (last) this.whale.store.addVoiceExample({ peerId, text: last.text, context: 'owner_liked', liked: true, at: Date.now() })
  }

  captureVoiceFeedback(text) {
    void feedbackToRule(text)
      .then((rule) => {
        if (rule) this.whale.store.addVoiceRule(rule)
      })
      .catch(() => {})
  }

  async deliverReply(pending, text) {
    const polished = await this.polishVoice(text, pending.conversationId)
    const mode = this.chatModes?.stateFor(pending.conversationId)?.mode || 'chat'
    await this.sendText(pending.channel, pending.conversationId, polished, { ...(pending.voiceCtx || {}), mode })
    if (pending.peerId && this.whale.attitudes) {
      try { await this.whale.attitudes.onReplied(pending.peerId) } catch (error) {
        this.whale.logger?.warn?.('whale-chan: attitude onReplied failed', error)
      }
    }
  }

  /** STEP 18: structure checker. It returns to the generator only when the
   * score is low; the post-processor remains the fallback, not the main act. */
  async polishVoice(text, conversationId) {
    const cfg = this.whale.config || {}
    if (cfg.voiceRewriteEnabled === false) return text
    if (this.chatModes?.stateFor?.(conversationId)?.mode !== 'chat') return text
    const before = needsRewrite(text, cfg.voiceRewriteThreshold || 60)
    if (!before.need) return text
    try {
      this.whale.store.health('voice_shape', {
        ok: true, score: before.score, issues: before.fixes.map((f) => f.issue), at: Date.now(),
      })
    } catch { /* health is best effort */ }
    if (!this.whale.digest?.available?.()) return text
    try {
      const reply = await this.whale.digest.complete(
        `把下面这条微信回复改得更像人在打字。保留全部事实、承诺和未决事项，不新增细节，不解释，不列点；能一句说完就一句，长短句分开，最多两句。只输出改写后的正文。\n\n${text}`,
        { maxTokens: 180, temperature: 0.8 },
      )
      const cleaned = cleanVoice(reply, {
        maxChars: cfg.voiceCleanMaxChars || 80,
        maxBubbles: cfg.voiceCleanMaxBubbles || 2,
        aiTells: cfg.voiceAiTellsEnabled !== false,
        poeticEnabled: cfg.voicePoeticEnabled !== false,
        styleEnabled: false,
      })
      // 重写后被硬上限截掉的部分不能吞掉：宁可回退原文，也不发残缺版本。
      if (cleaned.dropped) return text
      const after = needsRewrite(cleaned.text, cfg.voiceRewriteThreshold || 60)
      this.whale.store.health('voice_rewrite', {
        ok: true, before: before.score, after: after.score, at: Date.now(),
      })
      return after.score >= before.score ? cleaned.text : text
    } catch (error) {
      this.whale.store.health('voice_rewrite', { ok: false, error: String(error?.message || error), at: Date.now() })
      return text
    }
  }

  /** STEP 25: L0 不是发送开关。先退回生成层重写一次；仍不过再降级原文。
   * 只有身份泄露/角色矛盾这类真会越界的内容才允许丢弃。 */
  async rewriteL0(text, violations, scene) {
    if (!this.whale.digest?.available?.()) return []
    try {
      const why = (violations || []).map((v) => v.why).join('；')
      const reply = await this.whale.digest.complete(
        `把下面这条微信回复改写一遍。不要暴露 AI/助手身份，不要用 Markdown 标题、列表或粗体，不要客服腔，不要重复原句。保留事实和承诺，不新增细节。只输出改写后的正文。\n违规点：${why || '不够自然'}\n\n${text}`,
        { maxTokens: 180, temperature: 0.6 },
      )
      const cleaned = cleanVoice(reply, {
        maxChars: this.whale.config?.voiceCleanMaxChars || 80,
        maxBubbles: this.whale.config?.voiceCleanMaxBubbles || 2,
        styleEnabled: false,
        ackMerge: true,
      })
      const parts = (cleaned.bubbles || []).map((p) => String(p || '').trim()).filter(Boolean)
      return parts.length ? parts : (cleaned.text ? [cleaned.text] : [])
    } catch (error) {
      this.whale.store.health('voice_l0', { ok: false, phase: 'rewrite', error: String(error?.message || error), scene, at: Date.now() })
      return []
    }
  }

  async sendText(channelName, conversationId, text, ctx = {}) {
    const channel = this.channels.get(channelName)
    if (!channel) throw new Error(`whale-chan: 通道 ${channelName} 未注册`)
    const registry = this.whale.peerRegistry
    if (registry) {
      const raw = String(conversationId || '').replace(/^private:/, '')
      const kind = raw.startsWith('group:') ? 'group' : 'direct'
      if (!registry.isAllowed(raw, kind)) throw new Error('whale-chan: 目标未登记，拒绝发送')
    }
    const cfg = this.whale?.config || {}
    let outgoing = String(text ?? '')
    if (cfg.voiceCleanEnabled !== false && outgoing.trim()) {
      const cleaned = cleanVoice(outgoing, {
        maxChars: cfg.voiceCleanMaxChars || 80,
        maxBubbles: cfg.voiceCleanMaxBubbles || 2,
        aiTells: cfg.voiceAiTellsEnabled !== false,
        poeticEnabled: cfg.voicePoeticEnabled !== false,
        styleEnabled: cfg.voiceStyleEnabled === true && ctx.mode !== 'agent',
        styleTypoRate: cfg.voiceStyleTypoRate || 0,
      }, {
        band: ctx.band,
        emojiCtx: ctx.emojiCtx || {},
        rand: ctx.rand,
      })
      if (cleaned.dropped) {
        // 只有单条超过 80 字才允许截；非空时必须留下痕迹，不能静默丢。
        try {
          this.whale.store.health('voice_dropped', {
            ok: true, channel: channelName, conversationId: String(conversationId || ''),
            chars: cleaned.dropped.length, at: Date.now(),
          })
        } catch { /* health is best effort */ }
        console.warn('[voice] trimmed tail', { channel: channelName, chars: cleaned.dropped.length })
      }
      const bubbles = (cleaned.bubbles || []).map((part) => String(part || '').trim()).filter(Boolean)
      outgoing = bubbles.length ? bubbles : [cleaned.text].filter(Boolean)
    } else {
      outgoing = [outgoing].filter((part) => String(part || '').trim())
    }
    if (!outgoing.length) return
    const recent = this.recentReplies.get(conversationId) || []
    // STEP 23: 极短应答连续重复时换一个同义说法；不动有信息量的句子。
    if (outgoing.length === 1) {
      const short = outgoing[0]
      const acks = new Set(['行', '可以', '嗯', '好', '收到', '明白', '懂了', '对', '是'])
      if (acks.has(short) && recent.includes(short)) {
        const alt = pickFrom('ok', { avoid: recent })
        if (alt) outgoing[0] = alt
      }
    }
    const joined = outgoing.join('\n')
    const scene = ctx.mode === 'agent' ? 'task' : (ctx.scene || 'chat')
    const grice = checkGrice(joined, {
      scene,
      userText: ctx.userText,
      expectShort: scene === 'chat' || scene === 'emotion',
    })
    const repeat = repetitionCheck(joined, recent)
    const l0 = l0Gate(joined, { scene })
    try {
      this.whale.store.health('voice_grice', {
        ok: grice.ok, channel: channelName, conversationId: String(conversationId || ''),
        scene, score: grice.score, violations: grice.violations, at: Date.now(),
      })
      if (!repeat.ok) {
        this.whale.store.health('voice_repeat', {
          ok: false, channel: channelName, conversationId: String(conversationId || ''),
          repeated: repeat.repeated, at: Date.now(),
        })
      }
      if (!l0.pass) {
        this.whale.store.health('voice_l0', {
          ok: false, channel: channelName, conversationId: String(conversationId || ''),
          violations: l0.violations, at: Date.now(),
        })
      }
    } catch { /* health is best effort */ }
    if (!l0.pass) {
      // STEP 25: 先重写一次；仍不过就降级清洗前原文。只有越界内容才允许丢弃。
      const codes = l0.violations.map((v) => v.code)
      const fatal = codes.some((c) => c === 'identity_leak' || c === 'persona_conflict')
      let recovered = ''
      const retried = await this.rewriteL0(joined, l0.violations, scene)
      if (retried.length) {
        const second = l0Gate(retried.join('\n'), { scene })
        if (second.pass) {
          outgoing = retried
          recovered = 'rewrite'
        }
      }
      if (!recovered && !fatal) {
        const fallback = String(text ?? '').trim()
        if (fallback) {
          outgoing = [fallback]
          recovered = 'fallback'
        }
      }
      try {
        this.whale.store.health('voice_l0', {
          ok: !!recovered, channel: channelName, conversationId: String(conversationId || ''),
          violations: l0.violations, recovered, at: Date.now(),
        })
      } catch { /* health is best effort */ }
      if (!recovered) {
        console.warn('[voice] L0 blocked', { channel: channelName, violations: codes, dropped: joined.slice(0, 120) })
        return
      }
    }
    for (const part of outgoing) await channel.sendText(conversationId, part)
    try {
      recent.push(...outgoing)
      while (recent.length > 30) recent.shift()
      this.recentReplies.set(conversationId, recent)
    } catch { /* best effort */ }
  }

  async sendMedia(channelName, conversationId, media, ctx = {}) {
    const channel = this.channels.get(channelName)
    if (!channel) throw new Error(`whale-chan: 通道 ${channelName} 未注册`)
    if (typeof channel.sendMedia !== 'function') throw new Error(`whale-chan: 通道 ${channelName} 不支持发送媒体`)
    const registry = this.whale.peerRegistry
    if (registry && !ctx.agentBypass) {
      const raw = String(conversationId || '').replace(/^private:/, '')
      const kind = raw.startsWith('group:') ? 'group' : 'direct'
      if (!registry.isAllowed(raw, kind)) throw new Error('whale-chan: 目标未登记，拒绝发送')
    }
    const data = String(media?.data ?? media?.base64 ?? '')
    if (!data) throw new Error('whale-chan: 媒体数据为空')
    await channel.sendMedia(conversationId, { kind: String(media?.kind || 'file'), data, fileName: media?.fileName || '' })
    try {
      this.whale.store.kvSet?.('life:lastProactiveMedia', {
        at: Date.now(),
        channel: channelName,
        to: String(conversationId),
        kind: String(media?.kind || 'file'),
      })
    } catch { /* best effort */ }
  }

  get(name) {
    return this.channels.get(name)
  }

  list() {
    return [...this.channels.values()].map((channel) => channel.status())
  }

  resume(name) {
    this.channels.get(name)?.reset()
  }

  conversationIds() {
    return [...this.mapping.keys()]
  }

  sessionFor(conversationId) {
    return this.mapping.get(conversationId)
  }

  bind(conversationId, sessionId) {
    this.mapping.set(conversationId, sessionId)
    this.save()
  }

  newSessionId(msg) {
    const safe = `${msg.channel}-${msg.conversationId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
    return `session-whale-${safe}-${Math.random().toString(36).slice(2, 8)}`
  }

  load() {
    try {
      if (!existsSync(this.mappingPath)) return
      const raw = JSON.parse(readFileSync(this.mappingPath, 'utf8'))
      for (const [key, value] of Object.entries(raw)) this.mapping.set(key, String(value))
    } catch {
      /* corrupt mapping is ignored */
    }
  }

  save() {
    try {
      ensureDir(this.whale.dir)
      writeFileSync(this.mappingPath, JSON.stringify(Object.fromEntries(this.mapping), null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  /** Build one channel from an explicit config (used by config and by runtime enable). */
  buildOne(name, config) {
    if (name === 'qq') return new OneBotChannel(config)
    if (config.mode === 'native') return new WechatNativeChannel(config)
    return config.mode === 'linux' ? new WechatLinuxChannel(config) : new WeChatBridgeChannel(config)
  }

  /** Start a channel at runtime (console diagnostics); config is not persisted. */
  async enable(name, overrides = {}) {
    if (name !== 'qq' && name !== 'wechat') throw new Error(`unknown channel: ${name}`)
    const base = name === 'qq' ? this.whale.config.channels.qq : this.whale.config.channels.wechat
    const merged = { ...base, ...overrides, enabled: true }
    merged.allowUsers = overrides.allowUsers || base.allowUsers || []
    merged.allowGroups = overrides.allowGroups || base.allowGroups || []
    const existing = this.channels.get(name)
    if (existing) await existing.stop()
    const channel = this.buildOne(name, merged)
    this.register(channel)
    await channel.start(this.webServer)
    if (channel.dispose) this.whale.ctx.effect(() => channel.dispose)
    return channel.status()
  }

  async disable(name) {
    const channel = this.channels.get(name)
    if (!channel) return false
    await channel.stop()
    this.channels.delete(name)
    return true
  }

  async stopAll() {
    if (this.modeTimer) {
      clearInterval(this.modeTimer)
      this.modeTimer = null
    }
    for (const channel of this.channels.values()) {
      try {
        await channel.stop()
      } catch {
        /* ignore */
      }
    }
    this.onReply?.()
    this.onTurnEnd?.()
  }
}

export function buildChannels(whale) {
  const manager = new ChannelManager(whale)
  const qq = whale.config.channels.qq
  if (qq.enabled) manager.register(manager.buildOne('qq', qq))
  const wechat = whale.config.channels.wechat
  if (wechat.enabled) manager.register(manager.buildOne('wechat', wechat))
  return manager
}
