import { z } from 'zod'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import {
  type ActionToolInput,
  assertConfirmedDelete,
  confirmDeleteSchema,
  defineActionTool,
  forceFlagSchema,
  idOrIdArraySchema,
  mapBatchRows,
} from '~/server/utils/define-action-tool'
import { Bitrix24ErrorCode, Bitrix24ToolError } from '~/server/utils/errors'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'
import { pick, toBool, toNumber } from '~/server/utils/wire-coerce'
import type { BitrixChecklistItemRaw } from '~/server/types/bitrix24'

/**
 * Shared types + helpers for the five `task.checklistitem.*` tools.
 *
 * v2-only namespace — v3 has `tasks.template.checklist.*` for task templates
 * but no equivalent for tasks themselves. The five apidocs pages
 * (apidocs.bitrix24.ru/api-reference/tasks/checklist-item/*) are documented
 * and not flagged as deprecated.
 *
 * Built atop `defineActionTool` — the single-vs-batch dispatch, batch-cap
 * check, and summary projection are shared across both action-tool
 * families (lifecycle + checklist) via that scaffold.
 */

/** Subset of checklist-item fields surfaced to the agent. Mirrors what
 *  `b24_task_list` does for tasks — keep the response small and predictable. */
export interface ChecklistItemShort {
  id: number
  taskId: number
  parentId: number
  title: string
  sortIndex: number
  isComplete: boolean
  isImportant: boolean
  createdBy: number | null
  toggledBy: number | null
  toggledDate: string | null
}

export function toChecklistItemShort(raw: unknown): ChecklistItemShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = toNumber(pick(r, 'id', 'ID'))
  const taskId = toNumber(pick(r, 'taskId', 'TASK_ID'))
  const title = pick<string>(r, 'title', 'TITLE')
  if (id === null || taskId === null || title === null) return null
  return {
    id,
    taskId,
    // parentId === 0 marks a checklist heading; the wire ships 0 as a number
    // for headings and a stringified id for nested items.
    parentId: toNumber(pick(r, 'parentId', 'PARENT_ID')) ?? 0,
    title,
    sortIndex: toNumber(pick(r, 'sortIndex', 'SORT_INDEX')) ?? 0,
    isComplete: toBool(pick(r, 'isComplete', 'IS_COMPLETE')),
    isImportant: toBool(pick(r, 'isImportant', 'IS_IMPORTANT')),
    createdBy: toNumber(pick(r, 'createdBy', 'CREATED_BY')),
    toggledBy: toNumber(pick(r, 'toggledBy', 'TOGGLED_BY')),
    // Empty string -> null so callers can tell "never toggled" from "real timestamp".
    toggledDate: pick<string>(r, 'toggledDate', 'TOGGLED_DATE') || null,
  }
}

/**
 * Factory for the three `task.checklistitem.{complete,renew,delete}` tools.
 *
 * All three take positional `[taskId, itemId]` on the wire (documented form
 * on apidocs.bitrix24.ru) and return a boolean. Single mode = one `callV2`.
 * Batch mode = one `batchV2` round-trip via `actions.v2.batch.make` (cap 50
 * per Bitrix24's server-side limit).
 *
 * For `delete` only: TWO confirm flags are wired (the sibling `complete` /
 * `renew` tools omit both):
 *
 *   - `confirmDelete: boolean` — SKILL.md Rule #9 (universal). Refuses with
 *     `DELETE_NEEDS_CONFIRM` if not `true`. Fires FIRST (before any wire
 *     call) so the agent learns about the gate without burning a pre-flight.
 *   - `confirmDeleteHeading: boolean` — SKILL.md Rule #10 (cascade). Stacks
 *     on top: when the target is a checklist heading (`parentId: 0`) the
 *     request wipes the whole sub-tree. Pre-flight `task.checklistitem.getlist`
 *     refuses with `HEADING_DELETE_NEEDS_CONFIRM` unless this flag is
 *     `true` too. Heading deletes need BOTH flags; regular-item deletes
 *     only need `confirmDelete: true`.
 *
 * See `define-action-tool.ts::assertConfirmedDelete` for the shared Rule
 * #9 gate, and `assertNotHeading` / `assertBatchNoHeadings` below for the
 * checklist-specific Rule #10 cascade enforcement. `runOne` / `runBatch`
 * own the dispatch order (Rule #9 first, then Rule #10 pre-flight).
 */
export type ChecklistActionMethod =
  | 'task.checklistitem.complete'
  | 'task.checklistitem.renew'
  | 'task.checklistitem.delete'

export interface ChecklistActionToolSpec {
  /** MCP tool name, e.g. `b24_task_checklist_item_complete`. */
  name: string
  /** Bitrix24 REST method. */
  method: ChecklistActionMethod
  /** Infinitive verb used in error messages, e.g. `complete`. */
  verb: string
  /** Past-tense verb used as the success payload's boolean key, e.g. `completed`. */
  pastTense: string
  /** Human-readable tool description for the LLM. */
  description: string
}

const DEFAULT_BATCH_CAP = 50
const CHECKLIST_ACTION_USAGE_NOTES =
  ` Accepts a single item id OR an array of ids (batch mode, up to ${DEFAULT_BATCH_CAP} — pass \`force: true\` to override). Batch mode goes through one HTTP round-trip and returns a \`{ batch, total, ok, failed, results }\` summary; per-id errors do not abort the batch. If the operator names the item in free text instead of an id, list the checklist first via \`b24_task_checklist_item_list\` and match by title.`

interface ChecklistInput extends ActionToolInput {
  taskId: number
  itemId: number | number[]
  confirmDelete?: boolean
  confirmDeleteHeading?: boolean
}

interface ChecklistBatchRow {
  itemId: number
  ok: boolean
  error?: string
}

/** Positional `[taskId, itemId]` tuple — the documented wire form for the
 *  three action methods. `callV2`/`batchV2` accept positional params. */
function positional(taskId: number, itemId: number): unknown[] {
  return [taskId, itemId]
}

export function defineChecklistActionTool(spec: ChecklistActionToolSpec) {
  const isDelete = spec.method === 'task.checklistitem.delete'
  return defineActionTool<ChecklistInput, ChecklistBatchRow>({
    name: spec.name,
    description: spec.description,
    usageNotes: CHECKLIST_ACTION_USAGE_NOTES,
    pastTense: spec.pastTense,
    batchCap: DEFAULT_BATCH_CAP,
    inputSchema: {
      taskId: z.number().int().positive().describe('Task id the checklist item belongs to.'),
      itemId: idOrIdArraySchema.describe(
        'Checklist item id (from `b24_task_checklist_item_list`), or an array of item ids for batch mode. Pass a number for single-item semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
      ),
      force: forceFlagSchema(DEFAULT_BATCH_CAP),
      // `confirmDelete` (universal Ground Rule #9) + `confirmDeleteHeading`
      // (cascade-specific Rule #10) are wired only for the delete tool.
      // Other action tools (complete / renew) omit both so the LLM doesn't
      // see irrelevant fields. Heading delete stacks: agent must set BOTH.
      ...(isDelete
        ? {
            confirmDelete: confirmDeleteSchema(),
            confirmDeleteHeading: z
              .boolean()
              .optional()
              .describe(
                'Stacks on top of `confirmDelete` (Rule #9) when the target is a checklist HEADING (an item whose parentId is 0). Heading deletion wipes the entire checklist — heading + every child — with no undo. The tool refuses with a HEADING_DELETE_NEEDS_CONFIRM error if the target is a heading and this flag is not set. Confirm with the operator before passing true. Ignored when the target is a regular item.',
              ),
          }
        : {}),
    },
    extractIds: (input) => input.itemId,
    runOne: (input, itemId) =>
      runOne(spec, input.taskId, itemId, input.confirmDelete ?? false, input.confirmDeleteHeading ?? false),
    runBatch: (input, ids) =>
      runBatch(spec, input.taskId, ids, input.confirmDelete ?? false, input.confirmDeleteHeading ?? false),
    // Carry `taskId` into the batch summary so the agent can tell at a
    // glance which task the result rows belong to.
    batchSummaryExtras: (input) => ({ taskId: input.taskId }),
  })
}

async function runOne(
  spec: ChecklistActionToolSpec,
  taskId: number,
  itemId: number,
  confirmDelete: boolean,
  confirmDeleteHeading: boolean,
) {
  const b24 = useBitrix24Tenant()

  if (spec.method === 'task.checklistitem.delete') {
    // Universal gate (Rule #9) first — refuses every delete that wasn't
    // operator-agreed, regardless of heading status. Then cascade gate
    // (Rule #10) — pre-flight catches heading targets if confirmDeleteHeading
    // wasn't set.
    assertConfirmedDelete('b24_task_checklist_item_delete', describeChecklistTarget(taskId, itemId), confirmDelete)
    if (!confirmDeleteHeading) {
      await assertNotHeading(b24, taskId, itemId)
    }
  }

  await callV2<unknown>(
    b24,
    spec.method,
    positional(taskId, itemId),
    `Failed to ${spec.verb} Bitrix24 checklist item ${itemId} on task ${taskId}`,
  )

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          [spec.pastTense]: true,
          taskId,
          itemId,
        }),
      },
    ],
  }
}

async function runBatch(
  spec: ChecklistActionToolSpec,
  taskId: number,
  itemIds: number[],
  confirmDelete: boolean,
  confirmDeleteHeading: boolean,
): Promise<ChecklistBatchRow[]> {
  const b24 = useBitrix24Tenant()

  if (spec.method === 'task.checklistitem.delete') {
    // Universal gate first (Rule #9). Then cascade gate (Rule #10) — one
    // pre-flight getlist covers the whole batch.
    assertConfirmedDelete('b24_task_checklist_item_delete', describeChecklistTarget(taskId, itemIds), confirmDelete)
    if (!confirmDeleteHeading) {
      await assertBatchNoHeadings(b24, taskId, itemIds)
    }
  }

  const rows = await batchV2<unknown>(
    b24,
    itemIds.map((id) => [spec.method, positional(taskId, id)]),
    `Failed to ${spec.verb} a batch of ${itemIds.length} checklist item(s) on task ${taskId}`,
  )

  return mapBatchRows(rows, itemIds, 'itemId', ({ id, ok, errorMessages }) => {
    if (!ok) {
      return {
        itemId: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to ${spec.verb} Bitrix24 checklist item ${id} on task ${taskId}`,
      }
    }
    return { itemId: id, ok: true }
  })
}

/**
 * Format the human-readable target description for the Rule #9 gate.
 * Shape matches the historic local copy so existing test assertions
 * (`/checklist item 475 on task 13/`,
 * `/2 checklist item\(s\) \[475, 433\] on task 13/`) keep pinning the
 * wording. Behaviour now lives in
 * `define-action-tool.ts::assertConfirmedDelete` (closes #32).
 */
function describeChecklistTarget(taskId: number, itemId: number | number[]): string {
  return Array.isArray(itemId)
    ? `${itemId.length} checklist item(s) [${itemId.join(', ')}] on task ${taskId}`
    : `checklist item ${itemId} on task ${taskId}`
}

/**
 * Refuse to delete a checklist heading unless the agent confirmed it. Reads
 * the checklist once and matches on `parentId === 0`. If Bitrix24 returns no
 * matching item we let the delete call proceed — its own NOT_FOUND error is
 * a cleaner signal than fabricating one here.
 */
async function assertNotHeading(b24: Parameters<typeof callV2>[0], taskId: number, itemId: number): Promise<void> {
  const items = await callV2<BitrixChecklistItemRaw[]>(
    b24,
    'task.checklistitem.getlist',
    { TASKID: taskId },
    `Failed to pre-flight delete for Bitrix24 checklist item ${itemId} on task ${taskId}`,
  )
  if (!Array.isArray(items)) return
  const target = items.find((it) => toNumber(it.id ?? it.ID) === itemId)
  if (!target) return
  if ((toNumber(target.parentId ?? target.PARENT_ID) ?? 0) === 0) {
    throw new Bitrix24ToolError(
      `Item ${itemId} is a checklist HEADING on task ${taskId}; deleting it wipes the whole checklist (heading + all children) with no undo. Re-call \`b24_task_checklist_item_delete\` with BOTH \`confirmDelete: true\` (Rule #9) AND \`confirmDeleteHeading: true\` (Rule #10) after the operator has agreed.`,
      Bitrix24ErrorCode.HEADING_DELETE_NEEDS_CONFIRM,
    )
  }
}

async function assertBatchNoHeadings(
  b24: Parameters<typeof callV2>[0],
  taskId: number,
  itemIds: number[],
): Promise<void> {
  const items = await callV2<BitrixChecklistItemRaw[]>(
    b24,
    'task.checklistitem.getlist',
    { TASKID: taskId },
    `Failed to pre-flight batch delete for Bitrix24 task ${taskId}`,
  )
  if (!Array.isArray(items)) return
  const headingIds = items
    .filter((it) => (toNumber(it.parentId ?? it.PARENT_ID) ?? 0) === 0)
    .map((it) => toNumber(it.id ?? it.ID))
    .filter((id): id is number => id !== null)
  const headingHits = itemIds.filter((id) => headingIds.includes(id))
  if (headingHits.length > 0) {
    throw new Bitrix24ToolError(
      `Batch refused: ${headingHits.join(', ')} ${headingHits.length === 1 ? 'is a checklist heading' : 'are checklist headings'} on task ${taskId}. Deleting a heading wipes the whole checklist with no undo. Re-call with BOTH \`confirmDelete: true\` (Rule #9) AND \`confirmDeleteHeading: true\` (Rule #10) after the operator has agreed, or split the batch.`,
      Bitrix24ErrorCode.HEADING_DELETE_NEEDS_CONFIRM,
    )
  }
}
