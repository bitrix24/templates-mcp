import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24-tenant', () => ({
  useBitrix24Tenant: () => fake.b24,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/tasks/get-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('b24_task_get', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('routes through callV3 on tasks.task.get with the `id` wire param and nested select', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({ item: { id: 3703, title: 'demo', status: 'pending', deadline: '2026-09-04T16:00:00+03:00', responsible: { id: 33 }, priority: 'high', chat: { id: 5869 } } }),
    )

    const result = await tool.handler({ taskId: 3703 })

    // Verified against a live portal: the wire param is `id`, NOT `taskId`,
    // and `responsibleId` / `chatId` only come back nested.
    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.get',
      params: { id: 3703, select: ['id', 'title', 'status', 'deadline', 'responsible.id', 'priority', 'chat.id'] },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({
      id: 3703,
      title: 'demo',
      status: 'pending',
      deadline: '2026-09-04T16:00:00+03:00',
      responsibleId: 33,
      priority: 'high',
      chatId: 5869,
    })
  })

  it('reports chatId / responsibleId: null when the task has no linked chat / responsible in the response', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ item: { id: 1 } }))
    const result = await tool.handler({ taskId: 1 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.chatId).toBeNull()
    expect(payload.responsibleId).toBeNull()
  })

  it('returns a friendly message when the task is not found', async () => {
    fake.v3Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 999 })
    expect(result.content[0]!.text).toMatch(/not found/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v3Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 1 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
