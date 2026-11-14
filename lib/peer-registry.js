/**
 * STEP 10 / ① - 运行时会话目标注册表（零副作用）
 *
 * 目的：给一个 wxid / 群 ID 就能开对话，不改 cordis.patch.yml、不重启、不热重载。
 * 所有持久化由注入的 store 完成；模块内不碰 DB / fs / 网络。
 *
 * store 接口：
 *   load() -> [{ id, kind, displayName, enabled, addedAt, actor, reason }]
 *   save(rows) -> void
 *   appendAudit(row) -> void
 *
 * 模块格式与已发包一致（ESM）。
 */

export const KIND = { DIRECT: 'direct', GROUP: 'group' };

/** 群 ID 用 group: 前缀；私聊用通道原始 senderId（wxid_...），不接受微信号 / 显示名。 */
export function normalizeId(rawId, kind = KIND.DIRECT) {
  const id = String(rawId || '').trim();
  if (!id || /\s/.test(id)) return null;
  if (kind === KIND.GROUP) {
    if (id.startsWith('group:')) return id;
    if (!/^[A-Za-z0-9_@.\-]+$/.test(id)) return null;
    return `group:${id}`;
  }
  if (!/^[A-Za-z0-9_\-]+$/.test(id)) return null;
  return id;
}

export class PeerRegistry {
  constructor({ store, clock = () => Date.now(), config = {} } = {}) {
    this.store = store;
    this.clock = clock;
    this.cfg = { fallbackAllowUsers: [], fallbackAllowGroups: [], ...config };
    this.rows = (store && typeof store.load === 'function' ? store.load() : []) || [];
    this.auditLog = [];
  }

  _persist() {
    if (this.store && typeof this.store.save === 'function') this.store.save(this.rows.slice());
  }

  _audit(entry) {
    const row = { at: this.clock(), ...entry };
    this.auditLog.push(row);
    if (this.store && typeof this.store.appendAudit === 'function') this.store.appendAudit(row);
    return row;
  }

  _find(id) { return this.rows.find(r => r.id === id); }

  /** 新增或恢复；重复新增不产生新审计。 */
  add({ id, kind = KIND.DIRECT, displayName = '', actor = 'user', reason = '',
        canReply = true, canProactive = false } = {}) {
    const normalized = normalizeId(id, kind);
    if (!normalized) return { ok: false, reason: 'invalid_id' };
    const existing = this._find(normalized);
    if (existing && existing.enabled) return { ok: true, row: existing, unchanged: true };
    if (existing) {
      existing.enabled = true;
      existing.actor = actor;
      existing.reason = reason;
      this._persist();
      this._audit({ action: 'enable', id: normalized, actor, reason });
      return { ok: true, row: existing };
    }
    const row = {
      id: normalized, kind, displayName, enabled: true,
      // 三层权限分离（借鉴「用户页是权限中枢，不是通讯录」）：
      // enabled = 已登记 / canReply = 允许回复 / canProactive = 允许她主动找
      // 先登记，再单独开回复，最后才决定要不要主动，不一次性全开。
      canReply: canReply !== false,
      canProactive: canProactive === true,
      addedAt: this.clock(), actor, reason,
    };
    this.rows.push(row);
    this._persist();
    this._audit({ action: 'add', id: normalized, kind, actor, reason });
    return { ok: true, row };
  }

  /** 标记式停用，绝不物理删除。 */
  remove(id, { actor = 'user', reason = '' } = {}) {
    const row = this._find(String(id || '').trim());
    if (!row) return { ok: false, reason: 'not_found' };
    row.enabled = false;
    this._persist();
    this._audit({ action: 'disable', id: row.id, actor, reason });
    return { ok: true, row };
  }

  enable(id, { actor = 'user', reason = '' } = {}) {
    const existing = this._find(String(id || '').trim());
    return this.add({ id, kind: existing?.kind || KIND.DIRECT, actor, reason,
                      canReply: existing?.canReply !== false,
                      canProactive: existing?.canProactive === true });
  }

  /** 单独调整三层权限，不动登记状态。 */
  setPermission(id, { canReply, canProactive, actor = 'user', reason = '' } = {}) {
    const row = this._find(String(id || '').trim());
    if (!row) return { ok: false, reason: 'not_found' };
    if (typeof canReply === 'boolean') row.canReply = canReply;
    if (typeof canProactive === 'boolean') row.canProactive = canProactive;
    this._persist();
    this._audit({ action: 'permission', id: row.id, actor, reason,
                  canReply: row.canReply, canProactive: row.canProactive });
    return { ok: true, row: { ...row } };
  }

  /** 允许回复（登记 + canReply）。 */
  mayReply(id, kind = KIND.DIRECT) {
    const normalized = normalizeId(id, kind);
    if (!normalized) return false;
    const row = this._find(normalized);
    return !!row && row.enabled && row.canReply !== false;
  }

  /** 允许主动（默认 false，必须单独开）。 */
  mayProactive(id, kind = KIND.DIRECT) {
    const normalized = normalizeId(id, kind);
    if (!normalized) return false;
    const row = this._find(normalized);
    return !!row && row.enabled && row.canReply !== false && row.canProactive === true;
  }

  list({ kind = null, includeDisabled = false } = {}) {
    return this.rows
      .filter(r => (!kind || r.kind === kind) && (includeDisabled || r.enabled))
      .map(r => ({ ...r }));
  }

  /** fail-closed：表不可用或 id 未登记一律 false。 */
  isAllowed(id, kind = KIND.DIRECT) {
    const normalized = normalizeId(id, kind);
    if (!normalized) return false;
    try {
      const row = this._find(normalized);
      if (row) return !!row.enabled;
      const fallback = kind === KIND.GROUP
        ? (this.cfg.fallbackAllowGroups || [])
        : (this.cfg.fallbackAllowUsers || []);
      return fallback.includes(normalized);
    } catch (err) {
      return false;
    }
  }

  /** 会话 / 发言人 → 注册表条目；群返回 group: 前缀 id，speaker 单独返回。 */
  resolve(conversationId, senderId, kind = KIND.DIRECT) {
    const peerId = kind === KIND.GROUP
      ? normalizeId(conversationId, KIND.GROUP)
      : normalizeId(senderId, KIND.DIRECT);
    return { peerId, speakerId: String(senderId || '').trim() || null, kind };
  }

  /** 从静态配置幂等导入；已存在的不覆盖、不重复审计。 */
  importFromConfig({ allowUsers = [], allowGroups = [], actor = 'system' } = {}) {
    const out = { added: 0, skipped: 0 };
    for (const id of allowUsers) {
      const r = this.add({ id, kind: KIND.DIRECT, actor, reason: 'config_import' });
      if (r.unchanged || !r.ok) out.skipped += 1; else out.added += 1;
    }
    for (const id of allowGroups) {
      const r = this.add({ id, kind: KIND.GROUP, actor, reason: 'config_import' });
      if (r.unchanged || !r.ok) out.skipped += 1; else out.added += 1;
    }
    return out;
  }

  audit() { return this.auditLog.slice(); }
}
