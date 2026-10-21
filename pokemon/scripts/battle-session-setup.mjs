// Finish the binding before publishing the session to a watching workbench.
export async function createBoundBattleSession(client, cwd, title, model) {
  if (!model?.route || !model?.model) throw new Error('Battle session requires its admitted model');
  await client.workspace.add(cwd);
  const session = await client.session.new({ cwd, preset: 'battle' });
  await session.setModel({ slot: 'primary', route: model.route, model: model.model });
  await client.session.rename(session.id, title);
  const view = await session.projectUI(undefined, { surface: 'web' });
  if (view.usage?.model?.route !== model.route || view.usage?.model?.id !== model.model)
    throw new Error('Battle session projection does not match its admitted model');
  return session.id;
}
