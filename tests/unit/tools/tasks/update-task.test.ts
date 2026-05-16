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

interface UpdateInput {
  taskId: number
  fields: Record<string, unknown>
}

const tool = (await import('../../../../server/mcp/tools/tasks/update-task')).default as unknown as {
  handler: (input: UpdateInput) => Promise<ToolContent>
}

describe('bitrix24_update_task', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('passes taskId and fields through and returns the updated summary', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({
        result: {
          task: {
            id: 11,
            title: 'renamed',
            deadline: '2026-06-01T18:00:00+03:00',
            responsibleId: '5',
            status: '3',
          },
        },
      }),
    })

    const result = await tool.handler({
      taskId: 11,
      fields: { TITLE: 'renamed', DEADLINE: '2026-06-01T18:00:00+03:00' },
    })

    expect(callMethod).toHaveBeenCalledWith('tasks.task.update', {
      taskId: 11,
      fields: { TITLE: 'renamed', DEADLINE: '2026-06-01T18:00:00+03:00' },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({
      updated: true,
      id: 11,
      title: 'renamed',
      deadline: '2026-06-01T18:00:00+03:00',
      responsibleId: '5',
      status: '3',
    })
  })

  it('falls back to a "re-list to verify" message when Bitrix24 returns no body', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: {} }) })
    const result = await tool.handler({ taskId: 99, fields: { TITLE: 'x' } })
    expect(result.content[0]!.text).toMatch(/99/)
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors and includes the task id in the fallback message', async () => {
    callMethod.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7, fields: { STATUS: 5 } })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
