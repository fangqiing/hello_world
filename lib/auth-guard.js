/**
 * STEP 11 / P0-1 — request boundary for every hello-world / whale-chan route.
 * STEP 17 — Caddy proxy hardening + HttpOnly session cookie.
 *
 * Browser pages receive an HttpOnly, SameSite=Strict session cookie when an
 * HTML page is served. That cookie carries the API token; page JavaScript never
 * reads it and never sends a shared `x-whale-chan` value. A direct remote client
 * may authenticate with `Authorization: Bearer <token>`.
 *
 * Behind Caddy the socket is always loopback, so Caddy strips
 * `x-whale-from`, injects `x-whale-from: caddy` and the original client in
 * `x-forwarded-for`, and the guard only trusts that marker from a configured
 * proxy socket. This path is optional when the browser already has the cookie.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const PROXY_MARKER = 'caddy'
export const SESSION_COOKIE = 'whale_chan_session'

let runtime = { token: '', trustedProxies: [] }

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function same(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length !== y.length) return false
  try { return timingSafeEqual(x, y) } catch { return false }
}

function ipOf(req) {
  return String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
}

function loopback(req) {
  return LOCAL.has(ipOf(req))
}

function htmlNavigation(req) {
  return String(req?.method || 'GET').toUpperCase() === 'GET' &&
    String(req?.headers?.accept || '').includes('text/html')
}

function originOk(req) {
  const origin = String(req?.headers?.origin || '')
  if (!origin) return true
  try {
    const originHost = new URL(origin).host
    const requestHost = String(req?.headers?.host || '')
    return Boolean(originHost) && originHost === requestHost
  } catch {
    return false
  }
}

function cookieToken(req) {
  const raw = String(req?.headers?.cookie || '')
  for (const part of raw.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== SESSION_COOKIE) continue
    return part.slice(at + 1).trim()
  }
  return ''
}

function setSessionCookie(req, res) {
  if (!runtime.token || !res || typeof res.setHeader !== 'function') return
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const secure = req?.socket?.encrypted === true || proto === 'https'
  const parts = [
    `${SESSION_COOKIE}=${runtime.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=86400',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('set-cookie', parts.join('; '))
}

export function configureAuth({ token = '', trustedProxies = [] } = {}) {
  runtime = {
    token: String(token || ''),
    trustedProxies: Array.isArray(trustedProxies) ? trustedProxies.map(String) : [],
  }
}

export function apiTokenPath(dir) {
  return join(dir, '.api-token')
}

/** Create the token once; never rotate silently. */
export function ensureApiToken(dir) {
  if (!dir) return ''
  const path = apiTokenPath(dir)
  if (existsSync(path)) {
    try {
      const token = readFileSync(path, 'utf8').trim()
      if (token.length >= 32) return token
    } catch { /* fall through and regenerate */ }
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
  return token
}

/**
 * True only for a trusted source. A Caddy-proxied request is trusted only
 * when the direct socket peer is explicitly configured and Caddy's stripped +
 * re-injected marker is present. The rightmost XFF hop is the original client.
 */
export function clientTrust(req) {
  const socketIp = ipOf(req)
  const marker = String(req?.headers?.['x-whale-from'] || '').toLowerCase()
  const trustedProxy = runtime.trustedProxies.includes(socketIp)

  if (marker) {
    if (!trustedProxy || marker !== PROXY_MARKER) {
      return { trusted: false, viaProxy: true, local: false, clientIp: '' }
    }
    const raw = String(req?.headers?.['x-forwarded-for'] || '').trim()
    if (!raw) return { trusted: false, viaProxy: true, local: false, clientIp: '' }
    const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
    const last = String(parts[parts.length - 1] || '').replace(/^::ffff:/, '')
    if (!last) return { trusted: false, viaProxy: true, local: false, clientIp: '' }
    return { trusted: true, viaProxy: true, local: LOCAL.has(last), clientIp: last }
  }

  // Direct local access (dev / a local browser opening 127.0.0.1:3080). This
  // path still uses the CSRF header below; it is not reachable from a remote
  // socket.
  if (LOCAL.has(socketIp)) return { trusted: true, viaProxy: false, local: true, clientIp: socketIp }
  return { trusted: false, viaProxy: false, local: false, clientIp: socketIp }
}

/**
 * Return false after writing the response when the request is not allowed.
 * Never echo the path, token, stack, or reason to the client.
 */
export function guard(req, res, method, options = {}) {
  const requestMethod = String(req?.method || 'GET').toUpperCase()
  if (method && requestMethod !== String(method).toUpperCase()) {
    json(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }

  const source = clientTrust(req)
  const local = loopback(req)
  const allowHtml = options.allowHtml === true
  const expected = runtime.token
  const raw = String(req?.headers?.authorization || '')
  const presented = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : ''
  const fromCookie = cookieToken(req)
  const tokenOk = Boolean(expected) && (
    (Boolean(presented) && same(presented, expected)) ||
    (Boolean(fromCookie) && same(fromCookie, expected))
  )

  // A direct remote client may authenticate with the bearer token or a valid
  // HttpOnly session cookie. A proxied request normally relies on Caddy's
  // Basic auth + marker, but is also allowed to carry either credential.
  if (!source.trusted && !(!local && tokenOk)) {
    json(res, 401, { ok: false, error: 'unauthorized' })
    return false
  }

  if (source.viaProxy) {
    if (!source.trusted) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return false
    }
  } else if (local) {
    // HTML navigation is allowed so the page can receive the HttpOnly session
    // cookie; every API call then uses that cookie.
    if (!tokenOk && !allowHtml) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return false
    }
  } else if (!tokenOk) {
    json(res, 401, { ok: false, error: 'unauthorized' })
    return false
  }

  if (allowHtml && requestMethod === 'GET') setSessionCookie(req, res)

  if (WRITE_METHODS.has(requestMethod)) {
    if (source.viaProxy) {
      // Caddy's Basic auth is the credential; same-origin checks the browser
      // Origin against the proxied Host.
    } else if (!source.trusted && !local) {
      const tokenHeader = String(req?.headers?.['x-whale-token'] || '')
      if (!same(tokenHeader, runtime.token)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return false
      }
    }
    if (!originOk(req)) {
      json(res, 403, { ok: false, error: 'forbidden' })
      return false
    }
  }

  return true
}

export function trustedRequest(req) {
  const token = cookieToken(req)
  return Boolean(runtime.token) && Boolean(token) && same(token, runtime.token)
}

export function isTrustedToken(value) {
  return Boolean(runtime.token) && same(value, runtime.token)
}
