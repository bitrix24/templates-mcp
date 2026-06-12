import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhFeedback from '../../server/utils/github-feedback'

const runtimeConfig: {
  githubFeedbackToken: string
  githubFeedbackRepo: string
} = {
  githubFeedbackToken: 'ghp_test',
  githubFeedbackRepo: 'bitrix24/templates-mcp',
}

vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

async function loadFresh(): Promise<typeof GhFeedback> {
  // Resets the in-memory rate-limit window between tests.
  vi.resetModules()
  return await import('../../server/utils/github-feedback')
}

function okResponse(body: object): Response {
  return {
    ok: true,
    status: 201,
    json: async () => body,
  } as unknown as Response
}

function errResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response
}

describe('createGithubIssue', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    runtimeConfig.githubFeedbackToken = 'ghp_test'
    runtimeConfig.githubFeedbackRepo = 'bitrix24/templates-mcp'
  })

  it('POSTs to the issues endpoint and returns the issue URL', async () => {
    mockFetch.mockResolvedValue(
      okResponse({ html_url: 'https://github.com/bitrix24/templates-mcp/issues/42', number: 42 }),
    )

    const { createGithubIssue } = await loadFresh()
    const result = await createGithubIssue({ title: 't', body: 'b', labels: ['x'] })

    expect(result).toEqual({
      url: 'https://github.com/bitrix24/templates-mcp/issues/42',
      number: 42,
    })

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/bitrix24/templates-mcp/issues')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test')
    expect(JSON.parse(init.body as string)).toEqual({ title: 't', body: 'b', labels: ['x'] })
  })

  it('throws NOT_CONFIGURED when the token is missing', async () => {
    runtimeConfig.githubFeedbackToken = ''
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      name: 'GithubFeedbackError',
      code: 'NOT_CONFIGURED',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['../../users/admin/repos', 'path traversal / extra segment'],
    ['', 'empty'],
    ['justrepo', 'missing slash'],
    ['a/b/c', 'too many segments'],
    ['has space/repo', 'whitespace'],
    ['owner/re po', 'whitespace in name'],
  ])('throws NOT_CONFIGURED on a malformed repo slug (%s — %s) and never calls fetch', async (repo) => {
    runtimeConfig.githubFeedbackRepo = repo
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      name: 'GithubFeedbackError',
      code: 'NOT_CONFIGURED',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it.each([
    'bitrix24/templates-mcp',
    'My-Org.x/repo_1.2',
  ])('accepts a well-formed owner/repo slug (%s) and calls fetch', async (repo) => {
    runtimeConfig.githubFeedbackRepo = repo
    mockFetch.mockResolvedValue(
      okResponse({ html_url: `https://github.com/${repo}/issues/1`, number: 1 }),
    )
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).resolves.toMatchObject({
      number: 1,
    })
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.github.com/repos/${repo}/issues`)
  })

  it('maps 401/403 to a friendly UPSTREAM error without leaking the body', async () => {
    mockFetch.mockResolvedValue(errResponse(401))
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: expect.stringMatching(/rotate it/i) as unknown as string,
    })
  })

  it('reports a missing repo on 404', async () => {
    mockFetch.mockResolvedValue(errResponse(404))
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: expect.stringContaining('bitrix24/templates-mcp') as unknown as string,
    })
  })

  it('surfaces 422 (e.g. label-too-long) as UPSTREAM with the status', async () => {
    mockFetch.mockResolvedValue(errResponse(422))
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: expect.stringContaining('422') as unknown as string,
    })
  })

  it('wraps a network failure as NETWORK without exposing the cause', async () => {
    mockFetch.mockRejectedValue(new Error('TCP RST — ghp_test leaked'))
    const { createGithubIssue } = await loadFresh()

    const err = (await createGithubIssue({ title: 't', body: 'b', labels: [] }).catch(
      (e: unknown) => e,
    )) as Error & { code: string }
    expect(err.code).toBe('NETWORK')
    expect(err.message).toBe('GitHub API is unreachable.')
    // The raw error message contained the token; the wrapper must not.
    expect(err.message).not.toContain('ghp_test')
  })

  it('throws UPSTREAM on malformed success payload', async () => {
    mockFetch.mockResolvedValue(okResponse({ html_url: null }))
    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: /malformed/i,
    })
  })

  it('wraps non-JSON success body as UPSTREAM (proxy/GHE misconfig)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      // Mimics Cloudflare / GHE returning HTML on success.
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as unknown as Response)

    const { createGithubIssue } = await loadFresh()

    await expect(createGithubIssue({ title: 't', body: 'b', labels: [] })).rejects.toMatchObject({
      code: 'UPSTREAM',
      message: /non-JSON/i,
    })
  })
})

describe('consumeFeedbackQuota', () => {
  it('allows up to 5 attempts in the sliding window', async () => {
    const { consumeFeedbackQuota } = await loadFresh()
    const base = 1_700_000_000_000

    for (let i = 0; i < 5; i++) {
      const r = consumeFeedbackQuota(base + i * 1000)
      expect(r.ok).toBe(true)
      expect(r.remaining).toBe(5 - (i + 1))
    }

    const sixth = consumeFeedbackQuota(base + 6000)
    expect(sixth.ok).toBe(false)
    expect(sixth.remaining).toBe(0)
    expect(sixth.resetInSeconds).toBeGreaterThan(0)
  })

  it('re-allows after the window slides past the oldest entry', async () => {
    const { consumeFeedbackQuota } = await loadFresh()
    const base = 1_700_000_000_000

    for (let i = 0; i < 5; i++) consumeFeedbackQuota(base + i)

    const justAfterOldestExpires = base + 60 * 60 * 1000 + 1
    const r = consumeFeedbackQuota(justAfterOldestExpires)
    expect(r.ok).toBe(true)
  })

  it('keys the window per tenant under OAuth — one tenant exhausting the quota does not block another (#221)', async () => {
    const { consumeFeedbackQuota } = await loadFresh()
    // Use the REAL ALS implementation: the quota function reads
    // getTenantContext() from `~/server/utils/request-context`, so wrapping
    // the calls in runWithTenant mirrors what the toolkit middleware does
    // in production.
    const { runWithTenant } = await import('../../server/utils/request-context')
    const base = 1_700_000_000_000

    // Tenant A burns all 5 slots…
    runWithTenant({ memberId: 'portal-a', userId: '1' }, () => {
      for (let i = 0; i < 5; i++) expect(consumeFeedbackQuota(base + i).ok).toBe(true)
      expect(consumeFeedbackQuota(base + 10).ok).toBe(false)
    })

    // …tenant B is unaffected…
    runWithTenant({ memberId: 'portal-b', userId: '1' }, () => {
      expect(consumeFeedbackQuota(base + 11).ok).toBe(true)
    })

    // …and so is the global (webhook / stdio, no tenant scope) bucket.
    expect(consumeFeedbackQuota(base + 12).ok).toBe(true)
  })

  it('outside a tenant scope the global bucket behaves exactly as before (#221 back-compat)', async () => {
    const { consumeFeedbackQuota } = await loadFresh()
    const base = 1_700_000_000_000
    for (let i = 0; i < 5; i++) expect(consumeFeedbackQuota(base + i).ok).toBe(true)
    expect(consumeFeedbackQuota(base + 10).ok).toBe(false)
  })

  it('bounds memory: the 201st distinct tenant evicts the oldest bucket without throwing (#221)', async () => {
    const { consumeFeedbackQuota } = await loadFresh()
    const { runWithTenant } = await import('../../server/utils/request-context')
    const base = 1_700_000_000_000
    // 200 distinct tenants each take one slot — fills the bucket map to cap.
    for (let i = 0; i < 200; i++) {
      runWithTenant({ memberId: `tenant-${i}`, userId: '1' }, () => {
        expect(consumeFeedbackQuota(base).ok).toBe(true)
      })
    }
    // The 201st tenant must succeed (eviction of the oldest, fails-open) and
    // must not throw on the empty-map / iterator edge.
    runWithTenant({ memberId: 'tenant-200', userId: '1' }, () => {
      expect(() => consumeFeedbackQuota(base)).not.toThrow()
      expect(consumeFeedbackQuota(base).ok).toBe(true)
    })
  })
})

describe('sanitizeDetails', () => {
  it('passes short clean input through untouched', async () => {
    const { sanitizeDetails } = await loadFresh()
    expect(sanitizeDetails('hello\n\nworld')).toBe('hello\n\nworld')
  })

  it('strips control characters but keeps tab/LF/CR', async () => {
    const { sanitizeDetails } = await loadFresh()
    const noisy = `a\x00b\x07c\td\re\nf`
    expect(sanitizeDetails(noisy)).toBe('abc\td\re\nf')
  })

  it('strips bidi overrides (Trojan Source defence)', async () => {
    const { sanitizeDetails } = await loadFresh()
    // Explicit \u escapes so reviewers don't have to trust invisible code
    // points in the test source.
    const RLO = '\u202e' // Right-to-Left Override
    const PDF = '\u202c' // Pop Directional Formatting
    const trojan = `hello ${RLO}inject${PDF} world`
    expect(sanitizeDetails(trojan)).toBe('hello inject world')
  })

  it('strips zero-width characters and BOM', async () => {
    const { sanitizeDetails } = await loadFresh()
    const ZWSP = '\u200b'
    const ZWNJ = '\u200c'
    const BOM = '\ufeff'
    const smuggled = `visi${ZWSP}ble${ZWNJ} here${BOM}.`
    expect(sanitizeDetails(smuggled)).toBe('visible here.')
  })

  it('truncates input over 10000 chars and annotates it', async () => {
    const { sanitizeDetails } = await loadFresh()
    const long = 'x'.repeat(10100)
    const out = sanitizeDetails(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('truncated')
  })
})

describe('sanitizeToolName', () => {
  it('strips disallowed characters and lowercases', async () => {
    const { sanitizeToolName } = await loadFresh()
    expect(sanitizeToolName('Bitrix24_Create-Task!')).toBe('bitrix24_createtask')
  })

  it('passes a canonical b24_* tool name through unchanged', async () => {
    // Post-#129 every Bitrix24 tool matches `[a-z0-9_]+` already, so the
    // GitHub label `tool:b24_task_create` must come back byte-identical from
    // the sanitizer. A regression here would silently mangle every issue
    // label the feedback tool files.
    const { sanitizeToolName } = await loadFresh()
    expect(sanitizeToolName('b24_task_create')).toBe('b24_task_create')
    expect(sanitizeToolName('b24_task_checklist_item_add')).toBe('b24_task_checklist_item_add')
    expect(sanitizeToolName('bx24mcp_submit_feedback')).toBe('bx24mcp_submit_feedback')
  })

  it('passes the longest real tool name through without hitting the 45-char cap', async () => {
    // Post-#129 the longest live tool name is `b24_task_checklist_item_complete`
    // at 32 chars; `tool:` + 32 = 37, well under GitHub's 50-char label limit
    // and the internal 45-char cap. Pin both so a future tightening of the cap
    // (or a longer tool name slipping in) gets caught with a clear diagnostic
    // here — not as a silently truncated GitHub label downstream.
    const { sanitizeToolName } = await loadFresh()
    const longest = 'b24_task_checklist_item_complete'
    expect(longest.length).toBeLessThanOrEqual(45)
    expect(sanitizeToolName(longest)).toBe(longest)
    expect(sanitizeToolName(longest).length).toBeLessThanOrEqual(45)
  })

  it('caps length at 45 so `tool:<name>` fits GitHub\'s 50-char label limit', async () => {
    const { sanitizeToolName } = await loadFresh()
    const out = sanitizeToolName('a'.repeat(200))
    expect(out.length).toBe(45)
    // Verify the assembled label would pass GitHub's validation.
    expect(`tool:${out}`.length).toBeLessThanOrEqual(50)
  })
})

describe('stripHostileChars', () => {
  it('removes bidi, zero-width and BOM from arbitrary text (used for issue title)', async () => {
    const { stripHostileChars } = await loadFresh()
    const RLO = '\u202e'
    const ZWSP = '\u200b'
    const BOM = '\ufeff'
    expect(stripHostileChars(`hello${RLO}${ZWSP}${BOM}world`)).toBe('helloworld')
  })

  it('passes ordinary text through untouched', async () => {
    const { stripHostileChars } = await loadFresh()
    expect(stripHostileChars('plain summary 123')).toBe('plain summary 123')
  })
})

describe('formatIssueBody', () => {
  it('embeds details in a <pre><code> block with HTML-escaped content', async () => {
    const { formatIssueBody } = await loadFresh()
    const body = formatIssueBody({
      kind: 'issue',
      details: 'crash on <script>alert(1)</script> & more',
      relatedTool: 'b24_user_me',
      severity: 'high',
    })
    expect(body).toContain('**Kind**: issue')
    expect(body).toContain('**Related tool**: b24_user_me')
    expect(body).toContain('**Severity**: high')
    expect(body).toContain('<pre><code>')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more')
    expect(body).not.toContain('<script>')
  })

  it('HTML-escapes relatedTool defensively (caller-sanitised, but escaped again here)', async () => {
    const { formatIssueBody } = await loadFresh()
    const body = formatIssueBody({
      kind: 'issue',
      details: 'x',
      relatedTool: '<img src=x onerror=alert(1)>',
    })
    expect(body).toContain('**Related tool**: &lt;img src=x onerror=alert(1)&gt;')
    expect(body).not.toContain('<img')
  })

  it('escapes a bare ampersand in relatedTool', async () => {
    const { formatIssueBody } = await loadFresh()
    const body = formatIssueBody({ kind: 'issue', details: 'x', relatedTool: 'a & b' })
    expect(body).toContain('**Related tool**: a &amp; b')
  })

  it('falls back to n/a when relatedTool and severity are absent', async () => {
    const { formatIssueBody } = await loadFresh()
    const body = formatIssueBody({ kind: 'positive', details: 'good' })
    expect(body).toContain('**Related tool**: n/a')
    expect(body).toContain('**Severity**: n/a')
  })

  it('places the sanitiser truncation marker inside the <pre><code> block', async () => {
    // Composition test — the truncation marker emitted by sanitizeDetails must
    // remain inside the code fence in the rendered body, so the issue doesn't
    // get a stray Markdown paragraph after the closing tag.
    const { sanitizeDetails, formatIssueBody } = await loadFresh()
    const details = sanitizeDetails('x'.repeat(10100))
    const body = formatIssueBody({ kind: 'issue', details })

    const openIdx = body.indexOf('<pre><code>')
    const closeIdx = body.indexOf('</code></pre>')
    const truncatedIdx = body.indexOf('truncated to 10000 characters')

    expect(openIdx).toBeGreaterThan(-1)
    expect(closeIdx).toBeGreaterThan(openIdx)
    expect(truncatedIdx).toBeGreaterThan(openIdx)
    expect(truncatedIdx).toBeLessThan(closeIdx)
  })
})
