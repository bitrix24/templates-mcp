import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { Bitrix24ErrorCode, Bitrix24ToolError } from '~/server/utils/errors'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Set or clear the rating (`MARK` field) on a Bitrix24 task.
 *
 * Bitrix24 REST: tasks.task.update (classic / v2 transport) — there is no
 * dedicated rate method, so the rating is just a field write on `MARK`. This
 * is the classic `tasks.task.*` API, served on v2 (`callV2`), NOT rest-v3 —
 * the v3 `TaskDto` rejects the UPPERCASE `MARK` key.
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html
 *
 * Field semantics from `tasks.task.getFields`:
 *   MARK: enum — "P" (positive) | "N" (negative) | null (no rating, default)
 *
 * The agent-friendly enum `positive | negative | none` is mapped to the
 * underlying P / N / null at the boundary so the LLM never has to know about
 * single-letter codes.
 *
 * Batch mode mirrors the lifecycle factory (#7): pass an array of ids to
 * rate many tasks in one call via the `batchV2` helper from `sdk-helpers.ts`,
 * which sends the whole batch as one HTTP request rather than N.
 */
const RATING_TO_MARK = {
  positive: 'P',
  negative: 'N',
  none: null,
} as const

type Rating = keyof typeof RATING_TO_MARK
type Mark = (typeof RATING_TO_MARK)[Rating]

const DEFAULT_BATCH_CAP = 25

interface BatchEntryResult {
  taskId: number
  ok: boolean
  error?: string
}

export default defineMcpTool({
  name: 'b24_task_rate',
  description:
    'Set or clear the rating on a Bitrix24 task — `positive` (👍, MARK=P), `negative` (👎, MARK=N), or `none` to remove an existing rating. Typically set by the task creator after the task is completed (status 5). Accepts a single task id OR an array of ids (batch mode, up to 25 — pass `force: true` to override). Batch mode returns a `{ batch, total, ok, failed, results }` summary; per-id errors do not abort the batch. The Bitrix24 SDK paces outbound calls automatically. If the operator names a task in free text instead of an id, resolve via `b24_task_list` with a `%title` filter first.',
  inputSchema: {
    taskId: z
      .union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)])
      .describe(
        'Task id to rate, or an array of task ids for batch mode. Pass a number for single-task semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
      ),
    rating: z
      .enum(['positive', 'negative', 'none'])
      .describe(
        'New rating. `positive` = thumbs-up (Bitrix24 MARK=P), `negative` = thumbs-down (MARK=N), `none` clears the rating back to unset (MARK=null). Same rating applies to every id in batch mode.',
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        `Set true to allow batches larger than ${DEFAULT_BATCH_CAP}. Use sparingly — MCP clients may time out on long-running tool calls. Ignored for single-task input.`,
      ),
  },
  handler: async (input: { taskId: number | number[]; rating: Rating; force?: boolean }) => {
    const { taskId, rating, force } = input
    const mark = RATING_TO_MARK[rating]
    if (typeof taskId === 'number') {
      return runOne(taskId, rating, mark)
    }
    return runBatch(taskId, rating, mark, force ?? false)
  },
})

async function runOne(taskId: number, rating: Rating, mark: Mark) {
  const b24 = useBitrix24()
  const result = await callV2<SingleTaskEnvelope>(
    b24,
    'tasks.task.update',
    { taskId, fields: { MARK: mark } },
    `Failed to rate Bitrix24 task ${taskId}`,
  )
  const [task] = extractTasks(result)

  if (!task) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} rating set to ${rating}, but Bitrix24 returned no task body. Re-list to verify.`,
        },
      ],
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          rated: true,
          id: task.id,
          title: task.title,
          rating,
          mark,
        }),
      },
    ],
  }
}

async function runBatch(taskIds: number[], rating: Rating, mark: Mark, force: boolean) {
  if (taskIds.length > DEFAULT_BATCH_CAP && !force) {
    throw new Bitrix24ToolError(
      `Batch of ${taskIds.length} exceeds the default cap of ${DEFAULT_BATCH_CAP}. Pass force=true to override, or split into multiple calls.`,
      Bitrix24ErrorCode.BATCH_TOO_LARGE,
    )
  }

  const b24 = useBitrix24()
  const rows = await batchV2<SingleTaskEnvelope>(
    b24,
    taskIds.map((id) => ['tasks.task.update', { taskId: id, fields: { MARK: mark } }]),
    `Failed to rate ${taskIds.length} Bitrix24 task(s)`,
  )

  const results: BatchEntryResult[] = rows.map((row, index) => {
    const taskId = taskIds[index]
    if (taskId === undefined) {
      throw new Bitrix24ToolError(
        `Batch row index ${index} has no corresponding taskId; SDK rows/input length mismatch.`,
      )
    }
    if (!row.isSuccess) {
      return {
        taskId,
        ok: false,
        error: row.getErrorMessages().join('; ') || `Failed to rate Bitrix24 task ${taskId}`,
      }
    }
    return { taskId, ok: true }
  })

  const ok = results.filter((r) => r.ok).length
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          batch: true,
          rating,
          mark,
          total: results.length,
          ok,
          failed: results.length - ok,
          results,
        }),
      },
    ],
  }
}
