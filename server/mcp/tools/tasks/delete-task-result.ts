import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { assertConfirmedDelete, confirmDeleteSchema } from '~/server/utils/define-action-tool'
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
 * SKILL.md Rule #9: requires `confirmDelete: true` from the agent.
 * Standalone handler (no factory dispatch), so it calls the shared
 * `assertConfirmedDelete` gate directly. Refuses with `Bitrix24ToolError`
 * code `DELETE_NEEDS_CONFIRM` if the flag is absent or `false`. Both the
 * shared schema (`confirmDeleteSchema()`) and the shared gate live at
 * `server/utils/define-action-tool.ts` so wording stays uniform across
 * every `*_delete` / `*_remove` tool.
 */
export default defineMcpTool({
  name: 'b24_task_result_delete',
  description:
    'Delete a Bitrix24 task result. Destructive — there is no undo, but the task itself is not affected. **Requires `confirmDelete: true`** (SKILL.md Rule #9, universal) after the operator has explicitly agreed to the deletion. Only the result author (or a portal admin) is allowed to delete it; other callers get ACCESSDENIEDEXCEPTION from Bitrix24. The resultId comes from `b24_task_result_list`.',
  inputSchema: {
    resultId: z
      .number()
      .int()
      .positive()
      .describe('Result id (NOT the parent taskId). Get from `b24_task_result_list`.'),
    confirmDelete: confirmDeleteSchema(),
  },
  handler: async ({ resultId, confirmDelete }) => {
    assertConfirmedDelete('b24_task_result_delete', `task result ${resultId}`, confirmDelete)
    const b24 = useBitrix24Tenant()
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
