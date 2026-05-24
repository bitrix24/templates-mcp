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

const tool = (await import('../../../../server/mcp/tools/tasks/complete-checklist-item')).default as unknown as {
  handler: (input: { taskId: number; itemId: number | number[]; force?: boolean }) => Promise<ToolContent>
}

describe('b24_task_checklist_item_complete', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('calls actions.v2.call.make with task.checklistitem.complete + positional [taskId, itemId]', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: 21 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.complete',
      params: [13, 21],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ completed: true, taskId: 13, itemId: 21 })
  })

  it('wraps SDK errors with task and item ids in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 13, itemId: 21 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('one-element array enters batch mode and goes through v2 batch.make', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [fakeOk(true)],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [21] })

    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    expect(fake.v2Call).not.toHaveBeenCalled()
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, verb: 'completed', taskId: 13, total: 1, ok: 1, failed: 0 })
    expect(payload.results).toEqual([{ itemId: 21, ok: true }])
  })

  it('batch mode dispatches one v2 batch.make call with the right tuples and per-id outcomes', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk(true),
        { isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['action not allowed'] },
        fakeOk(true),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [21, 22, 23] })

    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const arg = fake.v2Batch.mock.calls[0]![0] as unknown as {
      calls: Array<[string, unknown[]]>
      options: { isHaltOnError: boolean; returnAjaxResult: boolean }
    }
    expect(arg.calls).toEqual([
      ['task.checklistitem.complete', [13, 21]],
      ['task.checklistitem.complete', [13, 22]],
      ['task.checklistitem.complete', [13, 23]],
    ])
    expect(arg.options).toEqual({ isHaltOnError: false, returnAjaxResult: true })

    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      total: number
      ok: number
      failed: number
      results: { itemId: number; ok: boolean; error?: string }[]
    }
    expect(payload).toMatchObject({ batch: true, total: 3, ok: 2, failed: 1 })
    expect(payload.results.map((r) => [r.itemId, r.ok])).toEqual([[21, true], [22, false], [23, true]])
    expect(payload.results[1]!.error).toMatch(/action not allowed/)
  })

  it('all-failure batch still returns a structured summary (ok: 0)', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        { isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['e1'] },
        { isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['e2'] },
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [1, 2] })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, total: 2, ok: 0, failed: 2 })
  })

  it('batch mode rejects > 50 ids without force', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    await expect(tool.handler({ taskId: 1, itemId: ids })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
  })

  it('force: true allows oversize batches', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map(() => fakeOk(true)),
      getErrorMessages: () => [],
    })
    const result = await tool.handler({ taskId: 1, itemId: ids, force: true })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, total: 51, ok: 51, failed: 0 })
  })
})
