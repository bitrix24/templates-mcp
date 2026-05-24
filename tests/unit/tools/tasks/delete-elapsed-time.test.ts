import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../../server/utils/errors'
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

const tool = (await import('../../../../server/mcp/tools/tasks/delete-elapsed-time')).default as unknown as {
  handler: (input: {
    taskId: number
    itemId: number | number[]
    confirmDelete?: boolean
    force?: boolean
  }) => Promise<ToolContent>
}

describe('b24_task_elapsed_time_delete', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('single mode: posts task.elapseditem.delete with TASKID + ITEMID (confirmDelete: true)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    const result = await tool.handler({ taskId: 691, itemId: 5, confirmDelete: true })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.elapseditem.delete',
      params: { TASKID: 691, ITEMID: 5 },
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      deleted: true,
      taskId: 691,
      itemId: 5,
    })
  })

  it('batch mode: dispatches one batchV2 round-trip and shapes per-id results (confirmDelete: true)', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk(null),
        { isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['action not allowed'] },
        fakeOk(null),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 700, itemId: [10, 11, 12], confirmDelete: true })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      taskId: number
      total: number
      ok: number
      failed: number
      results: { itemId: number; ok: boolean; error?: string }[]
    }

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledWith({
      calls: [
        ['task.elapseditem.delete', { TASKID: 700, ITEMID: 10 }],
        ['task.elapseditem.delete', { TASKID: 700, ITEMID: 11 }],
        ['task.elapseditem.delete', { TASKID: 700, ITEMID: 12 }],
      ],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
    expect(payload).toMatchObject({ batch: true, verb: 'deleted', taskId: 700, total: 3, ok: 2, failed: 1 })
    expect(payload.results.map((r) => [r.itemId, r.ok])).toEqual([
      [10, true],
      [11, false],
      [12, true],
    ])
    expect(payload.results[1]!.error).toMatch(/action not allowed/)
  })

  it('refuses single delete without confirmDelete: true and names the target in the message (Ground Rule #9)', async () => {
    await expect(tool.handler({ taskId: 1, itemId: 5 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      // Single-mode message must name the target so the operator sees
      // exactly which entry they're agreeing to delete.
      message: expect.stringMatching(/elapsed-time entry 5 on task 1/) as unknown as string,
    })
    await expect(tool.handler({ taskId: 1, itemId: 5, confirmDelete: false })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })
    // No wire call should have fired in either refusal path.
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('refuses batch delete without confirmDelete: true (Ground Rule #9)', async () => {
    await expect(tool.handler({ taskId: 1, itemId: [5, 7, 9] })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      // Message must name the targets so the operator sees what they're confirming.
      message: expect.stringMatching(/3 elapsed-time entries \[5, 7, 9\] on task 1/) as unknown as string,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('batch mode rejects > 50 ids by default and accepts the same with force=true', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(tool.handler({ taskId: 1, itemId: ids, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map(() => fakeOk(null)),
      getErrorMessages: () => [],
    })
    const payload = JSON.parse(
      (await tool.handler({ taskId: 1, itemId: ids, confirmDelete: true, force: true })).content[0]!.text,
    ) as { total: number; ok: number }
    expect(payload.total).toBe(51)
    expect(payload.ok).toBe(51)
  })

  it('single-element array [42] enters batch mode (does NOT short-circuit to runOne)', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [fakeOk(null)],
      getErrorMessages: () => [],
    })
    const result = await tool.handler({ taskId: 1, itemId: [42], confirmDelete: true })

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      total: number
      taskId: number
      results: { itemId: number; ok: boolean }[]
    }
    expect(payload).toMatchObject({ batch: true, total: 1, taskId: 1 })
    expect(payload.results[0]!.itemId).toBe(42)
  })

  it('wraps SDK errors into Bitrix24ToolError on single mode', async () => {
    fake.v2Call.mockRejectedValue(new Error('not found'))
    await expect(tool.handler({ taskId: 1, itemId: 99, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'not found',
    })
  })

  it('wraps SDK errors into Bitrix24ToolError on batch mode (network throw)', async () => {
    fake.v2Batch.mockRejectedValue(new Error('timeout'))
    await expect(
      tool.handler({ taskId: 1, itemId: [5, 7, 9], confirmDelete: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'timeout',
    })
  })

  it('confirm gate STILL fires when force=true bypasses BATCH_TOO_LARGE on >50 ids', async () => {
    // Force overrides only the batch-cap (BATCH_TOO_LARGE), not the
    // confirm gate. Confirm + cap are independent guards; the agent that
    // passes force=true to bypass the cap still hits DELETE_NEEDS_CONFIRM
    // if it didn't confirm. The current dispatch order surfaces
    // BATCH_TOO_LARGE FIRST (factory-side, before runBatch is called),
    // so confirm-without-force first hits BATCH_TOO_LARGE; agent retries
    // with force=true and then hits DELETE_NEEDS_CONFIRM. This test pins
    // that order. If the dispatch ever reorders (e.g. via a pre-dispatch
    // confirm hook), this test should be updated to assert
    // DELETE_NEEDS_CONFIRM is raised first.
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    // Step 1: no force, no confirm → BATCH_TOO_LARGE (cap check runs first)
    await expect(tool.handler({ taskId: 1, itemId: ids })).rejects.toMatchObject({
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })

    // Step 2: force=true overrides cap, but confirm is still missing →
    // gate fires. Agent learns about the gate only on this second attempt.
    await expect(
      tool.handler({ taskId: 1, itemId: ids, force: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })

    expect(fake.v2Batch).not.toHaveBeenCalled()
  })
})
