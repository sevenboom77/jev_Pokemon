import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PLAYER_HOMES } from './battle-env.mjs';
import { readFileSync } from 'node:fs';

/** Read-only fallback when the CLI cannot restore an already terminal session for export. */
export function readStoredHistory(seat, sessionId, { allowUnstarted = false, allowIncomplete = false, home = PLAYER_HOMES[seat] } = {}) {
  const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM events WHERE session_key = ? ORDER BY seq').all(sessionId);
    if (!rows.length || rows.some((r, i) => r.seq !== i + 1)) throw new Error('Stored history is missing or discontinuous.');
    const events = rows.map(r => ({
      seq: r.seq, ts: r.ts, id: r.id, type: r.type, lane: new TextDecoder().decode(r.lane), v: r.v,
      actor: JSON.parse(r.actor), origin: r.origin, trust: r.trust, data: JSON.parse(r.data),
      ...(r.register ? { register: r.register } : {}), ...(r.ignorable ? { ignorable: true } : {}),
      ...(r.surface_op ? { surfaceOp: JSON.parse(r.surface_op) } : {}),
      ...(r.source_event_seqs ? { sourceEventSeqs: JSON.parse(r.source_event_seqs) } : {}),
    }));
    if (!events.some(e => e.type === 'turn/end') && !allowIncomplete && !(allowUnstarted && !events.some(e => e.type === 'turn/start' || e.type === 'user/message'))) throw new Error('Stored task has no terminal event.');
    return events.map(e => JSON.stringify(e)).join('\n') + '\n';
  } finally { db.close(); }
}

/** Inspect the actual daemon generation and committed terminal state without loading a session. */
export function readPlayerTaskHealth(seat, sessionId, { home = PLAYER_HOMES[seat] } = {}) {
  const owner = JSON.parse(readFileSync(join(home, 'data/daemon/owner.json'), 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true });
  try {
    const terminal = db.prepare("SELECT data FROM events WHERE session_key=? AND type='turn/end' ORDER BY seq DESC LIMIT 1").get(sessionId);
    return { pid: owner.pid, generation: owner.generation, alive, terminalReason: terminal ? JSON.parse(terminal.data).reason : null };
  } finally { db.close(); }
}

/** AGH remints tool IDs. Its inference ledger retains the genuine provider response ID. */
export function storedToolResponseId(seat, toolIds, matchId) {
  const db = new DatabaseSync(join(PLAYER_HOMES[seat], 'data/sessions.db'), { readOnly: true });
  try {
    const ids = toolIds.map(toolId => {
      const row = db.prepare("SELECT session_key,seq,data FROM events WHERE type='tool/call' AND json_extract(data,'$.toolUseId')=? ORDER BY ts DESC LIMIT 1").get(toolId);
      if (!row || JSON.parse(row.data).args?.matchId !== matchId) return null;
      const ledger = db.prepare("SELECT data FROM events WHERE session_key=? AND seq>? AND type='cost/ledger' AND json_extract(data,'$.purpose')='inference' ORDER BY seq LIMIT 1").get(row.session_key, row.seq);
      return ledger ? JSON.parse(ledger.data).response?.id : null;
    });
    return ids.length && ids.every(id => id && id === ids[0]) ? ids[0] : null;
  } finally { db.close(); }
}

/** AGH can join two model summaries into one replacement with no single native response. */
export function storedCompactionSummary(seat, matchId, content, model, { home = PLAYER_HOMES[seat] } = {}) {
  if (!content.length || content.some(b => b.type !== 'text')) return null;
  const text = content.map(b => b.text).join('');
  const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT seq,session_key,origin,data,surface_op FROM events WHERE type='assistant/message' AND origin IN ('system','model') AND surface_op IS NOT NULL AND session_key IN (SELECT session_key FROM events WHERE type='tool/call' AND json_extract(data,'$.args.matchId')=?) ORDER BY ts DESC").all(matchId);
    for (const row of rows) {
      const stored = JSON.parse(row.data).content;
      if (JSON.parse(row.surface_op).op !== 'replace' || !stored.every(b => b.type === 'text') || stored.map(b => b.text).join('') !== text) continue;
      if (row.origin === 'model') {
        const ledger = db.prepare("SELECT data FROM events WHERE session_key=? AND seq=? AND type='cost/ledger'").get(row.session_key, row.seq + 1);
        const spend = ledger ? JSON.parse(ledger.data) : null;
        if (spend?.purpose !== 'compaction' || spend.model !== model) continue;
      }
      return content;
    }
    return null;
  } finally { db.close(); }
}

/** A summary may paraphrase away every textual identity marker. Use its unique durable owner. */
export function storedCompactionIdentity(content, model, { homes = PLAYER_HOMES } = {}) {
  if (!content.length || content.some(b => b.type !== 'text')) return null;
  const text = content.map(b => b.text).join('');
  const identities = new Map();
  for (const [seat, home] of Object.entries(homes)) {
    const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT seq,session_key,origin,data,surface_op FROM events WHERE type='assistant/message' AND origin IN ('system','model') AND surface_op IS NOT NULL").all();
      for (const row of rows) {
        const stored = JSON.parse(row.data).content;
        if (JSON.parse(row.surface_op).op !== 'replace' || !stored.every(b => b.type === 'text') || stored.map(b => b.text).join('') !== text) continue;
        const matches = db.prepare("SELECT DISTINCT json_extract(data,'$.args.matchId') AS matchId FROM events WHERE session_key=? AND type='tool/call'").all(row.session_key).filter(r => /^battle-[a-zA-Z0-9-]+$/.test(r.matchId));
        if (matches.length !== 1) continue;
        if (row.origin === 'system' && !db.prepare("SELECT seq FROM events WHERE session_key=? AND type='cost/ledger' AND json_extract(data,'$.purpose')='inference' AND json_extract(data,'$.model')=? LIMIT 1").get(row.session_key, model)) continue;
        const matchId = matches[0].matchId;
        if (storedCompactionSummary(seat, matchId, content, model, { home })) identities.set(seat + ':' + matchId, { seat, matchId });
      }
    } finally { db.close(); }
  }
  return identities.size === 1 ? [...identities.values()][0] : null;
}
