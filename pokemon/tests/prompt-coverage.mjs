import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArenaEngine } from "../packages/arena/src/engine/index.mjs";
import { createOfflineDecider } from "../packages/arena/src/decider-offline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
function four(card) { return [card, card, card, card]; }
const deck = [].concat(
  four("Team Rocket\u0027s Tarountula DRI"),
  four("Team Rocket\u0027s Spidops DRI"),
  four("Team Rocket\u0027s Mewtwo ex DRI"),
  four("Team Rocket\u0027s Mimikyu DRI"),
  four("Ultra Ball PAF"),
  four("Earthen Vessel PAR"),
  four("Night Stretcher SFA"),
  four("Switch SVI"),
  four("Professor\u0027s Research SVI"),
  four("Team Rocket\u0027s Great Ball DRI"),
  ["Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE", "Grass Energy SVE"],
  ["Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE", "Psychic Energy SVE"],
);
const engine = createArenaEngine({ log: () => {} });
const decider = createOfflineDecider();
const match = await engine.createMatch({ matchId: "coverage", generation: 1, format: 1, deckA: deck, deckB: deck, seed: 99, mode: "offline-jev" });
const candidateKinds = new Set();
const promptTypes = new Set();
const unsupported = new Set();
let steps = 0;
const t0 = Date.now();
let finished = false;
while (steps < 800) {
  const pending = match.getPending();
  if (pending.length === 0) { if (match.finished) { finished = true; break; } break; }
  const p = pending[0];
  promptTypes.add(p.promptType);
  if (p.unsupported) unsupported.add(p.promptType + ":" + p.unsupported);
  const obs = match.observe(p.seat, p.decisionId);
  for (const c of obs.candidates) candidateKinds.add(c.kind);
  if (obs.candidates.length === 0) { unsupported.add(p.promptType + ":ZERO_CANDIDATES"); break; }
  const receipt = await match.decide(p.seat, p.decisionId, decider);
  const res = match.submit({ seat: p.seat, decisionId: p.decisionId, stateRevision: obs.stateRevision, receiptId: receipt.receiptId, idempotencyKey: "cov:" + p.decisionId });
  if (res.accepted === false) { unsupported.add(p.promptType + ":SUBMIT_" + res.error); break; }
  steps += 1;
  if (match.finished) { finished = true; break; }
}
const summary = { matchId: "coverage", finished, steps, elapsedMs: Date.now() - t0, result: match.getResult(), engineStuck: match.engineStuck, engineError: match._lastEngineError || null, candidateKinds: Array.from(candidateKinds).sort(), promptTypes: Array.from(promptTypes).sort(), unsupported: Array.from(unsupported).sort(), deckSize: deck.length };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(ROOT, "runs", "coverage-" + stamp);
await fsp.mkdir(runDir, { recursive: true });
await fsp.writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
await fsp.writeFile(path.join(ROOT, "evidence", "game-engine-coverage.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
match.stop(); engine.stop();
process.exit(0);
