import { daemonStatus } from '@agnes/daemon'
import type { LocalBackend } from './backend.js'

/** Rebuild Web resources when the shared owner exits or changes. Never signal an owner here. */
export async function waitForBackendChange(
  backend: LocalBackend,
  signal: AbortSignal,
  deps: { status?: typeof daemonStatus; intervalMs?: number } = {},
): Promise<void> {
  const status = deps.status ?? daemonStatus
  let failures = 0
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, deps.intervalMs ?? 2000)
      timer.unref()
      signal.addEventListener('abort', finish, { once: true })
    })
    if (signal.aborted) return
    try {
      const current = await status(backend.scope.dataDir, { identityTimeoutMs: 1000, socketTimeoutMs: 1000 })
      const changed =
        !current.running ||
        current.socketReachable === false ||
        current.owner?.generation !== backend.discovery.owner.generation
      failures = changed ? failures + 1 : 0
    } catch {
      failures++
    }
    if (failures >= 2) return
  }
}
