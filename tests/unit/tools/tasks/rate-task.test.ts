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

const tool = (await import('../../../../server/mcp/tools/tasks/rate-task')).default as unknown as {
  handler: (input: { taskId: number; rating: 'positive' | 'negative' | 'none' }) => Promise<ToolContent>
}

describe('bitrix24_rate_task', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('maps positive rating to MARK=P via tasks.task.update', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 7, title: 'done well' } } }),
    })

    const result = await tool.handler({ taskId: 7, rating: 'positive' })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.update', {
      taskId: 7,
      fields: { MARK: 'P' },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rated: true,
      id: 7,
      title: 'done well',
      rating: 'positive',
      mark: 'P',
    })
  })

  it('maps negative rating to MARK=N', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: { task: { id: 8, title: 'redo' } } }) })

    await tool.handler({ taskId: 8, rating: 'negative' })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.update', {
      taskId: 8,
      fields: { MARK: 'N' },
    })
  })

  it('maps none to MARK=null to clear an existing rating', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: { task: { id: 9, title: 'unrated' } } }) })

    const result = await tool.handler({ taskId: 9, rating: 'none' })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.update', {
      taskId: 9,
      fields: { MARK: null },
    })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.rating).toBe('none')
    expect(payload.mark).toBeNull()
  })

  it('falls back to a re-list message when Bitrix24 returns no task body', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: {} }) })
    const result = await tool.handler({ taskId: 42, rating: 'positive' })
    expect(result.content[0]!.text).toMatch(/42/)
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    callMethod.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7, rating: 'positive' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
