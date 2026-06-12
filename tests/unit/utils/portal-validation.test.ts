import { describe, expect, it, vi } from 'vitest'

// Hoisted recorder so the logger mock can push without unbound-this issues.
const loggerCalls = vi.hoisted(() => [] as Array<{ level: string, event: string, ctx: Record<string, unknown> | undefined }>)
vi.mock('~/server/utils/logger', () => {
  const log = (level: string) => (event: string, ctx?: Record<string, unknown>) => {
    loggerCalls.push({ level, event, ctx })
    return Promise.resolve()
  }
  return {
    useLogger: () => ({
      info: log('info'),
      warning: log('warning'),
      error: log('error'),
      debug: log('debug'),
      notice: log('notice'),
    }),
  }
})

const {
  PORTAL_ALLOW_LIST_RE,
  isAllowedPortalDomain,
  isAllowedCentralOauthHost,
  safeHostname,
  validateClientEndpoint,
  validateServerEndpoint,
} = await import('~/server/utils/portal-validation')

describe('portal-validation — PORTAL_ALLOW_LIST_RE + isAllowedPortalDomain', () => {
  it('accepts every documented TLD', () => {
    for (const tld of ['com', 'ru', 'eu', 'de', 'by', 'kz', 'ua']) {
      expect(isAllowedPortalDomain(`acme.bitrix24.${tld}`)).toBe(true)
    }
  })

  it('rejects non-bitrix24 hostnames', () => {
    expect(isAllowedPortalDomain('attacker.example.com')).toBe(false)
    expect(isAllowedPortalDomain('bitrix24.com.attacker.com')).toBe(false)
    expect(isAllowedPortalDomain('attacker.com')).toBe(false)
  })

  it('rejects unlisted TLDs (open redirector class — refuse rather than allow)', () => {
    // Self-hosted portals don't go through /install; the regex is for cloud only.
    expect(isAllowedPortalDomain('acme.bitrix24.com.br')).toBe(false)
    expect(isAllowedPortalDomain('acme.bitrix24.es')).toBe(false)
  })

  it('rejects empty / uppercase / surrounding-whitespace / non-string inputs', () => {
    expect(isAllowedPortalDomain('')).toBe(false)
    expect(isAllowedPortalDomain('ACME.bitrix24.com')).toBe(false)
    expect(isAllowedPortalDomain(' acme.bitrix24.com ')).toBe(false)
    expect(isAllowedPortalDomain(undefined)).toBe(false)
    expect(isAllowedPortalDomain(null)).toBe(false)
    expect(isAllowedPortalDomain(42)).toBe(false)
  })

  it('rejects subdomain abuse and path injection', () => {
    expect(isAllowedPortalDomain('foo.acme.bitrix24.com')).toBe(false)
    expect(isAllowedPortalDomain('acme.bitrix24.com/x')).toBe(false)
    expect(isAllowedPortalDomain('acme.bitrix24.com\n')).toBe(false)
  })

  it('rejects labels with a leading or trailing hyphen (RFC-1123 shape)', () => {
    expect(isAllowedPortalDomain('-acme.bitrix24.com')).toBe(false)
    expect(isAllowedPortalDomain('acme-.bitrix24.com')).toBe(false)
    // interior hyphen is fine
    expect(isAllowedPortalDomain('a-c-me.bitrix24.com')).toBe(true)
    // single-char label is fine
    expect(isAllowedPortalDomain('a.bitrix24.com')).toBe(true)
  })

  it('PORTAL_ALLOW_LIST_RE is a real RegExp with the expected source', () => {
    expect(PORTAL_ALLOW_LIST_RE).toBeInstanceOf(RegExp)
    expect(PORTAL_ALLOW_LIST_RE.test('acme.bitrix24.ru')).toBe(true)
  })
})

describe('portal-validation — safeHostname', () => {
  it('extracts hostname from a well-formed HTTPS URL', () => {
    expect(safeHostname('https://acme.bitrix24.com/rest/')).toBe('acme.bitrix24.com')
  })

  it('returns null for non-string / empty / malformed inputs', () => {
    expect(safeHostname('')).toBeNull()
    expect(safeHostname(undefined)).toBeNull()
    expect(safeHostname(null)).toBeNull()
    expect(safeHostname(42)).toBeNull()
    expect(safeHostname('not a url')).toBeNull()
  })

  it('returns null for non-HTTPS schemes', () => {
    expect(safeHostname('http://acme.bitrix24.com/rest/')).toBeNull()
    expect(safeHostname('ftp://acme.bitrix24.com/rest/')).toBeNull()
    expect(safeHostname('javascript:alert(1)')).toBeNull()
  })

  it('returns null for URLs carrying userinfo (URL.hostname would silently strip it)', () => {
    // The attack: `hostname` parses to the allow-listed host, but the raw
    // string smuggles `attacker:creds@` past a naive equality check.
    expect(safeHostname('https://attacker:creds@acme.bitrix24.com/rest/')).toBeNull()
    expect(safeHostname('https://user@acme.bitrix24.com/rest/')).toBeNull()
  })

  it('returns null for URLs with an explicit non-standard port', () => {
    expect(safeHostname('https://acme.bitrix24.com:9000/rest/')).toBeNull()
    expect(safeHostname('https://acme.bitrix24.com:8443/rest/')).toBeNull()
  })

  it('treats the implicit/standard HTTPS port (:443) as no port — URL normalises it away', () => {
    // `URL.port` is '' for the scheme-default port, so :443 is identical
    // to omitting it. This is correct, not a bypass — 443 IS HTTPS.
    expect(safeHostname('https://acme.bitrix24.com:443/rest/')).toBe('acme.bitrix24.com')
  })
})

describe('portal-validation — validateClientEndpoint', () => {
  const ctx = { memberId: 'm', userId: 42, reason: 'refresh' as const }

  it('returns the URL unchanged when hostname matches the stored portal', () => {
    const url = 'https://acme.bitrix24.com/rest/'
    loggerCalls.length = 0
    expect(validateClientEndpoint(url, 'acme.bitrix24.com', ctx)).toBe(url)
    // No reject logged on the happy path.
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeUndefined()
  })

  it('returns the safe fallback when hostname is a DIFFERENT host + logs reject', () => {
    loggerCalls.length = 0
    const out = validateClientEndpoint('https://attacker.example.com/rest/', 'acme.bitrix24.com', ctx)
    expect(out).toBe('https://acme.bitrix24.com/rest/')
    const reject = loggerCalls.find(c => c.event === 'oauth.endpoint.reject')
    expect(reject).toBeDefined()
    expect(reject!.ctx).toMatchObject({ field: 'client_endpoint', expectedHost: 'acme.bitrix24.com' })
  })

  it('returns the safe fallback when URL is non-HTTPS', () => {
    loggerCalls.length = 0
    const out = validateClientEndpoint('http://acme.bitrix24.com/rest/', 'acme.bitrix24.com', ctx)
    expect(out).toBe('https://acme.bitrix24.com/rest/')
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeDefined()
  })

  it('returns the safe fallback when the URL smuggles userinfo past the hostname', () => {
    loggerCalls.length = 0
    const out = validateClientEndpoint('https://attacker:creds@acme.bitrix24.com/rest/', 'acme.bitrix24.com', ctx)
    expect(out).toBe('https://acme.bitrix24.com/rest/')
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeDefined()
  })

  it('returns the safe fallback when the URL specifies a non-standard port', () => {
    loggerCalls.length = 0
    const out = validateClientEndpoint('https://acme.bitrix24.com:9000/rest/', 'acme.bitrix24.com', ctx)
    expect(out).toBe('https://acme.bitrix24.com/rest/')
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeDefined()
  })

  it('canonicalises a matching URL — strips query string and fragment', () => {
    loggerCalls.length = 0
    // Even when the hostname matches, anything after the path is dropped so
    // nothing attacker-controllable rides along into the SDK.
    const out = validateClientEndpoint('https://acme.bitrix24.com/rest/?evil=1#frag', 'acme.bitrix24.com', ctx)
    expect(out).toBe('https://acme.bitrix24.com/rest/')
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeUndefined()
  })

  it('returns the safe fallback (no log) when URL is null/undefined — legitimate upstream omission', () => {
    loggerCalls.length = 0
    expect(validateClientEndpoint(null, 'acme.bitrix24.com', ctx)).toBe('https://acme.bitrix24.com/rest/')
    expect(validateClientEndpoint(undefined, 'acme.bitrix24.com', ctx)).toBe('https://acme.bitrix24.com/rest/')
    // No reject — `null` is a legitimate "no value", not a poisoned one.
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeUndefined()
  })

  it('truncates an overlong raw value in the log line (no unbounded log injection)', () => {
    loggerCalls.length = 0
    const evil = 'https://evil.example.com/' + 'A'.repeat(500)
    validateClientEndpoint(evil, 'acme.bitrix24.com', ctx)
    const reject = loggerCalls.find(c => c.event === 'oauth.endpoint.reject')!
    expect((reject.ctx as { raw: string }).raw.length).toBeLessThanOrEqual(200)
  })
})

describe('portal-validation — validateServerEndpoint', () => {
  const ctx = { memberId: 'm', userId: 42, reason: 'refresh' as const }

  it.each([
    'https://oauth.bitrix.info/rest/',
    'https://oauth.bitrix24.tech/rest/',
  ])('preserves the known central OAuth host: %s', (url) => {
    loggerCalls.length = 0
    expect(validateServerEndpoint(url, ctx)).toBe(url)
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeUndefined()
  })

  it('returns the documented fallback when hostname is unknown + logs reject', () => {
    loggerCalls.length = 0
    const out = validateServerEndpoint('https://attacker.example.com/rest/', ctx)
    expect(out).toBe('https://oauth.bitrix.info/rest/')
    const reject = loggerCalls.find(c => c.event === 'oauth.endpoint.reject')
    expect(reject).toBeDefined()
    expect(reject!.ctx).toMatchObject({ field: 'server_endpoint' })
  })

  it('returns the documented fallback (no log) when URL is null/undefined', () => {
    loggerCalls.length = 0
    expect(validateServerEndpoint(null, ctx)).toBe('https://oauth.bitrix.info/rest/')
    expect(validateServerEndpoint(undefined, ctx)).toBe('https://oauth.bitrix.info/rest/')
    expect(loggerCalls.find(c => c.event === 'oauth.endpoint.reject')).toBeUndefined()
  })
})

describe('portal-validation — isAllowedCentralOauthHost', () => {
  it('accepts the two known hosts', () => {
    expect(isAllowedCentralOauthHost('oauth.bitrix.info')).toBe(true)
    expect(isAllowedCentralOauthHost('oauth.bitrix24.tech')).toBe(true)
  })

  it('rejects anything else, including the tenant portal', () => {
    expect(isAllowedCentralOauthHost('acme.bitrix24.com')).toBe(false)
    expect(isAllowedCentralOauthHost('attacker.example.com')).toBe(false)
    expect(isAllowedCentralOauthHost('')).toBe(false)
    expect(isAllowedCentralOauthHost(undefined)).toBe(false)
  })
})
