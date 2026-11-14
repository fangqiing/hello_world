/**
 * STEP 36 - 冲突与修复（纯状态机）
 *
 * 问题：她有 irritation 维度和沉默记录，但没有「吵架 → 冷战 → 和好」的闭环。
 *       结果是每次烦躁都像孤立事件：既不会持续，也不会被修复。
 * 定案：一个四态机。摩擦会升级成冷战，冷战要么被对方化开，要么自己消气，
 *       但「消气」不等于「说开了」—— 这个区别是关系质感的关键。
 *
 * 两条硬约束，防止她变成记仇机器：
 *   ① 48 小时强制降级。真人会记很久，但那是靠记忆，不是靠一个永不复位的状态位。
 *   ② 同一次冲突 24 小时内不重复开启，否则每句重话都被记一笔。
 */

export const CONFLICT_DDL = `
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'normal',
  cause TEXT NOT NULL DEFAULT '',
  opened_at INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER NOT NULL DEFAULT 0,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  unresolved INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflicts_peer ON conflicts(peer_id);
`;

const HOUR = 3600000;
export const MAX_OPEN_MS = 48 * HOUR;
export const REOPEN_GUARD_MS = 24 * HOUR;

export const STATES = ['normal', 'friction', 'cold', 'repairing'];

/** 事件判定：从一轮对话的信号里读出发生了什么。 */
export function detectEvent({
  irritation = 0,
  irritationDelta = 0,
  replyLength = 0,
  userApology = false,
  userWarmth = false,
  idleMs = 0,
  now = Date.now(),
  conflict = null,
} = {}) {
  const state = conflict?.state || 'normal';

  if (userApology) return { type: 'open_repair', weight: 0.8 };
  if (userWarmth && (state === 'cold' || state === 'friction' || state === 'repairing')) {
    return { type: 'warmth', weight: 0.5 };
  }

  if (state === 'normal') {
    const spike = Math.abs(irritationDelta) >= 0.18 || irritation >= 0.55;
    if (spike) {
      const guard = now - Number(conflict?.closed_at || 0) < REOPEN_GUARD_MS;
      if (!guard) return { type: 'irritation_spike', weight: Math.abs(irritationDelta) || irritation };
    }
    return null;
  }

  // 开着的时候：持续烦躁会升级，短回复是冷战的信号。
  if (irritationDelta >= 0.12 && state === 'repairing') return { type: 'relapse', weight: irritationDelta };
  if (state === 'friction' && replyLength > 0 && replyLength <= 4) return { type: 'cold_reply', weight: 1 };
  if (state === 'friction' && now - Number(conflict?.last_at || now) > 12 * HOUR) return { type: 'time_pass', weight: 1 };
  if (state === 'cold' && idleMs > 12 * HOUR) return { type: 'time_pass', weight: 1 };
  return null;
}

/**
 * 状态转移。返回新状态对象与是否变化。
 * conflict 为 null 时视为 normal。
 */
export function nextState(conflict, event, { now = Date.now(), cause = '' } = {}) {
  const current = conflict || {
    state: 'normal', cause: '', opened_at: 0, last_at: now, closed_at: 0, repair_attempts: 0, unresolved: 0,
  };
  const base = { ...current, last_at: now };
  if (!event) {
    // 没有事件时只做超时降级。
    if (current.state !== 'normal' && now - Number(current.opened_at || now) > MAX_OPEN_MS) {
      return {
        conflict: { ...base, state: 'normal', closed_at: now, unresolved: current.state === 'cold' ? 1 : current.unresolved },
        changed: true,
        note: 'timeout',
      };
    }
    return { conflict: base, changed: false, note: '' };
  }

  switch (`${current.state}:${event.type}`) {
    case 'normal:irritation_spike':
      return { conflict: { ...base, state: 'friction', cause: cause || current.cause || '', opened_at: now }, changed: true, note: 'open' };

    case 'friction:cold_reply':
      return { conflict: { ...base, state: 'cold' }, changed: true, note: 'escalate' };

    case 'friction:warmth':
    case 'friction:open_repair':
      return {
        conflict: { ...base, state: 'repairing', repair_attempts: Number(current.repair_attempts || 0) + 1 },
        changed: true,
        note: 'repair',
      };

    case 'friction:time_pass':
      // 十二小时没吵起来：气消了，但话没说过 —— 记成 unresolved。
      return { conflict: { ...base, state: 'normal', closed_at: now, unresolved: 1 }, changed: true, note: 'fade' };

    case 'cold:open_repair':
    case 'cold:warmth':
      return {
        conflict: { ...base, state: 'repairing', repair_attempts: Number(current.repair_attempts || 0) + 1 },
        changed: true,
        note: 'repair',
      };

    case 'cold:time_pass':
      // 冷战熬过去了，但没和好：留着 unresolved，下次可能被翻出来。
      return { conflict: { ...base, state: 'normal', closed_at: now, unresolved: 1 }, changed: true, note: 'cold_fade' };

    case 'repairing:warmth':
      return { conflict: { ...base, state: 'normal', closed_at: now, unresolved: 0 }, changed: true, note: 'restored' };

    case 'repairing:open_repair':
      return {
        conflict: { ...base, state: 'normal', closed_at: now, unresolved: 0, repair_attempts: Number(current.repair_attempts || 0) + 1 },
        changed: true,
        note: 'restored',
      };

    case 'repairing:relapse':
      return { conflict: { ...base, state: 'cold' }, changed: true, note: 'relapse' };

    default:
      return { conflict: base, changed: false, note: '' };
  }
}

function hoursSince(from, now) {
  const ms = now - Number(from || now);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / HOUR);
}

/**
 * 注入块。只在非 normal 时有内容 —— 正常状态下提「你们没在吵架」是废话。
 * 语气按状态给，不给她台词：冷战时不逼她原谅，摩擦时不逼她翻脸。
 */
export function buildConflictBlock(conflict, { now = Date.now() } = {}) {
  if (!conflict || conflict.state === 'normal') return null;
  const cause = String(conflict.cause || '').trim();
  const since = hoursSince(conflict.opened_at, now);
  const lines = [];

  if (conflict.state === 'friction') {
    lines.push(`【有点别扭】${since} 小时前${cause ? `因为「${cause}」，` : ''}你心里还有点不痛快。`);
    lines.push('（不用装作没事，也不用马上发作。语气可以淡一点，别主动把话挑明。）');
  } else if (conflict.state === 'cold') {
    lines.push(`【你们在冷着】${cause ? `起因是「${cause}」，` : ''}已经 ${since} 小时没好好说话了。`);
    lines.push('（可以简短，可以不接话。别主动求和，也别翻旧账。对方先软下来你可以接。）');
  } else if (conflict.state === 'repairing') {
    lines.push(`【对方在往回找补】关于「${cause || '刚才的事'}」，对方已经放低了姿态。`);
    lines.push(`（你还没完全过去${Number(conflict.repair_attempts || 0) > 1 ? '，但也不想一直僵着' : ''}。可以缓一点，不必立刻说"没事"。）`);
  }

  return lines.join('\n');
}
