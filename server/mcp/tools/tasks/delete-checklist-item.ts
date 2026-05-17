import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Delete an item from a Bitrix24 task checklist. If the item is a checklist
 * heading (`parentId: 0`), the whole checklist (including children) is
 * removed.
 *
 * Bitrix24 REST: task.checklistitem.delete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-delete.html
 */
export default defineChecklistActionTool({
  name: 'bitrix24_delete_checklist_item',
  method: 'task.checklistitem.delete',
  verb: 'delete',
  pastTense: 'deleted',
  description:
    'Delete an item from a Bitrix24 task checklist. If the item is a checklist heading (parentId: 0), the WHOLE checklist (heading + every child) is removed — confirm with the operator before deleting a heading. Destructive; there is no undo.',
})
