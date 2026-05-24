/**
 * Tool-selection eval — does DeepSeek pick the right MCP tool for a given
 * natural-language prompt?
 *
 * The cases below are a curated subset of `docs/MANUAL-TEST-PHRASES.md`:
 * unambiguous prompts where the FIRST tool call should be one specific tool.
 * Each pass through the eval bills DeepSeek for ~80 small chat-completion
 * calls — one per case (≈ $0.01 total at current pricing).
 *
 * Skip behaviour: if `DEEPSEEK_API_KEY` is not set, this file logs a notice
 * and exits cleanly — useful so CI can run the eval suite only when the key
 * is configured.
 *
 * To run locally:
 *   export DEEPSEEK_API_KEY=sk-...
 *   pnpm test:evals
 *
 * To add new cases: edit `CASES` below. Keep them unambiguous — if a human
 * reviewer disagrees about which tool should be called first, the case isn't
 * a good eval signal.
 */

import { evalite } from 'evalite'
import { generateText, tool as aiTool, type ToolSet } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { vi } from 'vitest'

// Make the MCP tool default exports importable without bootstrapping Nuxt.
// We only read `name` / `description` / `inputSchema` off each definition —
// the handler is never invoked because the AI SDK `tool()` we register below
// omits `execute`, so `generateText` returns toolCalls without running them.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))
vi.mock('~/server/utils/bitrix24', () => {
  // Tools are registered in this eval with `execute` omitted, so handlers are
  // never invoked — Evalite only measures tool-selection. The mock still needs
  // to expose the actions tree (matching the SDK surface) so static imports
  // line up if anything is ever inspected at module load time.
  const noop = async () => ({
    isSuccess: true,
    getData: () => ({ result: {} }),
    getErrorMessages: () => [],
  })
  return {
    useBitrix24: () => ({
      actions: {
        v3: { call: { make: noop }, batch: { make: noop } },
        v2: { call: { make: noop } },
      },
    }),
  }
})
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({ debug: () => {}, info: () => {}, warning: () => {}, error: () => {} }),
}))
vi.mock('~/server/utils/github-feedback', () => ({
  createGithubIssue: async () => ({ url: '', number: 0 }),
  consumeFeedbackQuota: () => ({ ok: true, remaining: 5, resetInSeconds: 3600 }),
  sanitizeDetails: (s: string) => s,
  sanitizeToolName: (s: string) => s,
  stripHostileChars: (s: string) => s,
  formatIssueBody: () => '',
  GithubFeedbackError: class extends Error {},
}))
vi.stubGlobal('useRuntimeConfig', () => ({
  bitrix24WebhookUrl: '',
  mcpAuthToken: '',
  githubFeedbackToken: '',
  githubFeedbackRepo: 'bitrix24/templates-mcp',
}))

// eslint-disable-next-line import/first
import currentUser from '~/server/mcp/tools/users/current-user'
// eslint-disable-next-line import/first
import findUser from '~/server/mcp/tools/users/find-user'
// eslint-disable-next-line import/first
import createTask from '~/server/mcp/tools/tasks/create-task'
// eslint-disable-next-line import/first
import listTasks from '~/server/mcp/tools/tasks/list-tasks'
// eslint-disable-next-line import/first
import updateTask from '~/server/mcp/tools/tasks/update-task'
// eslint-disable-next-line import/first
import addTaskComment from '~/server/mcp/tools/tasks/add-task-comment'
// eslint-disable-next-line import/first
import startTask from '~/server/mcp/tools/tasks/start-task'
// eslint-disable-next-line import/first
import pauseTask from '~/server/mcp/tools/tasks/pause-task'
// eslint-disable-next-line import/first
import completeTask from '~/server/mcp/tools/tasks/complete-task'
// eslint-disable-next-line import/first
import approveTask from '~/server/mcp/tools/tasks/approve-task'
// eslint-disable-next-line import/first
import disapproveTask from '~/server/mcp/tools/tasks/disapprove-task'
// eslint-disable-next-line import/first
import deferTask from '~/server/mcp/tools/tasks/defer-task'
// eslint-disable-next-line import/first
import renewTask from '~/server/mcp/tools/tasks/renew-task'
// eslint-disable-next-line import/first
import rateTask from '~/server/mcp/tools/tasks/rate-task'
// eslint-disable-next-line import/first
import addChecklistItem from '~/server/mcp/tools/tasks/add-checklist-item'
// eslint-disable-next-line import/first
import listChecklistItems from '~/server/mcp/tools/tasks/list-checklist-items'
// eslint-disable-next-line import/first
import completeChecklistItem from '~/server/mcp/tools/tasks/complete-checklist-item'
// eslint-disable-next-line import/first
import renewChecklistItem from '~/server/mcp/tools/tasks/renew-checklist-item'
// eslint-disable-next-line import/first
import deleteChecklistItem from '~/server/mcp/tools/tasks/delete-checklist-item'
// eslint-disable-next-line import/first
import addTaskResult from '~/server/mcp/tools/tasks/add-task-result'
// eslint-disable-next-line import/first
import listTaskResults from '~/server/mcp/tools/tasks/list-task-results'
// eslint-disable-next-line import/first
import updateTaskResult from '~/server/mcp/tools/tasks/update-task-result'
// eslint-disable-next-line import/first
import deleteTaskResult from '~/server/mcp/tools/tasks/delete-task-result'
// eslint-disable-next-line import/first
import addElapsedTime from '~/server/mcp/tools/tasks/add-elapsed-time'
// eslint-disable-next-line import/first
import listElapsedTime from '~/server/mcp/tools/tasks/list-elapsed-time'
// eslint-disable-next-line import/first
import updateElapsedTime from '~/server/mcp/tools/tasks/update-elapsed-time'
// eslint-disable-next-line import/first
import deleteElapsedTime from '~/server/mcp/tools/tasks/delete-elapsed-time'
// eslint-disable-next-line import/first
import addTaskDependency from '~/server/mcp/tools/tasks/add-task-dependency'
// eslint-disable-next-line import/first
import removeTaskDependency from '~/server/mcp/tools/tasks/remove-task-dependency'
// eslint-disable-next-line import/first
import submitFeedback from '~/server/mcp/tools/meta/submit-feedback'

interface McpToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
}

const ALL_TOOLS: McpToolDef[] = [
  currentUser as unknown as McpToolDef,
  findUser as unknown as McpToolDef,
  createTask as unknown as McpToolDef,
  listTasks as unknown as McpToolDef,
  updateTask as unknown as McpToolDef,
  addTaskComment as unknown as McpToolDef,
  startTask as unknown as McpToolDef,
  pauseTask as unknown as McpToolDef,
  completeTask as unknown as McpToolDef,
  approveTask as unknown as McpToolDef,
  disapproveTask as unknown as McpToolDef,
  deferTask as unknown as McpToolDef,
  renewTask as unknown as McpToolDef,
  rateTask as unknown as McpToolDef,
  addChecklistItem as unknown as McpToolDef,
  listChecklistItems as unknown as McpToolDef,
  completeChecklistItem as unknown as McpToolDef,
  renewChecklistItem as unknown as McpToolDef,
  deleteChecklistItem as unknown as McpToolDef,
  addTaskResult as unknown as McpToolDef,
  listTaskResults as unknown as McpToolDef,
  updateTaskResult as unknown as McpToolDef,
  deleteTaskResult as unknown as McpToolDef,
  addElapsedTime as unknown as McpToolDef,
  listElapsedTime as unknown as McpToolDef,
  updateElapsedTime as unknown as McpToolDef,
  deleteElapsedTime as unknown as McpToolDef,
  addTaskDependency as unknown as McpToolDef,
  removeTaskDependency as unknown as McpToolDef,
  submitFeedback as unknown as McpToolDef,
]

const aiSdkTools = Object.fromEntries(
  ALL_TOOLS.map((t) => [
    t.name,
    aiTool({
      description: t.description,
      inputSchema: z.object(t.inputSchema),
      // `execute` deliberately omitted — generateText returns toolCalls
      // without executing them, which is what we want for selection-only
      // measurement.
    }),
  ]),
) as ToolSet

// @ai-sdk/openai v3 defaults the callable provider to the Responses API
// (`/responses` endpoint), which DeepSeek does not support. Use `.chat()`
// explicitly to force the Chat Completions path (`/chat/completions`).
const deepseekProvider = createOpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  // The eval skips when DEEPSEEK_API_KEY is unset (see runner switch below),
  // so an empty key here is fine — generateText is never reached.
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
})
const deepseek = (modelId: string) => deepseekProvider.chat(modelId)

interface Case {
  input: string
  expected: string
  notes?: string
}

const CASES: Case[] = [
  // ── find_user (resolve names → ids) ────────────────────────────────────
  {
    input: 'Кто такой Игорь?',
    expected: 'b24_user_find',
    notes: 'Bare first name — straight to find_user.',
  },
  {
    input: 'Найди мне Игоря Сергеевича Шевченко.',
    expected: 'b24_user_find',
    notes: 'Full Russian name with patronymic — should hit find_user via free-text query.',
  },
  {
    input: 'Покажи бэкенд-разработчиков.',
    expected: 'b24_user_find',
    notes: 'Position-based lookup.',
  },
  {
    input: 'Find all the project managers on our portal.',
    expected: 'b24_user_find',
    notes: 'English position-based lookup.',
  },

  // ── current_user (operator refers to themselves) ───────────────────────
  {
    input: 'Кто я?',
    expected: 'b24_user_me',
    notes: 'Self-reference — connectivity / identity check.',
  },
  {
    input: 'What is my Bitrix24 user id?',
    expected: 'b24_user_me',
    notes: 'Self-id English variant.',
  },

  // ── list_tasks (filtering without name resolution) ─────────────────────
  {
    input: 'Покажи все задачи группы 7.',
    expected: 'b24_task_list',
    notes: 'Group filter, no person.',
  },
  {
    input: 'Найди задачи со словом «договор» в названии.',
    expected: 'b24_task_list',
    notes: 'LIKE-search on title.',
  },
  {
    input: 'Сколько у нас всего задач на портале?',
    expected: 'b24_task_list',
    notes: 'Count via list with select=[ID] — reads `total`.',
  },
  {
    input: 'Show me overdue tasks across the company.',
    expected: 'b24_task_list',
    notes: 'Overdue filter, no specific person.',
  },

  // ── create_task with explicit numeric id (no name to resolve) ──────────
  {
    input: 'Create a task "Approve contract" for user 12, deadline Friday 18:00.',
    expected: 'b24_task_create',
    notes: 'Numeric responsibleId given — find_user not needed.',
  },
  {
    input: 'Заведи задачу пользователю с id 5: проверить логи прода.',
    expected: 'b24_task_create',
    notes: 'Russian phrasing with explicit numeric id.',
  },

  // ── create_task → expects find_user FIRST when a name is given ─────────
  {
    input: 'Создай задачу «Согласовать договор» для Игоря, дедлайн пятница.',
    expected: 'b24_user_find',
    notes: 'Must resolve "Игоря" before creating — first call should be find_user.',
  },
  {
    input: 'Поручи Маше Петровой позвонить клиенту до завтра.',
    expected: 'b24_user_find',
    notes: '"Поручи" = "assign a task"; name first → find_user.',
  },

  // ── update_task ────────────────────────────────────────────────────────
  {
    input: 'Перенеси дедлайн задачи 123 на понедельник.',
    expected: 'b24_task_update',
    notes: 'Direct field update — taskId is given.',
  },
  {
    input: 'Снизь приоритет задачи 456 до низкого.',
    expected: 'b24_task_update',
    notes: 'Priority change.',
  },

  // ── add_task_comment vs submit_feedback (must not confuse the two) ─────
  {
    input: 'Прокомментируй задачу 123: «Согласовано, можно запускать».',
    expected: 'b24_task_comment_add',
    notes: 'Comment on a Bitrix24 task — taskId given.',
  },
  {
    input: 'Добавь комментарий "WIP" к задаче 99.',
    expected: 'b24_task_comment_add',
    notes: 'Short comment.',
  },
  {
    input: 'Отправь фидбэк разработчикам MCP: описание тула b24_user_me непонятное, агент не понял что оно возвращает.',
    expected: 'bx24mcp_submit_feedback',
    notes: 'Meta-feedback about the MCP server itself — should NOT go to add_task_comment.',
  },
  {
    input: 'Запиши в баг-трекер: при пустом фильтре find_user падает.',
    expected: 'bx24mcp_submit_feedback',
    notes: 'Bug report against the MCP — submit_feedback, not anything tasks-related.',
  },

  // ── Task lifecycle (7 thin v3 wrappers) ────────────────────────────────
  {
    input: 'Возьми задачу 42 в работу.',
    expected: 'b24_task_start',
    notes: 'Russian "take into work" — start the task.',
  },
  {
    input: 'Поставь задачу 88 на паузу.',
    expected: 'b24_task_pause',
    notes: 'Pause an in-progress task.',
  },
  {
    input: 'Отметь задачу 15 как выполненную.',
    expected: 'b24_task_complete',
    notes: 'Mark task as done — responsible user closes the task.',
  },
  {
    input: 'Прими работу по задаче 27, всё устраивает.',
    expected: 'b24_task_approve',
    notes: 'Creator accepts work after taskControl review — approve, not complete.',
  },
  {
    input: 'Верни задачу 27 на доработку — нужно переделать.',
    expected: 'b24_task_disapprove',
    notes: 'Creator rejects work after taskControl review.',
  },
  {
    input: 'Отложи задачу 99 на потом.',
    expected: 'b24_task_defer',
    notes: 'Defer — postpone, do not close.',
  },
  {
    input: 'Возобнови задачу 10, она снова в работе.',
    expected: 'b24_task_renew',
    notes: 'Renew a previously closed/deferred task back to Pending.',
  },

  // ── Lifecycle, English (i18n probe — descriptions must read for EN ops) ─
  {
    input: 'Start working on task 42.',
    expected: 'b24_task_start',
    notes: 'EN equivalent of "возьми в работу".',
  },
  {
    input: 'Mark task 15 as done.',
    expected: 'b24_task_complete',
    notes: 'EN "done" — must NOT go to rate_task (positive).',
  },
  {
    input: 'Send task 27 back for rework, the document is wrong.',
    expected: 'b24_task_disapprove',
    notes: 'EN rejection — must NOT go to update_task.',
  },

  // ── Disambiguation (verbs with multiple plausible tools) ───────────────
  {
    input: 'Прими задачу 12.',
    expected: 'b24_task_start',
    notes: '"Прими" without further context = "take into work" (start). NOT approve_task — approve is for accepting completed work under task control.',
  },
  {
    input: 'Закрой задачу 88.',
    expected: 'b24_task_complete',
    notes: '"Закрой" = complete, NOT delete. There is no delete tool yet, but the verb must route to complete.',
  },
  {
    input: 'Верни задачу 15 в работу.',
    expected: 'b24_task_renew',
    notes: '"Верни в работу" of a closed task = renew. NOT disapprove (which is "верни на доработку" and only applies under task control).',
  },

  // ── Batch / bulk phrasing (issue #7) ───────────────────────────────────
  // Two flavours: explicit-id batches (straight to the mutation tool), and
  // enumerate-then-batch flows (list_tasks first, with its now-v3-shape
  // camelCase filter contract).
  {
    input: 'Закрой задачи 5, 7 и 12.',
    expected: 'b24_task_complete',
    notes: 'Explicit ids → straight to batch complete (taskId as [5,7,12]).',
  },
  {
    input: 'Pause tasks 100, 101, 102 — I need to step away.',
    expected: 'b24_task_pause',
    notes: 'EN multi-id bulk pause; goes directly to pause_task in batch mode.',
  },
  {
    input: 'Закрой все мои задачи по корпусу №3.',
    expected: 'b24_task_list',
    notes: 'No explicit ids → must enumerate first via list_tasks (camelCase filter), then loop complete_task in batch mode.',
  },
  {
    input: 'Approve everything from sprint 14, all looks good.',
    expected: 'b24_task_list',
    notes: 'EN bulk approval without explicit ids: enumerate via list_tasks first; approve_task batch follows.',
  },

  // ── Task checklist (5 v2 wrappers — add / list / complete / renew / delete) ─
  {
    input: 'Добавь в задачу 123 пункт чек-листа «деплой».',
    expected: 'b24_task_checklist_item_add',
    notes: 'Add a regular item — the operator picks a checklist by context; tool defaults to new-checklist when parentId is omitted.',
  },
  {
    input: 'Создай в задаче 123 новый чек-лист «Релиз» с пунктами changelog и smoke.',
    expected: 'b24_task_checklist_item_add',
    notes: 'New checklist + items — LLM should still pick add_checklist_item; multiple calls follow.',
  },
  {
    input: 'Покажи чек-лист задачи 123.',
    expected: 'b24_task_checklist_item_list',
    notes: 'Read the whole checklist tree.',
  },
  {
    input: 'Какой прогресс по чек-листу задачи 123?',
    expected: 'b24_task_checklist_item_list',
    notes: 'Progress = list + count completed; first tool is the list.',
  },
  {
    input: 'Отметь в задаче 123 пункт 47 как выполненный.',
    expected: 'b24_task_checklist_item_complete',
    notes: 'Both ids given — go straight to complete.',
  },
  {
    input: 'Сними галку с пункта 47 в задаче 123, ещё не доделано.',
    expected: 'b24_task_checklist_item_renew',
    notes: 'Un-check = renew; must NOT route to renew_task (the task-level wrapper).',
  },
  {
    input: 'Удали из задачи 123 пункт 47 чек-листа.',
    expected: 'b24_task_checklist_item_delete',
    notes: 'Delete a single item.',
  },
  {
    input: 'Mark checklist item 21 on task 13 as done.',
    expected: 'b24_task_checklist_item_complete',
    notes: 'EN variant — both ids given; tests the description reads in English.',
  },

  // ── Task rating (MARK field, P/N/null) ─────────────────────────────────
  {
    input: 'Поставь задаче 55 положительную оценку.',
    expected: 'b24_task_rate',
    notes: 'Set positive rating — must NOT route to update_task with raw MARK.',
  },
  {
    input: 'Отметь задачу 56 как плохо выполненную.',
    expected: 'b24_task_rate',
    notes: 'Negative rating phrased without the word "rating".',
  },
  {
    input: 'Сними оценку с задачи 57.',
    expected: 'b24_task_rate',
    notes: 'Clear an existing rating — rating: none.',
  },

  // ── Task results (tasks.task.result.* — separate from comments / status) ───
  {
    input: 'Запиши результат к задаче 51: «работы выполнены, договор подписан».',
    expected: 'b24_task_result_add',
    notes: 'Operator records a task RESULT (outcome) — distinct from a comment or completion.',
  },
  {
    input: 'Add a result to task 12: shipped to production at 18:00, all checks green.',
    expected: 'b24_task_result_add',
    notes: 'EN result entry — must NOT route to add_task_comment or update_task.',
  },
  {
    input: 'Покажи результаты задачи 51.',
    expected: 'b24_task_result_list',
    notes: 'Read results — distinct phrasing from "comments" or "status".',
  },
  {
    input: 'Что записано как итог работы по задаче 51?',
    expected: 'b24_task_result_list',
    notes: 'Synonym for "result" ("итог") — should still hit list_task_results.',
  },
  {
    input: 'Поправь результат 17 — там опечатка, замени на «договор согласован 30.04».',
    expected: 'b24_task_result_update',
    notes: 'Update result text — resultId explicit, not the parent taskId.',
  },
  {
    input: 'Удали результат 17 в задаче 51 — я ошибся, не должен был его записывать.',
    expected: 'b24_task_result_delete',
    notes: 'Destructive; resultId given explicitly.',
  },

  // ── task.elapseditem.* (PR #B — manual time logging) ───────────────────
  {
    input: 'Запиши 30 минут на задачу 691 — собирал договор.',
    expected: 'b24_task_elapsed_time_add',
    notes: 'Manual time entry — LLM must convert "30 минут" to 1800 seconds.',
  },
  {
    input: 'Покажи сколько часов потратили на задачу 691 на этой неделе.',
    expected: 'b24_task_elapsed_time_list',
    notes: 'Read entries — must NOT route to list_tasks.',
  },
  {
    input: 'Исправь запись 5 на задаче 691 — там не 15, а 45 минут.',
    expected: 'b24_task_elapsed_time_update',
    notes: 'Update — entry id explicit, distinguishes from update_task / update_task_result.',
  },
  {
    input: 'Удали записи 7, 8, 9 на задаче 691 — это были миссклики.',
    expected: 'b24_task_elapsed_time_delete',
    notes: 'Batch delete — array of ids, destructive, must NOT route to delete_task_result.',
  },

  // ── task.dependence.* (PR-C — task dependencies; no read tool, see #33) ─
  {
    input: 'Сделай так, чтобы задача 100 шла после задачи 50 — пока 50 не закроют, 100 не стартует.',
    expected: 'b24_task_dependency_add',
    notes: 'Add single dependency, FS semantics. taskIdTo=100 depends on taskIdFrom=50; "после" → linkType=2.',
  },
  {
    input: 'Поставь задачу 100 после задач 5, 7 и 9 — все три должны закрыться раньше.',
    expected: 'b24_task_dependency_add',
    notes: 'Batch add — three predecessors against one fixed dependent, default FS. Must NOT route to list/remove.',
  },
  {
    input: 'Убери зависимость задачи 100 от задачи 50 — она больше не нужна.',
    expected: 'b24_task_dependency_remove',
    notes: 'Single remove. Destructive — requires confirmDelete; must NOT route to delete_* on other entities.',
  },
  {
    input: 'Сними у задачи 100 связи с задачами 5, 7, 9 — это всё устарело.',
    expected: 'b24_task_dependency_remove',
    notes: 'Batch remove — array of predecessors. Destructive; must NOT route to delete_task_result.',
  },
  {
    input: 'Поставь задачи 10 и 20 стартовать одновременно (одна не может начаться без другой).',
    expected: 'b24_task_dependency_add',
    notes: 'SS linkType=0 (start-start). Verifies the model routes to add for non-FS phrasings — "одновременно" / "одна не может начаться без другой" maps to linkType:0, not the default FS.',
  },
  {
    input: 'Сделай чтобы задачи 50 и 51 завершались вместе — пока обе не готовы, ни одна не закрыта.',
    expected: 'b24_task_dependency_add',
    notes: 'FF linkType=3 (finish-finish). Another non-FS phrasing — "завершались вместе" maps to linkType:3.',
  },
  {
    input: 'Make task 100 wait for tasks 5, 7, 9 to finish before it can start.',
    expected: 'b24_task_dependency_add',
    notes: 'EN batch add, finish-start. Covers the most common dependency operator path in English so dependency family is not RU-only in the eval coverage.',
  },
  {
    input: 'Entferne die Abhängigkeit von Aufgabe 100 zu Aufgabe 50 — sie wird nicht mehr gebraucht.',
    expected: 'b24_task_dependency_remove',
    notes: 'DE single remove. Destructive — requires confirmDelete; pins German routing for dependency-removal vocabulary.',
  },
  {
    input: 'Faire en sorte que la tâche 100 démarre après les tâches 5, 7 et 9.',
    expected: 'b24_task_dependency_add',
    notes: 'FR batch add, finish-start. "démarre après" → FS. Pins French routing for the dependency family.',
  },

  // ── Multilingual / non-Latin (i18n probe — ≥ 3 cases per language) ─────
  // Chinese (zh-CN)
  {
    input: '为用户 5 创建一个任务"批准合同"，截止时间周五。',
    expected: 'b24_task_create',
    notes: 'zh — create with explicit numeric user id.',
  },
  {
    input: '开始处理任务 42。',
    expected: 'b24_task_start',
    notes: 'zh — start task lifecycle.',
  },
  {
    input: '给任务 55 一个好评。',
    expected: 'b24_task_rate',
    notes: 'zh — positive rating; must NOT route to update_task.',
  },

  // Arabic (ar, RTL)
  {
    input: 'أضف تعليقاً للمهمة 123: «تمت الموافقة».',
    expected: 'b24_task_comment_add',
    notes: 'ar (RTL) — task id given, comment text in Arabic.',
  },
  {
    input: 'ابدأ العمل على المهمة 42.',
    expected: 'b24_task_start',
    notes: 'ar — start the task.',
  },
  {
    input: 'أرجِع المهمة 27 للمراجعة، المستند خاطئ.',
    expected: 'b24_task_disapprove',
    notes: 'ar — send back for rework; tests that the Müller/Fatima-flagged rejection terminology lands in Arabic.',
  },

  // Japanese (ja)
  {
    input: 'ユーザーID 7 にタスク「契約を承認」を作成、締切は金曜18:00。',
    expected: 'b24_task_create',
    notes: 'ja — create with explicit numeric user id.',
  },
  {
    input: 'タスク 15 を完了としてマークしてください。',
    expected: 'b24_task_complete',
    notes: 'ja — mark task as done; must NOT route to rate_task (positive).',
  },
  {
    input: 'タスク 99 を後回しにしてください。',
    expected: 'b24_task_defer',
    notes: 'ja — defer; tests defer-vs-pause disambiguation across scripts.',
  },
]

interface DataItem {
  input: string
  expected: string
}

const runner = process.env.DEEPSEEK_API_KEY ? evalite : evalite.skip
if (!process.env.DEEPSEEK_API_KEY) {
  // eslint-disable-next-line no-console
  console.log(
    '⚠️  DEEPSEEK_API_KEY is not set — registering tool-selection eval as skipped. ' +
      'Set it (and optionally DEEPSEEK_BASE_URL) to actually run the eval against DeepSeek.',
  )
}

runner<DataItem, string, string>('Bitrix24 tool selection', {
  data: CASES.map((c) => ({ input: { input: c.input, expected: c.expected }, expected: c.expected })),
  task: async ({ input }: { input: string; expected: string }) => {
    const result = await generateText({
      model: deepseek('deepseek-chat'),
      prompt: input,
      tools: aiSdkTools,
      // Light system message — emulates the MCP framing without prescribing
      // the answer.
      system:
        'You are an AI assistant connected to a Bitrix24 MCP server. Pick the right tool to satisfy the user\'s request. If you need an identifier you don\'t have, call the tool that finds it first. Do not answer in plain text when a tool is appropriate.',
    })
    return result.toolCalls[0]?.toolName ?? '<no-tool-call>'
  },
  scorers: [
    {
      name: 'first-tool-exact-match',
      description: 'The first toolCall must be exactly the expected tool name.',
      scorer: ({ output, expected }) => (output === expected ? 1 : 0),
    },
  ],
})
