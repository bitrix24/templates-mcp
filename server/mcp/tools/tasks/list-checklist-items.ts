import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import { toChecklistItemShort, type ChecklistItemShort } from '~/server/utils/checklist'
import type { BitrixChecklistItemRaw } from '~/server/types/bitrix24'

/**
 * Lists all checklist items on a Bitrix24 task. Bitrix24 represents the
 * whole tree as a flat list — checklist headings have `parentId: 0`, and
 * every other item references its parent (heading or sibling) by id.
 *
 * Bitrix24 REST: task.checklistitem.getlist (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-get-list.html
 *
 * Sort fields per apidocs: ID, PARENT_ID, CREATED_BY, TITLE, SORT_INDEX,
 * IS_COMPLETE, IS_IMPORTANT, TOGGLED_BY, TOGGLED_DATE. Default is ID desc.
 */

const SORT_FIELDS = [
  'id',
  'parentId',
  'createdBy',
  'title',
  'sortIndex',
  'isComplete',
  'isImportant',
  'toggledBy',
  'toggledDate',
] as const

const CAMEL_TO_WIRE: Record<(typeof SORT_FIELDS)[number], string> = {
  id: 'ID',
  parentId: 'PARENT_ID',
  createdBy: 'CREATED_BY',
  title: 'TITLE',
  sortIndex: 'SORT_INDEX',
  isComplete: 'IS_COMPLETE',
  isImportant: 'IS_IMPORTANT',
  toggledBy: 'TOGGLED_BY',
  toggledDate: 'TOGGLED_DATE',
}

export default defineMcpTool({
  name: 'b24_task_checklist_item_list',
  description:
    'List every checklist item on a Bitrix24 task. The whole tree is FLAT — checklist headings have `parentId: 0`, regular items reference their parent (heading or sibling) via `parentId`. A task may carry several checklists; you see them all in one response. To compute progress, count `isComplete: true` over the items where `parentId` matches the heading you care about.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to read the checklist of.'),
    order: z
      .object({
        field: z
          .enum(SORT_FIELDS)
          .describe(
            'Sort field. `sortIndex` matches the visual order in the Bitrix24 UI; `id` ascending matches creation order.',
          ),
        direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
      })
      .optional()
      .describe('Sort order. Default is `{ field: "id", direction: "desc" }` — newest first.'),
  },
  handler: async ({ taskId, order }) => {
    const params: { TASKID: number; ORDER?: Record<string, string> } = { TASKID: taskId }
    if (order) {
      params.ORDER = { [CAMEL_TO_WIRE[order.field]]: order.direction.toUpperCase() }
    }

    // `task.checklistitem.getlist` returns `{ result: [...] }` — a bare array
    // of items (confirmed against the apidocs.bitrix24.ru response example).
    const raw = await callV2<BitrixChecklistItemRaw[]>(
      useBitrix24Tenant(),
      'task.checklistitem.getlist',
      params,
      `Failed to list Bitrix24 checklist items for task ${taskId}`,
    )

    const items: ChecklistItemShort[] = Array.isArray(raw)
      ? raw.map(toChecklistItemShort).filter((i): i is ChecklistItemShort => i !== null)
      : []

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            taskId,
            returned: items.length,
            items,
          }),
        },
      ],
    }
  },
})
