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

This is what a single-call tool looks like end-to-end. Two key invariants: the SDK call uses **`b24.actions.v3.call.make`** (never the deprecated `callMethod`), and the result handling uses **`isSuccess` / `getData()?.result` / `getErrorMessages()`** — not `try`/`catch` exclusively.

```ts
// server/mcp/tools/tasks/get-task.ts
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { Bitrix24ToolError, toToolError } from '~/server/utils/errors'

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
    try {
      const b24 = useBitrix24()

      // ✅ The right way: actions.v3.call.make with a typed generic.
      //    callMethod() is deprecated and disappears in SDK 2.0.
      const response = await b24.actions.v3.call.make<TaskGetResponse>({
        method: 'tasks.task.get',
        params: { taskId },
      })

      // ✅ Check isSuccess explicitly. Throwing a Bitrix24ToolError here keeps
      //    the LLM-visible error consistent across the whole project.
      if (!response.isSuccess) {
        throw new Bitrix24ToolError(
          response.getErrorMessages().join('; ') || `Failed to fetch Bitrix24 task ${taskId}`,
        )
      }

      // ✅ `.getData()` is typed `SuccessPayload<T> | undefined` — keep `?.`
      //    on the chain even after isSuccess passes, the type narrowing
      //    doesn't survive method calls.
      const task = response.getData()?.result?.task

      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `Task ${taskId} not found.` }],
        }
      }

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ id: task.id, title: task.title, status: task.status ?? null }, null, 2) },
        ],
      }
    } catch (err) {
      // ✅ toToolError handles AjaxError / SdkError / plain Error uniformly.
      //    Don't catch with `: any` — let it propagate as Bitrix24ToolError.
      throw toToolError(err, `Failed to fetch Bitrix24 task ${taskId}`)
    }
  },
})
```

## When the REST method is v2

`user.*`, `task.commentitem.*`, `task.elapseditem.*`, and other legacy methods live under v2. Use `b24.actions.v2.call.make` instead. Everything else stays the same.

```ts
const response = await b24.actions.v2.call.make<UserSearchRow[]>({
  method: 'user.search',
  params: { FILTER: filter, sort: 'ID', order: 'ASC' } as unknown as Record<string, unknown>,
  // ^ user.search uses non-standard `sort` / `order` scalar shape;
  //   the cast keeps the wire payload honest. Rarely needed elsewhere.
})
```

## When you need a batch

If the tool acts on a collection (10–25 ids), use **`b24.actions.v3.batch.make`** — one HTTP round-trip with up to 50 sub-calls. Don't loop `actions.v3.call.make` sequentially; that pattern existed briefly during PR #12 and was replaced for good reason (it lost the SDK's transactional report shape and ran ~25× slower).

```ts
import type { AjaxResult } from '@bitrix24/b24jssdk'

const response = await b24.actions.v3.batch.make<{ task: TaskItem }>({
  calls: taskIds.map((id) => ['tasks.task.start', { taskId: id }]),
  options: { isHaltOnError: false, returnAjaxResult: true },
})

if (!response.isSuccess) {
  throw new Bitrix24ToolError(response.getErrorMessages().join('; '))
}

// With `returnAjaxResult: true` each row is an AjaxResult<T>, not a bare payload.
// The cast is documented in the SDK's batch.make example.
const rows = response.getData() as unknown as Array<AjaxResult<{ task: TaskItem }>>

const results = rows.map((row, index) => {
  const taskId = taskIds[index]!
  if (!row.isSuccess) {
    return { taskId, ok: false, error: row.getErrorMessages().join('; ') }
  }
  return { taskId, ok: true, task: row.getData()?.result?.task }
})
```

Reference implementations: `server/utils/task-lifecycle.ts:runBatch`, `server/mcp/tools/tasks/rate-task.ts:runBatch`.

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

  it('calls actions.v3.call.make on tasks.task.get and shapes the response', async () => {
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

## Checklist before the PR

- [ ] One file under `server/mcp/tools/<group>/<kebab>.ts`.
- [ ] Uses `b24.actions.v3.call.make` or `b24.actions.v2.call.make`. Zero `callMethod` references.
- [ ] All Zod fields have `.describe()`.
- [ ] `isSuccess` is checked before reading `getData()`.
- [ ] Errors funnel through `toToolError()`; no `console.error`.
- [ ] Unit test in `tests/unit/tools/<group>/<name>.test.ts` using `makeFakeBitrix24`.
- [ ] Eval case in `tests/evals/tool-selection.eval.ts` (plus disambiguation if needed).
- [ ] Persona walk applied.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all green.
- [ ] PR title follows Conventional Commits: `feat(tools): add bitrix24_<name>`.
