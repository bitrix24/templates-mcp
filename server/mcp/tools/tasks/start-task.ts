import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Move a Bitrix24 task into "In progress" status.
 *
 * Bitrix24 REST: tasks.task.start (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-start.html
 */
export default defineTaskLifecycleTool({
  name: 'b24_task_start',
  method: 'tasks.task.start',
  verb: 'start',
  pastTense: 'started',
  description:
    'Start work on a Bitrix24 task — moves it from Pending (2) to In progress (3). Call when the responsible user is "taking" the task to work on it. Only the responsible user (or someone with rights) can start a task. Counterpart: `b24_task_pause`.',
  taskIdHint: 'Task id to start. Get it from `b24_task_list` or `b24_task_create`.',
})
