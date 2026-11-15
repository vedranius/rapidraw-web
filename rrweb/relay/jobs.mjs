// Background jobs of the MCP server (mcp.mjs): long work (processing a set of photos, exports, AI masks, noise
// analysis) runs here, on the server, one job at a time, instead of in a browser tab. An MCP call returns a jobId
// at once; rapidraw_job reports progress, waits (up to ~50 s per call, below AI clients' timeouts), cancels or
// resumes. Why: during a real concert edit, almost every long call timed out on the client while the work went on,
// parallel heavy calls froze the laptop, and a cancelled export left the tab stuck.
//
// - One heavy job runs at a time; up to MAX_QUEUED wait. More are refused with "busy" and a retry time
//   (backpressure) instead of being accepted and overloading the machine.
// - Jobs are kept in <config>/mcp-jobs.json: after a restart, a job that was running shows as "interrupted" and
//   rapidraw_job {action: "resume"} continues it with the photos it hadn't finished.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_QUEUED = 6;
const KEEP = 40;
const LOG_LINES = 60;

export class Busy extends Error {
  constructor(message, retryAfter) { super(message); this.busy = true; this.retryAfter = retryAfter; }
}

export function createJobs({ file = null, log = console } = {}) {
  const jobs = new Map();
  const queue = [];
  let running = null;
  const waiters = new Map(); // id -> Set<resolve>

  // what survives a restart (no functions, no snapshots)
  const persistable = (j) => ({ ...j, runner: undefined, onCancel: undefined, snapshot: undefined, internal: undefined });
  let saveTimer = null;
  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const list = [...jobs.values()].slice(-KEEP).map(persistable);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
        fs.renameSync(`${file}.tmp`, file);
      } catch (e) { log.warn?.(`[jobs] ${e.message}`); }
    }, 300);
  }
  if (file) {
    try {
      for (const j of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (j.state === 'running' || j.state === 'queued') {
          j.state = 'interrupted';
          j.finished = Date.now();
          j.log = [...(j.log ?? []), `${new Date().toISOString()} RapidRAW Web restarted: resume with rapidraw_job {action: "resume"}`];
        }
        jobs.set(j.id, j);
      }
    } catch { /* first start */ }
  }

  function finish(job, state, error) {
    job.state = state;
    job.finished = Date.now();
    if (error) job.error = error;
    running = running === job ? null : running;
    for (const r of waiters.get(job.id) ?? []) r();
    waiters.delete(job.id);
    while (jobs.size > KEEP) {
      const old = [...jobs.values()].find((j) => j.finished);
      if (!old) break;
      jobs.delete(old.id);
    }
    save();
    pump();
  }

  function context(job) {
    return {
      job,
      get cancelled() { return job.cancelRequested === true; },
      checkCancelled() { if (job.cancelRequested) throw Object.assign(new Error('Cancelled'), { cancelled: true }); },
      log(line) {
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        save();
      },
      progress(done, total, current) {
        if (done !== undefined) job.done = done;
        if (total !== undefined) job.total = total;
        if (current !== undefined) job.current = current;
        save();
      },
      result(r) { job.results.push(r); save(); },
      onCancel(fn) { job.onCancel = fn; },
    };
  }

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    job.state = 'running';
    job.started = Date.now();
    save();
    try {
      const summary = await job.runner(context(job));
      job.summary = summary ?? job.summary;
      finish(job, job.cancelRequested ? 'cancelled' : 'done');
    } catch (e) {
      if (e?.cancelled || job.cancelRequested) finish(job, 'cancelled');
      else { log.warn?.(`[jobs] ${job.kind} ${job.id}: ${e?.message ?? e}`); finish(job, 'failed', e?.message ?? String(e)); }
    }
  }

  // average seconds of a running job's photos so far, for "how long still"
  function eta(job) {
    if (job.state !== 'running' || !job.done || !job.total) return undefined;
    const per = (Date.now() - job.started) / job.done;
    return Math.round((per * (job.total - job.done)) / 1000);
  }

  function view(job, { full = false } = {}) {
    if (!job) return null;
    const ok = job.results.filter((r) => r.ok !== false).length;
    return {
      jobId: job.id, kind: job.kind, title: job.title, state: job.state,
      done: job.done, total: job.total, current: job.current ?? null,
      queuedBehind: job.state === 'queued' ? queue.indexOf(job) + (running ? 1 : 0) : undefined,
      etaSeconds: eta(job),
      seconds: job.started ? Math.round(((job.finished ?? Date.now()) - job.started) / 1000) : 0,
      ok, failed: job.results.length - ok,
      error: job.error,
      summary: job.summary,
      results: full ? job.results : job.results.slice(-10),
      log: full ? job.log : job.log.slice(-8),
      resumable: ['interrupted', 'failed', 'cancelled'].includes(job.state) && !!job.spec ? true : undefined,
    };
  }

  return {
    /** Queue a job. runner(ctx) does the work; spec is what "resume" needs to continue it. */
    submit({ kind, title, total = 0, spec = null, runner, internal }) {
      const waiting = queue.length;
      if (waiting >= MAX_QUEUED) {
        const retry = running ? Math.max(30, eta(running) ?? 120) : 30;
        throw new Busy(`RapidRAW is busy: ${running ? `"${running.title}" is running and ` : ''}${waiting} job(s) are waiting. Retry in about ${retry} s, or wait for a job with rapidraw_job.`, retry);
      }
      const job = { id: `j${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, kind, title, state: 'queued', created: Date.now(),
        started: null, finished: null, done: 0, total, current: null, results: [], log: [], spec, runner, internal };
      jobs.set(job.id, job);
      queue.push(job);
      save();
      setImmediate(pump);
      return job;
    },
    get: (id) => jobs.get(id),
    view,
    list: () => [...jobs.values()].reverse().map((j) => view(j)).map(({ results, log, ...rest }) => rest),
    running: () => running,
    queued: () => queue.length,
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.state === 'queued') { queue.splice(queue.indexOf(job), 1); finish(job, 'cancelled'); return job; }
      if (job.state === 'running') {
        job.cancelRequested = true;
        try { job.onCancel?.(); } catch { /* best effort */ }
        context(job).log('cancel requested');
      }
      return job;
    },
    /** Resolves when the job finishes or after ms */
    wait(id, ms) {
      const job = jobs.get(id);
      if (!job || job.finished) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => { waiters.get(id)?.delete(done); resolve(); }, ms);
        if (!waiters.has(id)) waiters.set(id, new Set());
        waiters.get(id).add(done);
      });
    },
  };
}
