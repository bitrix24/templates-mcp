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

interface ListInput {
  taskId: number
  order?: {
    field: 'id' | 'authorId' | 'createdAt' | 'updatedAt' | 'status' | 'messageId'
    direction: 'asc' | 'desc'
  }
  limit?: number
  offset?: number
}

const tool = (await import('../../../../server/mcp/tools/tasks/list-task-results')).default as unknown as {
  handler: (input: ListInput) => Promise<ToolContent>
}

describe('b24_task_result_list', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('calls tasks.task.result.list with the required taskId filter and default order/pagination', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({
        items: [
          {
            id: 17,
            taskId: 51,
            text: 'First result',
            authorId: 1,
            createdAt: '2026-04-30T10:15:00+03:00',
            status: 'open',
            messageId: null,
          },
          {
            id: 18,
            taskId: 51,
            text: 'Second result',
            authorId: 1,
            createdAt: '2026-04-30T10:25:00+03:00',
            status: 'open',
            messageId: 335,
          },
        ],
      }),
    )

    const result = await tool.handler({ taskId: 51 })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.list',
      params: {
        filter: [['taskId', 51]],
        order: { createdAt: 'DESC' },
        select: ['id', 'taskId', 'text', 'authorId', 'createdAt', 'updatedAt', 'status', 'messageId'],
        pagination: { limit: 50, offset: 0 },
      },
    })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.taskId).toBe(51)
    expect(payload.returned).toBe(2)
    expect(payload.results.map((r: { id: number }) => r.id)).toEqual([17, 18])
  })

  it('forwards an explicit order and pagination', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ items: [] }))

    await tool.handler({ taskId: 51, order: { field: 'id', direction: 'asc' }, limit: 10, offset: 20 })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.list',
      params: {
        filter: [['taskId', 51]],
        order: { id: 'ASC' },
        select: ['id', 'taskId', 'text', 'authorId', 'createdAt', 'updatedAt', 'status', 'messageId'],
        pagination: { limit: 10, offset: 20 },
      },
    })
  })

  it('returns an empty list when Bitrix24 returns no items', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ items: [] }))
    const result = await tool.handler({ taskId: 99 })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ taskId: 99, returned: 0, results: [] })
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v3Call.mockRejectedValue(new Error('filter required'))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'filter required',
    })
  })
})
