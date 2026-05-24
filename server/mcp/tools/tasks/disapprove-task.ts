import { defineTaskLifecycleTool } from '~/server/utils/task-lifecycle'

/**
 * Reject a "Supposedly completed" Bitrix24 task and send it back to the
 * responsible user. Only meaningful when task control is enabled on the task.
 *
 * Bitrix24 REST: tasks.task.disapprove (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-disapprove.html
 */
export default defineTaskLifecycleTool({
  name: 'b24_task_disapprove',
  method: 'tasks.task.disapprove',
  verb: 'disapprove',
  pastTense: 'disapproved',
  description:
    'Reject a Bitrix24 task that the responsible user reported as done — returns it to the responsible user\'s Pending queue (status 2) for rework. NOT a "Rejected" state — Bitrix24 models "send back for rework" as a return to Pending. Only the task creator (and only when task control is enabled) can call this. Counterpart: `b24_task_approve`. **Post the rejection comment FIRST via `b24_task_comment_add`, then call this** — the comment must be visible at the moment of rejection.',
  taskIdHint: 'Task id awaiting approval. Status must be 4 (Supposedly completed).',
})
