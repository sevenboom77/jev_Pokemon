import fs from "node:fs";
import { createArenaEngine } from "../packages/arena/src/engine/index.mjs";
import { createOfflineDecider } from "../packages/arena/src/decider-offline.mjs";

const deckA = JSON.parse(fs.readFileSync(new URL("../configs/decks/deck-a.json", import.meta.url), "utf8"));
const deckB = JSON.parse(fs.readFileSync(new URL("../configs/decks/deck-b.json", import.meta.url), "utf8"));

const engine = createArenaEngine({ log: (...args) => console.log("[engine]", ...args) });
const decider = createOfflineDecider();
const match = await engine.createMatch({ matchId: "smoke-1", generation: 1, format: 1, deckA: deckA.cards, deckB: deckB.cards, seed: 12345, mode: "offline-jev" });
console.log("created", match.inspect().stateRevision, match.getPending());
let steps = 0;
const t0 = Date.now();
while (steps < 3000) {
  const pending = match.getPending();
  if (pending.length === 0) {
    if (match.finished) break;
    const snap = match.inspect();
    throw new Error("no pending but not finished: " + JSON.stringify(snap.engineStuck));
  }
  const p = pending[0];
  const obs = match.observe(p.seat, p.decisionId);
  if (obs.candidates.length === 0) throw new Error("zero candidates " + p.promptType + " " + obs.unsupported);
  const receipt = await match.decide(p.seat, p.decisionId, decider);
  if (receipt.error) throw new Error("decide error " + receipt.error);
  const res = match.submit({ seat: p.seat, decisionId: p.decisionId, stateRevision: obs.stateRevision, receiptId: receipt.receiptId, idempotencyKey: "smoke-" + p.decisionId });
  if (res.accepted === false) throw new Error("submit rejected " + res.error + " " + p.promptType);
  steps += 1;
  if (match.finished) break;
  if (steps % 25 === 0) console.log("step", steps, "rev", match.stateRevision, "pending", pending.length);
}
const result = match.getResult();
console.log("RESULT", JSON.stringify(result));
console.log("steps", steps, "ms", Date.now() - t0, "events", match.getEvents(0).events.length);
match.stop();
engine.stop();
process.exit(0);
