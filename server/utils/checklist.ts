import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { Bitrix24ToolError, toToolError } from '~/server/utils/errors'
import { callV2 } from '~/server/utils/sdk-helpers'

/**
 * Shared types and helpers for the Bitrix24 task-checklist tools.
 *
 * The five tools (`add` / `list` / `complete` / `renew` / `delete`) wrap the
 * `task.checklistitem.*` REST methods. These methods are v2-only — Bitrix24
 * has no v3 `tasks.task.checklist.*` namespace for actual tasks (the
 * `tasks.template.checklist.*` family is for task templates only). v2 is the
 * documented and stable surface; the `apidocs.bitrix24.ru/api-reference/tasks/
 * checklist-item/*` pages do not flag these as deprecated.
 *
 * Response field casing mirrors v2 conventions (UPPER_SNAKE on the wire), so
 * `toChecklistItemShort` mirrors `toTaskShort` and tolerates the mixed-casing
 * shapes the SDK can hand back depending on transform middleware.
 */

/** Subset of checklist-item fields surfaced to the agent. The full Bitrix24
 *  response carries 11+ fields (members, attachments, …); trimming keeps the
 *  agent context window cheap and matches what `list_tasks` does for tasks. */
export interface ChecklistItemShort {
  id: number
  taskId: number
  parentId: number
  title: string
  sortIndex: number
  isComplete: boolean
  isImportant: boolean
  toggledBy: number | null
  toggledDate: string | null
}

function pick<T>(obj: Record<string, unknown>, lower: string, upper: string): T | null {
  const v = obj[lower] ?? obj[upper]
  return v === undefined ? null : (v as T)
}

/** Coerce Bitrix24's stringified numeric ids ("8017") into actual numbers.
 *  Returns null for absent / non-numeric values so the JSON payload distinguishes
 *  "missing" from "0". */
function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw as number)
  return Number.isFinite(n) ? n : null
}

function toBool(raw: unknown): boolean {
  // Bitrix24 returns the literal string "Y" / "N"; sometimes "1" / "0" via batch.
  return raw === 'Y' || raw === true || raw === 1 || raw === '1'
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
    // parentId can be the literal number 0 (top-level checklist heading) or a
    // stringified id ("431") for nested items. Both forms are valid; we
    // surface 0 unchanged so the agent can identify headings.
    parentId: toNumber(pick(r, 'parentId', 'PARENT_ID')) ?? 0,
    title,
    sortIndex: toNumber(pick(r, 'sortIndex', 'SORT_INDEX')) ?? 0,
    isComplete: toBool(pick(r, 'isComplete', 'IS_COMPLETE')),
    isImportant: toBool(pick(r, 'isImportant', 'IS_IMPORTANT')),
    toggledBy: toNumber(pick(r, 'toggledBy', 'TOGGLED_BY')),
    toggledDate: pick<string>(r, 'toggledDate', 'TOGGLED_DATE') || null,
  }
}

/**
 * Factory for the three `task.checklistitem.{complete,renew,delete}` tools.
 *
 * All three take the same `[TASKID, ITEMID]` positional contract on the wire
 * (the documented form on apidocs.bitrix24.ru — only the `delete` page also
 * shows a named `{TASKID, ITEMID}` example, while `complete`/`renew` show
 * positional only). Positional is the lowest-common-denominator that all
 * three honour. All three accept either a single `itemId: number` or an
 * array for batch mode — same shape as the lifecycle factory in
 * `task-lifecycle.ts`, kept separate because (a) the wire call is positional,
 * not named, and (b) `task.checklistitem.*` is v2-only, so we cannot piggy-
 * back on the v3 batch endpoint and have to loop `callV2` sequentially.
 */
export type ChecklistActionMethod =
  | 'task.checklistitem.complete'
  | 'task.checklistitem.renew'
  | 'task.checklistitem.delete'

export interface ChecklistActionToolSpec {
  /** MCP tool name, e.g. `bitrix24_complete_checklist_item`. */
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

const CHECKLIST_ACTION_USAGE_NOTES =
  ' Accepts a single item id OR an array of ids (batch mode, up to 25 — pass `force: true` to override). Batch mode returns a `{ batch, total, ok, failed, results }` summary; per-id errors do not abort the batch. The Bitrix24 SDK paces outbound calls automatically. If the operator names the item in free text instead of an id, list the checklist first via `bitrix24_list_checklist_items` and match by title.'

const DEFAULT_BATCH_CAP = 25

interface BatchEntryResult {
  itemId: number
  ok: boolean
  error?: string
}

export function defineChecklistActionTool(spec: ChecklistActionToolSpec) {
  return defineMcpTool({
    name: spec.name,
    description: spec.description + CHECKLIST_ACTION_USAGE_NOTES,
    inputSchema: {
      taskId: z.number().int().positive().describe('Task id the checklist item belongs to.'),
      itemId: z
        .union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)])
        .describe(
          'Checklist item id (from `bitrix24_list_checklist_items`), or an array of item ids for batch mode. Pass a number for single-item semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          `Set true to allow batches larger than ${DEFAULT_BATCH_CAP}. Use sparingly — MCP clients may time out on long-running tool calls. Ignored for single-item input.`,
        ),
    },
    handler: async (input: { taskId: number; itemId: number | number[]; force?: boolean }) => {
      const { taskId, itemId, force } = input
      if (typeof itemId === 'number') {
        return runOne(spec, taskId, itemId)
      }
      return runBatch(spec, taskId, itemId, force ?? false)
    },
  })
}

/**
 * Wire the positional `[taskId, itemId]` tuple through `callV2`. The SDK
 * types `params` as `Record<string, unknown>`, but the v2 REST adapter
 * serialises `[a, b]` to `0=a&1=b` form — which is what `task.checklistitem.
 * {complete,renew,delete}` expect per the apidocs examples. Localise the
 * cast so the type-system gap doesn't propagate beyond this file.
 */
function positional(taskId: number, itemId: number): Record<string, unknown> {
  return [taskId, itemId] as unknown as Record<string, unknown>
}

async function runOne(spec: ChecklistActionToolSpec, taskId: number, itemId: number) {
  await callV2<unknown>(
    useBitrix24(),
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
  force: boolean,
) {
  if (itemIds.length > DEFAULT_BATCH_CAP && !force) {
    throw new Bitrix24ToolError(
      `Batch of ${itemIds.length} exceeds the default cap of ${DEFAULT_BATCH_CAP}. Pass force=true to override, or split into multiple calls.`,
      'BATCH_TOO_LARGE',
    )
  }

  const b24 = useBitrix24()
  const results: BatchEntryResult[] = []

  // Sequential, not parallel: `task.checklistitem.*` is v2 and cannot ride
  // the v3 batch endpoint, so we loop `callV2`. The SDK's client-side rate
  // limiter would serialise them anyway, and sequential ordering preserves
  // a clean results[] alignment with the input order and predictable error
  // semantics.
  for (const itemId of itemIds) {
    try {
      await callV2<unknown>(
        b24,
        spec.method,
        positional(taskId, itemId),
        `Failed to ${spec.verb} Bitrix24 checklist item ${itemId} on task ${taskId}`,
      )
      results.push({ itemId, ok: true })
    } catch (err) {
      const wrapped = toToolError(err, `Failed to ${spec.verb} Bitrix24 checklist item ${itemId} on task ${taskId}`)
      results.push({ itemId, ok: false, error: wrapped.message })
    }
  }

  const ok = results.filter((r) => r.ok).length
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          batch: true,
          verb: spec.pastTense,
          taskId,
          total: results.length,
          ok,
          failed: results.length - ok,
          results,
        }),
      },
    ],
  }
}
