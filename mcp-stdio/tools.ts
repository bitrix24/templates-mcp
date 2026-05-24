/**
 * Hand-maintained registry of every MCP tool. Imported by `server.ts` after
 * the Nuxt shims are installed; each default export is a tool definition
 * built via `defineMcpTool` (which is a no-op passthrough — see
 * `node_modules/@nuxtjs/mcp-toolkit/dist/runtime/server/mcp/definitions/tools.js`).
 *
 * Adding a new tool: add it under `server/mcp/tools/**` for the HTTP server
 * (auto-discovery) AND append it here for the stdio bundle. The two
 * registries are checked against each other by
 * `tests/unit/mcp-stdio/tools.parity.test.ts` — CI will fail if either
 * registry drifts.
 *
 * Note on the local import aliases (`tasks_listTasks`, etc.): they are
 * **local JS identifiers**, NOT tool names. The runtime tool name is
 * declared inside each module's `defineMcpTool({ name: 'b24_...' })` call;
 * these camelCase aliases predate the issue #129 rename and are kept
 * verbatim so the file's diff history stays focused on the actual rename
 * (tool-name strings + their imports). Renaming the aliases is a pure-
 * cosmetic refactor for a separate PR.
 */
import users_currentUser from '~/server/mcp/tools/users/current-user'
import users_findUser from '~/server/mcp/tools/users/find-user'

import tasks_createTask from '~/server/mcp/tools/tasks/create-task'
import tasks_listTasks from '~/server/mcp/tools/tasks/list-tasks'
import tasks_updateTask from '~/server/mcp/tools/tasks/update-task'
import tasks_addTaskComment from '~/server/mcp/tools/tasks/add-task-comment'
import tasks_startTask from '~/server/mcp/tools/tasks/start-task'
import tasks_pauseTask from '~/server/mcp/tools/tasks/pause-task'
import tasks_completeTask from '~/server/mcp/tools/tasks/complete-task'
import tasks_approveTask from '~/server/mcp/tools/tasks/approve-task'
import tasks_disapproveTask from '~/server/mcp/tools/tasks/disapprove-task'
import tasks_deferTask from '~/server/mcp/tools/tasks/defer-task'
import tasks_renewTask from '~/server/mcp/tools/tasks/renew-task'
import tasks_rateTask from '~/server/mcp/tools/tasks/rate-task'
import tasks_addChecklistItem from '~/server/mcp/tools/tasks/add-checklist-item'
import tasks_listChecklistItems from '~/server/mcp/tools/tasks/list-checklist-items'
import tasks_completeChecklistItem from '~/server/mcp/tools/tasks/complete-checklist-item'
import tasks_renewChecklistItem from '~/server/mcp/tools/tasks/renew-checklist-item'
import tasks_deleteChecklistItem from '~/server/mcp/tools/tasks/delete-checklist-item'
import tasks_addTaskResult from '~/server/mcp/tools/tasks/add-task-result'
import tasks_listTaskResults from '~/server/mcp/tools/tasks/list-task-results'
import tasks_updateTaskResult from '~/server/mcp/tools/tasks/update-task-result'
import tasks_deleteTaskResult from '~/server/mcp/tools/tasks/delete-task-result'
import tasks_addElapsedTime from '~/server/mcp/tools/tasks/add-elapsed-time'
import tasks_listElapsedTime from '~/server/mcp/tools/tasks/list-elapsed-time'
import tasks_updateElapsedTime from '~/server/mcp/tools/tasks/update-elapsed-time'
import tasks_deleteElapsedTime from '~/server/mcp/tools/tasks/delete-elapsed-time'
import tasks_addTaskDependency from '~/server/mcp/tools/tasks/add-task-dependency'
import tasks_removeTaskDependency from '~/server/mcp/tools/tasks/remove-task-dependency'

import meta_submitFeedback from '~/server/mcp/tools/meta/submit-feedback'

export const tools = [
  users_currentUser,
  users_findUser,
  tasks_createTask,
  tasks_listTasks,
  tasks_updateTask,
  tasks_addTaskComment,
  tasks_startTask,
  tasks_pauseTask,
  tasks_completeTask,
  tasks_approveTask,
  tasks_disapproveTask,
  tasks_deferTask,
  tasks_renewTask,
  tasks_rateTask,
  tasks_addChecklistItem,
  tasks_listChecklistItems,
  tasks_completeChecklistItem,
  tasks_renewChecklistItem,
  tasks_deleteChecklistItem,
  tasks_addTaskResult,
  tasks_listTaskResults,
  tasks_updateTaskResult,
  tasks_deleteTaskResult,
  tasks_addElapsedTime,
  tasks_listElapsedTime,
  tasks_updateElapsedTime,
  tasks_deleteElapsedTime,
  tasks_addTaskDependency,
  tasks_removeTaskDependency,
  meta_submitFeedback,
] as const
