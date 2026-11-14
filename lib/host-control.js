/**
 * STEP 10 / ⑤ - 受限宿主机控制通道（零副作用、不含任何凭据）
 *
 * 前提：用户本人在宿主机配置了 restrict,from,command 的专用密钥（见 05-HOST-SSH.md）。
 * 本模块只调用三个白名单动作，拿不到交互式 shell，也不拼接任意命令。
 * 真正的 ssh 执行由注入的 exec adapter 完成；keyPath 从参数或环境变量读取。
 *
 * exec: async ({ command, argv, timeoutMs }) => { exitCode, stdout, stderr }
 */

export const ACTIONS = Object.freeze({
  STATUS: 'status',
  BRIDGE_HEALTH: 'bridge-health',
  RESTART_DSH: 'restart-dsh',
});

const ALLOWED = new Set(Object.values(ACTIONS));
/** 只有重启需要显式确认。 */
const NEEDS_CONFIRM = new Set([ACTIONS.RESTART_DSH]);

export function validateAction(action, { confirm = false } = {}) {
  if (!ALLOWED.has(action)) return { ok: false, reason: 'action_not_allowed' };
  if (NEEDS_CONFIRM.has(action) && confirm !== true) return { ok: false, reason: 'confirmation_required' };
  return { ok: true, action };
}

export class HostControl {
  constructor({ exec = null, keyPath = null, host = '172.21.0.1', user = 'root',
               logger = null, clock = () => Date.now(), config = {} } = {}) {
    this.exec = exec;
    this.keyPath = keyPath || (typeof process !== 'undefined' && process.env ? process.env.DSH_HOST_KEY || null : null);
    this.host = host;
    this.user = user;
    this.logger = logger;
    this.clock = clock;
    this.cfg = { timeoutMs: 20000, ...config };
    this.auditLog = [];
  }

  _record(row) {
    const entry = { at: this.clock(), ...row };
    this.auditLog.push(entry);
    if (this.logger && typeof this.logger.log === 'function') this.logger.log(entry);
    return entry;
  }

  /** 构造 argv（数组形式，不做字符串拼接，避免注入）。 */
  buildArgv(action) {
    return [
      'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${Math.ceil(this.cfg.timeoutMs / 1000)}`,
      '-i', this.keyPath || '__KEY_NOT_CONFIGURED__',
      `${this.user}@${this.host}`, action,
    ];
  }

  async run(action, { confirm = false, actor = 'self' } = {}) {
    const check = validateAction(action, { confirm });
    if (!check.ok) return this._record({ actor, action, ok: false, reason: check.reason });
    if (!this.exec) return this._record({ actor, action, ok: false, reason: 'exec_missing' });
    if (!this.keyPath) return this._record({ actor, action, ok: false, reason: 'key_missing' });

    let result;
    try {
      result = await this.exec({ command: 'ssh', argv: this.buildArgv(action), timeoutMs: this.cfg.timeoutMs });
    } catch (err) {
      return this._record({ actor, action, ok: false, reason: 'exec_failed', error: String(err && err.message || err) });
    }
    const ok = Number(result?.exitCode) === 0;
    return this._record({
      actor, action, ok,
      exitCode: result?.exitCode,
      stdout: String(result?.stdout || '').slice(0, 500),
      stderr: String(result?.stderr || '').slice(0, 300),
    });
  }

  status(opts = {}) { return this.run(ACTIONS.STATUS, opts); }
  bridgeHealth(opts = {}) { return this.run(ACTIONS.BRIDGE_HEALTH, opts); }
  /** 必须显式 confirm:true；单次失败不自动重试。 */
  restartDsh(opts = {}) { return this.run(ACTIONS.RESTART_DSH, opts); }

  audit() { return this.auditLog.slice(); }
}
