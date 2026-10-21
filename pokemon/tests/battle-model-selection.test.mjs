import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBattleModels } from '../packages/battle-arena/model-selection.mjs';
import { modelForDisplay, displayBattleLines } from '../packages/battle-web/model-names.js';
import { createBoundBattleSession } from '../scripts/battle-session-setup.mjs';

test('side-swapped matches use the same admitted models and reject unknown providers', () => {
  const catalog = [{ route: 'x', model: 'gemini' }, { route: 'y', model: 'gpt' }];
  const defaults = { A: catalog[0], B: catalog[1] };
  assert.deepEqual(selectBattleModels(catalog, defaults), defaults);
  const swapped = selectBattleModels(catalog, defaults, { A: 'y', B: 'x' });
  assert.deepEqual(swapped, { A: catalog[1], B: catalog[0] });
  assert.throws(() => selectBattleModels(catalog, defaults, { A: 'unregistered-provider' }), /未知/);
});

test('public names change while provider request identifiers and archived engine results remain intact', () => {
  const deepseek = { route: 'battle-deepseek', model: 'deepseek-flash', api: 'anthropic-messages' };
  const kimi = { route: 'battle-kimi', model: 'Kimi-K3-bingxing' };
  const catalog = [deepseek, kimi].map(modelForDisplay);
  assert.equal(catalog[0].displayName, 'DeepSeek-V4.1-Flash');
  assert.equal(catalog[1].displayName, 'Kimi-K3');
  const selected = selectBattleModels(catalog, { A: catalog[0], B: catalog[1] });
  assert.equal(selected.A.model, 'deepseek-flash');
  assert.equal(selected.B.model, 'Kimi-K3-bingxing');
  const lines = ['|player|p1|DeepSeek · A||', '|player|p2|Kimi · B||', '|move|p1a: Pikachu|Thunderbolt|p2a: Blastoise', '|win|DeepSeek · A'];
  const rendered = displayBattleLines(lines, { models: selected, playerNames: { A: 'DeepSeek · A', B: 'Kimi · B' } });
  assert.equal(rendered[0], '|player|p1|DeepSeek-V4.1-Flash · A||');
  assert.equal(rendered.at(-1), '|win|DeepSeek-V4.1-Flash · A');
  assert.equal(rendered[2], lines[2]);
  assert.equal(lines.at(-1), '|win|DeepSeek · A');
});

test('a published session already projects its admitted model, including side swaps', async () => {
  for (const model of [{ route: 'battle-deepseek', model: 'deepseek-flash' }, { route: 'battle-agnes', model: 'agnes-3.0-flash' }]) {
    let binding = { route: 'battle-agnes', id: 'agnes-3.0-flash' };
    const client = {
      workspace: { add: async () => {} },
      session: {
        new: async () => ({ id: 'bound-session', setModel: async selected => { binding = { route: selected.route, id: selected.model }; }, projectUI: async () => ({ usage: { model: binding } }) }),
        rename: async () => { assert.deepEqual(binding, { route: model.route, id: model.model }); },
      },
    };
    assert.equal(await createBoundBattleSession(client, '/workspace', 'Bound player', model), 'bound-session');
  }
  const mismatched = { workspace: { add: async () => {} }, session: { new: async () => ({ id: 'wrong', setModel: async () => {}, projectUI: async () => ({ usage: { model: { route: 'battle-agnes', id: 'agnes-3.0-flash' } } }) }), rename: async () => {} } };
  await assert.rejects(createBoundBattleSession(mismatched, '/workspace', 'Bound player', { route: 'battle-deepseek', model: 'deepseek-flash' }), /does not match/);
});
