# Adding a tool

A human-facing walkthrough for forking this template and adding your own Bitrix24
MCP tool. It covers the mental model, where files go, the two registrations you
must not forget, and an end-to-end look at a real tool.

This is the orientation. The exhaustive, copy-paste reference — the v2/v3 transport
rules, the single-or-batch action factory, the delete-confirmation registry, the
persona walk — lives in the agent skill
[`../skills/manage-bx24-template-mcp/adding-tools.md`](../skills/manage-bx24-template-mcp/adding-tools.md).
That doc is written for an AI agent driving the change; this one is for the person
deciding to make it. Read this first, then reach for the skill when you write code.

## What a "tool" is here

An MCP tool is a single TypeScript file that exports one `defineMcpTool({...})`
object. It declares a `name`, a `description` the LLM reads to decide when to call
it, a Zod `inputSchema`, and a `handler` that talks to Bitrix24 and returns a text
payload. The MCP server exposes it over the `/mcp` route; an MCP client (Claude
Desktop, the web client, the DXT stdio bundle) calls it.

The request path for one call:

```
MCP client ── /mcp ──▶ defineMcpTool handler
                          │  useBitrix24()        → the configured webhook client
                          │  callV2 / callV3 ...  → typed SDK boundary (sdk-helpers.ts)
                          ▼
                       Bitrix24 REST  →  compact JSON back to the agent
```

## Where the file goes

```
server/mcp/tools/
├── tasks/   – the tasks module (tasks.task.*, task.*)
├── users/   – user lookup / identity (user.current, user.search)
└── meta/    – MCP meta-tools that don't call Bitrix24 (e.g. bx24mcp_submit_feedback)
```

One tool per file, named `kebab-case.ts`. Adding a tool for a domain that doesn't
have a folder yet (CRM is the planned post-pilot expansion: deals / contacts /
leads; calendars, disk, im, … are also fair game)? Create the directory under
`server/mcp/tools/` — extending into new Bitrix24 modules is exactly what this
template is built for.

## The two registrations (don't skip the second one)

A tool has to be registered **twice**, because the project ships two transports:

1. **HTTP server** — file-based discovery. Dropping the file under
   `server/mcp/tools/**` is all the HTTP transport needs — no registration step here.
2. **DXT / stdio bundle** — a hand-maintained registry, and the step that's easy to
   miss: you must add **both** an `import` and an array entry in
   [`../mcp-stdio/tools.ts`](../mcp-stdio/tools.ts).

The two are cross-checked by `tests/unit/mcp-stdio/tools.parity.test.ts` — **CI
fails if they drift.** This is the single most common thing a first-time
contributor forgets, so it's the first thing to remember.

## Naming

- **Bitrix24 tools**: `b24_<domain>(_<entity>)*_<action>` — action LAST, entity slots zero-or-more, **all tokens singular** (including before `_list`: `b24_task_list`, `b24_task_result_list`, `b24_task_checklist_item_list`). One rule, no exceptions, no irregular-plural traps. Examples: `b24_task_create`, `b24_task_complete`, `b24_task_checklist_item_add`.
- **Identity / "me" tools**: `b24_user_me` is the one allowed `_me` form, where the trailing `me` covers both entity (the caller) and action ("identify me"). The CI guard scopes `_me` to the `user` domain — `b24_task_me`, `b24_calendar_me`, etc. fail the guard. Opening a new `_me` form requires extending the allowlist in `tests/unit/mcp-stdio/tool-naming-convention.test.ts` AND updating this section in the same PR.
- **Meta tools**: `bx24mcp_<verb>` — e.g. `bx24mcp_submit_feedback`. **Use `bx24mcp_` ONLY for tools that don't call the Bitrix24 REST API** (the prefix is the operator-visible signal that the tool stays inside the MCP server — no portal data leaves). Everything that talks to Bitrix24 uses `b24_`.
- **File names follow a different convention from tool names — by design.** Files are `kebab-case` with `verb-entity.ts` (e.g. `list-tasks.ts`, `create-task.ts`); tool names are `b24_entity_verb` (e.g. `b24_task_list`, `b24_task_create`). The file convention reads naturally in a directory listing (`add-`, `list-`, `update-`, `delete-` group alphabetically); the tool convention reads naturally for an LLM picking by domain. The two are not synced and don't need to be — `tools.parity.test.ts` checks the registries, not the names.
- A tool whose primary effect is removing a record (`*_delete` /
  `*_remove`) is subject to the confirm-delete gate — see "Bigger shapes".
- Both the prefix split and the singular-everywhere rule are CI-enforced by `tests/unit/mcp-stdio/tool-naming-convention.test.ts`.

## Anatomy of a real tool

The simplest shipped tool is
[`server/mcp/tools/users/current-user.ts`](../server/mcp/tools/users/current-user.ts).
Read it top to bottom — every tool in the repo is a variation on it:

```ts
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

// Local interface describing the subset of the REST response you surface.
interface CurrentUserResponse { ID?: string | number, NAME?: string, LAST_NAME?: string }

export default defineMcpTool({
  name: 'b24_user_me',
  description:
    'Get the Bitrix24 user that owns the configured incoming webhook. Use this as a '
    + 'connectivity check or when you need the operator id/name before any subsequent '
    + 'Bitrix24 calls.',
  inputSchema: {},                       // Zod raw shape; every field gets a .describe()
  handler: async () => {
    const b24 = useBitrix24()            // the webhook-backed client
    const user = await callV2<CurrentUserResponse>(
      b24,
      'user.current',
      {},
      'Failed to fetch current Bitrix24 user',   // error context if the call fails
    )
    // ... shape a compact JSON response (no pretty-print — newlines cost tokens)
  },
})
```

Four things the example bakes in, and why they matter for a human writing the next one:

- **`useBitrix24()`** hands you the client wired to the configured webhook. You
  never construct credentials yourself.
- **`callV2` / `callV3`** (from `server/utils/sdk-helpers.ts`) are the *only*
  sanctioned way to reach the SDK. They collapse the
  `await → isSuccess → getErrorMessages → getData` dance into one call and throw a
  typed `Bitrix24ToolError` on every failure path — which is why the handler has no
  `try`/`catch`. Never call `b24.actions.*.make` directly, and never use the
  deprecated `b24.callMethod`.
- **Compact JSON.** Use `JSON.stringify(payload)`, not `JSON.stringify(payload, null, 2)`
  — every space and newline is tokens out of the agent's budget.
- **Every Zod field gets `.describe()`** — that text is what the LLM reads to fill
  the argument correctly. Zod also validates the input *before* your handler runs, so
  treat the handler arguments as already-validated typed values, not raw strings to
  re-parse. (The SDK *response*, by contrast, is typed but not schema-validated —
  check fields for `undefined` before use, as the example does with `?? null`.)

## v2 vs v3 — the one rule that bites

Bitrix24 has two REST surfaces and they are **not** interchangeable. The classic
API (UPPERCASE fields) goes through `callV2`/`batchV2`; rest-v3 (camelCase DTOs)
through `callV3`/`batchV3`. Calling a classic method on v3 fails with
`UNKNOWNDTOPROPERTYEXCEPTION`.

**Default to v2.** Bitrix24's v3 migration is slow, so most methods (`tasks.task.{add,list,update,…}`,
`user.*`, `task.*`) are v2. Use v3 *only* for methods that are v3-only with
no working v2 form (currently `tasks.task.get` and `tasks.task.result.*`). When in
doubt: a `/rest/api/` URL with camelCase fields means v3. The authoritative
convention block is at the top of
[`server/utils/sdk-helpers.ts`](../server/utils/sdk-helpers.ts).

## Bigger shapes

You won't need these for a first read tool, but know they exist:

- **Acting on 10–50 ids at once** → use `batchV2` / `batchV3` (one round-trip, up to
  50 sub-calls), never a loop of single calls.
- **A family of tools sharing the same wire signature** (e.g. the seven task
  lifecycle verbs) → build on the `defineActionTool` factory in
  `server/utils/define-action-tool.ts` instead of re-implementing dispatch.
- **A `*_delete` / `*_remove` tool** → it MUST gate on
  `confirmDelete: true` (Ground Rule #9), and stack a second confirm flag if the
  delete cascades to more than the named target (Rule #10). Use the shared
  `confirmDeleteSchema()` / `assertConfirmedDelete()` helpers from
  `~/server/utils/define-action-tool` — don't hand-roll the refusal. Call
  `assertConfirmedDelete()` **before any wire call** in the handler, so an
  unconfirmed delete short-circuits without spending a round-trip. For a cascade
  pre-flight on a batch, do **one** shared check, not one per id.

All three are documented in full, with reference implementations, in the
[agent skill](../skills/manage-bx24-template-mcp/adding-tools.md).

## Errors and logging

- Funnel every error through `toToolError(err, fallback)` from
  `~/server/utils/errors`. For project-defined codes (refusal gates, batch-cap),
  throw `Bitrix24ToolError` with a `Bitrix24ErrorCode.*` constant — not a raw string.
  The `fallback` string is shown to the LLM verbatim — never interpolate the webhook
  URL, a token, or raw user input into it. The same applies to `err.message`:
  `toToolError` propagates the SDK's message, so never construct or re-throw an error
  whose message embeds a secret or raw input. Need a new project code? See the agent
  skill for the four-step process (append to the registry, throw, assert, update the
  completeness test).
- Don't `import console`. Use `useLogger()` from `~/server/utils/logger`. Don't log
  secrets, the webhook URL, or tokens.

## Tests and evals

Both are required by CI:

- **Unit test** co-located at `tests/unit/tools/<group>/<name>.test.ts`, mocking the
  SDK via `makeFakeBitrix24` (and the `fakeOk` / `fakeOkEmpty` helpers) from
  `tests/unit/_helpers/bitrix24-mock.ts`. Assert the call routed through the right
  transport and the response shape is correct. Runs under `pnpm test`.
- **Eval case** in `tests/evals/tool-selection.eval.ts` so the tool-selection eval
  confirms natural-language prompts route to your tool — add a disambiguation case
  if it could be confused with an existing tool. Evals run separately via
  `pnpm test:evals` (needs `DEEPSEEK_API_KEY`) — `pnpm test` does **not** run them.
  See [`EVALS.md`](./EVALS.md).

The skill has copy-paste skeletons for both.

## Before you open the PR

- [ ] One file under `server/mcp/tools/<group>/<kebab>.ts`.
- [ ] **Registered in `mcp-stdio/tools.ts` too** (import + array entry) — parity test.
- [ ] Correct transport (`callV2` default, `callV3` only for v3-only methods); no
      direct `actions.*.make`, no `callMethod`.
- [ ] Every Zod field has `.describe()`; compact JSON response.
- [ ] Unit test + eval case added.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all green (eval validated separately
      with `pnpm test:evals`).
- [ ] PR title in Conventional Commits form: `feat(tools): add b24_<name>`
      (the `Commit messages` CI job runs commitlint on the title and every commit).

The skill's checklist is the authoritative superset — including the persona walk
you should run over your tool's description before opening the PR. See
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the commit/PR rules and CI gates, and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the tool layer fits the rest of the system.
