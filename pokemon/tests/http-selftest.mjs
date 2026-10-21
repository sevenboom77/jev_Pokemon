import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startArena } from "../packages/arena/src/server.mjs";
import { createOfflineDecider } from "../packages/arena/src/decider-offline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const deckA = JSON.parse(fs.readFileSync(path.join(ROOT, "configs/decks/deck-a.json"), "utf8")).cards;
const deckB = JSON.parse(fs.readFileSync(path.join(ROOT, "configs/decks/deck-b.json"), "utf8")).cards;

const arena = await startArena({ port: 0, mode: "offline", decider: createOfflineDecider(), log: () => {} });
const base = "http://127.0.0.1:" + arena.port;

async function api(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  try { value = text.length > 0 ? JSON.parse(text) : null; } catch (error) { value = text; }
  return { status: response.status, value };
}

function assert(condition, message) {
  if (condition === false || condition === undefined || condition === null) throw new Error("ASSERT: " + message);
}

const report = { engine: arena.arena.engine.engineVersion, commit: arena.arena.engine.engineCommit, checks: {}, matches: {} };

async function runMatch(matchId, cardsA, cardsB, seed, recordPrefix) {
  const created = await api("POST", "/match", { matchId, generation: 1, format: "STANDARD", deckA: cardsA, deckB: cardsB, seed, mode: "offline-jev" });
  assert(created.status === 200, "POST /match status " + created.status + " " + JSON.stringify(created.value));
  const engineMatch = arena.arena.engine.getMatch(matchId);
  assert(engineMatch !== null, "engine match exists");
  const probes = {};
  let previousDecision = null;
  let steps = 0;
  const t0 = Date.now();
  while (steps < 3000) {
    const pendingResponse = await api("GET", "/pending?matchId=" + encodeURIComponent(matchId));
    assert(pendingResponse.status === 200, "GET /pending status");
    const pending = pendingResponse.value;
    if (pending.finished) break;
    assert(pending.pending.length > 0, "pending non-empty at step " + steps);
    const p = pending.pending[0];
    const observeResponse = await api("GET", "/observe?matchId=" + encodeURIComponent(matchId) + "&seat=" + p.seat + "&decisionId=" + encodeURIComponent(p.decisionId));
    assert(observeResponse.status === 200, "GET /observe status");
    const obs = observeResponse.value;
    assert(obs.candidates.length > 0, "candidates non-empty for " + p.promptType + " " + obs.unsupported);
    const decideResponse = await api("POST", "/decide", { matchId, generation: 1, seat: p.seat, decisionId: p.decisionId, nonce: "n-" + steps });
    assert(decideResponse.status === 200, "POST /decide status");
    const receipt = decideResponse.value;
    assert(receipt.selectedCandidateId !== null, "receipt selected");
    const submitBody = { matchId, generation: 1, seat: p.seat, decisionId: p.decisionId, stateRevision: obs.stateRevision, receiptId: receipt.receiptId, idempotencyKey: matchId + ":" + p.decisionId };
    if (steps === 0) {
      const before = engineMatch.actionCount;
      const wrongSeat = p.seat === "A" ? "B" : "A";
      const wrongSeatRes = await api("POST", "/submit", Object.assign({}, submitBody, { seat: wrongSeat }));
      assert(wrongSeatRes.value.accepted === false && wrongSeatRes.value.error === "E_WRONG_SEAT", "wrong seat rejected");
      assert(engineMatch.actionCount === before, "wrong seat no action");
      const staleRes = await api("POST", "/submit", Object.assign({}, submitBody, { stateRevision: obs.stateRevision + 1 }));
      assert(staleRes.value.accepted === false && staleRes.value.error === "E_STALE_STATE", "stale revision rejected");
      assert(engineMatch.actionCount === before, "stale revision no action");
      probes.wrongSeat = wrongSeatRes.value.error;
      probes.staleState = staleRes.value.error;
      const accepted = await api("POST", "/submit", submitBody);
      assert(accepted.value.accepted === true, "first submit accepted " + JSON.stringify(accepted.value));
      assert(engineMatch.actionCount === before + 1, "first submit applied");
      const duplicate = await api("POST", "/submit", submitBody);
      assert(duplicate.value.accepted === true && duplicate.value.duplicate === true, "duplicate idempotent");
      assert(engineMatch.actionCount === before + 1, "duplicate no extra action");
      probes.duplicate = "idempotent";
      previousDecision = { decisionId: p.decisionId, receiptId: receipt.receiptId, seat: p.seat, stateRevision: obs.stateRevision };
    } else if (steps === 1 && previousDecision) {
      const staleDecisionRes = await api("POST", "/submit", { matchId, generation: 1, seat: previousDecision.seat, decisionId: previousDecision.decisionId, stateRevision: previousDecision.stateRevision, receiptId: previousDecision.receiptId, idempotencyKey: matchId + ":stale:" + steps });
      assert(staleDecisionRes.value.accepted === false && staleDecisionRes.value.error === "E_STALE_DECISION", "old decision rejected");
      probes.staleDecision = staleDecisionRes.value.error;
      const accepted = await api("POST", "/submit", submitBody);
      assert(accepted.value.accepted === true, "submit accepted at step 1 " + JSON.stringify(accepted.value));
      previousDecision = null;
    } else {
      const accepted = await api("POST", "/submit", submitBody);
      assert(accepted.value.accepted === true, "submit accepted at step " + steps + " " + JSON.stringify(accepted.value));
    }
    steps += 1;
  }
  const result = await api("GET", "/result?matchId=" + encodeURIComponent(matchId));
  const events = await api("GET", "/events?matchId=" + encodeURIComponent(matchId) + "&since=0");
  const decisionsA = await api("GET", "/decisions?matchId=" + encodeURIComponent(matchId) + "&seat=A&since=0");
  const decisionsB = await api("GET", "/decisions?matchId=" + encodeURIComponent(matchId) + "&seat=B&since=0");
  const decisions = decisionsA.value.concat(decisionsB.value).sort((a, b) => a.seq - b.seq);
  return { matchId, result: result.value, events: events.value.events, decisions, steps, elapsedMs: Date.now() - t0, probes, engineMatch };
}

const main = await runMatch("m-main", deckA, deckB, 4242);
report.matches.main = { result: main.result, steps: main.steps, elapsedMs: main.elapsedMs, probes: main.probes, decisions: main.decisions.length, events: main.events.length };
assert(main.result.finished === true, "main match finished");
assert(main.result.winner === "A" || main.result.winner === "B", "main match has winner");
assert(["PRIZES", "DECK_OUT", "CONCEDE"].indexOf(main.result.reason) !== -1, "main reason " + main.result.reason);
let lastSeq = 0;
for (const event of main.events) { assert(event.seq > lastSeq, "events monotonic"); lastSeq = event.seq; }
assert(main.decisions.length > 0, "decision records saved");
assert(main.probes.wrongSeat === "E_WRONG_SEAT" && main.probes.staleState === "E_STALE_STATE" && main.probes.staleDecision === "E_STALE_DECISION" && main.probes.duplicate === "idempotent", "invalid submit probes");
report.checks.mainMatch = true;
report.checks.illegalSubmitNoExtraAction = true;
report.checks.eventsMonotonic = true;

await api("POST", "/match", { matchId: "m-iso", generation: 1, format: "STANDARD", deckA, deckB, seed: 777, mode: "offline-jev" });
const isoEngine = arena.arena.engine.getMatch("m-iso");
let isoSteps = 0;
while (isoSteps < 400) {
  const pr = await api("GET", "/pending?matchId=m-iso");
  if (pr.value.finished) break;
  const p = pr.value.pending[0];
  const ob = await api("GET", "/observe?matchId=m-iso&seat=" + p.seat + "&decisionId=" + encodeURIComponent(p.decisionId));
  const rc = await api("POST", "/decide", { matchId: "m-iso", generation: 1, seat: p.seat, decisionId: p.decisionId, nonce: "iso-" + isoSteps });
  const sb = await api("POST", "/submit", { matchId: "m-iso", generation: 1, seat: p.seat, decisionId: p.decisionId, stateRevision: ob.value.stateRevision, receiptId: rc.value.receiptId, idempotencyKey: "m-iso:" + p.decisionId });
  if (sb.value.accepted === false) throw new Error("iso submit " + sb.value.error);
  isoSteps += 1;
  const bPlayerNow = isoEngine.game.state.players[1];
  if (bPlayerNow.hand.cards.length >= 3 && bPlayerNow.deck.cards.length >= 5) break;
}
const aBefore = await api("GET", "/observe?matchId=m-iso&seat=A");
const bPlayer = isoEngine.game.state.players[1];
const handBefore = bPlayer.hand.cards.map(c => c.fullName).join("|");
const deckBefore = bPlayer.deck.cards.map(c => c.fullName).join("|");
bPlayer.hand.cards.reverse();
bPlayer.deck.cards.reverse();
const handAfter = bPlayer.hand.cards.map(c => c.fullName).join("|");
const deckAfter = bPlayer.deck.cards.map(c => c.fullName).join("|");
const aAfter = await api("GET", "/observe?matchId=m-iso&seat=A");
const aView1 = JSON.stringify(aBefore.value.observation);
const aView2 = JSON.stringify(aAfter.value.observation);
const hiddenOrderChanged = handBefore !== handAfter || deckBefore !== deckAfter;
report.isolation = { isoSteps, handBefore, handAfter, deckBefore, deckAfter, hiddenOrderChanged, aViewsEqual: aView1 === aView2 };
assert(aView1 === aView2, "A observation invariant under B hidden change");
assert(hiddenOrderChanged, "test is meaningful: B hidden order changed");
report.checks.infoIsolation = true;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(ROOT, "runs", "selftest-" + stamp);
await fsp.mkdir(runDir, { recursive: true });
await fsp.writeFile(path.join(runDir, "result.json"), JSON.stringify(main.result, null, 2) + "\n");
await fsp.writeFile(path.join(runDir, "events.jsonl"), main.events.map(e => JSON.stringify(e)).join("\n") + "\n");
const decisionsA = main.decisions.filter(d => d.seat === "A");
const decisionsB = main.decisions.filter(d => d.seat === "B");
await fsp.writeFile(path.join(runDir, "decisions-a.jsonl"), decisionsA.map(d => JSON.stringify(d)).join("\n") + "\n");
await fsp.writeFile(path.join(runDir, "decisions-b.jsonl"), decisionsB.map(d => JSON.stringify(d)).join("\n") + "\n");
await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ matchId: main.matchId, generation: 1, seed: 4242, engine: report.engine, commit: report.commit, steps: main.steps, elapsedMs: main.elapsedMs, decisions: main.decisions.length, events: main.events.length, probes: main.probes }, null, 2) + "\n");
report.runDir = path.relative(ROOT, runDir);
await fsp.mkdir(path.join(ROOT, "evidence"), { recursive: true });
await fsp.writeFile(path.join(ROOT, "evidence", "game-engine-selftest.json"), JSON.stringify(report, null, 2) + "\n");
await arena.stop();
console.log(JSON.stringify({ ok: true, runDir: report.runDir, result: main.result, steps: main.steps, elapsedMs: main.elapsedMs, decisions: main.decisions.length, events: main.events.length, probes: main.probes, isolation: report.isolation }, null, 2));
process.exit(0);
