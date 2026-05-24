import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Mark a Bitrix24 task checklist item as completed.
 *
 * Bitrix24 REST: task.checklistitem.complete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-complete.html
 */
export default defineChecklistActionTool({
  name: 'b24_task_checklist_item_complete',
  method: 'task.checklistitem.complete',
  verb: 'complete',
  pastTense: 'completed',
  description:
    'Mark a Bitrix24 task checklist item as completed (puts a check next to it in the UI). Use `b24_task_checklist_item_renew` to uncheck it again. To complete the task itself, use `b24_task_complete`.',
})
