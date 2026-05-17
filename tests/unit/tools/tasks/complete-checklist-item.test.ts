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

const tool = (await import('../../../../server/mcp/tools/tasks/complete-checklist-item')).default as unknown as {
  handler: (input: { taskId: number; itemId: number | number[]; force?: boolean }) => Promise<ToolContent>
}

describe('bitrix24_complete_checklist_item', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
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

  it('batch mode: completes every itemId and returns a per-id summary', async () => {
    fake.v2Call
      .mockResolvedValueOnce(fakeOk(true))
      .mockRejectedValueOnce(new Error('action not allowed'))
      .mockResolvedValueOnce(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: [21, 22, 23] })

    expect(fake.v2Call).toHaveBeenCalledTimes(3)
    for (const call of fake.v2Call.mock.calls) {
      expect(call[0]).toMatchObject({ method: 'task.checklistitem.complete' })
      expect(Array.isArray(call[0].params)).toBe(true)
    }

    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      taskId: number
      total: number
      ok: number
      failed: number
      results: { itemId: number; ok: boolean }[]
    }
    expect(payload).toMatchObject({ batch: true, verb: 'completed', taskId: 13, total: 3, ok: 2, failed: 1 })
    expect(payload.results.map((r) => [r.itemId, r.ok])).toEqual([
      [21, true],
      [22, false],
      [23, true],
    ])
  })

  it('batch mode rejects > 25 ids without force', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => i + 1)
    await expect(tool.handler({ taskId: 1, itemId: ids })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'BATCH_TOO_LARGE',
    })
  })
})
