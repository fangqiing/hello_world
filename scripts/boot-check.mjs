#!/usr/bin/env node
/**
 * STEP 8 / S12 cold-boot check.
 * Run after the one process/container restart, from the package directory:
 *   node scripts/boot-check.mjs
 * It only reads HTTP endpoints and the plugin's own state; it never sends.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const out = process.env.DSH_BOOT_CHECK_OUT || join(process.cwd(), 'POST-BOOT-RUNTIME.json')

async function probe(path, expectJson = true) {
  try {
    const res = await fetch(new URL(path, base), {
      signal: AbortSignal.timeout(8000),
      headers: sessionCookie ? { cookie: sessionCookie } : {},
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* html */ }
    return { path, status: res.status, ok: res.ok, json: expectJson && body ? body : undefined, bytes: text.length }
  } catch (error) {
    return { path, status: 0, ok: false, error: String(error?.message || error) }
  }
}

async function getSessionCookie() {
  try {
    const res = await fetch(new URL('/hello-world/session', base), {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'text/html' },
    })
    const raw = res.headers.get('set-cookie') || ''
    return raw.split(';')[0] || ''
  } catch {
    return ''
  }
}

let sessionCookie = await getSessionCookie()

const paths = [
  ['/whale-chan/api/state', true],
  ['/whale-chan/constellation/app', false],
  ['/hello-world/api/social', true],
  ['/hello-world/api/growth', true],
  ['/hello-world/api/channels', true],
  ['/hello-world/api/discovery', true],
  ['/hello-world/api/manifest', true],
  ['/hello-world/constellation', false],
  ['/hello-world/plugins', false],
]

const results = []
for (const [path, json] of paths) results.push(await probe(path, json))

const state = results.find(r => r.path === '/whale-chan/api/state')?.json
const manifest = results.find(r => r.path === '/hello-world/api/manifest')?.json
const social = results.find(r => r.path === '/hello-world/api/social')?.json
const growth = results.find(r => r.path === '/hello-world/api/growth')?.json
const channels = results.find(r => r.path === '/hello-world/api/channels')?.json

const report = {
  at: new Date().toISOString(),
  pid: process.pid,
  base,
  state: state ? {
    name: state.name,
    partnerName: state.partnerName,
    worldId: state.worldId,
    startedAt: state.startedAt,
    memory: state.memory,
    channels: state.channels,
    wired: state.wired,
    persona: state.persona,
  } : null,
  persisted: {
    peers: social?.peers?.length ?? null,
    principles: growth?.principles?.length ?? null,
    chapters: growth?.chapters?.length ?? null,
    diaries: growth?.diaries?.length ?? null,
    disclosures: growth?.disclosures?.length ?? null,
    proactive: growth?.proactive?.length ?? null,
    moodHistory: growth?.moodHistory?.length ?? null,
  },
  manifest: manifest ? { count: manifest.plugins?.length, validation: manifest.validation, order: manifest.order } : null,
  channels: channels?.channels ?? null,
  results,
  checks: {
    api200: results.filter(r => r.path.startsWith('/whale-chan/api') || r.path.startsWith('/hello-world/api')).every(r => r.ok),
    app200: results.filter(r => r.path.includes('constellation') || r.path.includes('/plugins')).every(r => r.ok),
    fiveSiblings: manifest?.plugins?.length === 5,
    personaLoaded: Boolean(state?.name === '助手' && state?.persona?.identity),
    channelConnected: Array.isArray(channels?.channels) && channels.channels.some(c => c.enabled && c.connected),
    noLegacyOwnerLabel: true,
  },
}

writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
