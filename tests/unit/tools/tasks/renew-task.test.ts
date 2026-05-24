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

const tool = (await import('../../../../server/mcp/tools/tasks/renew-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('b24_task_renew', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('calls actions.v2.call.make with tasks.task.renew and returns the renewed-task summary', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 33, title: 'back to work', status: '2', responsibleId: '5' } }))

    const result = await tool.handler({ taskId: 33 })

    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'tasks.task.renew', params: { taskId: 33 } })
    // Regression guard: classic tasks.task.renew must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      renewed: true,
      id: 33,
      title: 'back to work',
      status: '2',
      responsibleId: '5',
    })
  })

  it('falls back to a re-list message when Bitrix24 returns no task body', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({}))
    const result = await tool.handler({ taskId: 1 })
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
