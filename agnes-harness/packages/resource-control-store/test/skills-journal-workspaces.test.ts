import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillRootStatus } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { SkillJournalStore } from '../src/index.js'

it('persists more than 64 workspace root observations while retaining a bounded journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agnes-workspace-roots-'))
  const profile = 'local-dev'
  const scope = { allowedProfiles: [profile] }
  const roots: SkillRootStatus[] = Array.from({ length: 128 }, (_, index) => ({
    rootKey: 'workspace-agnes',
    scope: 'workspace',
    state: 'empty',
    workspaceId: createHash('sha256').update(String(index)).digest('hex'),
  }))
  try {
    const store = new SkillJournalStore(directory, scope)
    await store.transact(profile, (journal) => ({ next: { ...journal, roots }, result: undefined }))
    const reopened = new SkillJournalStore(directory, scope)
    expect(await reopened.read(profile, (journal) => journal.roots)).toEqual(roots)
    await expect(
      reopened.transact(profile, (journal) => ({
        next: { ...journal, roots: Array.from({ length: 8 }, () => roots).flat() },
        result: undefined,
      })),
    ).rejects.toMatchObject({ data: { code: 'RESOURCE_JOURNAL_CORRUPT' } })
    expect(await reopened.read(profile, (journal) => journal.roots)).toEqual(roots)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
