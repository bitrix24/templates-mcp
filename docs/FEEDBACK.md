# Agent feedback (`bx24mcp_submit_feedback`)

`Last reviewed: 2026-05-16`

This MCP exposes a meta-tool — `bx24mcp_submit_feedback` — that lets the AI agent file a GitHub issue against this repository when it notices something worth reporting. The mechanism is the project's primary channel for structured, machine-authored feedback. This document is for **maintainers** triaging those issues and **operators** configuring the integration; agents should look at [`../skills/manage-bx24-template-mcp/feedback.md`](../skills/manage-bx24-template-mcp/feedback.md) for the calling guide.

## Why

Human-only feedback loops miss the patterns only an automated caller surfaces: ambiguous tool descriptions, surprising error shapes, missing capabilities, off-by-one issues that happen at scale. Surfacing these as labelled GitHub issues turns ephemeral runtime observations into a triagable backlog.

## Tool contract

```ts
bx24mcp_submit_feedback({
  kind: 'positive' | 'issue' | 'suggestion',
  summary: string,            // 5..200 chars, becomes the issue title
  details: string,            // 10..10000 chars (longer is truncated)
  relatedTool?: string,       // sanitised to /^[a-z0-9_]{0,64}$/
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

### Triage

- New `agent-feedback` issues land in the open backlog. Maintainers should review at least weekly.
- Re-label as `bug` / `enhancement` / `wontfix` / `duplicate` as appropriate; keep `agent-feedback` so the source channel stays queryable.
- If multiple agents report the same problem, deduplicate by referencing the original issue rather than closing.

## Rate limit

A sliding-window counter caps submissions at **5 per hour** across the running process. The check is in-memory: a Nitro restart resets it; this is acceptable because the limit is a soft floodgate, not a security boundary.

When the quota is exhausted, the tool returns:

```
Feedback rate limit reached. Try again in about <N> seconds. (5 submissions per hour.)
```

No GitHub call is made. The agent is expected to back off and try later. Phase 3 (multi-tenant) will move this to a per-token shared store.

## Sanitisation

- `details` over 10 000 characters is truncated with a marker line.
- C0 control characters (`\x00–\x08`, `\x0b`, `\x0c`, `\x0e–\x1f`) are stripped; tab, LF, CR are preserved.
- `details` is HTML-escaped and rendered inside `<pre><code>`, so Markdown formatting (`*`, `_`, `` ` ``, `#`, `[`, etc.) and HTML tags from the agent render as literal text. This is the *only* defence — agents are trusted to write reasonable prose, but the framing keeps a careless or hostile call from breaking the issue layout.
- `summary` is collapsed to a single line (any `\r\n` runs become a single space) and trimmed to 200 characters.
- `relatedTool` is lowercased and reduced to `[a-z0-9_]{0,64}` before being embedded in a label, to avoid 422s from GitHub's label validation.

## Operator setup

Two configuration knobs (both env, both server-side):

| Variable | Default | Purpose |
|---|---|---|
| `NUXT_GITHUB_FEEDBACK_TOKEN` | — (required) | Personal access token or fine-grained token with `public_repo` or `repo` and `issues:write` on `NUXT_GITHUB_FEEDBACK_REPO`. |
| `NUXT_GITHUB_FEEDBACK_REPO` | `bitrix24/templates-mcp` | `owner/name` of the issue target. |

If the token is absent, `bx24mcp_submit_feedback` returns a `Failed to submit feedback` message and the operator gets a `GithubFeedbackError` (`NOT_CONFIGURED`) in logs.

### Rotation

1. Issue a new fine-grained PAT in GitHub with the same scopes.
2. Replace `NUXT_GITHUB_FEEDBACK_TOKEN` in the server's `.env` (production) or the corresponding GitHub Actions secret (CI).
3. `docker compose up -d` to roll the container.
4. Verify with a manual `bx24mcp_submit_feedback` call from a connected client.
5. Revoke the old PAT.

### Revoking a noisy agent

Per-agent revocation is **not currently supported** — the MCP token is shared. To stop a misbehaving caller:

1. Rotate the MCP `NUXT_MCP_AUTH_TOKEN` (this severs all current callers).
2. Re-issue the new token only to the agents that should retain access.

Phase 3 will introduce per-tenant credentials; revocation will become surgical at that point.

## Failure modes

| Code | Cause | What the agent sees |
|---|---|---|
| `NOT_CONFIGURED` | Token env empty | "Failed to submit feedback: GitHub feedback token is not configured…" |
| `UPSTREAM` (401/403) | Bad token | "GitHub rejected the feedback token (401/403). Rotate it and retry." |
| `UPSTREAM` (404) | Wrong repo | "GitHub returned 404 — the configured feedback repo … is missing or unreachable." |
| `UPSTREAM` (other) | Misc. GitHub error | "GitHub returned <N> when creating the feedback issue." |
| `UPSTREAM` (malformed) | Success status without `html_url`/`number` | "GitHub returned a malformed issue payload." |
| `NETWORK` | `fetch` rejection (DNS, TCP, TLS) | "GitHub API is unreachable." |

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
