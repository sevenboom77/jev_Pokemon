import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storedCompactionSummary, storedCompactionIdentity, readStoredHistory, readPlayerTaskHealth } from '../scripts/battle-history.mjs';

test('a crashed task retains its actual partial history without inventing a terminal event', () => {
  const home = mkdtempSync(join(tmpdir(), 'battle-incomplete-history-'));
  mkdirSync(join(home, 'data/daemon'), { recursive: true });
  writeFileSync(join(home, 'data/daemon/owner.json'), JSON.stringify({ pid: process.pid, generation: 'actual-generation' }));
  const db = new DatabaseSync(join(home, 'data/sessions.db'));
  try {
    db.exec('CREATE TABLE events (session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, lane BLOB, v INTEGER, actor TEXT, origin TEXT, trust TEXT, data TEXT)');
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [seq, type] of [[1, 'session/start'], [2, 'turn/start']])
      insert.run('actual-session', seq, '2026-10-05', 'event-' + seq, type, Buffer.from('main'), 1, '{}', 'system', 'trusted', '{}');
    assert.throws(() => readStoredHistory('A', 'actual-session', { home }), /no terminal event/);
    const actual = readStoredHistory('A', 'actual-session', { home, allowIncomplete: true }).trim().split('\n').map(JSON.parse);
    assert.deepEqual(actual.map(e => e.type), ['session/start', 'turn/start']);
    assert.deepEqual(actual.map(e => e.seq), [1, 2]);
    assert.equal(readPlayerTaskHealth('A', 'actual-session', { home }).terminalReason, null);
    insert.run('actual-session', 3, '2026-10-05', 'event-3', 'turn/end', Buffer.from('main'), 1, '{}', 'system', 'trusted', JSON.stringify({ reason: 'parked' }));
    assert.equal(readPlayerTaskHealth('A', 'actual-session', { home }).terminalReason, 'parked');
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('joined AGH compaction is authenticated against the actual game, model and durable replacement', () => {
  const home = mkdtempSync(join(tmpdir(), 'battle-summary-ledger-'));
  mkdirSync(join(home, 'data'));
  const db = new DatabaseSync(join(home, 'data/sessions.db'));
  try {
    db.exec('CREATE TABLE events (session_key TEXT, seq INTEGER, type TEXT, origin TEXT, data TEXT, surface_op TEXT, ts TEXT)');
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)');
    const content = [{ type: 'text', text: 'Actual history summary\n\n[turn prefix]\nActual current-turn summary' }];
    insert.run('session-a', 1, 'tool/call', 'model', JSON.stringify({ args: { matchId: 'battle-one' } }), null, '2026-10-04');
    insert.run('session-a', 2, 'assistant/message', 'model', JSON.stringify({ content }), JSON.stringify({ op: 'replace' }), '2026-10-04');
    insert.run('session-a', 3, 'cost/ledger', 'system', JSON.stringify({ purpose: 'compaction', model: 'deepseek-flash' }), null, '2026-10-04');
    const lookup = (match, value, model) => storedCompactionSummary('A', match, value, model, { home });
    const owner = (value = content, model = 'deepseek-flash') => storedCompactionIdentity(value, model, { homes: { A: home } });
    assert.deepEqual(lookup('battle-one', content, 'deepseek-flash'), content);
    assert.deepEqual(owner(), { seat: 'A', matchId: 'battle-one' });
    assert.equal(owner(content, 'other-model'), null);
    assert.equal(owner([{ type: 'text', text: content[0].text + ' tampered' }]), null);
    insert.run('session-b', 1, 'tool/call', 'model', JSON.stringify({ args: { matchId: 'battle-two' } }), null, '2026-10-04');
    insert.run('session-b', 2, 'assistant/message', 'model', JSON.stringify({ content }), JSON.stringify({ op: 'replace' }), '2026-10-04');
    insert.run('session-b', 3, 'cost/ledger', 'system', JSON.stringify({ purpose: 'compaction', model: 'deepseek-flash' }), null, '2026-10-04');
    assert.equal(owner(), null); // Identical summaries in two games are ambiguous.
    db.prepare("DELETE FROM events WHERE session_key='session-b'").run();
    assert.equal(lookup('battle-two', content, 'deepseek-flash'), null);
    assert.equal(lookup('battle-one', content, 'other-model'), null);
    assert.equal(lookup('battle-one', [{ type: 'text', text: content[0].text + ' tampered' }], 'deepseek-flash'), null);
    db.prepare("UPDATE events SET data=? WHERE seq=3").run(JSON.stringify({ purpose: 'inference', model: 'deepseek-flash' }));
    assert.equal(lookup('battle-one', content, 'deepseek-flash'), null);
    db.prepare("UPDATE events SET surface_op=NULL WHERE seq=2").run();
    assert.equal(lookup('battle-one', content, 'deepseek-flash'), null);
  } finally {
    db.close(); rmSync(home, { recursive: true, force: true });
  }
});
