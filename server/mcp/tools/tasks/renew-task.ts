import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Renew a Bitrix24 task — reopens a completed or deferred task by moving it
 * back to Pending (2).
 *
 * Bitrix24 REST: tasks.task.renew (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-renew.html
 */
export default defineTaskLifecycleTool({
  name: 'b24_task_renew',
  method: 'tasks.task.renew',
  verb: 'renew',
  pastTense: 'renewed',
  description:
    'Renew a Bitrix24 task — reopens a Completed (5) or Deferred (6) task by moving it back to Pending (2). Use when work needs to resume on a task that was previously closed.',
  taskIdHint: 'Task id to reopen. Typically called on Completed (5) or Deferred (6) tasks.',
})
