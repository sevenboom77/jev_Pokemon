/**
 * jev-client — Jev HTTP client + deterministic offline stub.
 *
 * Contract (frozen by docs/ARCHITECTURE.md and the Jev usage notes):
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   body: { model, state, questions }
 *   response: { answers: { action: { choice, probabilities, confidence } }, model, usage }
 *
 * No third-party dependencies. Uses global fetch and AbortController (Node 24).
 *
 * SECURITY: the API key is never logged, stored, or attached to any returned
 * value. Callers must pass it in explicitly (or set TYPESAFE_API_KEY).
 */

export const DEFAULT_MODEL = 'jev-1.13.0';
export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_CHOICES = 255;
export const ACTION_QUESTION_ID = 'action';
export const OFFLINE_MODEL = 'offline-stub';

export const ERROR_CODES = Object.freeze({
  E_INVALID_REQUEST: 'E_INVALID_REQUEST',
  E_CANDIDATE_COUNT: 'E_CANDIDATE_COUNT',
  E_INVALID_CANDIDATE: 'E_INVALID_CANDIDATE',
  E_NO_API_KEY: 'E_NO_API_KEY',
  E_AUTH: 'E_AUTH',
  E_RETRYABLE: 'E_RETRYABLE',
  E_TIMEOUT: 'E_TIMEOUT',
  E_INVALID_CHOICE: 'E_INVALID_CHOICE',
  E_API: 'E_API',
  E_OFFLINE_NOT_ALLOWED: 'E_OFFLINE_NOT_ALLOWED',
  E_SELFTEST: 'E_SELFTEST',
});

const DEFAULT_INSTRUCTIONS = '选择当前局面下最有利的合法动作。';
const CANDIDATE_META = Symbol.for('jev-client.candidateMeta');

/** Typed error thrown by every public function. Inspect `err.code`. */
export class JevError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    for (const key of ['status', 'detail', 'attempts', 'retryable', 'cause', 'chosen', 'candidateCount', 'candidateId']) {
      if (meta[key] !== undefined) this[key] = meta[key];
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      attempts: this.attempts,
      retryable: this.retryable,
    };
  }
}

function fail(code, message, meta) {
  throw new JevError(code, message, meta);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function truncate(value, max = 600) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic JSON string with sorted object keys. Used to embed publicFacts verbatim. */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null) return 'null';
    if (typeof node !== 'object') {
      if (typeof node === 'number' && !Number.isFinite(node)) return 'null';
      if (typeof node === 'bigint') return JSON.stringify(node.toString());
      if (typeof node === 'undefined' || typeof node === 'function' || typeof node === 'symbol') return undefined;
      return JSON.stringify(node);
    }
    if (seen.has(node)) return '"[Circular]"';
    seen.add(node);
    if (Array.isArray(node)) {
      return `[${node.map((entry) => walk(entry) ?? 'null').join(',')}]`;
    }
    const keys = Object.keys(node).sort();
    const parts = [];
    for (const key of keys) {
      const serialized = walk(node[key]);
      if (serialized !== undefined) parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${parts.join(',')}}`;
  };
  return walk(value) ?? 'null';
}

/**
 * Build the per-candidate criteria description. Only uses fields that the
 * candidate explicitly carries: label / description / publicFacts. Nothing
 * about card effects or costs is invented here.
 */
function candidateDescription(candidate) {
  const parts = [];
  if (isNonEmptyString(candidate.label)) parts.push(candidate.label.trim());
  if (isNonEmptyString(candidate.description)) {
    const description = candidate.description.trim();
    if (parts.indexOf(description) === -1) parts.push(description);
  }
  if (candidate.publicFacts !== undefined && candidate.publicFacts !== null) {
    const facts = stableStringify(candidate.publicFacts);
    if (facts !== '{}' && facts !== '[]' && facts !== 'null') parts.push(`publicFacts: ${facts}`);
  }
  if (parts.length === 0) {
    fail(
      ERROR_CODES.E_INVALID_CANDIDATE,
      `candidate ${JSON.stringify(candidate?.id ?? '?')} has no label/description/publicFacts; cannot describe it without inventing data`,
      { candidateId: candidate?.id },
    );
  }
  return parts.join(' | ');
}

function observationSources(observation) {
  const outer = isPlainObject(observation) ? observation : null;
  const inner = outer && isPlainObject(outer.observation) ? outer.observation : null;
  return [outer, inner].filter(Boolean);
}

function pickField(sources, ...keys) {
  for (const source of sources) {
    for (const key of keys) {
      if (source && source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

/**
 * State is copied only from the supplied observation. Recognised payload keys
 * are phase / own / opponent / public_history / available_card_rules; the
 * camelCase forms (publicHistory, rules) are accepted as aliases because the
 * Arena /observe shape uses them.
 */
function buildState(observation) {
  const sources = observationSources(observation);
  if (sources.length === 0) fail(ERROR_CODES.E_INVALID_REQUEST, 'observation must be a JSON object');
  const state = {};
  const put = (key, value) => {
    if (value !== undefined) state[key] = value;
  };
  put('phase', pickField(sources, 'phase'));
  put('own', pickField(sources, 'own'));
  put('opponent', pickField(sources, 'opponent'));
  put('public_history', pickField(sources, 'public_history', 'publicHistory'));
  put('available_card_rules', pickField(sources, 'available_card_rules', 'rules'));
  if (Object.keys(state).length === 0) {
    fail(
      ERROR_CODES.E_INVALID_REQUEST,
      'observation contained none of phase/own/opponent/public_history/available_card_rules',
    );
  }
  return state;
}

/**
 * Build the exact `{ model, state, questions }` payload for one Jev choice
 * question (questions.action).
 *
 * @param {object} input
 * @param {object} input.observation filtered seat-local observation
 * @param {Array<{id:string,kind?:string,label?:string,description?:string,publicFacts?:any}>} input.candidates 1..255 candidates
 * @param {string} [input.instructions]
 * @param {string} [input.model] defaults to jev-1.13.0
 * @returns {{model:string,state:object,questions:object}}
 */
export function buildChoiceRequest({ observation, candidates, instructions, model } = {}) {
  if (!isPlainObject(observation)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'buildChoiceRequest requires observation to be an object');
  }
  if (!Array.isArray(candidates)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'buildChoiceRequest requires candidates to be an array');
  }
  if (candidates.length === 0) {
    fail(ERROR_CODES.E_CANDIDATE_COUNT, 'candidates must contain at least 1 option (got 0)');
  }
  if (candidates.length > MAX_CHOICES) {
    fail(
      ERROR_CODES.E_CANDIDATE_COUNT,
      `candidates must contain at most ${MAX_CHOICES} options (got ${candidates.length})`,
      { candidateCount: candidates.length },
    );
  }

  const criteria = {};
  const meta = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) {
      fail(ERROR_CODES.E_INVALID_CANDIDATE, 'every candidate must be an object');
    }
    if (!isNonEmptyString(candidate.id)) {
      fail(ERROR_CODES.E_INVALID_CANDIDATE, 'every candidate needs a non-empty string id');
    }
    if (seen.has(candidate.id)) {
      fail(ERROR_CODES.E_INVALID_CANDIDATE, `duplicate candidate id ${JSON.stringify(candidate.id)}`, {
        candidateId: candidate.id,
      });
    }
    seen.add(candidate.id);
    criteria[candidate.id] = candidateDescription(candidate);
    meta.push({
      id: candidate.id,
      kind: candidate.kind ?? null,
      label: candidate.label ?? null,
      description: candidate.description ?? null,
      publicFacts: candidate.publicFacts ?? null,
    });
  }

  const resolvedModel = model === undefined ? DEFAULT_MODEL : model;
  if (!isNonEmptyString(resolvedModel)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'model must be a non-empty string');
  }
  const resolvedInstructions = instructions === undefined ? DEFAULT_INSTRUCTIONS : instructions;
  if (!isNonEmptyString(resolvedInstructions)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'instructions must be a non-empty string');
  }

  const request = {
    model: resolvedModel,
    state: buildState(observation),
    questions: {
      [ACTION_QUESTION_ID]: {
        type: 'choice',
        instructions: resolvedInstructions,
        criteria,
      },
    },
  };

  // Local-only metadata used by offlineDecider (kind/publicFacts). Symbol keys
  // are omitted by JSON.stringify, so the wire payload stays exactly
  // { model, state, questions }.
  Object.defineProperty(request, CANDIDATE_META, {
    value: meta,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return request;
}

/** Structural validation for a choice request before any network activity. */
export function validateChoiceRequest(request) {
  if (!isPlainObject(request)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'request must be an object');
  }
  if (!isNonEmptyString(request.model)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'request.model must be a non-empty string');
  }
  const state = request.state;
  if (!(isPlainObject(state) || typeof state === 'string' || Array.isArray(state))) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'request.state must be an object, string, or array');
  }
  const question = request.questions?.[ACTION_QUESTION_ID];
  if (!isPlainObject(question)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, `request.questions.${ACTION_QUESTION_ID} must be an object`);
  }
  if (question.type !== 'choice') {
    fail(ERROR_CODES.E_INVALID_REQUEST, `request.questions.${ACTION_QUESTION_ID}.type must be "choice"`);
  }
  if (!isNonEmptyString(question.instructions)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, `request.questions.${ACTION_QUESTION_ID}.instructions must be a non-empty string`);
  }
  if (!isPlainObject(question.criteria)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, `request.questions.${ACTION_QUESTION_ID}.criteria must be an object`);
  }
  const ids = Object.keys(question.criteria);
  if (ids.length === 0) {
    fail(ERROR_CODES.E_CANDIDATE_COUNT, 'choice criteria must contain at least 1 option (got 0)');
  }
  if (ids.length > MAX_CHOICES) {
    fail(
      ERROR_CODES.E_CANDIDATE_COUNT,
      `choice criteria must contain at most ${MAX_CHOICES} options (got ${ids.length})`,
      { candidateCount: ids.length },
    );
  }
  for (const id of ids) {
    if (!isNonEmptyString(question.criteria[id])) {
      fail(ERROR_CODES.E_INVALID_REQUEST, `criteria description for ${JSON.stringify(id)} must be a non-empty string`);
    }
  }
  return { ids, criteria: question.criteria, instructions: question.instructions, model: request.model };
}

async function readResponseText(response) {
  try {
    if (response && typeof response.text === 'function') return await response.text();
    if (response && typeof response.json === 'function') return JSON.stringify(await response.json());
  } catch {
    // fall through to empty string; callers surface E_API with truncated detail
  }
  return '';
}

function isAbortError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        error.code === 'ABORT_ERR' ||
        error.code === 'ERR_ABORTED'),
  );
}

/**
 * Call the real Jev API for one choice question.
 *
 * @param {ReturnType<typeof buildChoiceRequest>} request
 * @param {object} [options]
 * @param {string} [options.apiKey] defaults to process.env.TYPESAFE_API_KEY
 * @param {number} [options.timeoutMs=60000] AbortController timeout
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {number} [options.retries=1] extra attempts on 429/5xx/network errors only
 * @param {number} [options.retryDelayMs=0]
 * @param {string} [options.apiUrl=API_URL] override for fake-server integration tests
 * @returns {Promise<{selectedCandidateId:string,probabilities:object,confidence:number|null,model:string,usage:object|null,latencyMs:number,raw:object,attempts:number,offline:false}>}
 */
export async function decide(request, options = {}) {
  const {
    apiKey = process.env.TYPESAFE_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    retries = 1,
    retryDelayMs = 0,
    apiUrl = API_URL,
  } = options ?? {};

  const { ids, criteria, model } = validateChoiceRequest(request);

  if (!isNonEmptyString(apiKey)) {
    fail(
      ERROR_CODES.E_NO_API_KEY,
      'No TYPESAFE_API_KEY available; refusing to make a real Jev call. Use TCG_JEV_MODE=offline with offlineDecider().',
    );
  }
  if (Number.isFinite(timeoutMs) === false || timeoutMs <= 0) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'timeoutMs must be a positive finite number');
  }
  if (Number.isInteger(retries) === false || retries < 0) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'retries must be a non-negative integer');
  }
  if (typeof fetchImpl !== 'function') {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'fetchImpl must be a function');
  }
  if (!isNonEmptyString(apiUrl)) {
    fail(ERROR_CODES.E_INVALID_REQUEST, 'apiUrl must be a non-empty string');
  }
  let requestBody;
  try {
    requestBody = JSON.stringify(request);
  } catch (error) {
    fail(ERROR_CODES.E_INVALID_REQUEST, "request must be JSON-serializable", { cause: error });
  }

  const totalAttempts = retries + 1;
  let lastRetryable = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = nowMs();
    try {
      const response = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      });

      const status = typeof response?.status === 'number' ? response.status : 0;
      const bodyText = await readResponseText(response);
      const detail = truncate(bodyText);

      if (status === 401 || status === 403) {
        fail(ERROR_CODES.E_AUTH, `Jev API authentication failed (HTTP ${status})`, {
          status,
          attempts: attempt,
          detail,
        });
      }
      if (status === 429 || status >= 500) {
        fail(ERROR_CODES.E_RETRYABLE, `Jev API temporarily unavailable (HTTP ${status})`, {
          status,
          attempts: attempt,
          retryable: true,
          detail,
        });
      }
      if (status < 200 || status >= 300) {
        fail(ERROR_CODES.E_API, `Jev API rejected the request (HTTP ${status || 'unknown'})`, {
          status,
          attempts: attempt,
          detail,
        });
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        fail(ERROR_CODES.E_API, 'Jev API returned a non-JSON 2xx response', {
          status,
          attempts: attempt,
          detail,
        });
      }

      const answer = payload?.answers?.[ACTION_QUESTION_ID];
      if (!isPlainObject(answer)) {
        fail(ERROR_CODES.E_API, `Jev response is missing answers.${ACTION_QUESTION_ID}`, {
          status,
          attempts: attempt,
          detail: truncate(stableStringify(payload)),
        });
      }

      const choice = answer.choice;
      if (!isNonEmptyString(choice) || !Object.prototype.hasOwnProperty.call(criteria, choice)) {
        fail(
          ERROR_CODES.E_INVALID_CHOICE,
          `Jev selected ${JSON.stringify(choice)}, which is not one of the ${ids.length} supplied candidates`,
          { chosen: choice, candidateCount: ids.length, attempts: attempt },
        );
      }

      const probabilities = isPlainObject(answer.probabilities)
        ? { ...answer.probabilities }
        : isPlainObject(answer.probability)
          ? { ...answer.probability }
          : {};
      const confidence =
        typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
          ? answer.confidence
          : typeof probabilities[choice] === 'number'
            ? probabilities[choice]
            : null;

      return {
        selectedCandidateId: choice,
        probabilities,
        confidence,
        model: isNonEmptyString(payload.model) ? payload.model : model,
        usage: payload.usage ?? null,
        latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
        raw: payload,
        attempts: attempt,
        offline: false,
      };
    } catch (error) {
      if (error instanceof JevError) {
        if (error.code === ERROR_CODES.E_RETRYABLE && attempt < totalAttempts) {
          lastRetryable = error;
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }
        throw error;
      }
      if (isAbortError(error)) {
        fail(ERROR_CODES.E_TIMEOUT, `Jev request aborted after ${timeoutMs}ms`, {
          attempts: attempt,
          cause: error,
        });
      }
      const networkError = new JevError(
        ERROR_CODES.E_RETRYABLE,
        `Jev network error: ${error?.message ?? String(error)}`,
        { attempts: attempt, retryable: true, cause: error },
      );
      if (attempt < totalAttempts) {
        lastRetryable = networkError;
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      throw networkError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastRetryable ?? new JevError(ERROR_CODES.E_RETRYABLE, 'Jev request failed after retries', {
    attempts: totalAttempts,
    retryable: true,
  });
}

function firstFiniteNumber(object, keys) {
  if (!isPlainObject(object)) return null;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function candidateFacts(candidate) {
  return isPlainObject(candidate.publicFacts) ? candidate.publicFacts : null;
}

function looksLikeKnockoutAttack(kind, text, facts) {
  const isAttack = kind.includes('ATTACK') || /\battack\b|damage|伤害|攻击/i.test(text);
  if (!isAttack) return false;
  if (facts) {
    for (const key of [
      'canKnockOut',
      'canKnockout',
      'knockout',
      'knockOut',
      'wouldKnockOut',
      'wouldKnockout',
      'lethal',
      'ko',
    ]) {
      if (facts[key] === true) return true;
    }
    const damage = firstFiniteNumber(facts, ['damage', 'damageOutput', 'attackDamage', 'dmg']);
    const hp = firstFiniteNumber(facts, [
      'targetHp',
      'defenderHp',
      'remainingHp',
      'opponentRemainingHp',
      'activeHp',
      'hpRemaining',
    ]);
    if (damage !== null && hp !== null && damage >= hp) return true;
  }
  return /knock[\s_-]?out|\bko\b|击倒|击败|打倒/i.test(text);
}

function offlineCandidateEntries(request, options = {}) {
  const { criteria } = validateChoiceRequest(request);
  const provided = Array.isArray(options.candidates) && options.candidates.length > 0 ? options.candidates : null;
  const hidden = request[CANDIDATE_META];
  const source = provided ?? (Array.isArray(hidden) && hidden.length > 0 ? hidden : null);

  return Object.keys(criteria).map((id) => {
    const base = source ? source.find((entry) => entry?.id === id) ?? {} : {};
    const text = [
      base.label,
      base.description,
      criteria[id],
      base.publicFacts !== undefined && base.publicFacts !== null ? stableStringify(base.publicFacts) : '',
    ]
      .filter((part) => typeof part === 'string' && part.trim() !== '')
      .join(' ');
    const kind = typeof base.kind === 'string' ? base.kind.toUpperCase() : '';
    const facts = isPlainObject(base.publicFacts) ? base.publicFacts : null;

    let priority = 3;
    let strategy = 'stable-id';
    if (looksLikeKnockoutAttack(kind, text, facts)) {
      priority = 0;
      strategy = 'knockout-attack';
    } else if (kind.includes('ATTACH_ENERGY') || /(attach[\s\S]{0,40}energy|energy[\s\S]{0,40}attach|附能量|贴能量)/i.test(text)) {
      priority = 1;
      strategy = 'attach-energy';
    } else if (kind.includes('END_TURN') || /end[\s_-]?turn|pass turn|结束回合|结束这回合/i.test(text)) {
      priority = 2;
      strategy = 'end-turn';
    }
    return { id, priority, strategy };
  });
}

function seededScore(id, seed) {
  let hash = (0x811c9dc5 ^ (Number(seed) >>> 0)) >>> 0;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function compareByStrategy(a, b, seed) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  // The fallback rule is explicit: with no usable information, take the
  // lexicographically first candidate id. With information, seed breaks ties.
  if (a.priority !== 3) {
    const hashedA = seededScore(a.id, seed);
    const hashedB = seededScore(b.id, seed);
    if (hashedA !== hashedB) return hashedA - hashedB;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function offlineDistribution(ids, selectedId) {
  const probabilities = {};
  if (ids.length === 1) {
    probabilities[selectedId] = 1;
    return probabilities;
  }
  const selectedProbability = 0.6;
  const otherProbability = Number(((1 - selectedProbability) / (ids.length - 1)).toFixed(6));
  let assigned = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === selectedId) continue;
    const value = index === ids.length - 1
      ? Number((1 - selectedProbability - assigned).toFixed(6))
      : otherProbability;
    probabilities[id] = value;
    assigned = Number((assigned + value).toFixed(6));
  }
  probabilities[selectedId] = Number((1 - assigned).toFixed(6));
  return probabilities;
}

/**
 * Deterministic offline stand-in with the same result shape as decide().
 *
 * Only allowed when TCG_JEV_MODE=offline. Never performs network I/O.
 * Fixed strategy: knockout attack > attach energy > end turn > stable id.
 *
 * @param {ReturnType<typeof buildChoiceRequest>} request
 * @param {{seed?:number, candidates?:object[]}} [options]
 * @returns {{selectedCandidateId:string,probabilities:object,confidence:number,model:string,usage:null,latencyMs:number,raw:object,attempts:number,offline:true}}
 */
export function offlineDecider(request, options = {}) {
  if (process.env.TCG_JEV_MODE !== 'offline') {
    fail(
      ERROR_CODES.E_OFFLINE_NOT_ALLOWED,
      `offlineDecider is only allowed when TCG_JEV_MODE=offline (current: ${process.env.TCG_JEV_MODE ?? 'unset'})`,
    );
  }
  const seed = Number.isFinite(options.seed) ? options.seed : 0;
  const entries = offlineCandidateEntries(request, options).sort((a, b) => compareByStrategy(a, b, seed));
  const chosen = entries[0];
  const ids = entries.map((entry) => entry.id);
  const probabilities = offlineDistribution(ids, chosen.id);
  return {
    selectedCandidateId: chosen.id,
    probabilities,
    confidence: probabilities[chosen.id],
    model: OFFLINE_MODEL,
    usage: null,
    latencyMs: 0,
    raw: {
      offline: true,
      mode: 'offline-jev',
      strategy: chosen.strategy,
      seed,
      candidateCount: ids.length,
    },
    attempts: 0,
    offline: true,
  };
}

function assertSelftest(condition, message) {
  if (!condition) fail(ERROR_CODES.E_SELFTEST, `selftest failed: ${message}`);
}

async function withOfflineMode(fn) {
  const previous = process.env.TCG_JEV_MODE;
  process.env.TCG_JEV_MODE = 'offline';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TCG_JEV_MODE;
    else process.env.TCG_JEV_MODE = previous;
  }
}

function sampleObservation() {
  return {
    phase: 'MAIN_TURN',
    own: { active: 'Pikachu ex', bench: ['Raichu'], handCount: 5, energyAttached: true },
    opponent: { active: 'Charizard ex', bench: [], handCount: 4 },
    public_history: [{ seq: 1, type: 'ATTACH_ENERGY', seat: 'A' }],
    available_card_rules: { attachEnergyOncePerTurn: true, retreatOncePerTurn: true },
  };
}

function sampleCandidates() {
  return [
    {
      id: 'c-attack',
      kind: 'ATTACK',
      label: 'Thunder Burst',
      description: 'Deals 220 damage to the opponent active Pokémon.',
      publicFacts: { energyCost: 3, damage: 220, targetHp: 180, canKnockOut: true },
    },
    {
      id: 'c-attach',
      kind: 'ATTACH_ENERGY',
      label: 'Attach Lightning Energy',
      description: 'Attach one Lightning Energy from hand to your active Pokémon.',
      publicFacts: { energyCost: 0 },
    },
    {
      id: 'c-end',
      kind: 'END_TURN',
      label: 'End turn',
      description: 'End your turn without taking another action.',
      publicFacts: {},
    },
  ];
}

/**
 * Offline self-check: payload construction, schema validation, offline
 * determinism and error wiring. Does not touch the network.
 */
export async function selftest() {
  const checks = [];
  const run = async (name, fn) => {
    await fn();
    checks.push(name);
  };

  await run('buildChoiceRequest produces the frozen payload shape', () => {
    const request = buildChoiceRequest({ observation: sampleObservation(), candidates: sampleCandidates() });
    assertSelftest(request.model === DEFAULT_MODEL, 'model must default to jev-1.13.0');
    assertSelftest(
      JSON.stringify(Object.keys(request)) === JSON.stringify(['model', 'state', 'questions']),
      'payload keys must stay exactly model/state/questions',
    );
    assertSelftest(request.questions.action.type === 'choice', 'questions.action.type must be choice');
    assertSelftest(
      Object.keys(request.questions.action.criteria).join(',') === 'c-attack,c-attach,c-end',
      'criteria keys must be candidate ids',
    );
    const attackDescription = request.questions.action.criteria['c-attack'];
    assertSelftest(attackDescription.includes('Thunder Burst'), 'criteria must include candidate label');
    assertSelftest(attackDescription.includes('Deals 220 damage'), 'criteria must include candidate description');
    assertSelftest(attackDescription.includes('publicFacts'), 'criteria must include candidate publicFacts');
    assertSelftest(
      ['phase', 'own', 'opponent', 'public_history', 'available_card_rules'].every((key) => key in request.state),
      'state must include phase/own/opponent/public_history/available_card_rules',
    );
    assertSelftest(request.state.own.active === 'Pikachu ex', 'state.own must be copied verbatim');
  });

  await run('camelCase Arena observation aliases map into Jev state', () => {
    const request = buildChoiceRequest({
      observation: {
        phase: 'MAIN_TURN',
        observation: { own: { active: 'x' }, opponent: {}, publicHistory: [{ seq: 2 }], rules: { a: 1 } },
      },
      candidates: sampleCandidates(),
    });
    assertSelftest(request.state.public_history.length === 1, 'publicHistory must map to public_history');
    assertSelftest(request.state.available_card_rules.a === 1, 'rules must map to available_card_rules');
  });

  await run('candidate count boundaries throw E_CANDIDATE_COUNT', () => {
    const tooMany = Array.from({ length: MAX_CHOICES + 1 }, (_, index) => ({ id: `c-${index}`, label: 'x' }));
    for (const bad of [[], tooMany]) {
      let code = null;
      try {
        buildChoiceRequest({ observation: sampleObservation(), candidates: bad });
      } catch (error) {
        code = error.code;
      }
      assertSelftest(code === ERROR_CODES.E_CANDIDATE_COUNT, `expected E_CANDIDATE_COUNT, got ${code}`);
    }
  });

  await run('descriptions cannot be invented from nothing', () => {
    let code = null;
    try {
      buildChoiceRequest({ observation: sampleObservation(), candidates: [{ id: 'c-1' }] });
    } catch (error) {
      code = error.code;
    }
    assertSelftest(code === ERROR_CODES.E_INVALID_CANDIDATE, `expected E_INVALID_CANDIDATE, got ${code}`);
  });

  await run('wire payload JSON excludes local candidate metadata', () => {
    const request = buildChoiceRequest({ observation: sampleObservation(), candidates: sampleCandidates() });
    const wire = JSON.parse(JSON.stringify(request));
    assertSelftest(
      JSON.stringify(Object.keys(wire)) === JSON.stringify(['model', 'state', 'questions']),
      'wire keys must stay frozen',
    );
    assertSelftest(wire.questions.action.criteria['c-attack'].includes('Thunder Burst'), 'criteria must survive JSON round-trip');
  });

  await run('offlineDecider returns the decide() shape and is deterministic', () =>
    withOfflineMode(() => {
      const request = buildChoiceRequest({ observation: sampleObservation(), candidates: sampleCandidates() });
      const first = offlineDecider(request, { seed: 7 });
      const second = offlineDecider(request, { seed: 7 });
      assertSelftest(first.offline === true, 'offline result must be marked offline:true');
      assertSelftest(first.model === OFFLINE_MODEL, 'offline model must be offline-stub');
      assertSelftest(first.selectedCandidateId === second.selectedCandidateId, 'same seed must be deterministic');
      assertSelftest(first.selectedCandidateId === 'c-attack', 'knockout attack must win the fixed strategy');
      assertSelftest(first.usage === null, 'offline usage must be null');
      assertSelftest(first.probabilities[first.selectedCandidateId] === first.confidence, 'confidence must match selected probability');
      const total = Object.values(first.probabilities).reduce((sum, value) => sum + value, 0);
      assertSelftest(Math.abs(total - 1) < 1e-9, `probabilities must sum to 1 (got ${total})`);
    }));

  await run('offline strategy falls back to attach energy then stable id', () =>
    withOfflineMode(() => {
      const attachOnly = buildChoiceRequest({
        observation: sampleObservation(),
        candidates: sampleCandidates().filter((candidate) => candidate.id !== 'c-attack'),
      });
      assertSelftest(offlineDecider(attachOnly, { seed: 1 }).selectedCandidateId === 'c-attach', 'attach energy must beat end turn');
      const noInfo = buildChoiceRequest({
        observation: sampleObservation(),
        candidates: [
          { id: 'z-last', label: 'Z move', description: 'A move' },
          { id: 'a-first', label: 'A move', description: 'Another move' },
        ],
      });
      assertSelftest(offlineDecider(noInfo, { seed: 99 }).selectedCandidateId === 'a-first', 'no-info fallback must take lexicographic first id');
    }));

  await run('offlineDecider refuses to run outside TCG_JEV_MODE=offline', () => {
    const previous = process.env.TCG_JEV_MODE;
    delete process.env.TCG_JEV_MODE;
    try {
      let code = null;
      try {
        offlineDecider(buildChoiceRequest({ observation: sampleObservation(), candidates: sampleCandidates() }), { seed: 1 });
      } catch (error) {
        code = error.code;
      }
      assertSelftest(code === ERROR_CODES.E_OFFLINE_NOT_ALLOWED, `expected E_OFFLINE_NOT_ALLOWED, got ${code}`);
    } finally {
      if (previous === undefined) delete process.env.TCG_JEV_MODE;
      else process.env.TCG_JEV_MODE = previous;
    }
  });

  await run('decide refuses to call Jev without an API key', async () => {
    let fetchCalled = false;
    let code = null;
    try {
      await decide(buildChoiceRequest({ observation: sampleObservation(), candidates: sampleCandidates() }), {
        apiKey: '',
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('fetch must not be reached');
        },
      });
    } catch (error) {
      code = error.code;
    }
    assertSelftest(code === ERROR_CODES.E_NO_API_KEY, `expected E_NO_API_KEY, got ${code}`);
    assertSelftest(fetchCalled === false, 'no network call may happen without a key');
  });

  await run('decide validates the request before touching the network', async () => {
    let fetchCalled = false;
    let code = null;
    try {
      await decide({}, {
        apiKey: 'not-a-real-key',
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('fetch must not be reached');
        },
      });
    } catch (error) {
      code = error.code;
    }
    assertSelftest(code === ERROR_CODES.E_INVALID_REQUEST, `expected E_INVALID_REQUEST, got ${code}`);
    assertSelftest(fetchCalled === false, 'invalid requests must not reach the network');
  });

  console.log(`[jev-client selftest] ${checks.length} checks passed (offline only, no network)`);
  return { ok: true, checks: checks.length, networkCalls: 0 };
}
