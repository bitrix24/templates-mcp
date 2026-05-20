import { describe, expect, it, vi } from 'vitest'

// defineEventHandler is a Nuxt auto-import — stub it as identity so the
// handler's pure return value is observable in isolation.
vi.stubGlobal('defineEventHandler', <T>(fn: T) => fn)

const handler = (await import('../../../server/api/health.get')).default as () => {
  status: string
  timestamp: string
}

describe('/api/health', () => {
  it('returns the documented shape', () => {
    const result = handler()
    expect(result.status).toBe('ok')
    expect(() => new Date(result.timestamp)).not.toThrow()
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp)
  })

  it('produces a fresh timestamp on every call', async () => {
    const a = handler()
    // 2ms is enough to guarantee a different Date.now() on any platform
    await new Promise((r) => setTimeout(r, 2))
    const b = handler()
    expect(b.timestamp).not.toBe(a.timestamp)
  })

  it('has no extra fields — the deploy workflow relies on the payload being stable, and no service name / version / build / commit string is exposed (fingerprinting surface)', () => {
    const keys = Object.keys(handler()).sort()
    expect(keys).toEqual(['status', 'timestamp'])
  })
})
