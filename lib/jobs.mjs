/**
 * 任务队列与状态机 —— 与 HTTP 层解耦，便于用假 runner 做纯逻辑测试。
 *
 * 状态：queued → running → done | error | cancelled
 *                        └→ waiting_login →（resumeLogin）→ running
 *
 * 不变量：
 * 1. 任一时刻至多 1 个任务处于 running/waiting_login（同一浏览器 profile 串行，避免飞书侧限流）；
 * 2. 任务进入终态后必须释放 AbortController 与 resume 回调，不留悬挂引用；
 * 3. 对外暴露的任务对象必须经过 toPublic()，不泄漏 signal / 回调 / 内部字段。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const TERMINAL_STATES = ['done', 'error', 'cancelled'];

const HISTORY_LIMIT = 200;

export function toPublic(job) {
  return {
    id: job.id,
    status: job.status,
    urls: job.urls,
    opts: { out: job.opts.out, md: job.opts.md !== false, waitLogin: !!job.opts.waitLogin },
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    currentUrl: job.currentUrl,
    phase: job.phase,
    progress: job.progress,
    result: job.result,
    error: job.error,
    events: job.events
  };
}

export class JobQueue extends EventEmitter {
  #jobs = new Map();
  #order = [];
  #current = null;

  /**
   * @param {{runner: (job:object, ctx:{emit:Function, signal:AbortSignal, waitForResume:Function})=>Promise<any>}} deps
   */
  constructor({ runner }) {
    super();
    if (typeof runner !== 'function') throw new Error('JobQueue 需要 runner 函数');
    this.runner = runner;
  }

  create(urls, opts = {}) {
    const job = {
      id: randomUUID(),
      status: 'queued',
      urls: [...urls],
      opts: { out: 'out', md: true, waitLogin: false, port: 9222, browser: null, profile: null, ...opts },
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      currentUrl: null,
      phase: 'queued',
      progress: null,
      result: null,
      error: null,
      events: [],
      _abort: null,
      _resume: null
    };
    this.#jobs.set(job.id, job);
    this.#order.push(job.id);
    this.#push(job, { phase: 'queued' });
    this.emit('job', job);
    queueMicrotask(() => this.#pump());
    return job;
  }

  list() {
    return this.#order.map(id => this.#jobs.get(id));
  }

  get(id) {
    return this.#jobs.get(id) || null;
  }

  /** @returns {boolean} 是否受理了取消 */
  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.finishedAt = Date.now();
      this.#push(job, { phase: 'cancelled', reason: 'queued 阶段取消' });
      this.emit('job', job);
      return true;
    }
    if (job.status === 'running' || job.status === 'waiting_login') {
      // 立即置终态：不依赖 runner 是否响应 abort（driver 会在下个检查点抛 CancelledError，
      // 但假 runner / 卡住的 runner 不能把任务永远吊在 running）。
      job._abort?.abort();
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.finishedAt = Date.now();
      const resume = job._resume;
      job._resume = null;
      this.#push(job, { phase: 'cancelled', reason: '用户取消' });
      this.emit('job', job);
      resume?.();
      return true;
    }
    return false;
  }

  /** 唤醒 waiting_login 的任务 */
  resumeLogin(id) {
    const job = this.#jobs.get(id);
    if (!job || !job._resume) return false;
    if (TERMINAL_STATES.includes(job.status)) return false; // 终态不可唤醒
    const resume = job._resume;
    job._resume = null;
    job.status = 'running';
    job.phase = 'resuming';
    this.#push(job, { phase: 'resuming' });
    this.emit('job', job);
    resume();
    return true;
  }

  #push(job, event) {
    job.events.push({ at: Date.now(), ...event });
    if (job.events.length > HISTORY_LIMIT) job.events.splice(0, job.events.length - HISTORY_LIMIT);
  }

  #pump() {
    if (this.#current) return;
    const next = this.#order.map(id => this.#jobs.get(id)).find(j => j.status === 'queued');
    if (!next) return;

    this.#current = next;
    next.status = 'running';
    next.phase = 'starting';
    next.startedAt = Date.now();
    this.#push(next, { phase: 'starting' });
    this.emit('job', next);

    const controller = new AbortController();
    next._abort = controller;

    const ctx = {
      signal: controller.signal,
      emit: (phase, payload = {}) => {
        // 终态之后不得再改写状态：否则取消掉的任务会被后续 phase 事件"复活"
        if (TERMINAL_STATES.includes(next.status)) return;
        next.phase = phase;
        if (payload.url) next.currentUrl = payload.url;
        if (phase === 'assets') next.progress = {
          chunk: payload.chunk, totalChunks: payload.totalChunks,
          done: payload.done, assetTotal: payload.assetTotal
        };
        this.#push(next, { phase, ...payload });
        this.emit('job', next);
      },
      waitForResume: () => new Promise(resolve => {
        // 已被取消/失败：立即返回，绝不挂起 —— 否则 driver 永远 await，队列永久死锁
        if (TERMINAL_STATES.includes(next.status)) { resolve(); return; }
        next.status = 'waiting_login';
        next._resume = () => { if (!TERMINAL_STATES.includes(next.status)) next.status = 'running'; resolve(); };
        this.#push(next, { phase: 'waiting_login' });
        this.emit('job', next);
      })
    };

    // Promise.resolve().then(...) 包一层：runner 若是同步抛错的非 async 函数，
    // 直接 this.runner(...) 会变成 uncaughtException 并让 #current 永不释放。
    Promise.resolve()
      .then(() => this.runner(next, ctx))
      .then(result => {
        if (TERMINAL_STATES.includes(next.status)) return;
        next.status = 'done';
        next.phase = 'done';
        next.result = result;
      })
      .catch(err => {
        if (controller.signal.aborted || err?.code === 'CANCELLED') {
          next.status = 'cancelled';
          next.phase = 'cancelled';
          this.#push(next, { phase: 'cancelled' });
        } else {
          next.status = 'error';
          next.phase = 'error';
          next.error = { message: err?.message || String(err), code: err?.code || 'UNKNOWN' };
          this.#push(next, { phase: 'error', message: next.error.message, code: next.error.code });
        }
      })
      .finally(() => {
        next.finishedAt = Date.now();
        next._abort = null;
        next._resume = null;
        this.#current = null;
        this.emit('job', next);
        queueMicrotask(() => this.#pump());
      });
  }
}
