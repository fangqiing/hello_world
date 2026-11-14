import {
  JOB,
  acceptedResponse,
  completionNote,
  createJob,
  failureNote,
  progressOf,
  shouldNotify,
  transition,
} from './read-job.js'

function peerParts(peerId) {
  const parts = String(peerId || '').split(':')
  if (parts.length < 3) return null
  return { channel: parts[0], conversationId: parts.slice(2).join(':') }
}

/**
 * STEP 27: HTTP request only enqueues. The fusion pipeline runs in the
 * background; the owner gets one human-sounding completion note.
 */
export class ReadJobRunner {
  constructor({ store, reading, social = null, channels = null, clock = () => Date.now() } = {}) {
    Object.assign(this, { store, reading, social, channels, clock })
    this.recoverOrphaned()
  }

  /**
   * A background job lives only in this process. If the web process restarts,
   * its row can stay queued/running forever and block every later read (409).
   * Only touch jobs created before this process started, so a hot reload does
   * not kill a job that is still alive in the current process.
   */
  recoverOrphaned({ processStartedAt = Date.now() - Math.round(process.uptime() * 1000) } = {}) {
    if (!this.store?.listReadJobs || !this.store?.updateReadJob) return 0
    let stale = []
    try {
      stale = this.store.listReadJobs(500).filter((job) =>
        (job.status === 'queued' || job.status === 'running') && job.createdAt < processStartedAt)
    } catch { return 0 }
    for (const job of stale) {
      this.store.updateReadJob(job.id, {
        status: 'failed',
        error: 'restart_interrupted',
        updatedAt: this.clock(),
      })
    }
    return stale.length
  }

  start({ title = '', source = 'book', text = '', chapters = [], mode = 'book', peerId = null } = {}) {
    const active = this.store.findActiveReadJob(peerId)
    if (active) {
      return {
        status: 409,
        body: {
          ok: false,
          busy: true,
          jobId: active.id,
          status: active.status,
          progress: progressOf(active),
          message: '上一本还在看，等我看完。',
        },
      }
    }
    const seed = createJob({ title: String(title || '').trim() || '未命名', chapters: chapters.length, mode, now: this.clock() })
    const peer = peerParts(peerId)
    const job = this.store.createReadJob({
      ...seed,
      peerId: peerId || null,
      channel: peer?.channel || '',
      chapters: chapters.length,
    })
    const payload = { title: seed.title, source, text: String(text || ''), chapters, mode, peerId: peerId || null }
    setImmediate(() => { void this.run(job.id, payload) })
    return { status: 202, body: acceptedResponse(job) }
  }

  async run(id, payload) {
    const before = this.store.getReadJob(id)
    if (!before) return
    const running = transition(before, JOB.RUNNING, { now: this.clock() })
    if (running.ok) this.store.updateReadJob(id, running.job)
    try {
      const result = await this.reading.readBook({
        title: payload.title,
        source: payload.source,
        text: payload.text,
        chapters: payload.chapters,
        mode: payload.mode,
        actor: 'user',
        peerId: payload.peerId,
        onProgress: (p) => {
          const done = Math.min(
            Math.max(0, payload.chapters.length || 0),
            Math.max(0, Number(p?.done) || 0),
          )
          this.store.updateReadJob(id, { doneChapters: done })
          this.store.health?.('read_job', { jobId: id, done, total: Number(p?.total) || 0, at: this.clock() })
        },
      })
      const events = Array.isArray(result?.events) ? result.events : []
      const principles = events.filter((event) => event?.principle).length
      const parsed = result?.reading || {}
      const done = transition(this.store.getReadJob(id), JOB.DONE, {
        now: this.clock(),
        doneChapters: payload.chapters.length,
      })
      const job = done.ok
        ? this.store.updateReadJob(id, {
          ...done.job,
          readingId: result?.readingId || null,
          principles,
        })
        : null
      if (job) await this.notify(job, {
        principles,
        title: payload.title,
        chapterCount: parsed.chapterCount || payload.chapters.length,
        frontChars: parsed.frontChars || 0,
        ocrSuspect: parsed.ocrSuspect || false,
      })
    } catch (error) {
      const failed = transition(this.store.getReadJob(id), JOB.FAILED, {
        now: this.clock(),
        error: String(error?.message || error),
      })
      if (failed.ok) {
        const job = this.store.updateReadJob(id, failed.job)
        await this.notify(job, { principles: 0, title: payload.title, failed: true })
      }
    }
  }

  async notify(job, { principles = 0, title = '', chapterCount = 0, frontChars = 0, ocrSuspect = false, failed = false } = {}) {
    if (!job || job.notified === true) return
    if (!failed && !shouldNotify(job)) return
    const peer = peerParts(job.peerId)
    const text = failed ? failureNote(job) : completionNote(job, { principles, title, chapterCount, frontChars, ocrSuspect })
    let sent = false
    let reason = ''
    if (!peer) reason = 'no_peer'
    else if (!this.channels?.channels?.has(peer.channel)) reason = 'channel_unavailable'
    else {
      try {
        await this.channels.sendText(peer.channel, peer.conversationId, text, { scene: 'chat' })
        sent = true
      } catch (error) {
        reason = String(error?.message || error)
      }
    }
    try {
      this.social?.appendProactive?.({
        at: this.clock(),
        target_peer: job.peerId,
        trigger: 'read_complete',
        decision: sent ? 'sent' : 'blocked',
        content_summary: text,
        reason,
      })
    } catch { /* proactive log is best effort */ }
    this.store.updateReadJob(job.id, { notified: true, error: failed ? (job.error || 'failed') : null })
  }
}
