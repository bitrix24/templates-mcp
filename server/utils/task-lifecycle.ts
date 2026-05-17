import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { Bitrix24ToolError } from '~/server/utils/errors'
import { batchV3, callV3 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'

/**
 * Factory for the seven `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}`
 * lifecycle wrappers. Each REST method takes the same shape — `{ taskId }` in,
 * `{ result: { task: {...} } }` out. Keeping the boilerplate in one place
 * means there's only one error-handling and response-projection contract to
 * review across all seven tools.
 *
 * Lives in its own file (not `tasks.ts`) so that the pure helpers
 * `extractTasks` / `toTaskShort` stay importable from unit tests without
 * dragging in Nitro / mcp-toolkit at evaluation time.
 */
/** The seven REST methods this factory is allowed to wrap. Listed explicitly
 *  (not as `tasks.task.${string}`) so a typo would fail typecheck. */
export type LifecycleMethod =
  | 'tasks.task.start'
  | 'tasks.task.pause'
  | 'tasks.task.complete'
  | 'tasks.task.approve'
  | 'tasks.task.disapprove'
  | 'tasks.task.defer'
  | 'tasks.task.renew'

export interface LifecycleToolSpec {
  /** MCP tool name, e.g. `bitrix24_start_task`. */
  name: string
  /** Bitrix24 REST method, e.g. `tasks.task.start`. */
  method: LifecycleMethod
  /** Infinitive verb used in error messages, e.g. `start`. */
  verb: string
  /** Past-tense verb used as the success payload's boolean key, e.g. `started`. */
  pastTense: string
  /** Human-readable tool description for the LLM. */
  description: string
  /** Per-tool taskId field description (operation-specific hints land here). */
  taskIdHint: string
}

/**
 * Universal usage notes appended to every lifecycle tool's description, so we
 * tell the LLM exactly once — across all seven tools — about three things
 * unit tests can't enforce:
 *
 *   1. Bulk: pass an array of ids to act on many tasks in one call. The
 *      Bitrix24 SDK's built-in `RestrictionManager` (leaky-bucket, default
 *      ~2 req/sec on standard tariffs, with adaptive delay on
 *      QUERY_LIMIT_EXCEEDED) paces the calls automatically. Default cap 25;
 *      set `force: true` to override (use sparingly — MCP clients may time
 *      out around 30 s).
 *
 *   2. Idempotency: if a task is already in the target status, Bitrix24
 *      returns "Действие над задачей не разрешено" / "action not allowed".
 *      In single-task mode this propagates as a Bitrix24ToolError; in batch
 *      mode that one entry lands in `results` with `ok: false`. NOT a real
 *      failure — surface it as already-applied rather than retrying.
 *
 *   3. Task lookup: if the operator names a task in free text instead of an
 *      id ("ту задачу про склад"), call `bitrix24_list_tasks` with a
 *      `%title` filter first (camelCase — `list_tasks` speaks the same
 *      v3-style contract as every other task tool).
 */
const LIFECYCLE_USAGE_NOTES =
  ' Accepts a single task id OR an array of ids (batch mode, up to 25 — pass `force: true` to override). Batch mode returns a `{ batch, total, ok, failed, results }` summary; per-id errors do not abort the batch. The Bitrix24 SDK paces outbound calls and retries transient errors automatically — no need to throttle on the agent side. If the task is already in the target status, Bitrix24 returns "action not allowed" — treat as already-applied, do not retry. If the operator names a task in free text instead of an id, resolve via `bitrix24_list_tasks` with a `%title` filter first.'

const DEFAULT_BATCH_CAP = 25

const taskIdSchema = z
  .union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)])

/** Result shape for a single task in a batch run. */
interface BatchEntryResult {
  taskId: number
  ok: boolean
  status?: string | null
  responsibleId?: string | null
  error?: string
}

export function defineTaskLifecycleTool(spec: LifecycleToolSpec) {
  return defineMcpTool({
    name: spec.name,
    description: spec.description + LIFECYCLE_USAGE_NOTES,
    inputSchema: {
      taskId: taskIdSchema.describe(
        spec.taskIdHint
          + ' Pass a number for single-task semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
      ),
      force: z
        .boolean()
        .optional()
        .describe(
          `Set true to allow batches larger than ${DEFAULT_BATCH_CAP}. Use sparingly — MCP clients may time out on long-running tool calls. Ignored for single-task input.`,
        ),
    },
    handler: async (input: { taskId: number | number[]; force?: boolean }) => {
      const { taskId, force } = input
      if (typeof taskId === 'number') {
        return runOne(spec, taskId)
      }
      return runBatch(spec, taskId, force ?? false)
    },
  })
}

async function runOne(spec: LifecycleToolSpec, taskId: number) {
  const b24 = useBitrix24()
  // Lifecycle methods always return a single `{ task: {...} }`. We use
  // `extractTasks` (which also handles list-shaped responses) and take
  // the first element so there's one shared parser across all task
  // tools — same code path as `update_task`.
  const result = await callV3<SingleTaskEnvelope>(
    b24,
    spec.method,
    { taskId },
    `Failed to ${spec.verb} Bitrix24 task ${taskId}`,
  )
  const [task] = extractTasks(result)

  if (!task) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} ${spec.pastTense}, but Bitrix24 returned no task body. Re-list to verify the status change.`,
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          [spec.pastTense]: true,
          id: task.id,
          title: task.title,
          status: task.status ?? null,
          responsibleId: task.responsibleId ?? null,
        }),
      },
    ],
  }
}

async function runBatch(spec: LifecycleToolSpec, taskIds: number[], force: boolean) {
  if (taskIds.length > DEFAULT_BATCH_CAP && !force) {
    throw new Bitrix24ToolError(
      `Batch of ${taskIds.length} exceeds the default cap of ${DEFAULT_BATCH_CAP}. Pass force=true to override, or split into multiple calls.`,
      'BATCH_TOO_LARGE',
    )
  }

  const b24 = useBitrix24()
  const rows = await batchV3<SingleTaskEnvelope>(
    b24,
    taskIds.map((id) => [spec.method, { taskId: id }]),
    `Failed to ${spec.verb} a batch of ${taskIds.length} task(s)`,
  )

  const results: BatchEntryResult[] = rows.map((row, index) => {
    const taskId = taskIds[index]
    if (taskId === undefined) {
      // Defensive: SDK contract guarantees rows.length === taskIds.length when
      // returnAjaxResult is true. If that ever drifts, fail loud rather than
      // silently producing an entry with `taskId: undefined`.
      throw new Bitrix24ToolError(
        `Batch row index ${index} has no corresponding taskId; SDK rows/input length mismatch.`,
      )
    }
    if (!row.isSuccess) {
      return {
        taskId,
        ok: false,
        error: row.getErrorMessages().join('; ') || `Failed to ${spec.verb} Bitrix24 task ${taskId}`,
      }
    }
    const [task] = extractTasks(row.getData()?.result)
    return {
      taskId,
      ok: true,
      status: task?.status ?? null,
      responsibleId: task?.responsibleId ?? null,
    }
  })

  const ok = results.filter((r) => r.ok).length
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          batch: true,
          verb: spec.pastTense,
          total: results.length,
          ok,
          failed: results.length - ok,
          results,
        }),
      },
    ],
  }
}
