/**
 * STEP 8 修订版 - 主动发送闸门（覆盖 step-7 同名模块）
 *
 * 修订点：
 *  - F1：checkDisclosure 不再是可跳过项。有跨 peer 候选而 gate 缺失 / 无 logId -> fail-closed 不发；
 *        生成内容只能用 gate 返回的 allowed，不得夹带原始候选。
 *  - F2：章节是否「未完结」按 status 判定，不按 kind 白名单。
 *  - F4：静默时段按 config.timeZone（默认 Asia/Shanghai）取小时，不用服务器本地小时。
 *
 * 不变：enabled 默认 false；限流 / 日上限 / 群默认不发 / 留痕；sender 注入，零真实发送。
 * pending_ask 是触发源之一，发不发仍由她自己决定，代码不设用户门槛。
 */

import { periodOf, zonedParts } from './temporal-context.js';
import { rhythmOf, proactiveQuota } from './rhythm-policy.js';

/** 统一的 open 语义：只看 status，不看 kind。 */
export function isOpenChapter(chapter) {
  return !!chapter && chapter.status === 'open';
}

export class ProactiveGate {
  constructor({ store, peers, narratives, mood, sender, clock = () => Date.now(),
               checkDisclosure = null, infer = null, associative = null, config = {} }) {
Object.assign(this, { store, peers, narratives, mood, sender, clock, checkDisclosure, infer, associative });
    this.cfg = {
      enabled: false,
      minIntervalMs: 2 * 3600 * 1000,
      dailyLimit: 3,
      quietHours: [23 * 60, 7 * 60],
      timeZone: 'Asia/Shanghai',
      allowGroups: false,
      moodThreshold: 0.45,
      idleDays: 3,
      maxPerPeriod: 1,
      ...config,
    };
  }

  _period(now = this.clock()) {
    return periodOf(zonedParts(this.cfg.timeZone, now).hour).key;
  }

  /** IANA 时区下的小时；时区串非法时回退本地小时。 */
  _minutes() {
    const now = new Date(this.clock());
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: this.cfg.timeZone, hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      const m = Number(parts.find((p) => p.type === 'minute')?.value);
      return (Number.isFinite(h) ? h % 24 : now.getHours()) * 60 + (Number.isFinite(m) ? m : now.getMinutes());
    } catch (err) {
      return now.getHours() * 60 + now.getMinutes();
    }
  }

  _quiet() {
    const h = this._minutes();
    const raw = this.cfg.quietHours || [];
    const norm = raw.map((value) => Number(value) <= 24 ? Number(value) * 60 : Number(value));
    const [from, to] = norm;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    return from > to ? (h >= from || h < to) : (h >= from && h < to);
  }

  _limited(peerId) {
    if (Number(this.cfg.dailyLimit) === 0) return 'daily_limit';
    const now = this.clock();
    const periodKey = this._period(now);
    const quota = proactiveQuota(periodKey, { maxPerPeriod: this.cfg.maxPerPeriod });
    if (!rhythmOf(periodKey).proactive || quota <= 0) return 'period_limit';
    const recent = this.store.listProactive({
      peerId, since: now - 86400000, order: 'desc', limit: 200,
    });
    const sent = recent.filter((row) => row.decision === 'sent');
    if (sent.length >= Number(this.cfg.dailyLimit)) return 'daily_limit';
    const today = zonedParts(this.cfg.timeZone, now).date;
    const inPeriod = sent.filter((row) => {
      const p = zonedParts(this.cfg.timeZone, row.at);
      return p.date === today && periodOf(p.hour).key === periodKey;
    });
    if (inPeriod.length >= quota) return 'period_limit';
    const last = sent[0];
    if (last && now - last.at < this.cfg.minIntervalMs) return 'min_interval';
    return null;
  }

  evaluate() {
    if (!this.cfg.enabled) return [];
    const now = this.clock();
    const periodKey = this._period(now);
    if (!rhythmOf(periodKey).proactive || proactiveQuota(periodKey, { maxPerPeriod: this.cfg.maxPerPeriod }) <= 0) return [];
    const out = [];
    for (const peer of this.peers.listActive()) {
      if (peer.peer_kind === 'group' && !this.cfg.allowGroups) continue;
      const reasons = [];
      const m = this.mood && this.mood.current ? this.mood.current() : 0;
      if (Math.abs(m) >= this.cfg.moodThreshold) reasons.push({ trigger: 'mood', value: m });
      const chapters = this.narratives && this.narratives.listChapters
        ? this.narratives.listChapters(peer.id) : [];
      const open = chapters.filter(isOpenChapter);
      if (open.length) reasons.push({ trigger: 'open_chapter', value: open.length });
      const idle = now - (peer.last_seen || 0);
      if (idle > this.cfg.idleDays * 86400000) reasons.push({ trigger: 'long_silence', value: idle });
      const asks = this.store.listPendingAsks
        ? this.store.listPendingAsks({ targetPeer: peer.id }) : [];
      if (asks.length) reasons.push({ trigger: 'pending_ask', value: asks.length });
      // STEP 33 联想式主动：不是每次主动都有理由，"突然想到"也算一个。
      if (typeof this.associative === 'function') {
        try {
          const assoc = this.associative(peer.id, now);
          if (assoc) reasons.push({ trigger: 'associative', value: assoc.score, pair: assoc });
        } catch (err) {
          // 联想失败不影响其它触发。
        }
      }
      // 每日问候兜底：当天还没主动发过、且安静了至少 2 小时，就给她一个「想开口」的理由。
      // 不加这条时，她只会在情绪明显/故事未完结/静默 3 天时才开口——刚聊完的那天永远不会主动。
      try {
        const todayKey = zonedParts(this.cfg.timeZone, now).date;
        const sentToday = (this.store.listProactive
          ? this.store.listProactive({ peerId: peer.id, since: now - 86400000, order: 'desc', limit: 50 })
          : []).filter((r) => r.decision === 'sent' && zonedParts(this.cfg.timeZone, Number(r.at)).date === todayKey).length;
        const lastSeen = Number(peer.last_seen || 0);
        const idleHours = lastSeen ? (now - lastSeen) / 3600000 : 999;
        if (sentToday === 0 && idleHours >= Number(this.cfg.greetAfterHours ?? 2)) {
          reasons.push({ trigger: 'daily_greeting', value: Math.round(idleHours) });
        }
      } catch (err) { /* 兜底失败不影响其它触发 */ }
      if (reasons.length) out.push({ targetPeer: peer.id, reasons, at: now });
    }
    return out.sort((a, b) => b.reasons.length - a.reasons.length);
  }

  _record(candidate, decision, extra = {}) {
    const row = {
      at: this.clock(),
      target_peer: candidate.targetPeer,
      trigger: candidate.reasons.map(r => r.trigger).join('+'),
      mood_snapshot: this.mood && this.mood.current ? this.mood.current() : 0,
      decision,
      ...extra,
    };
    // Blocked decisions are operational counters, not send history. Persisting
    // them was the feedback loop that permanently exhausted the daily cap.
    if (String(decision).startsWith('blocked_')) return row;
    return this.store.appendProactive(row);
  }

  async dispatch(candidate) {
    if (!candidate || !candidate.targetPeer) return { decision: 'blocked_no_target' };
    if (String(candidate.targetPeer).startsWith('local:')) return { decision: 'blocked_local_target' };
    if (!this.cfg.enabled) return this._record(candidate, 'blocked_disabled');
    if (this._quiet()) return this._record(candidate, 'blocked_quiet');
    const limited = this._limited(candidate.targetPeer);
    if (limited) return this._record(candidate, 'blocked_limit', { reason: limited });

    // 本次主动消息可能用到的候选；由 DSH 的存储适配器提供。
    const candidates = this.store.listProactiveCandidates
      ? this.store.listProactiveCandidates(candidate.targetPeer) : [];
    const isGroup = String(candidate.targetPeer).includes(':group:');
    const hasCross = candidates.some(c =>
      (c.peer_id && c.peer_id !== candidate.targetPeer) || c.commitment_id || (isGroup && c.speaker_id));

    let allowed = candidates;
    if (hasCross) {
      // F1：主动路径与回复路径共用同一不变量 —— 无 log 不发。
      if (!this.checkDisclosure) {
        return this._record(candidate, 'blocked_disclosure', { reason: 'gate_missing' });
      }
      try {
        const r = await this.checkDisclosure({
          currentPeerId: candidate.targetPeer, candidates, isGroup,
        });
        if (!r || !r.logId) {
          return this._record(candidate, 'blocked_disclosure', { reason: 'no_log' });
        }
        allowed = Array.isArray(r.allowed) ? r.allowed.filter((c) => !c.redact && !c.redactNeeded) : [];
      } catch (err) {
        return this._record(candidate, 'blocked_disclosure', {
          reason: String(err && err.message || err),
        });
      }
    }

    try {
      // 只把放行后的候选交给生成；不得夹带原始候选。
      const content = this.infer ? await this.infer(candidate, allowed) : null;
      if (!content) return this._record(candidate, 'no_content');
      await this.sender.send(candidate.targetPeer, content);
      return this._record(candidate, 'sent', { content_summary: String(content).slice(0, 120) });
    } catch (err) {
      return this._record(candidate, 'failed', { reason: String(err && err.message || err) });
    }
  }
}
