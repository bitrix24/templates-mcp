import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Defer a Bitrix24 task — moves it to status 6 (Deferred), removing it from
 * active work queues without closing it.
 *
 * Bitrix24 REST: tasks.task.defer (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-defer.html
 */
export default defineTaskLifecycleTool({
  name: 'b24_task_defer',
  method: 'tasks.task.defer',
  verb: 'defer',
  pastTense: 'deferred',
  description:
    'Defer a Bitrix24 task — moves it to Deferred (6). Use when work is postponed indefinitely but the task should stay open. Re-activate with `b24_task_renew`.',
  taskIdHint: 'Task id to defer. Typically called on Pending (2) or In progress (3) tasks.',
})
