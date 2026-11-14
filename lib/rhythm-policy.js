/**
 * STEP 14 - 节律策略（纯函数）
 *
 * 时间不只是「几点」，还决定「该不该说话、说多长、说什么」。
 * 这里只给倾向与额度，不给固定句子——具体语气仍由她按语境决定。
 */

import { periodOf, zonedParts } from './temporal-context.js';

/** 每个时段的默认倾向。 */
export const RHYTHM = {
  late_night: { tone: 'lighter', replyHint: 'short', proactive: false, quota: 0, askHowWasDay: false },
  dawn: { tone: 'gentle', replyHint: 'short', proactive: false, quota: 0, askHowWasDay: false },
  morning: { tone: 'normal', replyHint: 'normal', proactive: true, quota: 1, askHowWasDay: false },
  noon: { tone: 'normal', replyHint: 'normal', proactive: true, quota: 1, askHowWasDay: false },
  afternoon: { tone: 'normal', replyHint: 'normal', proactive: true, quota: 1, askHowWasDay: false },
  evening: { tone: 'warm', replyHint: 'normal', proactive: true, quota: 1, askHowWasDay: true },
  night: { tone: 'soft', replyHint: 'normal', proactive: false, quota: 0, askHowWasDay: true },
};

export function rhythmOf(periodKey) {
  return RHYTHM[periodKey] || RHYTHM.morning;
}

export function toneFor(periodKey) {
  return rhythmOf(periodKey).tone;
}

/** 该时段允许几条主动消息（0 = 不主动）。 */
export function proactiveQuota(periodKey, cfg = {}) {
  const base = rhythmOf(periodKey).quota;
  const cap = Number.isFinite(Number(cfg.maxPerPeriod)) ? Number(cfg.maxPerPeriod) : base;
  return Math.max(0, Math.min(base, cap));
}

/** 深夜/夜里问「今天过得怎么样」会很怪。 */
export function asksHowWasDay(periodKey) {
  return rhythmOf(periodKey).askHowWasDay === true;
}

/**
 * 问候策略：给出「该不该提这段时间」而不是一句固定问候。
 * 返回 { greet, reason }
 */
export function greetingPolicy({ at = Date.now(), timeZone = 'Asia/Shanghai', lastTalkAt = null } = {}) {
  const p = zonedParts(timeZone, at);
  const period = periodOf(p.hour);
  const rhythm = rhythmOf(period.key);
  if (!rhythm.proactive) return { greet: false, reason: 'quiet_period', period: period.key };

  const last = Number(lastTalkAt);
  if (Number.isFinite(last) && last > 0) {
    const hours = (at - last) / 3600000;
    if (hours < 2) return { greet: false, reason: 'just_talked', period: period.key };
    if (hours > 24 * 3) return { greet: true, reason: 'long_absence', period: period.key };
  }
  return { greet: true, reason: 'normal', period: period.key };
}

/** 时间锚点：把「回复长度」也交给节律。 */
export function replyLengthHint(periodKey) {
  return rhythmOf(periodKey).replyHint;
}

/** 连续对话跨过午夜时，提醒切换语气（供 agent-layer 检查）。 */
export function crossedMidnight(prevAt, nowAt, timeZone = 'Asia/Shanghai') {
  if (!Number.isFinite(Number(prevAt)) || !Number.isFinite(Number(nowAt))) return false;
  const a = zonedParts(timeZone, prevAt).date;
  const b = zonedParts(timeZone, nowAt).date;
  return a !== b;
}
