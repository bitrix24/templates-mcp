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

function hit(ip: string, url = '/api/oauth/install?portal=acme.bitrix24.com'): FakeEvent {
  // The default URL carries `?portal=` because #232 review (security) made
  // the middleware skip landing-form hits on `/api/oauth/install` (no
  // `?portal=` = pure HTML render, no DB write, no rate-limit threat).
  // The threat model the middleware exists to cover is `oauth_state`-flood
  // — that only happens when `?portal=` is present, so every test of the
  // limit itself uses a populated query.
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

  it('skips paths outside the OAuth surface (_health, mcp untouched)', () => {
    // Health + mcp aren't rate-limited here — `_health` is operator-only and
    // `/mcp` has its own Bearer-based gate.
    for (let i = 0; i < 50; i++) {
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
      event = { _url: '/api/oauth/install?portal=acme.bitrix24.com', _ip: '1.2.3.4' }
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
    // IP. The limit must stay above that or CI flakes. We also pin the
    // OTHER side of the bound — the 11th must 429 — so a future change
    // that bumped MAX_PER_WINDOW to 6 (relieving the CI gate but losing
    // most of the flood-defence headroom) would fail this test too.
    for (let i = 0; i < 6; i++) expect(() => hit('10.9.8.7')).not.toThrow()
    // Headroom over 5 probes is real, AND the limit is still tight at 10.
    for (let i = 6; i < 10; i++) expect(() => hit('10.9.8.7')).not.toThrow()
    expect(() => hit('10.9.8.7')).toThrow(/Too many install attempts/)
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
      expect(() => middleware({ _url: '/api/oauth/install?portal=acme.bitrix24.com' })).not.toThrow()
    }
    expect(() => middleware({ _url: '/api/oauth/install?portal=acme.bitrix24.com' })).toThrow(/Too many install attempts/)
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

  // ---------------------------------------------------------------
  // /api/oauth/callback — same middleware, looser limit (#221 round-3)
  // ---------------------------------------------------------------
  // Security agent on PR #228 flagged that an unauthenticated junk-`state`
  // flood at /callback runs `consumeState()` (SQLite DELETE) per hit —
  // secondary to install (no row mint) but still a write-pressure DoS.
  // Same middleware, higher cap (30/min — a legitimate flow only hits
  // once per install, but operators retry / use browser back).

  it('callback path is rate-limited at 30/min, refuses the 31st with 429 + Retry-After=60', () => {
    for (let i = 0; i < 30; i++) {
      expect(() => hit('2.3.4.5', '/api/oauth/callback')).not.toThrow()
    }
    let caught: (Error & { statusCode?: number, data?: { errorCode?: string } }) | undefined
    let event: FakeEvent | undefined
    try {
      event = { _url: '/api/oauth/callback', _ip: '2.3.4.5' }
      middleware(event)
    }
    catch (err) {
      caught = err as typeof caught
    }
    expect(caught?.statusCode).toBe(429)
    expect(caught?.data?.errorCode).toBe('RATE-LIMITED')
    expect(Number(event!._responseHeaders?.['retry-after'])).toBe(60)
    const logged = loggerCalls.find(c => c.event === 'oauth.callback.deny.rate-limited')
    expect(logged).toBeDefined()
    expect(logged!.ctx).toMatchObject({ ip: '2.3.4.5' })
  })

  it('callback skips entirely when the OAuth flag is off (webhook-only forks see no 429 surface)', () => {
    runtimeConfig.bitrix24OauthEnabled = false
    for (let i = 0; i < 60; i++) {
      expect(() => hit('2.3.4.5', '/api/oauth/callback')).not.toThrow()
    }
  })

  it('install and callback buckets are INDEPENDENT — flooding install does not lock out callback (and vice versa)', () => {
    // Same IP hits the install limit hard…
    for (let i = 0; i < 10; i++) hit('9.9.9.9', '/api/oauth/install?portal=acme.bitrix24.com')
    expect(() => hit('9.9.9.9', '/api/oauth/install?portal=acme.bitrix24.com')).toThrow(/install/)
    // …but the callback bucket for the same IP is untouched.
    for (let i = 0; i < 30; i++) {
      expect(() => hit('9.9.9.9', '/api/oauth/callback')).not.toThrow()
    }
    expect(() => hit('9.9.9.9', '/api/oauth/callback')).toThrow(/callback/)
    // The install bucket also stayed at its refused state — not extended
    // by the callback hits (per-route accounting).
    expect(() => hit('9.9.9.9', '/api/oauth/install?portal=acme.bitrix24.com')).toThrow(/install/)
  })

  it('callback path has 30/min headroom — 29 pass, 30 passes, 31 refused', () => {
    // Provable both-sides bound on the callback limit (mirrors the
    // install 6th/11th test). If MAX changed to 25 or 35, this fails.
    for (let i = 0; i < 30; i++) {
      expect(() => hit('3.4.5.6', '/api/oauth/callback')).not.toThrow()
    }
    expect(() => hit('3.4.5.6', '/api/oauth/callback')).toThrow(/Too many callback attempts/)
  })

  // ---------------------------------------------------------------
  // Landing-form skip on /api/oauth/install (#232 review — security)
  // ---------------------------------------------------------------
  // Threat model: `oauth_state` row flood. That only happens when the
  // handler reaches Step 3 (mint state) — which requires `?portal=`.
  // The landing-form render (no `?portal=`) writes nothing to the DB,
  // so it MUST NOT consume a bucket slot. Otherwise a tab-F5-er would
  // self-ban from the very form they're trying to use.

  it('install path WITHOUT ?portal= (landing render) is NOT rate-limited — 200 hits in a row pass', () => {
    for (let i = 0; i < 200; i++) {
      expect(() => middleware({ _url: '/api/oauth/install', _ip: '7.7.7.7' })).not.toThrow()
    }
    // No deny event emitted on any of the 200 hits.
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.rate-limited')).toBeUndefined()
  })

  it('install with empty ?portal= (`?portal=`) is still landing → also skipped', () => {
    for (let i = 0; i < 50; i++) {
      expect(() => middleware({ _url: '/api/oauth/install?portal=', _ip: '7.7.7.7' })).not.toThrow()
    }
  })

  it('mixing landing renders and real submits — only the submits count toward the limit', () => {
    // 100 landing renders (should all skip)…
    for (let i = 0; i < 100; i++) hit('8.8.8.8', '/api/oauth/install')
    // …then 10 real submits land in the bucket and the 11th 429s.
    for (let i = 0; i < 10; i++) {
      expect(() => hit('8.8.8.8', '/api/oauth/install?portal=acme.bitrix24.com')).not.toThrow()
    }
    expect(() => hit('8.8.8.8', '/api/oauth/install?portal=acme.bitrix24.com')).toThrow(/Too many install attempts/)
  })
})
