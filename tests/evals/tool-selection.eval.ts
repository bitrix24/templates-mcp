/**
 * Tool-selection eval — does DeepSeek pick the right MCP tool for a given
 * natural-language prompt?
 *
 * The cases below are a curated subset of `docs/MANUAL-TEST-PHRASES.md`:
 * unambiguous prompts where the FIRST tool call should be one specific tool.
 * Each pass through the eval bills DeepSeek for ~20 small chat-completion
 * calls (≈ $0.002 total at current pricing).
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
vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod: async () => ({ getData: () => ({}) }) }),
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

const deepseek = createOpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  // The eval skips when DEEPSEEK_API_KEY is unset (see runner switch below),
  // so an empty key here is fine — generateText is never reached.
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
})

interface Case {
  input: string
  expected: string
  notes?: string
}

const CASES: Case[] = [
  // ── find_user (resolve names → ids) ────────────────────────────────────
  {
    input: 'Кто такой Игорь?',
    expected: 'bitrix24_find_user',
    notes: 'Bare first name — straight to find_user.',
  },
  {
    input: 'Найди мне Игоря Сергеевича Шевченко.',
    expected: 'bitrix24_find_user',
    notes: 'Full Russian name with patronymic — should hit find_user via free-text query.',
  },
  {
    input: 'Покажи бэкенд-разработчиков.',
    expected: 'bitrix24_find_user',
    notes: 'Position-based lookup.',
  },
  {
    input: 'Find all the project managers on our portal.',
    expected: 'bitrix24_find_user',
    notes: 'English position-based lookup.',
  },

  // ── current_user (operator refers to themselves) ───────────────────────
  {
    input: 'Кто я?',
    expected: 'bitrix24_current_user',
    notes: 'Self-reference — connectivity / identity check.',
  },
  {
    input: 'What is my Bitrix24 user id?',
    expected: 'bitrix24_current_user',
    notes: 'Self-id English variant.',
  },

  // ── list_tasks (filtering without name resolution) ─────────────────────
  {
    input: 'Покажи все задачи группы 7.',
    expected: 'bitrix24_list_tasks',
    notes: 'Group filter, no person.',
  },
  {
    input: 'Найди задачи со словом «договор» в названии.',
    expected: 'bitrix24_list_tasks',
    notes: 'LIKE-search on title.',
  },
  {
    input: 'Сколько у нас всего задач на портале?',
    expected: 'bitrix24_list_tasks',
    notes: 'Count via list with select=[ID] — reads `total`.',
  },
  {
    input: 'Show me overdue tasks across the company.',
    expected: 'bitrix24_list_tasks',
    notes: 'Overdue filter, no specific person.',
  },

  // ── create_task with explicit numeric id (no name to resolve) ──────────
  {
    input: 'Create a task "Approve contract" for user 12, deadline Friday 18:00.',
    expected: 'bitrix24_create_task',
    notes: 'Numeric responsibleId given — find_user not needed.',
  },
  {
    input: 'Заведи задачу пользователю с id 5: проверить логи прода.',
    expected: 'bitrix24_create_task',
    notes: 'Russian phrasing with explicit numeric id.',
  },

  // ── create_task → expects find_user FIRST when a name is given ─────────
  {
    input: 'Создай задачу «Согласовать договор» для Игоря, дедлайн пятница.',
    expected: 'bitrix24_find_user',
    notes: 'Must resolve "Игоря" before creating — first call should be find_user.',
  },
  {
    input: 'Поручи Маше Петровой позвонить клиенту до завтра.',
    expected: 'bitrix24_find_user',
    notes: '"Поручи" = "assign a task"; name first → find_user.',
  },

  // ── update_task ────────────────────────────────────────────────────────
  {
    input: 'Перенеси дедлайн задачи 123 на понедельник.',
    expected: 'bitrix24_update_task',
    notes: 'Direct field update — taskId is given.',
  },
  {
    input: 'Снизь приоритет задачи 456 до низкого.',
    expected: 'bitrix24_update_task',
    notes: 'Priority change.',
  },

  // ── add_task_comment vs submit_feedback (must not confuse the two) ─────
  {
    input: 'Прокомментируй задачу 123: «Согласовано, можно запускать».',
    expected: 'bitrix24_add_task_comment',
    notes: 'Comment on a Bitrix24 task — taskId given.',
  },
  {
    input: 'Добавь комментарий "WIP" к задаче 99.',
    expected: 'bitrix24_add_task_comment',
    notes: 'Short comment.',
  },
  {
    input: 'Отправь фидбэк разработчикам MCP: описание тула bitrix24_current_user непонятное, агент не понял что оно возвращает.',
    expected: 'bx24mcp_submit_feedback',
    notes: 'Meta-feedback about the MCP server itself — should NOT go to add_task_comment.',
  },
  {
    input: 'Запиши в баг-трекер: при пустом фильтре find_user падает.',
    expected: 'bx24mcp_submit_feedback',
    notes: 'Bug report against the MCP — submit_feedback, not anything tasks-related.',
  },

  // ── Multilingual / non-Latin (i18n probe) ──────────────────────────────
  {
    input: '为用户 5 创建一个任务"批准合同"，截止时间周五。',
    expected: 'bitrix24_create_task',
    notes: 'Chinese Simplified — explicit numeric user id.',
  },
  {
    input: 'أضف تعليقاً للمهمة 123: «تمت الموافقة».',
    expected: 'bitrix24_add_task_comment',
    notes: 'Arabic RTL — task id given, comment text in Arabic.',
  },
  {
    input: 'ユーザーID 7 にタスク「契約を承認」を作成、締切は金曜18:00。',
    expected: 'bitrix24_create_task',
    notes: 'Japanese — explicit numeric user id.',
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
