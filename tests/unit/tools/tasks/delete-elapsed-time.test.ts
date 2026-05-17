import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    force?: boolean
  }) => Promise<ToolContent>
}

describe('bitrix24_delete_elapsed_time', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('single mode: posts task.elapseditem.delete with TASKID + ITEMID', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    const result = await tool.handler({ taskId: 691, itemId: 5 })

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

  it('batch mode: dispatches one batchV2 round-trip and shapes per-id results', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk(null),
        { isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['action not allowed'] },
        fakeOk(null),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 700, itemId: [10, 11, 12] })
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

  it('batch mode rejects > 50 ids by default and accepts the same with force=true', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(tool.handler({ taskId: 1, itemId: ids })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'BATCH_TOO_LARGE',
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map(() => fakeOk(null)),
      getErrorMessages: () => [],
    })
    const payload = JSON.parse(
      (await tool.handler({ taskId: 1, itemId: ids, force: true })).content[0]!.text,
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
    const result = await tool.handler({ taskId: 1, itemId: [42] })

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, total: 1, taskId: 1 })
  })

  it('wraps SDK errors into Bitrix24ToolError on single mode', async () => {
    fake.v2Call.mockRejectedValue(new Error('not found'))
    await expect(tool.handler({ taskId: 1, itemId: 99 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'not found',
    })
  })
})
