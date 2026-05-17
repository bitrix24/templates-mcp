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

describe('bitrix24_renew_checklist_item', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
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

  it('batch mode runs through every itemId sequentially', async () => {
    fake.v2Call.mockResolvedValueOnce(fakeOk(true)).mockResolvedValueOnce(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: [21, 22] })

    expect(fake.v2Call).toHaveBeenCalledTimes(2)
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, verb: 'renewed', taskId: 13, total: 2, ok: 2, failed: 0 })
  })
})
