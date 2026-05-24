import { defineChecklistActionTool } from '~/server/utils/checklist'

/**
 * Delete an item from a Bitrix24 task checklist. Destructive; no undo.
 *
 * Bitrix24 REST: task.checklistitem.delete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/task-checklist-item-delete.html
 *
 * The factory adds TWO confirm fields for this tool only (omitted from the
 * sibling `complete` / `renew` tools' schema):
 *
 *   - `confirmDelete: boolean` (SKILL.md Rule #9, universal) — required for
 *     every delete; refused with `DELETE_NEEDS_CONFIRM` if not `true`.
 *   - `confirmDeleteHeading: boolean` (SKILL.md Rule #10, cascade-specific)
 *     — additionally required when the target is a checklist heading
 *     (parentId === 0). Refused with `HEADING_DELETE_NEEDS_CONFIRM` after a
 *     single pre-flight `task.checklistitem.getlist` that gates both
 *     single-id and batch flows. See `server/utils/checklist.ts`:
 *       - `assertConfirmedDelete` — Rule #9 gate (universal, fires first)
 *       - `assertNotHeading` — Rule #10 cascade gate, single-id
 *       - `assertBatchNoHeadings` — Rule #10 cascade gate, batch (one pre-flight)
 *
 * Heading deletes need BOTH flags `true`; regular-item deletes only need
 * `confirmDelete: true`.
 */
export default defineChecklistActionTool({
  name: 'b24_task_checklist_item_delete',
  method: 'task.checklistitem.delete',
  verb: 'delete',
  pastTense: 'deleted',
  description:
    'Delete one item from a Bitrix24 task checklist. Destructive — there is no undo. **Requires `confirmDelete: true`** (SKILL.md Rule #9, universal) after the operator has explicitly agreed to the deletion. Additionally, deleting a checklist HEADING (the item that names the whole checklist) wipes every child item with it; heading deletes ALSO require `confirmDeleteHeading: true` (Rule #10, cascade) — pre-flight refuses with HEADING_DELETE_NEEDS_CONFIRM otherwise. Regular-item deletes need only `confirmDelete: true`.',
})
