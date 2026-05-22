/**
 * Thin GitHub REST client used by `bx24mcp_submit_feedback` to persist agent
 * feedback as GitHub issues. Built on `fetch` to avoid a runtime dependency on
 * the octokit family for a single endpoint.
 *
 * Token comes from `NUXT_GITHUB_FEEDBACK_TOKEN`. Required scopes:
 * - `public_repo` (or `repo` for private targets) for issue write.
 *
 * The function does not log the token, the request URL, or the response body
 * on error — operators reading container logs should not be able to recover
 * the credential from a failure.
 */

const GITHUB_API = 'https://api.github.com'

export interface CreateIssueInput {
  title: string
  body: string
  labels: string[]
}

export interface CreateIssueResult {
  /** HTML URL of the created issue, safe to expose to the AI agent. */
  url: string
  /** Numeric issue id, useful for downstream links. */
  number: number
}

export class GithubFeedbackError extends Error {
  override readonly name = 'GithubFeedbackError'
  readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'NETWORK'

  constructor(message: string, code: GithubFeedbackError['code']) {
    super(message)
    this.code = code
  }
}

export async function createGithubIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
  const { githubFeedbackToken, githubFeedbackRepo } = useRuntimeConfig()

  if (!githubFeedbackToken) {
    throw new GithubFeedbackError(
      'GitHub feedback token is not configured on the server.',
      'NOT_CONFIGURED',
    )
  }

  // Guard the operator-supplied repo before it lands in the request path. The
  // host is fixed (no SSRF), but an unvalidated value like `../../users/x`
  // would still let a misconfiguration retarget the API call to an unintended
  // resource. GitHub repo slugs are `owner/repo` over a conservative charset.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubFeedbackRepo)) {
    throw new GithubFeedbackError(
      'GitHub feedback repo is misconfigured — expected "owner/repo".',
      'NOT_CONFIGURED',
    )
  }

  const url = `${GITHUB_API}/repos/${githubFeedbackRepo}/issues`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubFeedbackToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'bx24-template-mcp',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        labels: input.labels,
      }),
    })
  } catch {
    // Deliberately swallow the cause — Node's fetch errors can include the URL
    // and headers, which would echo the bearer token into operator logs.
    throw new GithubFeedbackError('GitHub API is unreachable.', 'NETWORK')
  }

  if (!response.ok) {
    // Map a handful of statuses to actionable messages without leaking the
    // upstream body verbatim.
    if (response.status === 401 || response.status === 403) {
      throw new GithubFeedbackError(
        'GitHub rejected the feedback token (401/403). Rotate it and retry.',
        'UPSTREAM',
      )
    }
    if (response.status === 404) {
      throw new GithubFeedbackError(
        `GitHub returned 404 — the configured feedback repo (${githubFeedbackRepo}) is missing or unreachable.`,
        'UPSTREAM',
      )
    }
    throw new GithubFeedbackError(
      `GitHub returned ${response.status} when creating the feedback issue.`,
      'UPSTREAM',
    )
  }

  let data: { html_url?: string; number?: number }
  try {
    data = (await response.json()) as { html_url?: string; number?: number }
  } catch {
    // Rare but possible — proxies, GHE misconfig, etc. We must not let raw
    // SyntaxError reach the agent unwrapped.
    throw new GithubFeedbackError(
      'GitHub returned a non-JSON response.',
      'UPSTREAM',
    )
  }

  if (!data.html_url || typeof data.number !== 'number') {
    throw new GithubFeedbackError(
      'GitHub returned a malformed issue payload.',
      'UPSTREAM',
    )
  }

  return { url: data.html_url, number: data.number }
}

// --- Rate limit ---------------------------------------------------------------
//
// Sliding-window counter. Cheap, in-memory, single-instance. Phase 3 will move
// this to a shared store when we go multi-tenant — until then it's adequate.
//
// Counts ATTEMPTS, not successes: a failed call (auth, network, 5xx) still
// consumes one slot. This is the deliberate trade-off — it discourages tight
// retry loops at the cost of being unfair on flaky networks. See FEEDBACK.md.

const WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_REQUESTS_PER_WINDOW = 5

const timestamps: number[] = []

export function consumeFeedbackQuota(now: number = Date.now()): {
  ok: boolean
  remaining: number
  resetInSeconds: number
} {
  const cutoff = now - WINDOW_MS
  // Drop expired entries in place to avoid unbounded growth.
  while (timestamps.length > 0 && timestamps[0]! < cutoff) {
    timestamps.shift()
  }

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = timestamps[0]!
    return {
      ok: false,
      remaining: 0,
      resetInSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    }
  }

  timestamps.push(now)
  return {
    ok: true,
    remaining: MAX_REQUESTS_PER_WINDOW - timestamps.length,
    resetInSeconds: WINDOW_MS / 1000,
  }
}

// --- Sanitisation -------------------------------------------------------------

const MAX_DETAILS_LENGTH = 10000

// Hostile / accidentally-confusing characters in agent-supplied details.
// Spelled out with `\u` / `\x` escapes so reviewers can verify what is
// stripped without trusting invisible code points in the source — embedding
// the literal characters here would itself be a Trojan Source vector against
// the reviewer.
//   - C0 controls except tab (0x09), LF (0x0A), CR (0x0D)
//   - Bidi overrides (U+202A..U+202E, U+2066..U+2069)
//   - Zero-width / BOM (U+200B..U+200D, U+FEFF)
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g

/**
 * Removes C0 controls, bidi overrides, zero-widths, and BOM from arbitrary
 * agent-supplied text. Used standalone for the issue title (where Trojan
 * Source visually flipping the GitHub issue list is the worry) and as a
 * first step inside `sanitizeDetails` for the body.
 */
export function stripHostileChars(input: string): string {
  return input.replace(HOSTILE_CHARS, '')
}

/**
 * Trims an agent-supplied free-text field to a maximum length and replaces a
 * narrow set of control characters that would corrupt the issue payload.
 * Markdown is not aggressively escaped — see `formatIssueBody` for how the
 * text is framed in the issue body (an HTML <pre><code> block) which renders
 * everything as inert text.
 */
export function sanitizeDetails(input: string): string {
  const stripped = stripHostileChars(input)
  if (stripped.length <= MAX_DETAILS_LENGTH) return stripped
  return `${stripped.slice(0, MAX_DETAILS_LENGTH)}…\n\n[truncated to ${MAX_DETAILS_LENGTH} characters]`
}

/**
 * Tool names land in a GitHub label (`tool:<name>`). GitHub caps label names
 * at 50 characters; with the 5-char prefix that leaves 45 for the name. We
 * also reduce to the conservative `a-z0-9_` subset of what labels accept,
 * so the label never triggers a 422 even if GitHub's allowed character set
 * narrows in the future.
 */
export function sanitizeToolName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 45)
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export interface FeedbackBody {
  kind: 'positive' | 'issue' | 'suggestion'
  details: string
  relatedTool?: string
  severity?: 'low' | 'medium' | 'high'
}

/**
 * Renders the issue body. The details block is wrapped in `<pre><code>` so
 * Markdown control characters (backticks, asterisks, brackets, HTML tags) are
 * inert. The trade-off is loss of intentional formatting from the agent —
 * acceptable, since the audience is a maintainer triaging the issue.
 */
export function formatIssueBody(body: FeedbackBody): string {
  const lines = [
    `**Kind**: ${body.kind}`,
    // `relatedTool` is sanitised to `a-z0-9_` upstream; escape here too as
    // defence-in-depth against HTML injection if a future caller passes raw
    // input. Note this neutralises HTML only, not Markdown metacharacters
    // (`*`, `_`, backticks) — fine because it renders inline, not in a code
    // block, and the upstream charset already excludes them.
    `**Related tool**: ${body.relatedTool ? escapeHtml(body.relatedTool) : 'n/a'}`,
    `**Severity**: ${body.severity ?? 'n/a'}`,
    '',
    '## Details',
    '',
    '<pre><code>',
    escapeHtml(body.details),
    '</code></pre>',
    '',
    '---',
    '_Submitted programmatically by `bx24mcp_submit_feedback`._',
  ]
  return lines.join('\n')
}
