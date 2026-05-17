import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Mark a Bitrix24 task checklist item as not completed (renew = remove the
 * check mark, the item becomes active again).
 *
 * Bitrix24 REST: task.checklistitem.renew (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-renew.html
 */
export default defineChecklistActionTool({
  name: 'bitrix24_renew_checklist_item',
  method: 'task.checklistitem.renew',
  verb: 'renew',
  pastTense: 'renewed',
  description:
    'Un-check a previously completed Bitrix24 task checklist item — marks it active again. The opposite of `bitrix24_complete_checklist_item`. Use when the operator says they finished it by mistake or the work needs to be redone.',
})
