# Agent feedback (`bx24mcp_submit_feedback`)

`Last reviewed: 2026-06-14`

This MCP exposes a meta-tool — `bx24mcp_submit_feedback` — that lets the AI agent file a GitHub issue against this repository when it notices something worth reporting. The mechanism is the project's primary channel for structured, machine-authored feedback. This document is for **maintainers** triaging those issues and **operators** configuring the integration; agents should look at [`../skills/manage-bx24-template-mcp/feedback.md`](../skills/manage-bx24-template-mcp/feedback.md) for the calling guide.

## Why

Human-only feedback loops miss the patterns only an automated caller surfaces: ambiguous tool descriptions, surprising error shapes, missing capabilities, off-by-one issues that happen at scale. Surfacing these as labelled GitHub issues turns ephemeral runtime observations into a triagable backlog.

## Tool contract

```ts
bx24mcp_submit_feedback({
  kind: 'positive' | 'issue' | 'suggestion',
  summary: string,            // 5..200 chars, becomes the issue title
  details: string,            // 10..10000 chars (longer is truncated)
  relatedTool?: string,       // sanitised to /^[a-z0-9_]{0,45}$/ — fits inside `tool:<name>` ≤ 50-char label
  severity?: 'low' | 'medium' | 'high',
})
```

Returns a text content block. Success path includes the issue URL and number; failure path explains the reason and asks the agent not to retry (the call has already consumed quota).

## GitHub flow

A successful submission creates an issue with:

- **Title**: `[agent-feedback/<kind>] <summary>`
- **Labels**: always `agent-feedback`, `feedback:<kind>`; plus `tool:<sanitised-related-tool>` and `severity:<level>` when provided.
- **Body**: kind / related tool / severity header, then the agent's `details` rendered inside `<pre><code>` (HTML-escaped, Markdown-inert). Footer notes the programmatic origin.

The repository ships an [issue template](../.github/ISSUE_TEMPLATE/agent_feedback.md) that documents the same shape for humans.

### Label auto-creation

GitHub creates the labels on demand when the token has `issues:write` — the first submission of a new `feedback:<kind>`, `tool:<name>`, or `severity:<level>` combination materialises the corresponding label in the repository, with a default colour assigned by GitHub. Pre-create them via Settings → Labels if you want custom colours; otherwise expect a slow trickle of greys to appear as triage volume grows.

### Triage

- New `agent-feedback` issues land in the open backlog. Maintainers should review at least weekly.
- Re-label as `bug` / `enhancement` / `wontfix` / `duplicate` as appropriate; keep `agent-feedback` so the source channel stays queryable.
- If multiple agents report the same problem, deduplicate by referencing the original issue rather than closing.

## Rate limit

A sliding-window counter caps **attempts** at **5 per hour per tenant**. Under OAuth the window is keyed on the caller's `memberId` (from the request's tenant context), so one noisy or prompt-injected tenant can't exhaust every other tenant's quota (issue #221). In webhook / stdio deployments there is a single identity, so everything shares one `__global__` bucket — identical to the pre-#221 behaviour. Failed attempts (auth errors, network drops, GitHub 5xx) consume a slot too — this is intentional, it discourages tight retry loops at the cost of being unfair on flaky networks. The check is in-memory: a Nitro restart resets it; this is acceptable because the limit is a soft floodgate, not a security boundary.

When the quota is exhausted, the tool returns:

```
Feedback rate limit reached. Try again in about <N> seconds. (5 attempts per hour, including failures.)
```

No GitHub call is made. The agent is expected to back off and try later. (A future multi-instance deployment would move this counter to a shared store; the single-process map is adequate for the single-instance design — see `OAUTH-DESIGN.md` §5.)

## Privacy — no personal data in feedback

The destination repository (`NUXT_GITHUB_FEEDBACK_REPO`, default `bitrix24/templates-mcp`) is **public**. Every issue body — including the AI agent's `details` payload — is world-readable from the moment it's created and may be indexed by search engines within hours.

Operators running this MCP against portals that hold personal data (almost any production Bitrix24 portal does) must keep that data out of feedback submissions:

- **Do not** put customer names, phone numbers, email addresses, government IDs (CPF / СНИЛС / SSN), home or shipping addresses, or specific CRM-record contents into `summary` or `details`.
- **Do** describe the technical failure: which tool was called, what input shape was given (with personal data replaced by placeholders — `<name>`, `<email>`, `taskId:12345`), what the agent expected vs what it observed.
- The agent is the primary author of feedback submissions. The tool's runtime description and the `details` field description both instruct the agent to keep submissions PII-free, but the agent's training is not a privacy guarantee — operators with GDPR, LGPD, or similar exposure should review the issue tracker periodically and report any agent slip-ups via [GitHub Security Advisory](https://github.com/bitrix24/templates-mcp/security/advisories), not via a regular issue (which would compound the disclosure).
- For multi-tenant deployments or portals subject to data-residency regulations, point `NUXT_GITHUB_FEEDBACK_REPO` at a **private** repository on a GitHub Enterprise instance under your control, or set `NUXT_GITHUB_FEEDBACK_TOKEN` to an empty string to disable the meta-tool entirely.

This is one of two PII-bearing surfaces in the MCP (the other is the application logger, where the credential redactor in `server/utils/logger-redactor.ts` already strips webhook secrets but does not generally redact portal-business data — that's an explicit project decision documented in `docs/SECURITY-AUDIT.md`).

## Sanitisation

Both `summary` and `details` pass through the same hostile-character strip before any further processing:

- C0 control characters (`\x00–\x08`, `\x0b`, `\x0c`, `\x0e–\x1f`) — preserves tab, LF, CR.
- Bidi overrides (`U+202A–U+202E`, `U+2066–U+2069`) — Trojan Source defence. Without this, an RLO in a summary would visually flip the GitHub issue title in the repo's issue list.
- Zero-width characters (`U+200B–U+200D`) and BOM (`U+FEFF`) — invisible smuggling.

Beyond the strip:

- `details` over 10 000 characters is truncated with a `[truncated to 10000 characters]` marker line; the marker stays inside the `<pre><code>` block in the rendered body.
- `details` is HTML-escaped and rendered inside `<pre><code>`, so Markdown formatting (`*`, `_`, `` ` ``, `#`, `[`, etc.) and HTML tags from the agent render as literal text. This is the *only* defence against Markdown injection — agents are trusted to write reasonable prose, but the framing keeps a careless or hostile call from breaking the issue layout.
- `summary` is collapsed to a single line (any `\r\n` runs become a single space) and trimmed to 200 characters.
- `relatedTool` is lowercased and reduced to `[a-z0-9_]{0,45}` before being embedded in a `tool:<name>` label — 45 chars is the longest name that fits inside GitHub's 50-character label limit alongside the prefix.

## Operator setup

One required env variable, one optional override — both server-side:

| Variable | Default | Purpose |
|---|---|---|
| `NUXT_GITHUB_FEEDBACK_TOKEN` | — (required) | Fine-grained Personal Access Token scoped to `NUXT_GITHUB_FEEDBACK_REPO` only, with **Repository permissions → Issues: Read and write**. Classic PATs work too — use the `public_repo` scope for public repos, `repo` for private — but fine-grained is preferred for least privilege. |
| `NUXT_GITHUB_FEEDBACK_REPO` | `bitrix24/templates-mcp` | `owner/name` of the issue target. |

If the token is absent, `bx24mcp_submit_feedback` returns a `Failed to submit feedback` message and the operator gets a `GithubFeedbackError` (`NOT_CONFIGURED`) in logs.

### Rotation

1. Issue a new fine-grained PAT in GitHub with the same scopes.
2. Replace `NUXT_GITHUB_FEEDBACK_TOKEN` in the server's `.env` (production) or the corresponding GitHub Actions secret (CI).
3. `docker compose up -d` to roll the container.
4. Verify with a manual `bx24mcp_submit_feedback` call from a connected client.
5. Revoke the old PAT.

### Revoking a noisy agent

**Webhook mode** (`NUXT_BITRIX24_OAUTH_ENABLED=false`): the MCP token is shared, so per-agent revocation isn't possible. To stop a misbehaving caller:

1. Rotate the MCP `NUXT_MCP_AUTH_TOKEN` (this severs all current callers).
2. Re-issue the new token only to the agents that should retain access.

**OAuth mode**: each tenant has its own per-user Bearer, so revocation is already surgical — revoke that user's Bearer (re-authorise at `/api/oauth/install`) without touching anyone else. The per-tenant feedback quota above means a noisy tenant is also rate-limited in isolation.

## Failure modes

| Code | Cause | What the agent sees |
|---|---|---|
| `NOT_CONFIGURED` | Token env empty | "Failed to submit feedback: GitHub feedback token is not configured…" |
| `UPSTREAM` (401/403) | Bad token | "GitHub rejected the feedback token (401/403). Rotate it and retry." |
| `UPSTREAM` (404) | Wrong repo | "GitHub returned 404 — the configured feedback repo … is missing or unreachable." |
| `UPSTREAM` (other) | Misc. GitHub error | "GitHub returned <N> when creating the feedback issue." |
| `UPSTREAM` (malformed) | Success status without `html_url`/`number` | "GitHub returned a malformed issue payload." |
| `UPSTREAM` (non-JSON) | Success status with non-JSON body (proxy/GHE misconfig) | "GitHub returned a non-JSON response." |
| `NETWORK` | `fetch` rejection (DNS, TCP, TLS) | "GitHub API is unreachable." |
| — (pre-GitHub guard) | Quota exhausted | "Feedback rate limit reached. Try again in about <N> seconds. (5 attempts per hour, including failures.)" |
| — (pre-GitHub guard) | Summary reduces to empty after hostile-char strip | "Feedback summary became empty after sanitisation. Send a summary that contains printable characters." |

Operator logs carry the same string with no further detail — in particular, the bearer token never appears in error messages.

## Mocking in tests

Unit tests mock both `createGithubIssue` and `consumeFeedbackQuota`:

```ts
vi.mock('~/server/utils/github-feedback', async () => {
  const actual = await vi.importActual<typeof GhFeedback>(...)
  return { ...actual, createGithubIssue, consumeFeedbackQuota }
})
```

Eval suites (Evalite + DeepSeek) treat `bx24mcp_submit_feedback` as a stubbed tool — no real issues should be created from automated scorers.
