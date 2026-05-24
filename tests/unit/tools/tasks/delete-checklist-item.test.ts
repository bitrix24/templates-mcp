import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../../server/utils/errors'
import type { z } from 'zod'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => fake.b24,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/tasks/delete-checklist-item')).default as unknown as {
  handler: (input: {
    taskId: number
    itemId: number | number[]
    force?: boolean
    confirmDelete?: boolean
    confirmDeleteHeading?: boolean
  }) => Promise<ToolContent>
  inputSchema: {
    confirmDelete: z.ZodOptional<z.ZodBoolean>
    confirmDeleteHeading: z.ZodOptional<z.ZodBoolean>
  }
}

/** Shared checklist fixture: heading 431, two regular items 433 / 475. */
function fakeChecklistList() {
  return fakeOk([
    { ID: '431', TASK_ID: '13', PARENT_ID: 0, TITLE: 'QA' },
    { ID: '433', TASK_ID: '13', PARENT_ID: '431', TITLE: 'UI' },
    { ID: '475', TASK_ID: '13', PARENT_ID: '431', TITLE: 'API' },
  ])
}

describe('b24_task_checklist_item_delete', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('deletes a regular (non-heading) item with confirmDelete: true, single call', async () => {
    fake.v2Call.mockResolvedValueOnce(fakeChecklistList()).mockResolvedValueOnce(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: 475, confirmDelete: true })

    // First call is the pre-flight getlist; second is the real delete.
    expect(fake.v2Call).toHaveBeenNthCalledWith(1, {
      method: 'task.checklistitem.getlist',
      params: { TASKID: 13 },
    })
    expect(fake.v2Call).toHaveBeenNthCalledWith(2, {
      method: 'task.checklistitem.delete',
      params: [13, 475],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, taskId: 13, itemId: 475 })
  })

  it('refuses single delete without confirmDelete: true and names the target (Ground Rule #9, universal)', async () => {
    // Rule #9 fires BEFORE the heading pre-flight — the agent learns the
    // confirm requirement without burning a getlist round-trip. Both
    // `undefined` and explicit `false` paths must refuse.
    await expect(tool.handler({ taskId: 13, itemId: 475 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringMatching(/checklist item 475 on task 13/) as unknown as string,
    })
    await expect(tool.handler({ taskId: 13, itemId: 475, confirmDelete: false })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('refuses single heading delete with confirmDeleteHeading: true but confirmDelete absent (Rule #9 fires first)', async () => {
    // Pins the stacking-order invariant: Rule #9 has priority. Even when
    // the agent supplied the cascade flag for a heading target, the
    // universal gate refuses BEFORE the pre-flight runs — no getlist
    // round-trip, no leak about whether the target is a heading.
    await expect(
      tool.handler({ taskId: 13, itemId: 431, confirmDeleteHeading: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('refuses batch delete without confirmDelete: true (Ground Rule #9)', async () => {
    await expect(tool.handler({ taskId: 13, itemId: [475, 433] })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringMatching(/2 checklist item\(s\) \[475, 433\] on task 13/) as unknown as string,
    })
    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('refuses to delete a heading without confirmDeleteHeading (Rule #10 stacks on Rule #9)', async () => {
    fake.v2Call.mockResolvedValue(fakeChecklistList())

    // confirmDelete: true alone is not enough for a heading target — Rule #10
    // (cascade) stacks on top, requiring confirmDeleteHeading as well.
    await expect(tool.handler({ taskId: 13, itemId: 431, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.HEADING_DELETE_NEEDS_CONFIRM,
    })
    // Only the pre-flight call should have run — never the destructive delete.
    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.getlist',
      params: { TASKID: 13 },
    })
  })

  it('proceeds with heading deletion when BOTH confirmDelete and confirmDeleteHeading are true (skips pre-flight)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(true))

    const result = await tool.handler({
      taskId: 13,
      itemId: 431,
      confirmDelete: true,
      confirmDeleteHeading: true,
    })

    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.delete',
      params: [13, 431],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, taskId: 13, itemId: 431 })
  })

  it('wraps SDK errors with task and item ids in the fallback', async () => {
    fake.v2Call.mockResolvedValueOnce(fakeChecklistList()).mockRejectedValueOnce(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 13, itemId: 475, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('batch mode: pre-flight refuses any batch that targets a heading without cascade confirmation', async () => {
    fake.v2Call.mockResolvedValue(fakeChecklistList())

    // confirmDelete: true satisfies Rule #9; the cascade (heading 431 in the
    // batch) still triggers Rule #10's pre-flight refusal.
    await expect(
      tool.handler({ taskId: 13, itemId: [433, 431, 475], confirmDelete: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.HEADING_DELETE_NEEDS_CONFIRM,
    })
    // batchV2 must NOT have been called — we refuse before destructive work.
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('batch mode reports per-id outcomes including failures', async () => {
    fake.v2Call.mockResolvedValue(fakeChecklistList())
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk(true),
        { isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['access denied'] },
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [475, 476], confirmDelete: true })

    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      total: number
      ok: number
      failed: number
      results: { itemId: number; ok: boolean; error?: string }[]
    }
    expect(payload).toMatchObject({ batch: true, verb: 'deleted', total: 2, ok: 1, failed: 1 })
    expect(payload.results[1]!.error).toMatch(/access denied/)
  })

  it('batch rejects > 50 ids with BATCH_TOO_LARGE BEFORE confirm gate fires (cap check is factory-side)', async () => {
    // Cap check lives in `defineActionTool` dispatch — runs before the
    // spec's runBatch (which calls assertConfirmedDelete). Result: agent
    // missing both `force` AND `confirmDelete` sees BATCH_TOO_LARGE
    // first, learns about the confirm requirement only on retry with
    // force=true. Same dispatch order as `delete_elapsed_time`.
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(tool.handler({ taskId: 1, itemId: ids })).rejects.toMatchObject({
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })

    // With force=true the cap clears; now the confirm gate fires.
    await expect(
      tool.handler({ taskId: 1, itemId: ids, force: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })

    // No wire call in either refusal path.
    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('schema accepts confirmDelete + confirmDeleteHeading as optional booleans (no coercion bypass)', () => {
    // Zod strictness: only true / false / undefined accepted; strings and
    // numbers rejected. Pins the same surface as delete_task_result.
    for (const schema of [tool.inputSchema.confirmDelete, tool.inputSchema.confirmDeleteHeading]) {
      expect(schema.safeParse(undefined).success).toBe(true)
      expect(schema.safeParse(true).success).toBe(true)
      expect(schema.safeParse(false).success).toBe(true)
      expect(schema.safeParse('true').success).toBe(false)
      expect(schema.safeParse(1).success).toBe(false)
      expect(schema.safeParse(null).success).toBe(false)
    }
  })
})
