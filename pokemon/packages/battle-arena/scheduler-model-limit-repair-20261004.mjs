import { EventEmitter } from 'node:events';

/** Slots belong to whole games, including both AGH tasks and their final history exports. */
export class BattleScheduler extends EventEmitter {
  constructor({ concurrency = 8, maxQueued = 64, preparationConcurrency = 4, modelGameLimits = { 'battle-agnes': 2 }, settlePreparation = async () => {} } = {}) {
    super();
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Battle concurrency must be an integer from 1 to 32.');
    this.concurrency = concurrency; this.maxQueued = maxQueued;
    this.preparationConcurrency = preparationConcurrency;
    this.modelGameLimits = modelGameLimits;
    this.jobs = new Map(); this.queue = []; this.active = new Set(); this.stopped = false;
    this.settlePreparation = settlePreparation; this.preparing = false;
  }

  canAccept(count = 1) { return !this.stopped && this.queue.length + this.active.size + count <= this.maxQueued + this.concurrency; }

  enqueue({ id, models, run, prepare, onCancel = () => {} }) {
    if (!this.canAccept() || this.jobs.has(id)) throw new Error('Battle queue is full, stopped or contains this ID.');
    let resolveDone;
    const job = { id, models, run, prepare, ready: !prepare, onCancel, state: 'queued', queuedAt: new Date().toISOString(),
      done: new Promise(resolve => { resolveDone = resolve; }), resolveDone: result => resolveDone(result) };
    this.jobs.set(id, job); this.queue.push(job); this.changed(job); this.drain();
    return job;
  }

  changed(job) { this.emit('change', this.publicJob(job)); }
  publicJob({ id, models, state, queuedAt, startedAt, finishedAt, outcome, error }) { return { id, models, state, queuedAt, startedAt, finishedAt, outcome, error }; }
  snapshot() { return { concurrency: this.concurrency, running: this.active.size, queued: this.queue.length, preparing: this.preparing, stopped: this.stopped, jobs: [...this.jobs.values()].map(job => this.publicJob(job)) }; }
  setConcurrency(concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Battle concurrency must be an integer from 1 to 32.');
    this.concurrency = concurrency; this.drain(); return this.snapshot();
  }

  drain() {
    if (this.preparing) return;
    if (this.queue[0] && !this.queue[0].ready) {
      // Binding new workspaces refreshes the shared AGH worker's resources. Never do it
      // during an existing long task; prepare the whole waiting batch before any starts.
      if (this.active.size || this.stopped) return;
      this.preparing = true;
      queueMicrotask(async () => {
        const batch = this.queue.filter(job => !job.ready);
        try {
          const prepared = new Array(batch.length);
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(this.preparationConcurrency, batch.length) }, async () => {
            for (;;) {
              const index = cursor++;
              if (index >= batch.length) return;
              try { await batch[index].prepare(); prepared[index] = { status: 'fulfilled' }; }
              catch (reason) { prepared[index] = { status: 'rejected', reason }; }
            }
          }));
          const failure = prepared.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          await this.settlePreparation(batch);
          for (const job of batch) job.ready = true;
        } catch (error) {
          for (const job of batch) if (job.state === 'queued') {
            this.queue = this.queue.filter(item => item !== job);
            job.state = 'failed'; job.error = 'AGH preparation: ' + error.message;
            job.finishedAt = new Date().toISOString(); job.onCancel(job.error);
            this.changed(job); job.resolveDone(this.publicJob(job));
          }
        } finally { this.preparing = false; this.drain(); }
      });
      return;
    }
    while (!this.stopped && this.active.size < this.concurrency && this.queue.length) {
      const limits = this.modelGameLimits ?? { 'battle-agnes': 2 };
      const counts = new Map();
      for (const id of this.active) for (const model of Object.values(this.jobs.get(id).models ?? {})) {
        counts.set(model.route, (counts.get(model.route) ?? 0) + 1);
      }
      const index = this.queue.findIndex(job => job.ready && Object.values(job.models ?? {}).every(model =>
        !limits[model.route] || (counts.get(model.route) ?? 0) < limits[model.route]));
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1); this.active.add(job.id);
      job.state = 'running'; job.startedAt = new Date().toISOString(); this.changed(job);
      Promise.resolve().then(job.run).then(result => {
        job.outcome = result?.status;
        job.state = result?.status === 'aborted' || result?.autonomousTaskVerified === false ? 'failed' : 'completed';
      }, error => { job.state = 'failed'; job.error = error.message; }).finally(() => {
        this.active.delete(job.id); job.finishedAt = new Date().toISOString(); this.changed(job);
        job.resolveDone(this.publicJob(job)); this.drain();
      });
    }
  }

  stop(reason = 'Server stopped') {
    this.stopped = true;
    for (const job of this.queue.splice(0)) {
      job.state = 'cancelled'; job.error = reason; job.finishedAt = new Date().toISOString();
      job.onCancel(reason); this.changed(job); job.resolveDone(this.publicJob(job));
    }
  }
  async idle() { await Promise.all([...this.jobs.values()].map(job => job.done)); }
}
// Spread the same pair fixtures across providers instead of filling the first
// wave with every opponent of one model. This changes admission order only.
export function spreadModelPairs(pairs, pairsPerWave = 8) {
  const remaining = [...pairs], ordered = [];
  while (remaining.length) {
    const counts = new Map();
    for (let slot = 0; slot < pairsPerWave && remaining.length; slot++) {
      const load = pair => Object.values(pair.games[0].models).map(id => counts.get(id) ?? 0);
      const score = pair => { const values = load(pair); return Math.max(...values) * 100 + values.reduce((a,b)=>a+b,0); };
      let best = 0;
      for (let i = 1; i < remaining.length; i++) if (score(remaining[i]) < score(remaining[best])) best = i;
      const [pair] = remaining.splice(best, 1); ordered.push(pair);
      for (const id of Object.values(pair.games[0].models)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return ordered;
}
