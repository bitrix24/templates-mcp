import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Verifies the Nitro shutdown plugin wires `drainAuditQueue` onto the
 * `close` hook. `defineNitroPlugin` is a Nitro auto-import (a global at
 * runtime, undefined under Vitest) so we stub it to return the plugin
 * function unchanged, then drive a fake Nitro app whose hook registry we
 * can trigger.
 */

const drainAuditQueue = vi.fn(async () => {})
vi.mock('~/server/utils/audit-log', () => ({ drainAuditQueue }))

// `defineNitroPlugin(fn)` simply returns `fn` at runtime; that's all we need.
vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)

afterEach(() => {
  drainAuditQueue.mockClear()
})

interface FakeNitro {
  hooks: { hook: (name: string, cb: () => Promise<void>) => void }
}

async function loadPlugin(): Promise<(nitro: FakeNitro) => void> {
  vi.resetModules()
  const mod = await import('../../server/plugins/audit-drain')
  return mod.default as unknown as (nitro: FakeNitro) => void
}

describe('audit-drain Nitro plugin (#61)', () => {
  it('registers a `close` hook that calls drainAuditQueue', async () => {
    const registered = new Map<string, () => Promise<void>>()
    const nitro: FakeNitro = {
      hooks: { hook: (name, cb) => void registered.set(name, cb) },
    }

    const plugin = await loadPlugin()
    plugin(nitro)

    expect(registered.has('close')).toBe(true)
    expect(drainAuditQueue).not.toHaveBeenCalled()

    await registered.get('close')!()
    expect(drainAuditQueue).toHaveBeenCalledTimes(1)
  })
})
