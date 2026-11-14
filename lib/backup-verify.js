/**
 * STEP 9 / C - 备份清单与还原结果判定（零副作用）
 * 不读盘、不解 tar、不执行还原；实际 I/O 由 DSH 注入或直接在副本目录做。
 */

export const EXPECTED_BACKUPS = [
  { key: 'old_db', name: 'memory.db.bak-step6', expectBytes: 268 * 1024, note: '268 KB 级别，实际值以 stat 为准' },
  { key: 'channel_sessions', name: 'channel-sessions.json.bak-step6' },
  { key: 'persona', name: 'persona/（含 history）' },
  { key: 'code_snapshot', name: 'code-20261106-231552.tar.gz', expectBytes: 117 * 1024 },
  { key: 'incremental', name: '本轮各阶段增量快照' },
];

/** 旧库还原后的期望计数（step-6 报告口径）。 */
export const EXPECTED_OLD_COUNTS = { memories: 58, episodes: 45, ledger: 12 };

/**
 * inventory: [{ key, exists, bytes?, sha256?, recordedSha256? }]
 * 返回缺失项、哈希不符项、尺寸异常项与 ok。
 */
export function verifyBackup(inventory = [], expected = EXPECTED_BACKUPS) {
  const byKey = new Map(inventory.map(x => [x.key, x]));
  const missing = [];
  const hashMismatch = [];
  const sizeMismatch = [];
  for (const item of expected) {
    const got = byKey.get(item.key);
    if (!got || !got.exists) { missing.push(item.key); continue; }
    if (got.recordedSha256 && got.sha256 && got.sha256 !== got.recordedSha256) {
      hashMismatch.push({ key: item.key, got: got.sha256, expected: got.recordedSha256 });
    }
    if (item.expectBytes && Number.isFinite(got.bytes) && Math.abs(got.bytes - item.expectBytes) > item.expectBytes * 0.2) {
      sizeMismatch.push({ key: item.key, got: got.bytes, expected: item.expectBytes });
    }
  }
  return {
    ok: !missing.length && !hashMismatch.length,
    missing, hashMismatch, sizeMismatch,
  };
}

/** 还原后条数对比。 */
export function verifyCounts(actual = {}, expected = EXPECTED_OLD_COUNTS) {
  const diffs = Object.entries(expected)
    .filter(([k, v]) => actual[k] !== v)
    .map(([k, v]) => ({ table: k, expected: v, actual: actual[k] ?? null }));
  return { ok: diffs.length === 0, diffs };
}

export function hashReport(records = []) {
  return records.map(r => ({
    name: r.name, bytes: r.bytes, sha256: r.sha256,
    matchesRecord: !r.recordedSha256 || r.sha256 === r.recordedSha256,
  }));
}

/** 灾难恢复剧本（只返回步骤数组，不执行）。 */
export function restorePlan() {
  return [
    '停装载（若已装载）并关闭主动发送总开关',
    '确认目标目录与当前状态，打一次当前快照',
    '还原 DB 并验条数与 hash',
    '从 tar 快照还原代码',
    '还原 persona / self / world 与 history',
    '复核 --dump-config 与路由状态',
    '记录每步 actor / 时间 / 前后值（留痕，可逐项撤销）',
  ];
}
