import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Delete an item from a Bitrix24 task checklist. Destructive; no undo.
 *
 * Bitrix24 REST: task.checklistitem.delete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-delete.html
 *
 * The factory adds a `confirmDeleteHeading: boolean` field for this tool
 * only; deletions targeting a checklist heading are refused with
 * `HEADING_DELETE_NEEDS_CONFIRM` until the agent re-calls with confirmation.
 * See `server/utils/checklist.ts` (`assertNotHeading` / `assertBatchNoHeadings`).
 */
export default defineChecklistActionTool({
  name: 'bitrix24_delete_checklist_item',
  method: 'task.checklistitem.delete',
  verb: 'delete',
  pastTense: 'deleted',
  description:
    'Delete one item from a Bitrix24 task checklist. Destructive — there is no undo. Deleting a checklist HEADING (the item that names the whole checklist) wipes every child item with it; the tool refuses such requests with HEADING_DELETE_NEEDS_CONFIRM unless you also pass `confirmDeleteHeading: true` after the operator has agreed. Regular item deletions need no confirmation.',
})
