import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { Bitrix24ErrorCode, Bitrix24ToolError } from '~/server/utils/errors'
import { callV2 } from '~/server/utils/sdk-helpers'

/**
 * Update an existing elapsed-time entry on a Bitrix24 task.
 *
 * Operators use this to correct miss-clicked durations or to back-fill a
 * comment they forgot. Author / responsible-user / admin scope: Bitrix24
 * server-side enforces — non-author edits surface as `ACCESS_DENIED` from
 * the REST layer. A pre-flight check (`user.current` + entry-author
 * comparison) is planned per issue #24 to give the agent an earlier,
 * typed `AUTHOR_ONLY` error instead of waiting for the wire round-trip.
 *
 * Bitrix24 REST: task.elapseditem.update (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/elapsed-item/task-elapsed-item-update.html
 *
 * REST shape: `{ TASKID, ITEMID, ARFIELDS: { SECONDS?, COMMENT_TEXT?, USER_ID? } }`.
 * Returns `null` on success — we echo back the operator-visible changes for
 * UX continuity (no follow-up read needed).
 */
export default defineMcpTool({
  name: 'b24_task_elapsed_time_update',
  description:
    'Update an existing elapsed-time entry on a Bitrix24 task — correct a miss-clicked duration, back-fill a comment, or change attribution. Provide at least one of `seconds` / `comment` / `userId`; omitted fields are left unchanged. Only the entry author (or someone with admin rights) can update. Use `b24_task_elapsed_time_list` to find the entry id first if the operator names it in free text ("исправь запись на 30 минут").',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id the entry belongs to. Get it from `b24_task_elapsed_time_list`.'),
    itemId: z.number().int().positive().describe('Elapsed-time entry id (from `b24_task_elapsed_time_list`).'),
    seconds: z
      .number()
      .int()
      .positive()
      .max(86400)
      .optional()
      .describe(
        'New duration in SECONDS. Convert operator vocabulary ("на 30 минут" → 1800). Capped at 86400 (24h) — same guardrail as `b24_task_elapsed_time_add`. Omit to leave unchanged.',
      ),
    comment: z
      .string()
      .max(4000)
      .optional()
      .describe(
        'New comment text. Pass an empty string to wipe the comment; omit to leave unchanged. Max 4000 chars. The schema distinguishes "" (explicit clear) from `undefined` (no-op) at the handler layer.',
      ),
    userId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Re-attribute the entry to another user — this REWRITES the recorded authorship of the entry, not just the assignee. Default: leave unchanged. Requires Bitrix24 MANAGER or PORTAL-ADMIN rights — plain task-edit permission is NOT enough. Use only when the operator explicitly requests re-attribution (e.g. "log this under Игорь, не под мной"). If the agent has only standard rights and supplies `userId`, Bitrix24 responds with ACCESS_DENIED.',
      ),
  },
  handler: async ({ taskId, itemId, seconds, comment, userId }) => {
    if (seconds === undefined && comment === undefined && userId === undefined) {
      // At least one field must change — Bitrix24 doesn't error on an
      // empty ARFIELDS, but the operator clearly intended _something_, so
      // surface the schema-level confusion early instead of a silent no-op.
      throw new Bitrix24ToolError(
        `Update on elapsed-time entry ${itemId} (task ${taskId}) has no changes — pass at least one of \`seconds\`, \`comment\`, \`userId\`.`,
        Bitrix24ErrorCode.NO_CHANGES,
      )
    }

    const arFields: Record<string, unknown> = {}
    if (seconds !== undefined) arFields.SECONDS = seconds
    // `comment === ''` is a deliberate clear; `comment === undefined` means
    // leave it alone. Don't collapse the two.
    if (comment !== undefined) arFields.COMMENT_TEXT = comment
    if (userId !== undefined) arFields.USER_ID = userId

    const b24 = useBitrix24Tenant()
    await callV2<null>(
      b24,
      'task.elapseditem.update',
      { TASKID: taskId, ITEMID: itemId, ARFIELDS: arFields },
      `Failed to update Bitrix24 elapsed-time entry ${itemId} on task ${taskId}`,
    )

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            updated: true,
            taskId,
            itemId,
            // Echo only the fields that actually changed — the agent has
            // ground truth about what it asked for, but mirroring keeps
            // the response self-describing for downstream tools.
            ...(seconds !== undefined ? { seconds } : {}),
            ...(comment !== undefined ? { comment } : {}),
            ...(userId !== undefined ? { userId } : {}),
          }),
        },
      ],
    }
  },
})
