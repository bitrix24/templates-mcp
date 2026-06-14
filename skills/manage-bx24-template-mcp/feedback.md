# Agent feedback guide

`Last reviewed: 2026-06-14`

This MCP exposes a meta-tool `bx24mcp_submit_feedback`. Use it to report **your own** experience using or developing this server. Each call creates a GitHub issue in `bitrix24/templates-mcp` with the `agent-feedback` label.

The operator/maintainer-facing companion to this guide is [`../../docs/FEEDBACK.md`](../../docs/FEEDBACK.md). Read this file for *when* and *how* to call the tool.

## When to call

Call `bx24mcp_submit_feedback` when one of these is true:

- A **tool description** was ambiguous and led you to a wrong call (kind: `issue`, severity: `low`/`medium`).
- A tool **threw an unexpected error** or its response shape did not match its description (kind: `issue`, severity depends on impact).
- A capability is **missing** — you needed an operation this MCP does not expose and would have helped (kind: `suggestion`, severity: `low`).
- A workflow **worked notably well** — a tool description matched intent on the first try in a non-trivial scenario (kind: `positive`, no severity). Rare but useful as a signal.

Do **not** call it when:

- The Bitrix24 portal returned an expected business error (e.g., "task already closed"). That's not bx24-template-mcp's fault.
- You are unsure whether the problem is the agent's misuse or the tool's design. Try once more with the correction first.
- A previous call already returned a rate-limit message — back off, do not retry within the same conversation.

## How to call

```ts
bx24mcp_submit_feedback({
  kind: 'issue' | 'suggestion' | 'positive',
  summary: '<one line, < 200 chars>',
  details: '<what happened, what you expected, why it matters>',
  relatedTool: '<MCP tool name, optional>',
  severity: 'low' | 'medium' | 'high', // optional
})
```

### Writing the `summary`

- One line, declarative, no Markdown.
- Lead with the observable: `"b24_user_me response missed EMAIL on portal X"`, not `"problem with current user tool"`.
- Avoid "please" or "could you" — this is a structured report, not a request.

### Writing the `details`

- Start with the smallest reproducer you have: parameters used, what was returned, what was expected.
- Quote literal values when possible. The body is rendered inside `<pre><code>` so Markdown/HTML in your text appears verbatim — no need to escape, just paste.
- If a different tool's description influenced your behaviour, name it (`relatedTool`) and quote the relevant sentence.
- Keep it under 10 000 characters; anything past that is truncated with a marker.

### Choosing `severity`

| Level | Use when |
|---|---|
| `low` | Cosmetic, confusing description, missing optional field. Workflow completed. |
| `medium` | Workflow was disrupted but recoverable on the agent's side. |
| `high` | A tool failed in a way that blocks the user-visible task and is not obvious to the agent. |

Default to omitting `severity` if you are uncertain — it signals "no opinion".

## Rate limit

Five **attempts** per hour — **per tenant** under OAuth (keyed on the caller's `memberId`, so one noisy tenant can't starve another), or server-wide in webhook / stdio deployments (single identity, one bucket). Failed calls (auth, network, GitHub 5xx) consume a slot too. If you hit the limit, the tool returns a "rate limit reached" string with the seconds until reset. **Do not retry within the same conversation.** Continue the user's task and, if the problem persists across sessions, the next session can submit.

## Expected return shape

Success:

```
Feedback submitted as https://github.com/bitrix24/templates-mcp/issues/<N> (#<N>). Thank you — this will be triaged by a maintainer.
```

Rate-limited:

```
Feedback rate limit reached. Try again in about <N> seconds. (5 attempts per hour, including failures.)
```

Configuration / GitHub failure:

```
Failed to submit feedback: <reason>. The maintainer will need to fix the GitHub integration. Do not retry — your input has not been recorded.
```

When you see the failure message, **stop**. Do not retry. Continue the user's task and surface the underlying observation to the user verbally — the channel is temporarily closed.

## What you should not do

- Do not submit feedback about the *user's* request (e.g., "user asked for something impossible"). The channel is for the MCP server, not the conversation.
- Do not include PII, webhook URLs, bearer tokens, or other secrets in `details`. The issue is public.
- Do not fabricate `relatedTool` names. Use only tool names that actually exist in this MCP.
- Do not call this tool in eval/test runs — it is mocked in those contexts, but real network would still hit GitHub. If you are unsure whether you are in eval mode, do not submit.
