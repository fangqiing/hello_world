/**
 * STEP 16 - 群聊/单聊的模式状态机（纯函数，零副作用）
 *
 * 四种模式：
 *   chat        普通聊天（群聊永远停在这里）
 *   ask_enter   检测到「想让我做事」，正在征求同意
 *   agent       已同意，带着扩展工具集执行任务
 *   ask_exit    任务做完，正在确认还有没有别的事
 *
 * 每个会话（conversationId）各存一份状态；状态写库由调用方负责，这里只算转移。
 */

export const MODE = {
  CHAT: 'chat',
  ASK_ENTER: 'ask_enter',
  AGENT: 'agent',
  ASK_EXIT: 'ask_exit',
};

export const EVENT = {
  INTENT: 'intent',       // 检测到 agent 倾向
  ACCEPT: 'accept',       // 对话人肯定
  DECLINE: 'decline',     // 对话人否定
  TASK_DONE: 'task_done', // 她自己判断任务完成
  MORE: 'more',           // 完成后还有事
  TIMEOUT: 'timeout',
  RESET: 'reset',
};

export const DEFAULTS = {
  askEnterTimeoutMs: 5 * 60 * 1000,
  agentIdleTimeoutMs: 10 * 60 * 1000,
  askExitTimeoutMs: 5 * 60 * 1000,
  maxAgentRounds: 20,
};

const TABLE = [
  { from: MODE.CHAT, event: EVENT.INTENT, to: MODE.ASK_ENTER, guard: 'canEnter' },
  { from: MODE.CHAT, event: EVENT.RESET, to: MODE.CHAT },
  { from: MODE.ASK_ENTER, event: EVENT.ACCEPT, to: MODE.AGENT, guard: 'canEnter' },
  { from: MODE.ASK_ENTER, event: EVENT.DECLINE, to: MODE.CHAT },
  { from: MODE.ASK_ENTER, event: EVENT.TIMEOUT, to: MODE.CHAT },
  { from: MODE.AGENT, event: EVENT.TASK_DONE, to: MODE.ASK_EXIT },
  { from: MODE.AGENT, event: EVENT.TIMEOUT, to: MODE.CHAT },
  { from: MODE.AGENT, event: EVENT.RESET, to: MODE.CHAT },
  { from: MODE.ASK_EXIT, event: EVENT.MORE, to: MODE.AGENT },
  { from: MODE.ASK_EXIT, event: EVENT.ACCEPT, to: MODE.AGENT },
  { from: MODE.ASK_EXIT, event: EVENT.DECLINE, to: MODE.CHAT },
  { from: MODE.ASK_EXIT, event: EVENT.TIMEOUT, to: MODE.CHAT },
];

export function initialState(conversationId, now = Date.now()) {
  return {
    conversationId: String(conversationId || ''),
    mode: MODE.CHAT,
    since: now,
    lastActivityAt: now,
    agentRounds: 0,
    enterCount: 0,
    lastReason: '',
  };
}

/**
 * 能否进入 agent。群聊一律不行；单人需要有授权（owner 或在 allowUsers 里），
 * 并且必须有可用的扩展工具集。
 */
export function canEnterAgent(ctx = {}) {
  if (ctx.isGroup === true) return { ok: false, reason: 'group_forbidden' };
  if (ctx.authorized !== true) return { ok: false, reason: 'not_authorized' };
  if (ctx.agentToolsAvailable === false) return { ok: false, reason: 'no_agent_tools' };
  return { ok: true };
}

/** 状态转移。返回新状态 + 动作提示，不修改入参。 */
export function reduce(state, event, ctx = {}, now = Date.now()) {
  const cur = state || initialState(ctx.conversationId, now);
  const rule = TABLE.find(r => r.from === cur.mode && r.event === event);
  if (!rule) {
    return { state: { ...cur, lastActivityAt: now }, changed: false, action: 'ignored' };
  }
  if (rule.guard === 'canEnter') {
    const g = canEnterAgent(ctx);
    if (!g.ok) {
      return {
        state: { ...cur, lastActivityAt: now, lastReason: g.reason },
        changed: false,
        action: 'blocked',
        reason: g.reason,
      };
    }
  }

  const next = { ...cur, mode: rule.to, since: now, lastActivityAt: now, lastReason: event };
  if (rule.to === MODE.AGENT && cur.mode !== MODE.AGENT) {
    next.agentRounds = 0;
    next.enterCount = (cur.enterCount || 0) + 1;
  }
  if (rule.to === MODE.CHAT) {
    next.agentRounds = 0;
  }

  return {
    state: next,
    changed: next.mode !== cur.mode,
    action: actionOf(rule.from, event, rule.to),
  };
}

function actionOf(from, event, to) {
  if (to === MODE.ASK_ENTER) return 'ask_enter';
  if (to === MODE.AGENT) return from === MODE.ASK_EXIT ? 'resume_agent' : 'enter_agent';
  if (to === MODE.ASK_EXIT) return 'ask_exit';
  if (to === MODE.CHAT && from !== MODE.CHAT) return 'exit_agent';
  return 'noop';
}

/** 记录一轮 agent 活动；超过上限强制回 chat。 */
export function tickAgent(state, ctx = {}, now = Date.now(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const cur = state || initialState(ctx.conversationId, now);
  if (cur.mode !== MODE.AGENT) return { state: { ...cur, lastActivityAt: now }, forced: false };
  const rounds = (cur.agentRounds || 0) + 1;
  if (rounds > c.maxAgentRounds) {
    return {
      state: { ...cur, mode: MODE.CHAT, agentRounds: 0, since: now, lastActivityAt: now, lastReason: 'round_limit' },
      forced: true,
      reason: 'round_limit',
    };
  }
  return { state: { ...cur, agentRounds: rounds, lastActivityAt: now }, forced: false };
}

/** 超时检查。各阶段的超时时长不同。 */
export function checkTimeout(state, now = Date.now(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const s = state || {};
  const idle = now - Number(s.lastActivityAt || s.since || now);
  const limit = s.mode === MODE.ASK_ENTER ? c.askEnterTimeoutMs
    : s.mode === MODE.AGENT ? c.agentIdleTimeoutMs
      : s.mode === MODE.ASK_EXIT ? c.askExitTimeoutMs
        : null;
  if (limit == null || idle < limit) return { expired: false, idle };
  return { expired: true, idle, mode: s.mode, reason: 'idle_timeout' };
}

/**
 * 是否应该给这个会话挂完整工具集。
 *
 * 用户 20:41 明确：agent 模式不要限制，要和正常 agent 一样，否则「我要他干嘛」。
 * 所以唯一的分界是模式：agent = 与 console agent 同一套工具。
 * 安全性不靠削减工具，靠三件事：审计留痕、可中断、关键操作前置快照。
 */
export function toolsFor(state, ctx = {}) {
  const mode = (state && state.mode) || MODE.CHAT;
  if (ctx.isGroup === true) return 'chat_only';
  return mode === MODE.AGENT ? 'full' : 'chat_only';
}
