# Adding a new MCP tool

Practical template for an AI agent (or human) adding a Bitrix24 MCP tool to this project. Read [`SKILL.md`](./SKILL.md) first — this doc fills in the concrete shape that the ground rules and persona walk describe.

## Where the tool goes

```
server/mcp/tools/
├── tasks/    – everything touching the tasks module (tasks.task.*, task.*)
├── users/    – user lookup / identity (user.current, user.search)
├── deals/    – CRM deals (crm.deal.*)        — Phase 2
├── contacts/ – CRM contacts (crm.contact.*)  — Phase 2
└── meta/     – MCP meta-tools (e.g. bx24mcp_submit_feedback)
```

One tool per file, `kebab-name.ts`. File-based discovery picks them up automatically.

## Naming

- **Bitrix24 tools**: `bitrix24_<verb>_<entity>` — e.g. `bitrix24_complete_task`.
- **Meta tools**: `bx24mcp_<verb>` — e.g. `bx24mcp_submit_feedback`. These do not talk to Bitrix24.

## The reference template

This is what a single-call tool looks like end-to-end. Two key invariants:
1. The SDK call goes through the **typed `callV3` / `callV2` helpers** from `server/utils/sdk-helpers.ts`. Never call `b24.actions.v3.call.make` directly from a tool — the helpers own the `isSuccess` / `getErrorMessages` boilerplate and the transport-error wrap. The deprecated `b24.callMethod` is forbidden.
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
  name: 'bitrix24_get_task',
  description:
    'Fetch a single Bitrix24 task by id. … Persona-walk notes: explicit task-control / idempotency / bulk hints here.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id from `bitrix24_list_tasks` or `bitrix24_create_task`.'),
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

Each wrapper factory supplies only the v2/v3-specific parts (REST namespace, params shape, response projection, optional pre-flight) via `runOne` / `runBatch` callbacks. Two precedents:

- `server/utils/task-lifecycle.ts` — wraps the seven `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}` v3 methods.
- `server/utils/checklist.ts` — wraps the three `task.checklistitem.{complete,renew,delete}` v2 methods, with optional pre-flight for heading-delete confirmation.

A new action-tool family (e.g. `task.elapseditem.*`, `task.dependence.*`) lands as ~30 LOC of callbacks plus per-tool spec files of ~10 LOC each.

#### `mapBatchRows` — the row-projection helper

Inside a factory's `runBatch`, use **`mapBatchRows(rows, ids, label, build)`** from `define-action-tool.ts` to walk SDK batch rows in lockstep with the input ids. It enforces:
- two-sided length assert (`rows.length === ids.length`) — catches SDK contract drift in either direction
- per-row `ok` / `error` propagation via the `build` callback
- a consistent error-message shape on length mismatch (`BATCH_TOO_LARGE`-grade loud)

Skip the manual `rows.map` + `taskId === undefined` defensive throw — it's exactly the pattern `mapBatchRows` exists to deduplicate.

A factory pays for itself when (a) three or more tools share the call shape and (b) the per-tool difference is description text + method name. Otherwise repeat the four lines.

### Destructive cascade ops — require a confirm flag

Ground Rule #9 in `SKILL.md`: when a Bitrix24 method silently destroys more than the agent meant to, gate the call behind a `confirm<Action>: boolean` field in the schema and a typed `*_NEEDS_CONFIRM` error code.

Reference implementation: `server/mcp/tools/tasks/delete-checklist-item.ts` + `server/utils/checklist.ts` (`assertNotHeading`, `assertBatchNoHeadings`). The factory adds `confirmDeleteHeading` to the Zod schema only for the delete tool (siblings `complete` / `renew` omit it). Pre-flight `callV2('task.checklistitem.getlist', { TASKID })` runs once for the whole batch — one extra round-trip, gates both single and batch flows.

Checklist for new destructive tools:

1. Identify the cascade: which Bitrix24 entities does the call silently remove besides the target?
2. Add `confirm<CascadeName>: boolean.optional()` to the Zod schema. Describe in plain language what gets wiped.
3. Pre-flight via the cheapest list/get method that returns the cascade indicator (`parentId`, `groupId`, …).
4. Throw `Bitrix24ToolError(message, '<CASCADE>_NEEDS_CONFIRM')`. Message MUST name the target and tell the agent how to re-call.
5. Skip pre-flight when confirm is `true` — the agent committed.
6. For batch mode, run ONE shared pre-flight, not N per-id checks.

#### Known Bitrix24 cascades (extend as you add destructive tools)

Use this table to decide whether a `delete_*` / `move_*` tool needs a confirm flag. "Pre-flight method" is the cheapest call that surfaces the cascade indicator for a single id; row "Confirm field" suggests the canonical schema field name to keep families consistent.

| Destructive op | Cascade target | Cascade indicator | Pre-flight method | Confirm field | Reference |
|---|---|---|---|---|---|
| `task.checklistitem.delete` on a heading | every child checklist item under the heading | `PARENT_ID === 0` on the target | `task.checklistitem.getlist { TASKID }` (one call gates both single + batch) | `confirmDeleteHeading` | `server/utils/checklist.ts` ✅ shipped in PR #17 |
| `sonet_group.delete` *(future)* | every task / file / discussion in the workgroup | the workgroup id itself | `sonet_group.get { ID }` + `tasks.task.list { GROUP_ID }` | `confirmDeleteWorkgroup` | not implemented |
| `tasks.task.delete` *(future)* | every comment / checklist item / time entry / result / dependency on the task | the task id itself | `tasks.task.get` (cheap) | `confirmDeleteTask` | not implemented; consider deferring — Bitrix24 UI hides hard-delete behind a per-portal toggle |
| `crm.deal.delete` *(post-pilot)* | every activity / quote / invoice linked to the deal | the deal id itself | `crm.activity.list { OWNER_TYPE_ID, OWNER_ID }` | `confirmDeleteDeal` | post-pilot |
| `disk.folder.deletetree` *(future)* | every file / sub-folder under the disk folder | folder type vs file type | `disk.folder.get { id }` | `confirmDeleteFolder` | not implemented |

If your tool isn't in this table and you find yourself adding a `confirm*` flag, add a row to keep the registry useful. If your tool feels destructive but doesn't cascade beyond a single record (e.g. `delete_task_result` removes one result; the parent task is untouched), no confirm flag is required — the Bitrix24 server-side author-only check is the right gate.

## When you need a batch

If the tool acts on a collection (10–50 ids), use **`batchV3`** (for v3 methods) or **`batchV2`** (for v2 methods) — one HTTP round-trip with up to 50 sub-calls. Don't loop `callV3` / `callV2` sequentially; that pattern existed briefly and was replaced (it lost the SDK's transactional report shape and ran ~25× slower).

**Inside a factory built on `defineActionTool`**, project the rows via `mapBatchRows` (see "Shared factory pattern" above) — never re-implement the row loop. The example below is for **standalone** batch tools (e.g. `rate-task.ts`) where the factory abstraction doesn't fit.

```ts
import { batchV3 } from '~/server/utils/sdk-helpers'
import { Bitrix24ToolError } from '~/server/utils/errors'

const rows = await batchV3<{ task: TaskItem }>(
  b24,
  taskIds.map((id) => ['tasks.task.start', { taskId: id }]),
  `Failed to start a batch of ${taskIds.length} task(s)`,
)

// rows is Array<AjaxResult<{ task: TaskItem }>> aligned with taskIds[].
// `isHaltOnError: false` + `returnAjaxResult: true` are applied by batchV3
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

describe('bitrix24_get_task', () => {
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

For tools that use batch mode, mock `fake.v3Batch` similarly — see `tests/unit/tools/tasks/rate-task.test.ts` for the canonical batch-mock pattern.

## Eval cases

Add at least one entry to `tests/evals/tool-selection.eval.ts` so DeepSeek validates that natural-language prompts route correctly:

```ts
{
  input: 'Покажи задачу 42 — заголовок, статус, кто исполнитель.',
  expected: 'bitrix24_get_task',
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
- **Allowed scopes**: `tools`, `client`, `auth`, `security`, `deploy`, `evals`, `skill`, `feedback`, `deps`, `docs`, `ci`, `tsconfig`, `lint`, `types`, `test`, `utils`
- **Header max length**: 120 chars
- **Subject case**: lowercase first word (rest free — `JSDoc`, `BatchCall` etc. are fine mid-sentence)

Pick the broadest scope that applies — a refactor across `server/utils/*` is `refactor(utils): ...`, not `refactor(sdk-helpers): ...`. If your change genuinely doesn't fit any existing scope, extend the enum in `commitlint.config.js` as part of the same PR and explain why in the commit body.

## Checklist before the PR

- [ ] One file under `server/mcp/tools/<group>/<kebab>.ts`.
- [ ] Uses `callV3` / `callV2` / `batchV3` from `server/utils/sdk-helpers.ts`. Zero direct `actions.*.{call,batch}.make` references in the handler; zero `callMethod` references anywhere.
- [ ] All Zod fields have `.describe()`.
- [ ] `isSuccess` is checked before reading `getData()`.
- [ ] Errors funnel through `toToolError()`; no `console.error`.
- [ ] Unit test in `tests/unit/tools/<group>/<name>.test.ts` using `makeFakeBitrix24`.
- [ ] Eval case in `tests/evals/tool-selection.eval.ts` (plus disambiguation if needed).
- [ ] Persona walk applied.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all green.
- [ ] PR title follows Conventional Commits (see "Commit message conventions" above): `feat(tools): add bitrix24_<name>`.
