import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadExtraModels(root) {
  const file = join(root, '.runtime/battle-extra-models.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).map(model => ({
    ...model, key: JSON.parse(readFileSync(model.credentialPath, 'utf8')).key,
  }));
}
