# Adding a new MCP tool

`Last reviewed: 2026-05-30`

Practical template for an AI agent (or human) adding a Bitrix24 MCP tool to this project. Read [`SKILL.md`](./SKILL.md) first — this doc fills in the concrete shape that the ground rules and persona walk describe.

## Where the tool goes

```
server/mcp/tools/
├── tasks/    – everything touching the tasks module (tasks.task.*, task.*)
├── users/    – user lookup / identity (user.current, user.search)
└── meta/     – MCP meta-tools (e.g. bx24mcp_submit_feedback)
```

The template ships these three groups. If you're adding a tool for a different
domain (CRM is the planned post-pilot expansion: deals / contacts / leads;
calendars, disk, im, … are also fair game), create the directory yourself
under `server/mcp/tools/` — that's the canonical "fork and extend" path this
starter template is designed around.

One tool per file, `kebab-name.ts`. File-based discovery picks them up automatically.

## Naming

- **Bitrix24 tools**: `b24_<domain>(_<entity>)*_<action>` — action LAST, entity slots zero-or-more, **all tokens singular** (including for `_list`: `b24_task_list`, `b24_task_result_list`, `b24_task_checklist_item_list`). Singular-everywhere keeps one rule with no exceptions and side-steps irregular plurals (`children`, `people`) when CRM and other domains land. Examples: `b24_task_create`, `b24_task_complete`, `b24_task_checklist_item_add`.
- **Identity / "me" tools**: `b24_user_me` is the one allowed `_me` form, where the trailing `me` covers both the entity (the caller themselves) and the action ("identify me"). The CI guard restricts `_me` to the `user` domain — `b24_task_me`, `b24_calendar_me`, etc. fail. For "mine" semantics on other entities, use a filter on `_list` (`b24_task_list { responsibleId: me-id }`), not a separate tool. Extending `_me` to a new domain requires updating the allowlist in `tests/unit/mcp-stdio/tool-naming-convention.test.ts` AND updating this section in the same PR.
- **Meta tools**: `bx24mcp_<verb>` — e.g. `bx24mcp_submit_feedback`. **Use `bx24mcp_` ONLY for tools that do NOT call the Bitrix24 REST API** (the prefix is the operator-visible signal that the tool stays inside the MCP server — no portal data leaves). Every Bitrix24-touching tool uses `b24_`.
- **File names follow a separate convention.** Tool files are `kebab-case` (`list-tasks.ts`, `create-task.ts`) with `verb-entity` order; tool names are `b24_entity_verb`. The two intentionally diverge: file convention reads naturally in a directory listing, tool convention reads naturally for the LLM. Don't try to align them.
- The `b24_*` / `bx24mcp_*` split, the singular-everywhere rule, AND the `_me` domain restriction are all **CI-enforced** by `tests/unit/mcp-stdio/tool-naming-convention.test.ts` — every name under `server/mcp/tools/**` must match the pattern for its directory (`meta/` → `bx24mcp_`, everywhere else → `b24_`).

## The reference template

> **Transport: pick v2 vs v3 correctly (this matters).** Bitrix24 has two REST surfaces and they are NOT interchangeable. The classic API (`/rest/<uid>/<secret>/…`, UPPERCASE fields) is reached via `callV2`/`batchV2`; rest-v3 (`/rest/api/…`, camelCase DTOs, `BITRIX_REST_V3_EXCEPTION_*` errors) via `callV3`/`batchV3`. Calling a classic method on v3 fails with `UNKNOWNDTOPROPERTYEXCEPTION` (wrong casing) or "restApi:v3 not support method". Bitrix24's migration to rest-v3 is slow, so **default to v2** for anything with a classic implementation — `tasks.task.{add,list,update,start,pause,complete,approve,disapprove,defer,renew}`, `user.*`, `task.*` (singular). Use **v3 only** for methods that are v3-ONLY with no working v2 form — currently `tasks.task.get` and `tasks.task.result.*`. When unsure, check apidocs: a `/rest/api/` URL + camelCase fields = v3. See the convention block in `server/utils/sdk-helpers.ts`.

This is what a single-call tool looks like end-to-end. Two key invariants:
1. The SDK call goes through the **typed `callV3` / `callV2` helpers** from `server/utils/sdk-helpers.ts`. Never call `b24.actions.v3.call.make` directly from a tool — the helpers own the `isSuccess` / `getErrorMessages` boilerplate and the transport-error wrap. The deprecated `b24.callMethod` is forbidden. The example below uses `tasks.task.get`, which really is a v3 method; for a classic method (e.g. `tasks.task.add`) use `callV2` instead.
2. Compact `JSON.stringify(payload)` (no `null, 2` pretty-print) — every newline / space costs tokens in the LLM tool response.

```ts
// server/mcp/tools/tasks/get-task.ts
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'

/**
 * One-line summary of what this tool does.
 *
 * Bitrix24 REST: tasks.task.get (v3)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-get.html
 */

/** Subset of the REST response we surface back to the agent. */
interface TaskGetResponse {
  task: { id: number | string; title: string; status?: string }
}

export default defineMcpTool({
  name: 'b24_task_get',
  description:
    'Fetch a single Bitrix24 task by id. … Persona-walk notes: explicit task-control / idempotency / bulk hints here.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id from `b24_task_list` or `b24_task_create`.'),
  },
  handler: async ({ taskId }) => {
    const b24 = useBitrix24()
    // ✅ callV3 wraps the SDK boundary:
    //    - transport throws → Bitrix24ToolError via toToolError
    //    - !isSuccess → Bitrix24ToolError with joined SDK error messages
    //    - returns the unwrapped `result` payload (or undefined for empty body)
    const result = await callV3<TaskGetResponse>(
      b24,
      'tasks.task.get',
      { taskId },
      `Failed to fetch Bitrix24 task ${taskId}`,
    )

    if (!result?.task) {
      return {
        content: [{ type: 'text' as const, text: `Task ${taskId} not found.` }],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          // ✅ Compact JSON. Pretty-print costs ~30 % more tokens per response.
          text: JSON.stringify({
            id: result.task.id,
            title: result.task.title,
            status: result.task.status ?? null,
          }),
        },
      ],
    }
  },
})
```

Note the absence of `try`/`catch` in this template: `callV3` already throws `Bitrix24ToolError` instances on every failure path. Add an outer `try`/`catch` only if you have post-SDK code that can fail (e.g. local I/O), and even then prefer rewrapping with `toToolError`.

## When the REST method is v2

`user.*`, `task.commentitem.*`, `task.checklistitem.*`, `task.elapseditem.*`, and other legacy methods live under v2. Use `callV2` instead of `callV3` — same signature, same return contract. `callV2`'s `params` accepts either an object (the common case) or a positional array — some v2 methods are documented with positional args only (e.g. `task.checklistitem.{complete,renew}` per apidocs.bitrix24.ru).

```ts
const user = await callV2<UserCurrentResponse>(
  b24,
  'user.current',
  {},
  'Failed to fetch current Bitrix24 user',
)

// Positional [taskId, itemId] — accepted directly, no cast needed.
await callV2<unknown>(
  b24,
  'task.checklistitem.complete',
  [taskId, itemId],
  `Failed to complete Bitrix24 checklist item ${itemId} on task ${taskId}`,
)
```

`user.search` has a non-standard params shape (scalar `sort` / `order`, not the `Record<string, ...>` documented by `TypeCallParams.order`); see `server/mcp/tools/users/find-user.ts` for the documented `as unknown as TypeCallParams` cast. Rarely needed elsewhere.

### Shared factory pattern (single-or-batch action tools)

When a group of tools shares the wire signature — same params, same response, same single-or-batch contract — build it on top of **`defineActionTool`** from `server/utils/define-action-tool.ts` rather than re-implementing the dispatch scaffold.

The scaffold owns:
- the `idOrIdArraySchema` (positive int OR non-empty array of positive ints)
- the `forceFlagSchema(cap)` flag for batch-cap overrides
- the single-vs-batch dispatch on `typeof targetId`
- the `BATCH_TOO_LARGE` error throw
- the batch summary envelope `{ batch, verb, total, ok, failed, results }`

Each wrapper factory supplies only the v2/v3-specific parts (REST namespace, params shape, response projection, optional pre-flight) via `runOne` / `runBatch` callbacks. Five precedents in the codebase:

- `server/utils/task-lifecycle.ts` — wraps the seven `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}` classic (v2) methods. Thin per-tool files (~10 LOC) because the runOne / runBatch callbacks live in the shared factory.
- `server/utils/checklist.ts` — wraps the three `task.checklistitem.{complete,renew,delete}` v2 methods with positional `[taskId, itemId]` params and optional heading-delete pre-flight.
- `server/mcp/tools/tasks/delete-elapsed-time.ts` — single-tool consumer demonstrating object-form `{TASKID, ITEMID}` params and the universal `confirmDelete` gate (SKILL.md Ground Rule #9). Callbacks live inline (no shared factory file) — that's the right shape when you have one delete tool per REST family, not a fan-out like lifecycle / checklist.
- `server/mcp/tools/tasks/add-task-dependency.ts` — single-tool consumer where the dispatched id-or-array (`taskIdFrom`) is paired with TWO fixed-per-call inputs (`taskIdTo`, `linkType`) that ride along on `input`. Shows that the factory shape extends naturally beyond "one fixed parent id" — any number of constants can bleed in via closure over `input`.
- `server/mcp/tools/tasks/remove-task-dependency.ts` — mirror of add (same shape, plus the universal `confirmDelete` gate). Demonstrates that `assertConfirmedDelete` from `server/utils/define-action-tool.ts` is the right Rule #9 entry-point for new delete tools.

Sizing: thin per-tool files when callbacks live in a shared factory (~10 LOC per tool, plus ~80 LOC for the factory itself); inline-callback files run ~80-100 LOC when there's a single consumer for the family. A new action-tool family is worth extracting into a shared factory once you have ≥2 verbs against the same REST namespace.

#### `mapBatchRows` — the row-projection helper

Inside a factory's `runBatch`, use **`mapBatchRows(rows, ids, label, build)`** from `define-action-tool.ts` to walk SDK batch rows in lockstep with the input ids. It enforces:
- two-sided length assert (`rows.length === ids.length`) — catches SDK contract drift in either direction
- per-row `ok` / `error` propagation via the `build` callback
- a consistent error-message shape on length mismatch (`BATCH_TOO_LARGE`-grade loud)

Skip the manual `rows.map` + `taskId === undefined` defensive throw — it's exactly the pattern `mapBatchRows` exists to deduplicate.

A factory pays for itself when (a) three or more tools share the call shape and (b) the per-tool difference is description text + method name. Otherwise repeat the four lines.

### Destructive ops — universal confirm + cascade-specific confirm

**Two stacking rules** from `SKILL.md`:

- **Ground Rule #9 (universal)** — EVERY `*_delete` or `*_remove` tool requires `confirmDelete: true` from the agent, regardless of cascade. Refuses with `DELETE_NEEDS_CONFIRM` otherwise. Implementation:
  1. Wire `confirmDelete: confirmDeleteSchema()` into the tool's Zod `inputSchema` — shared schema fragment from `server/utils/define-action-tool.ts` keeps wording uniform.
  2. In the handler, call `assertConfirmedDelete(toolName, targetDescription, confirmDelete)` from the same file. It owns the `Bitrix24ToolError` throw and the `DELETE_NEEDS_CONFIRM` code — do NOT re-implement.
  3. Format `targetDescription` per-callsite so the LLM sees a domain-specific message (e.g. `"elapsed-time entry 5 on task 1"`, `"dependency link 50 → task 100"`). The error message must name the target(s) so the agent shows the operator what they're agreeing to.

- **Ground Rule #10 (cascade)** — STACKS on top when the delete silently destroys more than the named target (e.g. a heading wipes child items). Adds a SECOND `confirm<CascadeName>: boolean` flag to the same schema. Both flags must be `true` for the delete to proceed.

**Reference implementations**:

- `server/mcp/tools/tasks/delete-elapsed-time.ts` — universal `confirmDelete` only (no cascade). The cleanest pattern for line-item deletes; uses the shared `assertConfirmedDelete` helper with a per-callsite `describeTarget`.
- `server/mcp/tools/tasks/remove-task-dependency.ts` — also universal-only, with a pair-shaped target (`taskIdFrom → taskIdTo`). Demonstrates that the helper extends naturally to non-id targets.
- `server/mcp/tools/tasks/delete-task-result.ts` — standalone (no factory) consumer of `assertConfirmedDelete`. Shows the helper works equally well outside the factory dispatch path.
- `server/mcp/tools/tasks/delete-checklist-item.ts` + `server/utils/checklist.ts` (`assertNotHeading`, `assertBatchNoHeadings`) — both `confirmDelete` (universal, Rule #9, via shared helper) AND `confirmDeleteHeading` (cascade-specific, Rule #10). Universal gate fires FIRST; cascade pre-flight `callV2('task.checklistitem.getlist', { TASKID })` runs once for the whole batch only when the universal gate passes — one extra round-trip, gates both flows.

**Checklist for new delete tools**:

1. **Always**: add `confirmDelete: confirmDeleteSchema()` to the Zod schema, then call `assertConfirmedDelete(toolName, describeTarget(...), confirmDelete)` from the handler. Do NOT re-implement the refusal — the shared helper owns the throw + code + message format.
2. **If cascade-destructive**: also add `confirm<CascadeName>: z.boolean().optional().describe(…)`. Pre-flight the cascade indicator (`parentId`, `groupId`, …) via the cheapest list/get method. Throw `<CASCADE>_NEEDS_CONFIRM` separately. Skip pre-flight when cascade-confirm is `true` — the agent committed.
3. For batch mode, run ONE shared pre-flight, not N per-id checks. The universal Rule #9 gate must fire BEFORE the cascade pre-flight so an unconfirmed call short-circuits without spending a wire round-trip.
4. Error messages MUST name the target(s) and tell the agent how to re-call. The shared helper takes care of this if you give it a good `targetDescription`.

#### Delete tools registry — universal `confirmDelete` + cascade gates

Every delete tool needs the universal `confirmDelete` flag (Rule #9). Some additionally need a cascade-specific flag (Rule #10) when they wipe more than the named target. This table tracks both: rows where "Cascade target" is `none` are pure-universal deletes; rows with a real cascade target stack a second flag on top.

| Destructive op | Cascade target | Cascade indicator | Pre-flight method | Confirm field | Reference |
|---|---|---|---|---|---|
| `task.checklistitem.delete` on a heading | every child checklist item under the heading | `PARENT_ID === 0` on the target | `task.checklistitem.getlist { TASKID }` (one call gates both single + batch) | `confirmDelete` (Rule #9) + `confirmDeleteHeading` (Rule #10, cascade) | `server/utils/checklist.ts` ✅ shipped — universal gate retrofit landed in PR #31 |
| `task.elapseditem.delete` (single or batch) | none — line-item delete only | — | — | universal `confirmDelete` only (Ground Rule #9) | `server/mcp/tools/tasks/delete-elapsed-time.ts` ✅ shipped in PR #28 |
| `tasks.task.result.delete` (single) | none — single result, parent task untouched | — | — | universal `confirmDelete` only (Ground Rule #9) | `server/mcp/tools/tasks/delete-task-result.ts` ✅ shipped — universal gate retrofit landed in PR #31 |
| `task.dependence.delete` (single or batch) | none — removes one predecessor edge only | — | — | universal `confirmDelete` only (Ground Rule #9) | `server/mcp/tools/tasks/remove-task-dependency.ts` ✅ shipped in PR-C |
| `sonet_group.delete` *(future)* | every task / file / discussion in the workgroup | the workgroup id itself | `sonet_group.get { ID }` + `tasks.task.list { GROUP_ID }` | `confirmDeleteWorkgroup` | not implemented |
| `tasks.task.delete` *(future)* | every comment / checklist item / time entry / result / dependency on the task | the task id itself | `tasks.task.get` (cheap) | `confirmDeleteTask` | not implemented; consider deferring — Bitrix24 UI hides hard-delete behind a per-portal toggle |
| `disk.folder.deletetree` *(future)* | every file / sub-folder under the disk folder | folder type vs file type | `disk.folder.get { id }` | `confirmDeleteFolder` | not implemented |

If your tool isn't in this table and you find yourself adding a `confirm<Cascade>` flag for a NEW cascade pattern, add a row to keep the registry useful. NB: every delete tool needs `confirmDelete: true` per Ground Rule #9 — the table above is specifically for CASCADE flags that stack on top of that universal gate.

## When you need a batch

If the tool acts on a collection (10–50 ids), use **`batchV2`** (for classic methods — the default) or **`batchV3`** (for v3-only methods) — one HTTP round-trip with up to 50 sub-calls. Don't loop `callV2` / `callV3` sequentially; that pattern existed briefly and was replaced (it lost the SDK's transactional report shape and ran ~25× slower).

**Inside a factory built on `defineActionTool`**, project the rows via `mapBatchRows` (see "Shared factory pattern" above) — never re-implement the row loop. The example below is for **standalone** batch tools (e.g. `rate-task.ts`) where the factory abstraction doesn't fit.

```ts
// tasks.task.start is a classic method → batchV2. Use batchV3 only for
// genuinely v3 methods (e.g. tasks.task.result.*).
import { batchV2 } from '~/server/utils/sdk-helpers'
import { Bitrix24ToolError } from '~/server/utils/errors'

const rows = await batchV2<{ task: TaskItem }>(
  b24,
  taskIds.map((id) => ['tasks.task.start', { taskId: id }]),
  `Failed to start a batch of ${taskIds.length} task(s)`,
)

// rows is Array<AjaxResult<{ task: TaskItem }>> aligned with taskIds[].
// `isHaltOnError: false` + `returnAjaxResult: true` are applied by batchV2
// for you — per-call failures land in rows[i] with isSuccess === false.
const results = rows.map((row, index) => {
  const taskId = taskIds[index]
  if (taskId === undefined) {
    throw new Bitrix24ToolError(`Batch row index ${index} has no taskId; SDK rows/input length mismatch.`)
  }
  if (!row.isSuccess) {
    return { taskId, ok: false, error: row.getErrorMessages().join('; ') }
  }
  return { taskId, ok: true, task: row.getData()?.result?.task }
})
```

Reference implementations: `server/utils/task-lifecycle.ts` (factory-style, uses `mapBatchRows`), `server/mcp/tools/tasks/rate-task.ts:runBatch` (standalone, hand-rolled loop).

## Errors and logging

- **Errors**: always go through `toToolError(err, fallback)` from `~/server/utils/errors`. It special-cases `AjaxError` and `SdkError` (preserves `.code` and `.status`) and falls back to a generic wrap for plain `Error`.
- **Error codes**: when throwing `Bitrix24ToolError` directly with a project-defined code (refusal gates, schema-passing-but-semantically-invalid input, batch-cap exceeded, …), use the `Bitrix24ErrorCode` registry from `~/server/utils/errors` — not raw strings. `Bitrix24ErrorCode.BATCH_TOO_LARGE` is typo-safe; `'BATCH_TO_LARGE'` compiles and silently bypasses every catch block matching the correct code. SDK-passed codes (Bitrix24's own `QUERY_LIMIT_EXCEEDED`, `ACCESS_DENIED`, etc.) flow through `toToolError` as strings — don't enumerate them.
  - **Adding a new project code**:
    1. Append a `KEY: 'VALUE'` line to `Bitrix24ErrorCode` in `errors.ts` with a JSDoc one-liner explaining when to throw it.
    2. Reference it at the throw site: `new Bitrix24ToolError(msg, Bitrix24ErrorCode.KEY)`.
    3. Reference it in test assertions: `expect(...).rejects.toMatchObject({ code: Bitrix24ErrorCode.KEY })`.
    4. Update the registry-completeness test in `tests/unit/errors.test.ts` — its failure is the deliberate "you added a code" signal, not noise.
- **Logging**: don't import `console` directly. The shared logger is `useLogger()` from `~/server/utils/logger`. The SDK's internal events (retry, rate-limit) already flow through it because `useBitrix24()` calls `client.setLogger(useLogger())` on construction.

```ts
import { useLogger } from '~/server/utils/logger'

const log = useLogger()
log.info('starting batch update', { count: taskIds.length })
log.error('Bitrix24 batch failed', { error: wrapped.message })
```

## Tests

Co-locate at `tests/unit/tools/<group>/<name>.test.ts`. Mock the SDK via the shared helper:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => fake.b24,
}))

const tool = (await import('../../../../server/mcp/tools/tasks/get-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<{ content: { type: 'text'; text: string }[] }>
}

describe('b24_task_get', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('routes the call through callV3 on tasks.task.get and shapes the response', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ task: { id: 1, title: 'demo', status: '3' } }))

    const result = await tool.handler({ taskId: 1 })

    expect(fake.v3Call).toHaveBeenCalledWith({ method: 'tasks.task.get', params: { taskId: 1 } })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ id: 1, title: 'demo', status: '3' })
  })

  it('returns a friendly message when the task is not found', async () => {
    fake.v3Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 999 })
    expect(result.content[0]!.text).toMatch(/not found/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v3Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 1 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
```

For tools that use batch mode, mock `fake.v2Batch` (or `fake.v3Batch` for a v3-only method) similarly — see `tests/unit/tools/tasks/rate-task.test.ts` (a v2 batch tool) for the canonical batch-mock pattern. Match the mock to the transport the tool actually uses, and assert the other one was NOT called.

## Eval cases

Add at least one entry to `tests/evals/tool-selection.eval.ts` so DeepSeek validates that natural-language prompts route correctly:

```ts
{
  input: 'Покажи задачу 42 — заголовок, статус, кто исполнитель.',
  expected: 'b24_task_get',
  notes: 'RU explicit-id task lookup — must NOT route to list_tasks.',
},
```

If your tool can be confused with another tool the project already has (lookup vs. list, create vs. update, etc.), add a disambiguation case for each plausible confusion.

## Persona walk before opening the PR

Apply SKILL.md "Persona walk" to your tool's description and eval cases. Specifically:

| Persona | Question |
|---|---|
| 👷 RU factory director | Does this scale to 200/day? Do I see partial-failure clearly? |
| 👩‍⚕️ RU polyclinic HR head | Any jargon (taskControl, MARK, UPPER_SNAKE) leaking into the description? |
| 💼 RU owner-operator | Can I name things in free text, or does the description force ids? |
| 🚀 DOGE walk | Is this 7 tools that could be 1 enum? What's the token cost? |
| 🏭 DE Müller | Audit trail in the result? No silent mutations? |
| 🌙 UAE Fatima | Locale-independent? RTL-friendly? Hijri-aware deadlines? |

## Commit message conventions

The `Commit messages` CI job runs `commitlint` against both the PR title and every commit in the PR. Conventional Commits format is enforced via `commitlint.config.js`:

- **Allowed types**: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `ci`, `perf`, `build`, `revert`
- **Allowed scopes**: `tools`, `client`, `auth`, `security`, `deploy`, `evals`, `skill`, `feedback`, `deps`, `docs`, `ci`, `tsconfig`, `lint`, `types`, `test`, `app`, `dxt`, `utils`
- **Header max length**: 120 chars
- **Subject case**: lowercase first word (rest free — `JSDoc`, `BatchCall` etc. are fine mid-sentence)

Pick the broadest scope that applies — a refactor across `server/utils/*` is `refactor(utils): ...`, not `refactor(sdk-helpers): ...`. If your change genuinely doesn't fit any existing scope, extend the enum in `commitlint.config.js` as part of the same PR and explain why in the commit body.

## Checklist before the PR

- [ ] One file under `server/mcp/tools/<group>/<kebab>.ts`.
- [ ] Uses `callV2` / `callV3` / `batchV2` / `batchV3` from `server/utils/sdk-helpers.ts`, with the **correct transport** for the method (default v2; v3 only for v3-only methods — see the convention block in `sdk-helpers.ts`). Zero direct `actions.*.{call,batch}.make` references in the handler; zero `callMethod` references anywhere.
- [ ] All Zod fields have `.describe()`.
- [ ] `isSuccess` is checked before reading `getData()`.
- [ ] Errors funnel through `toToolError()`; no `console.error`.
- [ ] Unit test in `tests/unit/tools/<group>/<name>.test.ts` using `makeFakeBitrix24`.
- [ ] Eval case in `tests/evals/tool-selection.eval.ts` (plus disambiguation if needed).
- [ ] Persona walk applied.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all green.
- [ ] PR title follows Conventional Commits (see "Commit message conventions" above): `feat(tools): add b24_<name>`.
