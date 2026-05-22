import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Approve a "Supposedly completed" Bitrix24 task — only meaningful when task
 * control is enabled on the task.
 *
 * Bitrix24 REST: tasks.task.approve (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-approve.html
 */
export default defineTaskLifecycleTool({
  name: 'bitrix24_approve_task',
  method: 'tasks.task.approve',
  verb: 'approve',
  pastTense: 'approved',
  description:
    'Approve the responsible user\'s work on a Bitrix24 task — moves it from Supposedly completed (4) to Completed (5). Only the task creator (and only when task control is enabled on the task) can call this. Counterpart: `bitrix24_disapprove_task`.',
  taskIdHint: 'Task id awaiting approval. Status must be 4 (Supposedly completed).',
})
