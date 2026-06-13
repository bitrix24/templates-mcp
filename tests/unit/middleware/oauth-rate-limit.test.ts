import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same h3-stub pattern as mcp-auth.test.ts: defineEventHandler becomes the
// identity function, the rest read off a synthetic event object.
vi.mock('h3', () => ({
  defineEventHandler: <T>(fn: T) => fn,
  getRequestURL: (event: FakeEvent) => new URL(event._url, 'http://test.local'),
  getRequestIP: (event: FakeEvent) => event._ip,
  setResponseHeader: (event: FakeEvent, name: string, value: string) => {
    event._responseHeaders ??= {}
    event._responseHeaders[name.toLowerCase()] = value
  },
  createError: (opts: { statusCode: number, statusMessage: string, data?: { errorCode?: string } }) => {
    const err = new Error(opts.statusMessage) as Error & {
      statusCode: number
      statusMessage: string
      data?: { errorCode?: string }
    }
    err.statusCode = opts.statusCode
    err.statusMessage = opts.statusMessage
    err.data = opts.data
    return err
  },
}))

interface FakeEvent {
  _url: string
  _ip?: string
  _responseHeaders?: Record<string, string>
}

const runtimeConfig: { bitrix24OauthEnabled: boolean } = { bitrix24OauthEnabled: true }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const loggerCalls: Array<{ event: string, ctx: Record<string, unknown> | undefined }> = []
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({
    warning: (event: string, ctx?: Record<string, unknown>) => {
      loggerCalls.push({ event, ctx })
      return Promise.resolve()
    },
  }),
}))

const mod = await import('../../../server/middleware/oauth-rate-limit')
const middleware = mod.default as unknown as (event: FakeEvent) => void
const { _resetOauthRateLimitForTests } = mod

function hit(ip: string, url = '/api/oauth/install'): FakeEvent {
  const event: FakeEvent = { _url: url, _ip: ip }
  middleware(event)
  return event
}

describe('oauth-rate-limit middleware', () => {
  beforeEach(() => {
    _resetOauthRateLimitForTests()
    runtimeConfig.bitrix24OauthEnabled = true
    loggerCalls.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(1_750_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips paths other than /api/oauth/install (callback, health, mcp untouched)', () => {
    for (let i = 0; i < 20; i++) {
      expect(() => hit('1.2.3.4', '/api/oauth/callback')).not.toThrow()
      expect(() => hit('1.2.3.4', '/api/oauth/_health')).not.toThrow()
      expect(() => hit('1.2.3.4', '/mcp')).not.toThrow()
    }
  })

  it('skips entirely when the OAuth flag is off (webhook-only forks see no 429 surface)', () => {
    runtimeConfig.bitrix24OauthEnabled = false
    for (let i = 0; i < 20; i++) {
      expect(() => hit('1.2.3.4')).not.toThrow()
    }
  })

  it('allows 10 requests per IP per minute, refuses the 11th with 429 RATE-LIMITED + Retry-After', () => {
    for (let i = 0; i < 10; i++) expect(() => hit('1.2.3.4')).not.toThrow()

    let caught: (Error & { statusCode?: number, data?: { errorCode?: string } }) | undefined
    let event: FakeEvent | undefined
    try {
      event = { _url: '/api/oauth/install', _ip: '1.2.3.4' }
      middleware(event)
    }
    catch (err) {
      caught = err as typeof caught
    }
    expect(caught).toBeDefined()
    expect(caught!.statusCode).toBe(429)
    expect(caught!.data?.errorCode).toBe('RATE-LIMITED')
    // Standard header so well-behaved clients back off without parsing JSON.
    // Pin the exact value: all 10 hits land at t=0 (fake timers frozen), so
    // the oldest expires a full WINDOW_MS later → ceil(60_000/1000) = 60.
    expect(Number(event!._responseHeaders?.['retry-after'])).toBe(60)
    // §11 event logged with the source ip.
    const logged = loggerCalls.find(c => c.event === 'oauth.install.deny.rate-limited')
    expect(logged).toBeDefined()
    expect(logged!.ctx).toMatchObject({ ip: '1.2.3.4' })
  })

  it('leaves comfortable headroom over the 5 install probes the CI smoke script makes', () => {
    // Regression guard for the #227 docker-smoke coupling: the OAuth-on
    // gate runs manual-qa-pr2c.sh, which makes 5 /install probes from one
    // IP. The limit must stay above that or CI flakes. Assert the 6th also
    // passes so there is provable headroom ABOVE the probe count — a future
    // MAX_PER_WINDOW=5 (==probe count, zero margin) would fail here.
    for (let i = 0; i < 6; i++) expect(() => hit('10.9.8.7')).not.toThrow()
  })

  it('buckets are per-IP — a second client is unaffected by the first one flooding', () => {
    for (let i = 0; i < 15; i++) {
      try {
        hit('10.0.0.1')
      }
      catch { /* flooding client gets refused — expected */ }
    }
    expect(() => hit('10.0.0.2')).not.toThrow()
  })

  it('window slides: after 60s the oldest hit expires and a new request passes', () => {
    for (let i = 0; i < 10; i++) hit('1.2.3.4')
    expect(() => hit('1.2.3.4')).toThrow(/Too many install attempts/)

    vi.advanceTimersByTime(61_000)
    expect(() => hit('1.2.3.4')).not.toThrow()
  })

  it('window boundary is strict: at EXACTLY 60s the oldest hit still counts (matches the feedback-quota window)', () => {
    // 10 hits at t=0; the bucket is full.
    for (let i = 0; i < 10; i++) hit('1.2.3.4')
    // Advance to exactly 60_000ms. With strict `<` semantics the t=0 hit
    // is NOT yet expired (0 < 0 is false), so the 11th is still refused.
    vi.advanceTimersByTime(60_000)
    expect(() => hit('1.2.3.4')).toThrow(/Too many install attempts/)
    // One more ms and the window opens.
    vi.advanceTimersByTime(1)
    expect(() => hit('1.2.3.4')).not.toThrow()
  })

  it('a refused request does not consume a slot (the window is not extended by retries)', () => {
    for (let i = 0; i < 10; i++) hit('1.2.3.4')
    // Hammer the refused state a few times…
    for (let i = 0; i < 3; i++) {
      expect(() => hit('1.2.3.4')).toThrow()
    }
    // …the original 10 still expire on the original schedule.
    vi.advanceTimersByTime(61_000)
    expect(() => hit('1.2.3.4')).not.toThrow()
  })

  it('missing source IP falls into a shared <unknown> bucket and is still limited', () => {
    for (let i = 0; i < 10; i++) {
      expect(() => middleware({ _url: '/api/oauth/install' })).not.toThrow()
    }
    expect(() => middleware({ _url: '/api/oauth/install' })).toThrow(/Too many install attempts/)
  })

  it('LRU eviction cannot be gamed: a continuously-active IP survives a 10k-IP churn and stays limited', () => {
    // The bypass we're defending against: an attacker hammers one IP to
    // its limit, then rotates throwaway IPs to flush the map and reset
    // their own counter. With true LRU the attacker's IP stays MRU (each
    // request — even a refused one — moves it to the back), so the churn
    // only ever evicts genuinely idle throwaways, never the active IP.
    for (let i = 0; i < 10; i++) hit('1.1.1.1')
    expect(() => hit('1.1.1.1')).toThrow(/Too many install attempts/)

    // Churn 10k throwaway IPs, but the attacker keeps touching their own
    // IP periodically (as a real attacker would) — that keeps it MRU.
    for (let i = 0; i < 10_000; i++) {
      hit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)
      if (i % 50 === 0) {
        try {
          hit('1.1.1.1')
        }
        catch { /* still refused — and the touch refreshes its MRU position */ }
      }
    }
    // The attacker's window was never reset by the churn.
    expect(() => hit('1.1.1.1')).toThrow(/Too many install attempts/)
  })
})
