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

const tool = (await import('../../../../server/mcp/tools/tasks/defer-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('bitrix24_defer_task', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('calls tasks.task.defer and returns the deferred-task summary', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 21, title: 'later', status: '6', responsibleId: '5' } } }),
    })

    const result = await tool.handler({ taskId: 21 })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.defer', { taskId: 21 })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      deferred: true,
      id: 21,
      title: 'later',
      status: '6',
      responsibleId: '5',
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
