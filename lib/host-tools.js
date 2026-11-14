/**
 * 微信窗口缺口补齐：主机运维、长文本回传、生成任务查询/取消。
 *
 * 低危动作（status/logs/read_file/任务查询）默认可用；
 * 高危动作（exec / write_file / restart）必须先经 whale_authorize 提权。
 * 所有动作写 append-only 审计；exec 有 30 秒超时与输出上限。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isGranted } from './grant.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(HERE, '..', 'config');
const MEDIA_ROOT = '/root/whale-media';
const AUDIT = path.join(CONFIG_DIR, 'host-audit.jsonl');
const HIGH_RISK = ['write_file', 'restart', 'exec'];

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  },
};

function audit(row) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  } catch (err) { /* audit must never block */ }
}
function readJson(p, fb) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb; }
  catch (err) { return fb; }
}
function tailJsonl(file, n = 6) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => {
      try { return JSON.parse(l); } catch (err) { return { raw: l.slice(0, 120) }; }
    });
  } catch (err) { return []; }
}
function targetOf(whale) {
  return whale?.config?.ownerId || whale?.channels?.conversationIds?.()?.[0] || '';
}
// 她塑造自己时需要用 sleep 真的等一段时间；默认 30 秒会把 sleep 直接杀掉，放到 5 分钟。
// 仍保留上限：卡死的命令最多占 5 分钟。
async function shell(cmd, timeoutMs = 300_000) {
  const { stdout, stderr } = await run('/bin/bash', ['-c', cmd], {
    timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
  });
  return { out: String(stdout || '').slice(0, 4000), err: String(stderr || '').slice(0, 1000) };
}

export function createHostTool(whale) {
  return {
    name: 'whale_host',
    description: '在服务器上做事。低危：status / logs / read_file 直接可用；高危：write_file / restart / exec 需要先经 whale_authorize 授权。全部写审计日志。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'logs', 'read_file', 'write_file', 'restart', 'exec'] },
        service: { type: 'string', description: 'logs/restart 用：wx-bridge 或 dsh-web' },
        lines: { type: 'number', description: 'logs 行数，默认 40，最多 100' },
        path: { type: 'string', description: 'read_file / write_file 的文件绝对路径' },
        content: { type: 'string', description: 'write_file 的内容' },
        cmd: { type: 'string', description: 'exec 的命令' },
      },
      required: ['action'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = String(args.action || '');
      if (HIGH_RISK.includes(action) && !isGranted(whale)) {
        audit({ event: 'host_denied', action, reason: 'no_grant' });
        return {
          ok: false, action, needGrant: true,
          error: '这是高危动作，需要授权：先调 whale_authorize 发起请求，等本人明确回复「授权」。',
        };
      }
      let result;
      try {
        if (action === 'status') {
          result = await shell('systemctl is-active wx-bridge dsh-web; echo ---; uptime; echo ---; df -h / | tail -1; echo ---; free -m | head -2');
        } else if (action === 'logs') {
          const svc = ['wx-bridge', 'dsh-web'].includes(String(args.service)) ? String(args.service) : 'wx-bridge';
          const lines = Math.min(100, Math.max(5, Number(args.lines || 40)));
          result = await shell(`journalctl -u ${svc} -n ${lines} --no-pager`);
        } else if (action === 'read_file') {
          const p = path.resolve(String(args.path || ''));
          if (!p || p === '/') return { ok: false, error: 'path required' };
          result = { path: p, content: readFileSync(p, 'utf8').slice(0, 12000) };
        } else if (action === 'write_file') {
          const p = path.resolve(String(args.path || ''));
          if (!p || p === '/') return { ok: false, error: 'path required' };
          writeFileSync(p, String(args.content ?? ''));
          result = { ok: true, path: p, bytes: String(args.content ?? '').length };
        } else if (action === 'restart') {
          const svc = ['wx-bridge', 'dsh-web'].includes(String(args.service)) ? String(args.service) : 'wx-bridge';
          // 重启 dsh-web 会杀掉当前进程，延迟 3 秒让工具先返回。
          const cmd = svc === 'dsh-web'
            ? 'systemd-run --on-active=3 --unit=whale-dsh-restart /bin/systemctl restart dsh-web'
            : `systemctl restart ${svc}`;
          result = await shell(cmd);
          result = { ...result, scheduled: svc === 'dsh-web' };
        } else if (action === 'exec') {
          const cmd = String(args.cmd || '').trim();
          if (!cmd) return { ok: false, error: 'cmd required' };
          result = await shell(cmd);
        } else {
          return { ok: false, error: `unknown action: ${action}` };
        }
        audit({ event: 'host', action, service: args.service || null, path: args.path || null,
                cmd: args.cmd ? String(args.cmd).slice(0, 200) : null, granted: isGranted(whale) });
        return { ok: true, action, ...result };
      } catch (err) {
        audit({ event: 'host_failed', action, error: String(err?.message || err).slice(0, 200) });
        return { ok: false, action, error: String(err?.message || err).slice(0, 300) };
      }
    },
  };
}

export function createSendTextFileTool(whale) {
  return {
    name: 'whale_send_text_file',
    description: '把一段长文字写成 .md / .txt 文件并发到当前微信会话。适合日志、报告、配置清单这类一条消息塞不下的内容。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '文件内容' },
        fileName: { type: 'string', description: '文件名，默认 report-<时间>.md' },
        caption: { type: 'string', description: '可选：随文件一起发的说明' },
      },
      required: ['text'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, error: 'text required' };
      const raw = String(args.fileName || `report-${Date.now()}.md`).replace(/[^\w.\-]/g, '_').slice(0, 100);
      const fileName = /\.(md|txt|json|log|csv)$/i.test(raw) ? raw : `${raw}.md`;
      const target = targetOf(whale);
      if (!target) return { ok: false, error: '没有可用的会话目标' };
      mkdirSync(MEDIA_ROOT, { recursive: true });
      const abs = path.join(MEDIA_ROOT, fileName);
      writeFileSync(abs, text);
      try {
        await whale.channels.sendMedia('wechat', target,
          { kind: 'file', data: Buffer.from(text).toString('base64'), fileName }, { agentBypass: true });
        if (args.caption) {
          try { await whale.channels.sendText('wechat', target, String(args.caption)); } catch (err) { /* best effort */ }
        }
      } catch (err) {
        return { ok: false, error: `发送失败：${String(err?.message || err).slice(0, 160)}`, path: abs };
      }
      audit({ event: 'send_text_file', path: abs, bytes: text.length, target });
      return { ok: true, path: abs, bytes: text.length, sent: true };
    },
  };
}

export function createJobStatusTool(whale) {
  return {
    name: 'whale_job_status',
    description: '查看待确认的生成票据、今日已用额度、当前授权状态、最近生成/运维记录。',
    parameters: { type: 'object', properties: {} },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute() {
      const pending = readJson(path.join(CONFIG_DIR, 'generation-pending.json'), []);
      const usage = readJson(path.join(CONFIG_DIR, 'generation-usage.json'), {});
      const cfg = readJson(path.join(CONFIG_DIR, 'providers.json'), {});
      const now = Date.now();
      return {
        ok: true,
        granted: isGranted(whale),
        pending: (Array.isArray(pending) ? pending : []).map((t) => ({
          id: t.id, kind: t.kind, prompt: String(t.prompt || '').slice(0, 80),
          model: t.model, sticker: Boolean(t.sticker),
          estimatedCostCny: t.estimatedCostCny,
          expiresInSec: Math.max(0, Math.round((Number(t.expiresAt) - now) / 1000)),
        })),
        todayUsed: usage[new Date().toISOString().slice(0, 10)] || 0,
        dailyLimit: cfg.generation?.dailyLimit ?? 20,
        recent: [
          ...tailJsonl(path.join(CONFIG_DIR, 'generation-audit.jsonl'), 8),
          ...tailJsonl(AUDIT, 8),
        ].slice(-12),
        recentGenerated: tailJsonl(path.join(CONFIG_DIR, 'generation-audit.jsonl'), 40)
          .filter((row) => row.event === 'generated' || row.event === 'manual_delivery')
          .slice(-6),
      };
    },
  };
}

export function createJobCancelTool() {
  return {
    name: 'whale_job_cancel',
    description: '取消一张还没确认的生成票据。已经提交给云端的任务无法撤回，只能取消待确认的请求。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '待确认票据的 requestId' } },
      required: ['id'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const id = String(args.id || '');
      if (!id) return { ok: false, error: 'id required' };
      const pf = path.join(CONFIG_DIR, 'generation-pending.json');
      const list = readJson(pf, []);
      const hit = list.find((t) => t.id === id);
      if (!hit) return { ok: false, error: '票据不存在或已过期' };
      writeFileSync(pf, JSON.stringify(list.filter((t) => t.id !== id), null, 2));
      audit({ event: 'cancel_ticket', id, kind: hit.kind, prompt: String(hit.prompt || '').slice(0, 80) });
      return { ok: true, cancelled: id, kind: hit.kind };
    },
  };
}
