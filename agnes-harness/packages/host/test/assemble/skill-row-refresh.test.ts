import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const emptySkills: SkillRuntimeInput = {
  list: () => [],
  read: () => ({ ok: false, code: 'NOT_FOUND' }),
  readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
}

it.each([false, true])(
  'refreshes admitted Skills but respects a disabled capability ceiling (%s)',
  async (disabled) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agnes-skill-row-'))
    let attempts = 0
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        skillResources: emptySkills,
        ...(disabled
          ? { profileInputs: { user: { name: 'local-dev', policy: { capabilityCeiling: [] } } } }
          : {}),
        packages: {
          '@agnes/base': {
            ecosystem: {
              ...baseEcosystem,
              'agnes/skills': (init) => {
                attempts++
                if (attempts === 1) throw new Error('synthetic first load failure')
                return baseEcosystem['agnes/skills'](init)
              },
            },
          },
        },
      })
      try {
        if (disabled) {
          const before = host.extensionRows.current()
          await host.refreshSkillRow(emptySkills)
          await host.refreshSkillRow(undefined)
          expect(host.extensionRows.current()).toEqual(before)
          expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).not.toBe(true)
          expect(attempts).toBe(0)
          return
        }
        expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(false)
        await host.refreshSkillRow(emptySkills)
        expect(attempts).toBe(2)
        expect(host.extensions().find((status) => status.id === 'agnes/skills')?.loaded).toBe(true)
        await host.refreshSkillRow(emptySkills)
        expect(attempts).toBe(2)
      } finally {
        await host.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  },
)
