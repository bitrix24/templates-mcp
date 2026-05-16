import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Reject a "Supposedly completed" Bitrix24 task and send it back to the
 * responsible user. Only meaningful when task control is enabled on the task.
 *
 * Bitrix24 REST: tasks.task.disapprove (v3)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-disapprove.html
 */
export default defineTaskLifecycleTool({
  name: 'bitrix24_disapprove_task',
  method: 'tasks.task.disapprove',
  verb: 'disapprove',
  pastTense: 'disapproved',
  description:
    'Reject a Bitrix24 task that the responsible user reported as done — sends it back to Pending (2) for rework. Only the task creator (and only when task control is enabled) can call this. Counterpart: `bitrix24_approve_task`. To leave a reason, post a comment first via `bitrix24_add_task_comment`.',
  taskIdHint: 'Task id awaiting approval. Status must be 4 (Supposedly completed).',
})
