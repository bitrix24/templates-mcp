import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { confirmDeleteSchema } from '~/server/utils/define-action-tool'
import { Bitrix24ToolError } from '~/server/utils/errors'
import { callV3 } from '~/server/utils/sdk-helpers'

/**
 * Delete a Bitrix24 task result.
 *
 * Bitrix24 REST: tasks.task.result.delete (v3)
 *   https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-delete.html
 *
 * Only the author of the result (or a portal admin) can delete it.
 * Destructive — there is no undo. The task itself is untouched; only the
 * result entry disappears.
 *
 * SKILL.md Rule #9: requires `confirmDelete: true` from the agent. The
 * standalone handler (no factory dispatch) checks the flag inline and
 * throws `Bitrix24ToolError` code `DELETE_NEEDS_CONFIRM` if absent or
 * `false`. The shared `confirmDeleteSchema()` keeps the LLM-facing
 * wording uniform across delete tools.
 */
export default defineMcpTool({
  name: 'bitrix24_delete_task_result',
  description:
    'Delete a Bitrix24 task result. Destructive — there is no undo, but the task itself is not affected. **Requires `confirmDelete: true`** (SKILL.md Rule #9, universal) after the operator has explicitly agreed to the deletion. Only the result author (or a portal admin) is allowed to delete it; other callers get ACCESSDENIEDEXCEPTION from Bitrix24. The resultId comes from `bitrix24_list_task_results`.',
  inputSchema: {
    resultId: z
      .number()
      .int()
      .positive()
      .describe('Result id (NOT the parent taskId). Get from `bitrix24_list_task_results`.'),
    confirmDelete: confirmDeleteSchema(),
  },
  handler: async ({ resultId, confirmDelete }) => {
    if (!confirmDelete) {
      throw new Bitrix24ToolError(
        `Refusing to delete task result ${resultId} without confirmation. Re-call \`bitrix24_delete_task_result\` with \`confirmDelete: true\` only after the operator has explicitly agreed to the deletion (SKILL.md Ground Rule #9).`,
        'DELETE_NEEDS_CONFIRM',
      )
    }
    const b24 = useBitrix24()
    // The endpoint's success envelope is `{ result: true }` — we don't need
    // the body, only that `callV3` didn't throw.
    await callV3<{ result?: boolean }>(
      b24,
      'tasks.task.result.delete',
      { id: resultId },
      `Failed to delete Bitrix24 task result ${resultId}`,
    )

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ deleted: true, resultId }),
        },
      ],
    }
  },
})
