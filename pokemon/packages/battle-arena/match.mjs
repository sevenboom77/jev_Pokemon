import sim from 'pokemon-showdown';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { decide } from '../jev-client/index.mjs';
import { DECISION_POLICY, JEV_STRATEGY } from './strategy.mjs';
import { jevRequests, jevRequestKeys } from './request-pool.mjs';

const { BattleStream, getPlayerStreams, Teams, Dex } = sim;
const PLAYERS = { A: 'p1', B: 'p2' };
export const FIXED_TEAMS = {
  A: [
    { species: 'Pikachu', ability: 'Static', moves: ['Thunderbolt', 'Volt Switch', 'Quick Attack', 'Grass Knot'] },
    { species: 'Charizard', ability: 'Blaze', moves: ['Flamethrower', 'Air Slash', 'Dragon Pulse', 'Roost'] },
    { species: 'Venusaur', ability: 'Overgrow', moves: ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Synthesis'] },
  ],
  B: [
    { species: 'Blastoise', ability: 'Torrent', moves: ['Surf', 'Ice Beam', 'Aura Sphere', 'Protect'] },
    { species: 'Gengar', ability: 'Cursed Body', moves: ['Shadow Ball', 'Sludge Bomb', 'Thunderbolt', 'Will-O-Wisp'] },
    { species: 'Dragonite', ability: 'Inner Focus', moves: ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Dragon Dance'] },
  ],
};
// A short, real rule-engine fixture for service concurrency acceptance, excluded from model scores.
export const CONCURRENCY_TEAMS = Object.fromEntries(['A', 'B'].map(seat => [seat, [
  { species: 'Shedinja', ability: 'Wonder Guard', moves: ['Shadow Sneak', 'Shadow Claw'] },
]]));
export class BattleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Each player reads only its own simulator stream and the public spectator stream. */
export class BattleMatch extends EventEmitter {
  constructor({ id = 'battle-' + randomUUID().slice(0, 8), teams = FIXED_TEAMS, seed = [10, 3, 20, 26], jev = false, suite = 'evaluation', league = null, playerNames = { A: 'Agnes · A', B: 'DeepSeek · B' } } = {}) {
    super();
    this.id = id;
    this.teams = structuredClone(teams);
    this.seed = seed;
    this.suite = suite;
    this.league = league;
    this.settlementReason = null;
    this.turnLimitPending = false;
    this.playerNames = { ...playerNames };
    this.stream = new BattleStream();
    this.streams = getPlayerStreams(this.stream);
    this.requests = { A: null, B: null };
    this.decisionNumbers = { A: 0, B: 0 };
    this.submissions = new Map();
    this.publicLog = [];
    this.decisions = [];
    this.traces = [];
    this.sessions = {};
    this.executionMode = null;
    this.jevEnabled = jev;
    this.evaluations = new Map();
    this.turn = 0;
    this.finished = false;
    this.winner = null;
    this.status = 'ready';
    this.error = null;
    this.paused = false;
    this.known = { A: {}, B: {} };
    this.active = { A: null, B: null };
    this.tasks = [this.consumePublic(), ...Object.keys(PLAYERS).map(seat => this.consumeSeat(seat))];
    // Join all stream readers: unexpected stream errors must abort rather than masquerade as victory.
    for (const task of this.tasks) task.catch(error => this.abort(error.message));
  }

  async start() {
    const team = seat => Teams.pack(this.teams[seat].map(p => ({ level: 50, gender: 'M', ...p })));
    await this.streams.omniscient.write(
      '>start ' + JSON.stringify({ formatid: 'gen9customgame', seed: this.seed }) + '\n' +
      '>player p1 ' + JSON.stringify({ name: this.playerNames.A, team: team('A') }) + '\n' +
      '>player p2 ' + JSON.stringify({ name: this.playerNames.B, team: team('B') })
    );
    await this.settle();
    return this;
  }

  async settle() { await new Promise(resolve => setImmediate(resolve)); }

  async consumeSeat(seat) {
    for await (const chunk of this.streams[PLAYERS[seat]]) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('|request|')) {
          const request = JSON.parse(line.slice(9));
          if (request.wait) { this.requests[seat] = null; continue; }
          this.decisionNumbers[seat]++;
          this.requests[seat] = {
            id: `${this.id}-${seat}-${this.decisionNumbers[seat]}`,
            request,
          };
          this.emit('change');
        } else if (line.startsWith('|error|')) {
          this.abort('Simulator rejected a submitted action: ' + line.slice(7));
        }
      }
    }
  }

  async consumePublic() {
    for await (const chunk of this.streams.spectator) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('|')) continue;
        this.publicLog.push(line);
        this.applyPublic(line);
      }
      this.emit('change');
    }
  }

  applyPublic(line) {
    const [, type, ident, detail, health] = line.split('|');
    const seat = ident?.startsWith('p1') ? 'A' : ident?.startsWith('p2') ? 'B' : null;
    if (type === 'turn') this.turn = Number(ident);
    if (['switch', 'drag', 'replace'].includes(type) && seat) {
      const species = detail.split(',')[0];
      const pokemon = { ident, species, types: Dex.species.get(species).types, health, movesSeen: this.known[seat][ident]?.movesSeen ?? [] };
      this.known[seat][ident] = { ...this.known[seat][ident], ...pokemon };
      this.active[seat] = ident;
    }
    if (['-damage', '-heal', '-sethp'].includes(type) && seat && this.known[seat][ident]) {
      this.known[seat][ident].health = detail;
    }
    if (type === 'faint' && seat && this.known[seat][ident]) this.known[seat][ident].health = '0 fnt';
    if (type === 'move' && seat && this.known[seat][ident]) {
      const moves = this.known[seat][ident].movesSeen;
      if (!moves.includes(detail)) moves.push(detail);
    }
    if (type === '-status' && seat && this.known[seat][ident]) this.known[seat][ident].status = detail;
    if (type === '-curestatus' && seat && this.known[seat][ident]) delete this.known[seat][ident].status;
    if (type === 'win' || type === 'tie') {
      this.finished = true;
      this.status = 'finished';
      this.winner = type === 'tie' ? null : Object.keys(PLAYERS).find(seat => this.playerNames[seat] === ident) ?? null;
      this.requests = { A: null, B: null };
    }
  }

  candidates(seat) {
    const pending = this.requests[seat];
    if (!pending) return [];
    const r = pending.request;
    const choices = [];
    const add = (choice, label, facts = {}) => choices.push({
      id: createHash('sha256').update(pending.id + ':' + choice).digest('hex').slice(0, 16),
      label, choice, ...facts,
    });
    if (r.teamPreview) {
      const count = r.side.pokemon.length;
      for (let i = 1; i <= count; i++) {
        const order = [i, ...Array.from({ length: count }, (_, j) => j + 1).filter(x => x !== i)];
        add('team ' + order.join(''), '首发 ' + r.side.pokemon[i - 1].details.split(',')[0], { kind: 'lead' });
      }
      return choices;
    }
    const active = r.active?.[0];
    const opponent = this.known[seat === 'A' ? 'B' : 'A'][this.active[seat === 'A' ? 'B' : 'A']];
    if (!r.forceSwitch?.[0] && active) {
      for (const [index, move] of active.moves.entries()) {
        if (move.disabled || (move.pp === 0 && move.id !== 'struggle')) continue;
        const info = Dex.moves.get(move.id);
        const multiplier = opponent
          ? Dex.getImmunity(info.type, opponent.types) ? 2 ** Dex.getEffectiveness(info.type, opponent.types) : 0
          : null;
        add('move ' + (index + 1), '使用 ' + move.move, {
          kind: 'move', move: move.move, type: info.type, category: info.category,
          basePower: info.basePower, accuracy: info.accuracy, pp: move.pp, typeMultiplier: multiplier,
          description: info.shortDesc,
        });
      }
    }
    if (r.forceSwitch?.[0] || !active?.trapped) {
      const current = r.side.pokemon.find(p => p.active);
      const switchReason = !r.forceSwitch?.[0] ? 'voluntary' : current?.condition.endsWith('fnt') ? 'faintReplacement' : 'pivot';
      const previous = this.decisions.filter(d => d.seat === seat && d.phase === 'move').at(-1);
      r.side.pokemon.forEach((pokemon, i) => {
        if (!pokemon.active && !pokemon.condition.endsWith('fnt')) {
          add('switch ' + (i + 1), '换上 ' + pokemon.details.split(',')[0], {
            kind: 'switch', species: pokemon.details.split(',')[0], health: pokemon.condition,
            switchReason, spendsTurn: switchReason === 'voluntary',
            immediateSwitchBack: switchReason === 'voluntary' && previous?.kind === 'switch'
              && previous.turn === this.turn - 1 && previous.fromSpecies === pokemon.details.split(',')[0],
          });
        }
      });
    }
    return choices;
  }

  observe(seat) {
    const pending = this.requests[seat];
    const other = seat === 'A' ? 'B' : 'A';
    const candidates = this.candidates(seat).map(({ choice, ...candidate }) => candidate);
    return {
      matchId: this.id, seat, turn: this.turn, decisionId: pending?.id ?? null,
      needsDecision: !!pending && !this.paused, finished: this.finished, status: this.status,
      winner: this.winner, error: this.error, paused: this.paused,
      jev: { enabled: this.jevEnabled, required: this.jevEnabled && candidates.length > 1 },
      phase: this.finished ? 'ended' : this.paused ? 'paused' : !pending ? 'waiting' : pending.request.teamPreview ? 'teamPreview' : pending.request.forceSwitch?.[0] ? 'forcedSwitch' : 'move',
      own: pending?.request.side ?? null,
      decisionPolicy: DECISION_POLICY,
      recentOwnActions: this.decisions.filter(d => d.seat === seat).slice(-6),
      opponent: { active: this.known[other][this.active[other]] ?? null, revealed: Object.values(this.known[other]) },
      candidates,
      publicHistory: this.publicLog.slice(-60),
      rules: 'Gen 9 singles, fixed three-Pokemon teams at level 50; no Tera choices. Only supplied candidates may be submitted. Opponent moves, stats and choices are hidden until publicly revealed. Type multiplier is not a win probability.',
    };
  }

  async wait(seat, decisionId, { timeoutMs = 45000, signal } = {}) {
    const ready = () => this.finished || (!this.paused && this.requests[seat] && this.requests[seat].id !== decisionId);
    const response = async timedOut => {
      // Private requests and public battle events arrive on separate stream readers.
      // Drain both before returning an observation for the newly available decision.
      await this.settle();
      return { ...this.observe(seat), waitStatus: timedOut ? 'timeout' : this.finished ? 'ended' : 'ready' };
    };
    if (signal?.aborted) throw new BattleError('E_WAIT_CANCELLED', 'Wait was cancelled.');
    if (ready()) return response(false);
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); this.off('change', changed); signal?.removeEventListener('abort', cancelled); };
      const changed = () => { if (ready()) { clean(); resolve(response(false)); } };
      const cancelled = () => { clean(); reject(new BattleError('E_WAIT_CANCELLED', 'Wait was cancelled.')); };
      const timer = setTimeout(() => { clean(); resolve(response(true)); }, timeoutMs);
      this.on('change', changed);
      signal?.addEventListener('abort', cancelled, { once: true });
    });
  }

  async act(seat, { decisionId, candidateId, explanation = '' }) {
    if (this.turnLimitPending) throw new BattleError('E_SETTLING', 'The turn limit is settling as a draw; wait for the final observation.');
    const existing = this.submissions.get(decisionId);
    if (existing) {
      if (existing.seat !== seat || existing.candidateId !== candidateId) throw new BattleError('E_DUPLICATE_CONFLICT', 'This decision already has a different action.');
      return existing;
    }
    const pending = this.requests[seat];
    if (!pending || pending.id !== decisionId || this.finished) throw new BattleError('E_STALE_DECISION', 'Observe the current decision again.');
    if (this.paused) throw new BattleError('E_PAUSED', 'The match is paused. Wait for it to resume.');
    const candidate = this.candidates(seat).find(c => c.id === candidateId);
    if (!candidate) throw new BattleError('E_INVALID_ACTION', 'Candidate is not legal for this seat and decision.');
    if (this.jevEnabled && this.candidates(seat).length > 1 && !this.traces.some(t => t.type === 'jev' && t.seat === seat && t.decisionId === decisionId)) {
      throw new BattleError('E_JEV_REQUIRED', 'Call battle_evaluate for this decision before choosing; you retain final choice.');
    }
    const current = pending.request.side.pokemon.find(p => p.active);
    const result = { accepted: true, seat, decisionId, candidateId, label: candidate.label, turn: this.turn,
      kind: candidate.kind, phase: pending.request.teamPreview ? 'teamPreview' : pending.request.forceSwitch?.[0] ? 'forcedSwitch' : 'move',
      ...(candidate.kind === 'switch' ? { switchReason: candidate.switchReason, spendsTurn: candidate.spendsTurn,
        fromSpecies: current?.details.split(',')[0] ?? null, toSpecies: candidate.species,
        immediateSwitchBack: candidate.immediateSwitchBack } : {}),
      explanation: explanation.slice(0, 400) };
    this.submissions.set(decisionId, result);
    this.requests[seat] = null;
    this.decisions.push({ ...result, at: new Date().toISOString() });
    this.emit('change');
    await this.streams[PLAYERS[seat]].write(candidate.choice);
    await this.settle();
    if (this.error) throw new BattleError('E_ENGINE', this.error);
    return { ...result, finished: this.finished, engineStatus: this.status };
  }

  async evaluate(seat, decisionId) {
    const observation = this.observe(seat);
    if (!observation.needsDecision || observation.decisionId !== decisionId) throw new BattleError('E_STALE_DECISION', 'Observe again before evaluating.');
    if (!this.jevEnabled) throw new BattleError('E_JEV_DISABLED', 'This match does not use Jev.');
    if (observation.candidates.length < 2) return { skipped: true, reason: 'only_one_legal_action', decisionId };
    const key = seat + ':' + decisionId;
    if (!this.evaluations.has(key)) {
      const pending = this.evaluateOnce(seat, decisionId, observation).catch(error => {
        // A failed network attempt is not an evaluation. Allow the same AGH task to
        // retry it; simultaneous callers still share this in-flight attempt.
        if (this.evaluations.get(key) === pending) this.evaluations.delete(key);
        throw error;
      });
      this.evaluations.set(key, pending);
    }
    return this.evaluations.get(key);
  }

  async evaluateOnce(seat, decisionId, observation) {
    const request = {
      model: 'jev-1.13.0', state: observation,
      questions: { action: {
        type: 'choice', instructions: JEV_STRATEGY,
        criteria: Object.fromEntries(observation.candidates.map(c => [c.id, JSON.stringify(c)])),
      } },
    };
    const result = await decide(request, { timeoutMs: 60000, retries: 0,
      fetchImpl: (url, init) => jevRequests.fetch(url, init, jevRequestKeys, this.requestObserver?.({ kind: 'jev', seat, decisionId, model: 'jev-1.13.0' })),
    });
    const evaluation = {
      seat, decisionId, model: result.model, selectedCandidateId: result.selectedCandidateId,
      probabilities: result.probabilities, confidence: result.confidence,
      latencyMs: result.latencyMs, usage: result.usage, offline: false,
    };
    this.traces.push({ type: 'jev', at: new Date().toISOString(), ...evaluation });
    this.emit('change');
    return evaluation;
  }

  feedback(seat, decisionId) {
    const submission = this.submissions.get(decisionId);
    if (submission && submission.seat !== seat) throw new BattleError('E_WRONG_SEAT', 'Decision belongs to another player.');
    return { submission: submission ?? null, turn: this.turn, finished: this.finished, winner: this.winner, status: this.status, publicHistory: this.publicLog.slice(-24) };
  }

  snapshot() {
    return {
      id: this.id, format: 'gen9customgame', suite: this.suite, seed: this.seed, turn: this.turn,
      league: this.league, settlementReason: this.settlementReason,
      status: this.status, finished: this.finished, winner: this.winner, error: this.error,
      executionMode: this.executionMode, jevEnabled: this.jevEnabled,
      decisionPolicy: DECISION_POLICY,
      playerNames: this.playerNames,
      paused: this.paused, publicLog: this.publicLog, decisions: this.decisions,
      traces: this.traces, sessions: this.sessions,
      pending: Object.keys(PLAYERS).filter(seat => this.requests[seat]),
      teams: Object.fromEntries(Object.entries(this.teams).map(([seat, team]) => [seat, team.map(p => p.species)])),
    };
  }

  abort(message) {
    if (this.status === 'finished' || this.status === 'aborted') return;
    this.status = 'aborted'; this.error = message; this.finished = true;
    this.requests = { A: null, B: null };
    this.emit('change');
  }

  async settleTurnLimit() {
    if (this.finished || this.turnLimitPending) return;
    this.turnLimitPending = true;
    this.settlementReason = 'turn-limit-draw';
    await this.streams.omniscient.write('>forcetie');
    await this.settle();
  }

  async close() { await this.stream.writeEnd(); await Promise.allSettled(this.tasks); }
}
