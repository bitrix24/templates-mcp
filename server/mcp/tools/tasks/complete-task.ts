import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Mark a Bitrix24 task as completed.
 *
 * Bitrix24 REST: tasks.task.complete (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-complete.html
 *
 * If the task has `taskControl: Y` (creator review enabled), the resulting
 * status is 4 (Supposedly completed) and the creator still has to call
 * `b24_task_approve` or `b24_task_disapprove`. Otherwise the task
 * goes straight to 5 (Completed).
 */
export default defineTaskLifecycleTool({
  name: 'b24_task_complete',
  method: 'tasks.task.complete',
  verb: 'complete',
  pastTense: 'completed',
  description:
    'Mark a Bitrix24 task as completed. If task control is on (`taskControl: Y`), the status becomes Supposedly completed (4) and the creator still has to approve or disapprove. Otherwise it goes to Completed (5).',
  taskIdHint: 'Task id to mark as completed. Called by the responsible user.',
})
