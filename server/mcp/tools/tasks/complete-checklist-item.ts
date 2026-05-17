import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Mark a Bitrix24 task checklist item as completed.
 *
 * Bitrix24 REST: task.checklistitem.complete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-complete.html
 */
export default defineChecklistActionTool({
  name: 'bitrix24_complete_checklist_item',
  method: 'task.checklistitem.complete',
  verb: 'complete',
  pastTense: 'completed',
  description:
    'Mark a Bitrix24 task checklist item as completed (puts a check next to it in the UI). Use `bitrix24_renew_checklist_item` to uncheck it again. To complete the task itself, use `bitrix24_complete_task`.',
})
