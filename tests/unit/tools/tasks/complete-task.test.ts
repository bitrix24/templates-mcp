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

const tool = (await import('../../../../server/mcp/tools/tasks/complete-task')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('bitrix24_complete_task', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('calls tasks.task.complete and reports status 5 when task control is off', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 12, title: 'done', status: '5', responsibleId: '5' } } }),
    })

    const result = await tool.handler({ taskId: 12 })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.complete', { taskId: 12 })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      completed: true,
      id: 12,
      title: 'done',
      status: '5',
      responsibleId: '5',
    })
  })

  it('surfaces status 4 (Supposedly completed) when task control is on', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 13, title: 'review me', status: '4' } } }),
    })

    const payload = JSON.parse((await tool.handler({ taskId: 13 })).content[0]!.text)
    expect(payload.status).toBe('4')
  })

  it('falls back to a re-list message when Bitrix24 returns no task body', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: {} }) })
    const result = await tool.handler({ taskId: 99 })
    expect(result.content[0]!.text).toMatch(/99/)
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
