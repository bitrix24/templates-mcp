import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'
import { extractTasks } from '~/server/utils/tasks'

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
 *   1. Bulk: the tool operates on one task at a time. If the operator says
 *      "all my X tasks", the agent must enumerate via `bitrix24_list_tasks`
 *      first, then loop. Bitrix24 caps at ~2 req/sec, so the agent should
 *      not parallelise aggressively.
 *   2. Idempotency: if the task is already in the target status, Bitrix24
 *      returns "Действие над задачей не разрешено" / "action not allowed".
 *      This is NOT a real failure — verify current status via
 *      `bitrix24_list_tasks` before retrying or reporting to the operator.
 *   3. Task lookup: if the operator names a task in free text instead of an
 *      id ("ту задачу про склад"), the agent must call `bitrix24_list_tasks`
 *      with a `%TITLE` filter first to resolve the id.
 */
const LIFECYCLE_USAGE_NOTES =
  ' Operates on one task at a time — for "all my X tasks" call `bitrix24_list_tasks` first, then loop (Bitrix24 caps ~2 req/sec). If the task is already in the target status, Bitrix24 returns "action not allowed" — verify via `bitrix24_list_tasks` before retrying. If the operator names a task in free text instead of an id, resolve it via `bitrix24_list_tasks` with a `%TITLE` filter first.'

export function defineTaskLifecycleTool(spec: LifecycleToolSpec) {
  return defineMcpTool({
    name: spec.name,
    description: spec.description + LIFECYCLE_USAGE_NOTES,
    inputSchema: {
      taskId: z.number().int().positive().describe(spec.taskIdHint),
    },
    handler: async ({ taskId }: { taskId: number }) => {
      try {
        const b24 = useBitrix24()
        const response = await b24.callMethod(spec.method, { taskId })
        // Lifecycle methods always return a single `{ task: {...} }`. We use
        // `extractTasks` (which also handles list-shaped responses) and take
        // the first element so there's one shared parser across all task
        // tools — same code path as `update_task`.
        const [task] = extractTasks(response.getData()?.result)

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
              text: JSON.stringify(
                {
                  [spec.pastTense]: true,
                  id: task.id,
                  title: task.title,
                  status: task.status ?? null,
                  responsibleId: task.responsibleId ?? null,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        throw toToolError(err, `Failed to ${spec.verb} Bitrix24 task ${taskId}`)
      }
    },
  })
}
