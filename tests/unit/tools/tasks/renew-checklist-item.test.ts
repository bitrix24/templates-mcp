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

const tool = (await import('../../../../server/mcp/tools/tasks/renew-checklist-item')).default as unknown as {
  handler: (input: { taskId: number; itemId: number | number[]; force?: boolean }) => Promise<ToolContent>
}

describe('b24_task_checklist_item_renew', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('calls task.checklistitem.renew with positional [taskId, itemId]', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: 21 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.renew',
      params: [13, 21],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ renewed: true, taskId: 13, itemId: 21 })
  })

  it('wraps SDK errors with task and item ids in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 13, itemId: 21 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('batch mode dispatches one v2 batch.make call with renew tuples', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [fakeOk(true), fakeOk(true)],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [21, 22] })

    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const calls = (fake.v2Batch.mock.calls[0]![0] as unknown as { calls: Array<[string, unknown[]]> }).calls
    expect(calls).toEqual([
      ['task.checklistitem.renew', [13, 21]],
      ['task.checklistitem.renew', [13, 22]],
    ])
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      batch: true,
      verb: 'renewed',
      taskId: 13,
      total: 2,
      ok: 2,
      failed: 0,
    })
  })
})
