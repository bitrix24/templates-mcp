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

const tool = (await import('../../../../server/mcp/tools/tasks/delete-checklist-item')).default as unknown as {
  handler: (input: { taskId: number; itemId: number | number[]; force?: boolean }) => Promise<ToolContent>
}

describe('bitrix24_delete_checklist_item', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('calls task.checklistitem.delete with positional [taskId, itemId]', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: 475 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.delete',
      params: [13, 475],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, taskId: 13, itemId: 475 })
  })

  it('wraps SDK errors with task and item ids in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 13, itemId: 475 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('batch mode reports per-id outcomes including failures', async () => {
    fake.v2Call.mockResolvedValueOnce(fakeOk(true)).mockRejectedValueOnce(new Error('access denied'))

    const result = await tool.handler({ taskId: 13, itemId: [475, 476] })

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
})
