/**
 * STEP 11 / P0-4 — disclosure gate.
 *
 * The pure policy lives in ./disclosure-policy.js. This class only persists the
 * decision and maps it to a per-decision allowlist. It deliberately never
 * returns original cross-peer text: mention/rephrase mark it for later
 * abstraction, and ask_source returns no text at all.
 */
import { filterRelevant } from './relevance.js'
import {
  DECISIONS,
  needsDecisionV2,
  commitmentIdsOf,
  allowForDecision,
  decideOutcome,
} from './disclosure-policy.js'

export { DECISIONS }

export class DisclosureGate {
  constructor({ store, infer, clock = () => Date.now(), enabled = true, relevance = {} }) {
    this.store = store
    this.infer = infer
    this.clock = clock
    this.enabled = enabled
    this.relevance = relevance
  }

  /**
   * @param {object} input
   * @param {boolean} [input.isGroup] true for group conversations; speaker_id
   *   is only sensitive there, never in a direct chat.
   */
  async decide({
    currentPeerId,
    candidates = [],
    commitments = [],
    principles = [],
    relationSummary = '',
    selfSummary = '',
    query = '',
    isGroup = false,
  } = {}) {
    if (!this.enabled || !needsDecisionV2(candidates, { peerId: currentPeerId, isGroup })) {
      return { skipped: true, allowed: candidates, allowedCommitmentIds: [] }
    }

    const relevant = query
      ? filterRelevant({ query, items: commitments, ...this.relevance })
      : commitments

    let raw
    try {
      raw = await this.infer({
        currentPeerId,
        candidates,
        commitments: relevant,
        principles,
        relationSummary,
        selfSummary,
        query,
      })
    } catch (error) {
      raw = null
    }
    const outcome = decideOutcome({ raw })
    if (outcome.reason === 'decision_unavailable') outcome.failed = true

    const cross = candidates.find((candidate) => candidate.peer_id && candidate.peer_id !== currentPeerId)
    const normalized = {
      decision: outcome.decision,
      reason: outcome.reason,
      principle_ids: outcome.principle_ids || [],
      confidence: outcome.confidence || 0,
      commitment_id: (candidates.find((candidate) => candidate.commitment_id) || {}).commitment_id || null,
      peer_from: cross ? cross.peer_id : null,
      peer_to: currentPeerId,
      at: this.clock(),
    }

    // Log before any candidate is made visible. If this throws, the caller must
    // fail closed and keep the memory block empty.
    const logged = this.store.appendDisclosure(normalized)
    const logId = logged && logged.id ? logged.id : logged

    const allowance = allowForDecision(normalized.decision, candidates, { peerId: currentPeerId })
    // In a direct chat a speaker_id is just the peer's own channel id. It must
    // never make her own memory disappear; group chats still use it to keep
    // another speaker's words out.
    if (normalized.decision === 'withhold' && !isGroup) {
      allowance.allowed = candidates.filter((c) => !c.commitment_id && (!c.peer_id || c.peer_id === currentPeerId))
    }
    if (normalized.decision === 'ask_source' && this.store.addPendingAsk) {
      for (const item of allowance.pendingAsks || []) {
        this.store.addPendingAsk({
          at: normalized.at,
          source_peer: item.sourcePeer,
          target_peer: currentPeerId,
          commitment_id: item.commitmentId,
          reason: normalized.reason,
          decided_by: 'self',
        })
      }
    }

    return {
      skipped: false,
      logId,
      decision: normalized,
      failed: outcome.failed,
      allowed: allowance.allowed || [],
      allowedCommitmentIds: [...commitmentIdsOf((allowance.allowed || []).filter((c) => !c.redact && !c.redactNeeded))],
      relevantCommitments: relevant.length,
    }
  }
}
