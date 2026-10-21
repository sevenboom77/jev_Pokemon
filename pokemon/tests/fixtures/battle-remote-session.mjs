// SPDX-License-Identifier: Apache-2.0
// Extracted unchanged from the original AGH daemon; see battle-remote-session.source.json.
var RemoteSession = class {
  constructor(key2, writerRunId, generation, link, cwd, onTurnBoundary) {
    this.key = key2;
    this.writerRunId = writerRunId;
    this.generation = generation;
    this.link = link;
    this.cwd = cwd;
    this.onTurnBoundary = onTurnBoundary;
  }
  key;
  writerRunId;
  generation;
  link;
  cwd;
  onTurnBoundary;
  lastSeq = 0;
  runSeq = 0;
  activeRuns = 0;
  /** A manual compaction persists a turn before its following `run()` command starts. */
  manualTurnReserved = false;
  /** External admission may enqueue a prompt before it can call `run()`. */
  activityLeases = 0;
  latestCache = /* @__PURE__ */ new Map();
  get running() {
    return this.activeRuns > 0 || this.manualTurnReserved || this.activityLeases > 0;
  }
  /**
   * Hold a worker generation across a caller's enqueue → run gap. This is deliberately separate
   * from ACP's client-visible `inflight` marker: scheduled work has no prompt id or cancel route.
   */
  beginActivity() {
    this.activityLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activityLeases--;
      this.onTurnBoundary?.();
    };
  }
  observe(e2) {
    if (e2.seq > this.lastSeq) this.lastSeq = e2.seq;
  }
  observeRegister(e2) {
    if (!e2.register) return;
    const dataKey = e2.data?.key ?? "";
    this.latestCache.set(`${e2.register}/${dataKey}`, e2.data);
  }
  enqueue(target2, msg) {
    return this.link.command("enqueue", { target: target2, msg });
  }
  async run(o) {
    const runId = `${this.key}#${++this.runSeq}`;
    const onAbort = () => {
      void this.link.command("abort", { runId }).catch((error) => {
        const code = typeof error?.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(error.code) ? error.code : null;
        console.error(JSON.stringify({ type: "battle-abort-relay-failed", at: new Date().toISOString(), sessionId: this.key, code }));
      });
    };
    if (!this.link.alive) throw new Error("worker link closed");
    this.activeRuns++;
    o.signal.addEventListener("abort", onAbort, { once: true });
    let completed = false;
    try {
      const result2 = await this.link.command("run", { runId, until: o.until });
      if (result2.lastSeq > this.lastSeq) this.lastSeq = result2.lastSeq;
      completed = true;
      return result2;
    } catch (error4) {
      try {
        if (await this.link.command("latest", { register: "op.state", key: "main" }) == null)
          completed = true;
      } catch {
      }
      throw error4;
    } finally {
      o.signal.removeEventListener("abort", onAbort);
      this.activeRuns--;
      if (completed) this.manualTurnReserved = false;
      this.onTurnBoundary?.();
    }
  }
  async status() {
    const state2 = await this.link.command("ping", {});
    if (typeof state2.lastSeq === "number" && state2.lastSeq > this.lastSeq) this.lastSeq = state2.lastSeq;
    const parent = typeof state2.parent?.key === "string" && typeof state2.parent.boundarySeq === "number" ? { key: state2.parent.key, boundarySeq: state2.parent.boundarySeq } : void 0;
    return {
      lastSeq: this.lastSeq,
      preset: typeof state2.preset === "string" ? state2.preset : null,
      ...parent ? { parent } : {}
    };
  }
  async currentPreset() {
    return (await this.status()).preset;
  }
  scan(q) {
    return this.link.command("scan", q);
  }
  readToolDetailPage(input) {
    return this.link.command("readToolDetail", input);
  }
  /**
   * A hibernated worker session answers with nothing rather than waking. Bounded, because a viewer
   * holds its live previews until the snapshot answers; a failure releases them without it.
   */
  async previewSnapshot() {
    const got = await this.link.command("previewSnapshot", {}, { timeoutMs: PREVIEW_SNAPSHOT_TIMEOUT_MS });
    return Array.isArray(got) ? got : [];
  }
  latest(register2, key2) {
    return this.latestCache.get(`${register2}/${key2 ?? ""}`);
  }
  projectUI(upto, o = {}) {
    return this.link.command("projectUI", { upto, ...o });
  }
  projectUIPatch(after, upto, o = {}) {
    return this.link.command("projectUIPatch", { after, upto, ...o });
  }
  projectUIOpening(o = {}) {
    return this.link.command("projectUIOpening", o);
  }
  projectUIHistory(cut, beforeIndex, o = {}) {
    return this.link.command("projectUIHistory", { cut, beforeIndex, ...o });
  }
  append(tx) {
    return this.link.command("append", { tx });
  }
  async setPreset(preset) {
    const result2 = await this.link.command("setPreset", { preset });
    this.lastSeq = Math.max(this.lastSeq, result2.effectiveFromSeq);
    return result2.effectiveFromSeq;
  }
  async setModel(sel) {
    const result2 = await this.link.command("setModel", { sel });
    this.lastSeq = Math.max(this.lastSeq, result2.effectiveFromSeq);
    return result2.effectiveFromSeq;
  }
  async setYolo(enabled, actor) {
    const result2 = await this.link.command("setYolo", { enabled, actor });
    this.lastSeq = Math.max(this.lastSeq, result2.effectiveFromSeq);
    return result2.effectiveFromSeq;
  }
  async requestCompaction(input) {
    if (!this.link.alive) throw new Error("worker link closed");
    this.manualTurnReserved = true;
    try {
      return await this.link.command("manualCompact", input);
    } catch (error4) {
      let released = false;
      try {
        if (await this.link.command("latest", { register: "op.state", key: "main" }) == null) {
          released = true;
        }
      } catch {
      }
      if (released) {
        this.manualTurnReserved = false;
        this.onTurnBoundary?.();
      }
      throw error4;
    }
  }
  /** Named to match core `HostSession.resumeApproval`'s job, not its name: the worker-side command
   *  handler (worker/commands.ts) is the piece that actually calls `resumeApproval` - this method is
   *  the daemon-internal `RemoteSession`'s own name for reaching it over the wire. */
  decideApproval(p) {
    return this.link.command("decideApproval", p);
  }
  /** Identity resolution belongs to the worker's assembled Host, not the kernel-less supervisor. */
  resolveActor(credential, surface) {
    return this.link.command("resolveActor", { credential, surface });
  }
  fork(at, childKey, credential, binding) {
    return this.link.command("fork", { at, childKey, credential, binding });
  }
  resume() {
    return this.link.command("resume", {});
  }
  async close() {
    await this.link.closeSession().catch(() => void 0);
  }
};

// fixture boundary
