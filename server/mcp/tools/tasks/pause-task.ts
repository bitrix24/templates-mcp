import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Pause an in-progress Bitrix24 task — sends it back to the pending queue.
 *
 * Bitrix24 REST: tasks.task.pause (v3)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-pause.html
 */
export default defineTaskLifecycleTool({
  name: 'bitrix24_pause_task',
  method: 'tasks.task.pause',
  verb: 'pause',
  pastTense: 'paused',
  description:
    'Pause an in-progress Bitrix24 task — moves it back from In progress (3) to Pending (2). Use when work is interrupted and the task is no longer actively worked on. Mirror of `bitrix24_start_task`.',
  taskIdHint: 'Task id to pause. The task must currently be In progress (status 3).',
})
