/**
 * STEP 27 - 读书任务的异步回执（纯函数）
 *
 * 问题：投一本书后，对话里什么都没出现，看起来像死进程。
 * 实际是：读书是后台任务，不是 turn，不进 agent loop，不产生聊天消息。
 * 正确做法：立即返回 accepted + jobId，后台跑，跑完主动说一句。
 *
 * 这里的函数只管状态与话术；真正的异步执行由 DSH 装配层提供。
 */

import { emptyResultNote } from './chapter-detect.js';

export const JOB = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
};

const NEXT = {
  queued: ['running', 'failed'],
  running: ['done', 'failed'],
  done: [],
  failed: ['queued'],   // 允许显式重试
};

export function createJob({ title = '', chapters = 0, mode = 'book', now = Date.now() } = {}) {
  return {
    id: `read_${now}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    mode,
    status: JOB.QUEUED,
    chapters,
    doneChapters: 0,
    startedAt: now,
    updatedAt: now,
    notified: false,
    error: null,
  };
}

export function transition(job, status, { now = Date.now(), doneChapters, error } = {}) {
  const cur = job || createJob({ now });
  const allowed = NEXT[cur.status] || [];
  if (!allowed.includes(status)) {
    return { ok: false, job: cur, reason: `cannot_${cur.status}_to_${status}` };
  }
  const next = {
    ...cur,
    status,
    updatedAt: now,
    doneChapters: Number.isFinite(doneChapters) ? doneChapters : cur.doneChapters,
    error: error != null ? String(error) : cur.error,
  };
  if (status === JOB.DONE) next.doneChapters = next.chapters || next.doneChapters;
  return { ok: true, job: next };
}

export function progressOf(job) {
  if (!job) return 0;
  if (job.status === JOB.DONE) return 100;
  if (job.status === JOB.FAILED) return 0;
  const total = Math.max(1, Number(job.chapters) || 1);
  return Math.min(99, Math.round((Number(job.doneChapters) || 0) / total * 100));
}

/** 是否该发一条完成回执：done 且没通知过。 */
export function shouldNotify(job) {
  return !!job && job.status === JOB.DONE && job.notified !== true;
}

/**
 * 完成话术：**像人，不像任务通知**。
 * 不带「已完成」「成功处理」这类词，也不列进度。
 */
export function completionNote(job, { principles = 0, title = '', chapterCount = 0, frontChars = 0, ocrSuspect = false } = {}) {
  const n = Number(principles) || 0;
  if (n === 0) return emptyResultNote({
    chapterCount: Number(chapterCount) || Number(job?.chapters) || 0,
    frontChars: Number(frontChars) || 0,
    ocrSuspect: Boolean(ocrSuspect),
  });
  if (n <= 3) return `读完了，长出 ${n} 条想法。`;
  return `读完了，记下 ${n} 条。有几条我还没想明白。`;
}

/** 失败时的话术，不甩锅、不说「系统错误」。 */
export function failureNote(job) {
  const reason = String((job && job.error) || '');
  if (/413|too large|entity/i.test(reason)) return '书太大了，一次没吞下。分两半给我？';
  if (/timeout|超时/i.test(reason)) return '读得有点久，断了。我再试一次。';
  return '没读成。等下重试。';
}

/** HTTP 立即响应（202），不等待后台跑完。 */
export function acceptedResponse(job) {
  return {
    ok: true,
    accepted: true,
    jobId: job.id,
    status: job.status,
    progress: progressOf(job),
    message: '收到了，我慢慢看。',
  };
}
