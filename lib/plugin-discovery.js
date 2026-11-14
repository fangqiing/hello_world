/**
 * STEP 8 附 - 插件发现骨架（供「hello_world-discovery」附属插件用）
 *
 * 零副作用：不联网、不写盘、不碰 profile、不装载、不执行任何下载内容。
 * 网络、哈希、存储全部由注入的 adapter 提供；本模块只做判定 / 归一化 / 排序 / 记录。
 *
 * 能力边界（07-PLUGIN-SPLIT.md §2.1）：
 *   搜索 / 下载到暂存区 / 校验 / 提议安装 = 自主；
 *   把第三方插件装载进生效 profile = 需确认，**本模块刻意不提供 install/load**。
 *
 * 模块格式与 step-7/8 一致（ESM）；CJS 转换同理。
 */

export const DEFAULT_ALLOWLIST = ['npm', 'github', 'local'];

const SUSPICIOUS = ['postinstall', 'preinstall', 'install', 'prepare', 'node-gyp', 'curl', 'wget'];

export function isAllowedSource(source, allowlist = DEFAULT_ALLOWLIST) {
  return allowlist.includes(String(source || '').toLowerCase());
}

/** 元信息归一化为候选；字段缺失一律补空，不让脏数据进后续流程。 */
export function normalizeCandidate(raw) {
  if (!raw || !raw.name) return null;
  return {
    id: String(raw.id || raw.name),
    name: String(raw.name),
    version: String(raw.version || ''),
    source: String(raw.source || '').toLowerCase(),
    url: String(raw.url || ''),
    checksum: String(raw.checksum || ''),
    description: String(raw.description || ''),
    declaredPermissions: Array.isArray(raw.permissions) ? raw.permissions.slice() : [],
    scripts: Array.isArray(raw.scripts)
      ? raw.scripts.slice()
      : raw.scripts && typeof raw.scripts === 'object'
        ? Object.entries(raw.scripts).map(([key, value]) => `${key}: ${value}`)
        : [],
  };
}

/** 可疑安装脚本检查：命中即需沙箱试运行，不能直接装载。 */
export function hasSuspiciousScripts(candidate) {
  if (!candidate) return false;
  const scripts = [...(candidate.scripts || []), ...(candidate.declaredPermissions || [])];
  return scripts.some(s => SUSPICIOUS.some(word => String(s).toLowerCase().includes(word)));
}

/** checksum 校验；hashFn 由外部注入，模块内不实现也不执行下载内容。 */
export async function verifyChecksum(payload, expected, hashFn) {
  if (!expected || typeof hashFn !== 'function') return false;
  const actual = await hashFn(payload);
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

/** 暂存路径：id 做安全化，避免路径穿越。 */
export function stagingPath(root, candidate) {
  const safe = String(candidate.id || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${String(root).replace(/\/+$/, '')}/${safe}-${candidate.version || 'latest'}.zip`;
}

/** 名称 / 描述优先的简单排序，不引入外部检索依赖。 */
export function rankCandidates(items = [], query = '') {
  const q = String(query).toLowerCase();
  if (!q) return items.slice();
  return items.slice().sort((a, b) => {
    const score = (x) => {
      const n = String(x.name || '').toLowerCase();
      const d = String(x.description || '').toLowerCase();
      return (n.includes(q) ? 2 : 0) + (d.includes(q) ? 1 : 0);
    };
    return score(b) - score(a);
  });
}

export class PluginDiscovery {
  constructor({ allowlist = DEFAULT_ALLOWLIST, fetcher, hasher, storage,
               clock = () => Date.now(), config = {} }) {
    Object.assign(this, { allowlist, fetcher, hasher, storage, clock });
    this.cfg = { stagingRoot: '/tmp/hello-world-staging', requireChecksum: true, ...config };
    this.staged = [];
    this.proposals = [];
  }

  /** 只搜白名单源；返回结果已归一化并排序。 */
  async search(query, source) {
    if (source && !isAllowedSource(source, this.allowlist)) return [];
    if (!this.fetcher || typeof this.fetcher.search !== 'function') return [];
    const raw = await this.fetcher.search(query, source || this.allowlist[0]);
    const items = (raw || []).map(normalizeCandidate).filter(Boolean)
      .filter(c => !c.source || isAllowedSource(c.source, this.allowlist));
    return rankCandidates(items, query);
  }

  /**
   * 下载 -> 校验 -> 写暂存区。由注入的 adapter 完成 I/O。
   * 校验失败即丢弃；可疑脚本只标记，不阻止暂存，但会写进记录。
   * 这里绝不写 profile、绝不装载。
   */
  async stage(candidate) {
    const c = normalizeCandidate(candidate);
    if (!c || !c.source || !isAllowedSource(c.source, this.allowlist)) return null;
    const payload = this.fetcher && this.fetcher.download
      ? await this.fetcher.download(c) : null;
    if (!payload) return null;
    if (this.cfg.requireChecksum) {
      const ok = await verifyChecksum(payload, c.checksum, this.hasher);
      if (!ok) return null;
    }
    const path = stagingPath(this.cfg.stagingRoot, c);
    if (this.storage && typeof this.storage.write === 'function') {
      await this.storage.write(path, payload);
    }
    const record = {
      at: this.clock(), candidate: c, path, source: c.source,
      checksum: c.checksum, suspicious: hasSuspiciousScripts(c),
      status: 'staged', // 只到暂存，不到 installed
    };
    this.staged.push(record);
    return record;
  }

  listStaged() { return this.staged.slice(); }

  /** 只生成「建议安装」记录，不执行安装；装载由 DSH 按 04 §1 边界另行处理。 */
  propose(candidateId, { proposedBy = 'self', reason = '' } = {}) {
    const item = this.staged.find(x => x.candidate.id === candidateId);
    if (!item) return null;
    const proposal = {
      at: this.clock(), candidateId, path: item.path, checksum: item.checksum,
      suspicious: item.suspicious, proposedBy, reason,
      status: 'proposed', // 不写 profile
    };
    this.proposals.push(proposal);
    return proposal;
  }

  listProposals() { return this.proposals.slice(); }

  /**
   * 审批：只把状态推进到 approved，不写 profile、不装载。
   * 真正写入生效 profile 由 DSH 按 04 §1 边界另行处理（需确认）。
   */
  approve(candidateId, { approvedBy = 'user', note = '' } = {}) {
    const proposal = this.proposals.find(p => p.candidateId === candidateId && p.status === 'proposed');
    if (!proposal) return null;
    const staged = this.staged.find(x => x.candidate.id === candidateId);
    const entry = {
      at: this.clock(), candidateId, path: proposal.path, checksum: proposal.checksum,
      suspicious: proposal.suspicious, approvedBy, note,
      status: 'approved_not_installed',
      requiresSandbox: !!(staged && staged.suspicious),
    };
    proposal.status = 'approved';
    this.auditLog = this.auditLog || [];
    this.auditLog.push(entry);
    return entry;
  }

  audit() { return (this.auditLog || []).slice(); }
}

/** 沙箱计划：返回计划而非执行；明确不允许写 profile。 */
export function sandboxPlan(record) {
  if (!record) return null;
  return {
    path: record.path,
    isolate: true,
    reason: record.suspicious ? 'suspicious_install_scripts' : 'routine',
    allowProfileWrite: false,
    snapshotRequired: true,
  };
}
