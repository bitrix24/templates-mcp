import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const callMethod = vi.fn()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod }),
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/tasks/approve-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('bitrix24_approve_task', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('calls tasks.task.approve and returns the approved-task summary', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 8017, title: 'x', status: '5', responsibleId: '547' } } }),
    })

    const result = await tool.handler({ taskId: 8017 })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.approve', { taskId: 8017 })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      approved: true,
      id: 8017,
      title: 'x',
      status: '5',
      responsibleId: '547',
    })
  })

  it('falls back to a re-list message when Bitrix24 returns no task body', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: {} }) })
    const result = await tool.handler({ taskId: 1 })
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    callMethod.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
