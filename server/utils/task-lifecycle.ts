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
export interface LifecycleToolSpec {
  /** MCP tool name, e.g. `bitrix24_start_task`. */
  name: string
  /** Bitrix24 REST method, e.g. `tasks.task.start`. */
  method: `tasks.task.${string}`
  /** Infinitive verb used in error messages, e.g. `start`. */
  verb: string
  /** Past-tense verb used as the success payload's boolean key, e.g. `started`. */
  pastTense: string
  /** Human-readable tool description for the LLM. */
  description: string
  /** Per-tool taskId field description (operation-specific hints land here). */
  taskIdHint: string
}

export function defineTaskLifecycleTool(spec: LifecycleToolSpec) {
  return defineMcpTool({
    name: spec.name,
    description: spec.description,
    inputSchema: {
      taskId: z.number().int().positive().describe(spec.taskIdHint),
    },
    handler: async ({ taskId }: { taskId: number }) => {
      try {
        const b24 = useBitrix24()
        const response = await b24.callMethod(spec.method, { taskId })
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
