import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import {
  type ActionToolInput,
  defineActionTool,
  forceFlagSchema,
  idOrIdArraySchema,
  mapBatchRows,
} from '~/server/utils/define-action-tool'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'

/**
 * Factory for the seven `tasks.task.{start,pause,complete,approve,disapprove,defer,renew}`
 * lifecycle wrappers. Each REST method takes the same shape — `{ taskId }` in,
 * `{ result: { task: {...} } }` out.
 *
 * These are classic `tasks.task.*` methods, served on the v2 transport
 * (`callV2`/`batchV2`), NOT rest-v3 — see the transport convention in
 * `server/utils/sdk-helpers.ts`. Keeping the boilerplate in one place
 * means there's only one error-handling and response-projection contract to
 * review across all seven tools.
 *
 * Lives in its own file (not `tasks.ts`) so that the pure helpers
 * `extractTasks` / `toTaskShort` stay importable from unit tests without
 * dragging in Nitro / mcp-toolkit at evaluation time.
 *
 * Built atop `defineActionTool` — the single-vs-batch dispatch, batch-cap
 * check, and summary projection are shared across both action-tool
 * families (lifecycle + checklist) via that scaffold.
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
  /** MCP tool name, e.g. `b24_task_start`. */
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
 *      id ("ту задачу про склад"), call `b24_task_list` with a
 *      `%title` filter first (camelCase — `b24_task_list` accepts the same
 *      camelCase-friendly contract as every other task tool).
 */
const LIFECYCLE_USAGE_NOTES =
  ' Accepts a single task id OR an array of ids (batch mode, up to 25 — pass `force: true` to override). Batch mode returns a `{ batch, total, ok, failed, results }` summary; per-id errors do not abort the batch. The Bitrix24 SDK paces outbound calls and retries transient errors automatically — no need to throttle on the agent side. If the task is already in the target status, Bitrix24 returns "action not allowed" — treat as already-applied, do not retry. If the operator names a task in free text instead of an id, resolve via `b24_task_list` with a `%title` filter first.'

const DEFAULT_BATCH_CAP = 25

interface LifecycleInput extends ActionToolInput {
  taskId: number | number[]
}

interface LifecycleBatchRow {
  taskId: number
  ok: boolean
  status?: string | null
  responsibleId?: string | null
  error?: string
}

export function defineTaskLifecycleTool(spec: LifecycleToolSpec) {
  return defineActionTool<LifecycleInput, LifecycleBatchRow>({
    name: spec.name,
    description: spec.description,
    usageNotes: LIFECYCLE_USAGE_NOTES,
    pastTense: spec.pastTense,
    batchCap: DEFAULT_BATCH_CAP,
    inputSchema: {
      taskId: idOrIdArraySchema.describe(
        spec.taskIdHint
          + ' Pass a number for single-task semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
      ),
      force: forceFlagSchema(DEFAULT_BATCH_CAP),
    },
    extractIds: (input) => input.taskId,
    runOne: (_input, taskId) => runOne(spec, taskId),
    runBatch: (_input, ids) => runBatch(spec, ids),
  })
}

async function runOne(spec: LifecycleToolSpec, taskId: number) {
  const b24 = useBitrix24Tenant()
  // Lifecycle methods always return a single `{ task: {...} }`. We use
  // `extractTasks` (which also handles list-shaped responses) and take
  // the first element so there's one shared parser across all task
  // tools — same code path as `update_task`.
  const result = await callV2<SingleTaskEnvelope>(
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

async function runBatch(spec: LifecycleToolSpec, taskIds: number[]): Promise<LifecycleBatchRow[]> {
  const b24 = useBitrix24Tenant()
  const rows = await batchV2<SingleTaskEnvelope>(
    b24,
    taskIds.map((id) => [spec.method, { taskId: id }]),
    `Failed to ${spec.verb} a batch of ${taskIds.length} task(s)`,
  )

  return mapBatchRows(rows, taskIds, 'taskId', ({ id, ok, envelope, errorMessages }) => {
    if (!ok) {
      return {
        taskId: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to ${spec.verb} Bitrix24 task ${id}`,
      }
    }
    const [task] = extractTasks(envelope)
    return {
      taskId: id,
      ok: true,
      status: task?.status ?? null,
      responsibleId: task?.responsibleId ?? null,
    }
  })
}
