import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

/**
 * Log a manual elapsed-time entry on a Bitrix24 task.
 *
 * Operators record how long a piece of work took, separately from the
 * stopwatch (which Bitrix24 manages automatically when a task transitions
 * through "in progress" / "paused"). A typical entry is "договор: 45
 * минут" — they're posted after the fact, often in bulk at end of day.
 *
 * Bitrix24 REST: task.elapseditem.add (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/elapsed-item/task-elapsed-item-add.html
 *
 * The REST contract is `{ TASKID, ARFIELDS: { SECONDS, COMMENT_TEXT, USER_ID? } }`
 * and returns just the new entry's id (integer) — no body. We echo back the
 * inputs alongside the id so the agent doesn't need a follow-up call to
 * confirm what landed.
 */
export default defineMcpTool({
  name: 'b24_task_elapsed_time_add',
  description:
    'Log a manual elapsed-time entry on a Bitrix24 task. Operators use these to record after-the-fact "how long did this take" — separate from the Bitrix24 stopwatch which fires automatically during in-progress / paused transitions. `seconds` is capped at 86400 (24h) — split multi-day work into separate entries per day. Returns the new entry id. To read existing entries on a task, use `b24_task_elapsed_time_list`. To correct or remove an entry, use `b24_task_elapsed_time_update` / `b24_task_elapsed_time_delete`.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to attach the entry to. Get it from `b24_task_list` or `b24_task_create`.'),
    seconds: z
      .number()
      .int()
      .positive()
      .max(86400)
      .describe(
        'Duration of the work in SECONDS. Convert operator vocabulary at this layer — "30 минут" → 1800, "1 час" → 3600, "1ч 30мин" → 5400, "1 рабочий день" → 28800 (8h). Capped at 86400 (24h) to catch obvious unit confusion (someone passing minutes when the field expects seconds); split multi-day work into separate entries per day.',
      ),
    comment: z
      .string()
      .max(4000)
      .optional()
      .describe(
        'What the time was spent on. Optional but recommended — without it, the operator and the LLM see only "45 минут on task 7" with no context. Max 4000 chars. BBCode is rendered the same as in task descriptions.',
      ),
    userId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Log the entry on behalf of another user. Default: the user owning the webhook (i.e. "you"). Use this when a team lead is recording time worked by a direct report. Requires Bitrix24 MANAGER or PORTAL-ADMIN rights for the acting webhook user — plain task-edit permission is NOT enough. If the agent has only standard rights and supplies `userId`, Bitrix24 responds with ACCESS_DENIED.',
      ),
  },
  handler: async ({ taskId, seconds, comment, userId }) => {
    const b24 = useBitrix24()
    // task.elapseditem.add returns the new id as a bare integer in `result`.
    // No envelope, no body — Bitrix24 v2 contract for write-only methods.
    const result = await callV2<number | string>(
      b24,
      'task.elapseditem.add',
      {
        TASKID: taskId,
        ARFIELDS: {
          SECONDS: seconds,
          // Bitrix24 accepts empty string for "no comment"; the optional
          // schema field arrives as undefined, normalise to '' for the wire.
          COMMENT_TEXT: comment ?? '',
          ...(userId !== undefined ? { USER_ID: userId } : {}),
        },
      },
      `Failed to log elapsed-time entry on Bitrix24 task ${taskId}`,
    )

    const id = typeof result === 'string' ? Number.parseInt(result, 10) : result
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      // Bitrix24 acked but the body shape drifted. Surface a soft failure
      // rather than a hard throw — the entry probably landed, the agent
      // just can't tell us its id. Re-list will find it.
      return {
        content: [
          {
            type: 'text' as const,
            text: `Elapsed-time entry posted on task ${taskId}, but Bitrix24 returned an unexpected body shape. Re-list with b24_task_elapsed_time_list to find the new id.`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            added: true,
            id,
            taskId,
            seconds,
            // Echo back the operator-visible inputs so the agent has the
            // full picture without a follow-up get/list call. `userId` is
            // included only when overridden — omitting it for the default
            // case mirrors the wire (Bitrix24 doesn't echo USER_ID when
            // it falls back to the webhook user).
            comment: comment ?? '',
            ...(userId !== undefined ? { userId } : {}),
          }),
        },
      ],
    }
  },
})
