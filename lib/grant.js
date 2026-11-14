/**
 * 微信提权门：默认低权限，用户明确确认后临时获得几乎全部权限。
 *
 * 语义（用户 2026-11-14 澄清）：
 *   - 未经确认：只有白名单里的低危工具，whale_host 的高危动作被拒。
 *   - 确认后：解除工具白名单 + 允许主机命令/写文件/重启，30 分钟内有效。
 *   - 可随时撤销；到期自动收回；每次提权、撤销、高危动作都写审计。
 *
 * chat-modes 的 agent 模式（她问「要我动手改？」你回「好」）也算一次确认，
 * 这样不会出现「我同意了她却还是没权限」。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(HERE, '..', 'config');
const GRANT_FILE = path.join(CONFIG_DIR, 'grant.json');
const PENDING_FILE = path.join(CONFIG_DIR, 'grant-pending.json');
const AUDIT_FILE = path.join(CONFIG_DIR, 'host-audit.jsonl');
const TTL_MS = 30 * 60 * 1000;
// 3 秒太严：对方回得快的时侯会「卡在同一秒」，降到 1 秒；防绕过主要靠 lastInboundAt。
const MIN_GAP_MS = 1000;

const YES = /^(授权|批准|同意|可以|好|行|对|确认|来吧|开吧|ok|yes|go)[\s，,。!！~～]*/i;
const NO = /^(不|别|不要|不用|不必|先不|算了|取消|停|撤销|no|cancel|stop)|不可以|不授权|不同意|不确认|不行/i;

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  },
};

function readJson(p, fb) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb; }
  catch (err) { return fb; }
}
function writeJson(p, v) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2));
}
function audit(row) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  } catch (err) { /* audit must never block */ }
}
function lastInboundAt(whale) {
  for (const name of ['wechat', 'qq']) {
    const ch = whale?.channels?.get?.(name);
    if (ch && Number(ch.lastInboundAt) > 0) return Number(ch.lastInboundAt);
  }
  return 0;
}
function agentModeActive(whale) {
  try {
    for (const st of whale?.agentLayer?.states?.values?.() || []) {
      if (st?.mode === 'agent' && st?.channel) return true;
    }
  } catch (err) { /* ignore */ }
  return false;
}

export function grantSnapshot() {
  const g = readJson(GRANT_FILE, {});
  const now = Date.now();
  const active = g.active === true && Number(g.expiresAt) > now;
  return {
    active,
    grantedAt: g.grantedAt || null,
    expiresAt: g.expiresAt || null,
    remainingSec: active ? Math.round((Number(g.expiresAt) - now) / 1000) : 0,
    grantedBy: g.grantedBy || null,
    reason: g.reason || null,
    scope: ['full toolset', 'host exec', 'write_file', 'restart', 'all wechat tools'],
  };
}

/** 授权来源二选一：显式授权文件，或用户确认后进入的 agent 模式。 */
export function isGranted(whale) {
  if (grantSnapshot().active) return true;
  return agentModeActive(whale);
}

/** 授权状态变化时立刻重新施加/解除工具白名单，不用等下一次模式切换。 */
function reapply(whale) {
  let n = 0;
  try {
    for (const st of whale?.agentLayer?.states?.values?.() || []) {
      if (typeof st?.applyToolMode === 'function') {
        st.applyToolMode(st.mode || 'chat');
        n++;
      }
    }
  } catch (err) { /* ignore */ }
  return n;
}

/** 到期自动收回：每 15 秒比对一次状态，变化时重新施加限制。 */
export function startGrantWatcher(whale) {
  let last = isGranted(whale);
  const timer = setInterval(() => {
    const now = isGranted(whale);
    if (now !== last) {
      last = now;
      const n = reapply(whale);
      audit({ event: 'grant_changed', granted: now, reappliedSessions: n });
    }
  }, 15_000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

export function createAuthorizeTool(whale) {
  return {
    name: 'whale_authorize',
    description: '请求临时提权。第一次调用只返回待确认说明（不提权）；把说明发给本人，等他明确回复「授权」后，带 confirm 与 confirmText 再调一次才生效。授权 30 分钟，期间可解除工具白名单并使用主机命令/写文件/重启。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '要做什么，写进授权说明给本人看' },
        confirm: { type: 'string', description: '第二阶段：第一次返回的 requestId' },
        confirmText: { type: 'string', description: '第二阶段：本人回复的原话' },
      },
      required: [],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const now = Date.now();
      if (isGranted(whale)) return { ok: true, alreadyGranted: true, ...grantSnapshot() };
      const pending = readJson(PENDING_FILE, []).filter((t) => Number(t.expiresAt) > now);

      if (args.confirm) {
        const t = pending.find((x) => x.id === String(args.confirm));
        if (!t) return { ok: false, error: '授权请求不存在或已过期，请重新发起' };
        const ct = String(args.confirmText || '').trim();
        if (NO.test(ct)) return { ok: false, error: '本人拒绝了授权' };
        if (!YES.test(ct)) return { ok: false, error: '没有明确的授权确认词' };
        if (now - Number(t.createdAt) < MIN_GAP_MS) return { ok: false, error: '同一轮连续调用不算确认' };
        // 用 >= ：同一毫秒内建票+收到回复时，严格大于会误判成「没有新消息」。
        // 仍能防「agent 自己连调两次」——那种情况下 lastInboundAt 还是上一条旧消息，早于 createdAt。
        if (!(lastInboundAt(whale) >= Number(t.createdAt))) return { ok: false, error: '还没收到本人的新消息' };
        const g = {
          active: true, grantedAt: now, expiresAt: now + TTL_MS,
          grantedBy: t.grantedBy || null, conversationId: t.conversationId || null,
          reason: t.reason || '', scope: 'full',
        };
        writeJson(GRANT_FILE, g);
        writeJson(PENDING_FILE, pending.filter((x) => x.id !== t.id));
        const reapplied = reapply(whale);
        audit({ event: 'grant', id: t.id, reason: g.reason, expiresAt: g.expiresAt, reappliedSessions: reapplied });
        return { ok: true, granted: true, ...grantSnapshot(), reappliedSessions: reapplied };
      }

      const reason = String(args.reason || '执行需要高权限的任务').slice(0, 200);
      const t = {
        id: randomUUID(), reason, createdAt: now, expiresAt: now + TTL_MS,
        grantedBy: whale?.config?.ownerId || null,
        conversationId: whale?.channels?.conversationIds?.()?.[0] || null,
      };
      pending.push(t);
      writeJson(PENDING_FILE, pending);
      audit({ event: 'grant_request', id: t.id, reason });
      return {
        ok: true, needConfirm: true, requestId: t.id,
        ttlSec: Math.round(TTL_MS / 1000),
        scope: ['解除微信工具白名单', '执行任意主机命令', '写文件', '重启服务'],
        risk: '授权期间她能在自用服务器上做任何事；30 分钟后自动收回，也可随时说「撤销授权」。',
        instruction: '把「需要授权：要做什么 / 将获得什么权限 / 30 分钟有效」原样发给本人，等他明确回复「授权」。收到后带 confirm=requestId 与 confirmText=他的原话再调一次。不许自己连调两次，不许编造确认词；他说「不行/算了」就是拒绝。',
      };
    },
  };
}

export function createRevokeTool(whale) {
  return {
    name: 'whale_revoke',
    description: '立即撤销临时提权，恢复微信低权限白名单。任何时候都可以调用，不需要确认。',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute() {
      const g = readJson(GRANT_FILE, {});
      writeJson(GRANT_FILE, { ...g, active: false, revokedAt: Date.now() });
      writeJson(PENDING_FILE, []);
      const reapplied = reapply(whale);
      audit({ event: 'revoke', reappliedSessions: reapplied });
      return { ok: true, granted: false, reappliedSessions: reapplied };
    },
  };
}

export function createGrantStatusTool(whale) {
  return {
    name: 'whale_grant_status',
    description: '查看当前是否处于临时提权状态、还剩多久、授权范围。',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute() {
      return { ok: true, ...grantSnapshot(), viaAgentMode: agentModeActive(whale) };
    },
  };
}
