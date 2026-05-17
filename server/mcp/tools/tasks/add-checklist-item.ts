import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

/**
 * Adds a new item to a Bitrix24 task checklist.
 *
 * Bitrix24 REST: task.checklistitem.add (v2 — no v3 equivalent for task
 * checklists; the v3 `tasks.template.checklist.*` family is for templates
 * only).
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-add.html
 *
 * Bitrix24 represents a whole checklist tree as a flat list of items with
 * `PARENT_ID` nesting. To create a brand-new checklist on a task, send
 * `parentId: 0` — the API treats the resulting item as the checklist
 * **heading**, and the `title` becomes the checklist name. To add a regular
 * item under an existing checklist, set `parentId` to the heading id (or to
 * another item's id for deeper nesting).
 */
export default defineMcpTool({
  name: 'bitrix24_add_checklist_item',
  description:
    'Add a new item to a Bitrix24 task checklist. `parentId` controls nesting: omit (or pass 0) to start a NEW checklist on the task — the `title` then becomes the checklist name. Pass an existing item id to nest under it. Returns the new item id. The whole checklist tree is flat with `PARENT_ID` references — fetch it via `bitrix24_list_checklist_items`.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id the checklist belongs to.'),
    title: z
      .string()
      .min(1)
      .describe(
        'Item text. If `parentId` is omitted or 0, this is the checklist NAME (heading), not an item under it.',
      ),
    parentId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Parent item id for nesting. Omit or pass 0 to start a NEW checklist (the new item becomes the heading). Pass the heading id (from `bitrix24_list_checklist_items` where `parentId` is 0) to add a regular item under it.',
      ),
    sortIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Sort position within the parent. Lower = higher in the list. Omit to append at the end.'),
    isImportant: z
      .boolean()
      .optional()
      .describe('Mark the item as important. Default false.'),
  },
  handler: async ({ taskId, title, parentId, sortIndex, isImportant }) => {
    // Pin PARENT_ID on the wire: the API docs only document behaviour when
    // PARENT_ID is supplied (0 = new heading, >0 = nested). Omitting it is
    // undefined behaviour. We default to 0 so "omit parentId" = "start a
    // new checklist" matches the tool description's promise deterministically.
    const fields: Record<string, unknown> = { TITLE: title, PARENT_ID: parentId ?? 0 }
    if (sortIndex !== undefined) fields.SORT_INDEX = sortIndex
    if (isImportant !== undefined) fields.IS_IMPORTANT = isImportant ? 'Y' : 'N'

    // task.checklistitem.add returns `{ result: <itemId int>, time: {...} }`.
    // `callV2` unwraps the envelope; we receive the bare id (number or string
    // depending on portal).
    const rawId = await callV2<number | string>(
      useBitrix24(),
      'task.checklistitem.add',
      { TASKID: taskId, FIELDS: fields },
      `Failed to add checklist item to Bitrix24 task ${taskId}`,
    )

    const itemId =
      typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number.parseInt(rawId, 10) : null

    if (itemId === null || !Number.isFinite(itemId)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Checklist item added to task ${taskId}, but Bitrix24 returned no item id. List checklist items to find it.`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            added: true,
            taskId,
            itemId,
            title,
            parentId: parentId ?? 0,
          }),
        },
      ],
    }
  },
})
