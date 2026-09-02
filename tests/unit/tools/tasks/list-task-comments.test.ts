import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

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

interface ListInput {
  taskId: number
  order?: { field: 'id' | 'postDate' | 'authorId'; direction: 'asc' | 'desc' }
}

const tool = (await import('../../../../server/mcp/tools/tasks/list-task-comments')).default as unknown as {
  handler: (input: ListInput) => Promise<ToolContent>
}

describe('b24_task_comment_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('defaults to postDate desc and shapes the response', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk([
        { ID: '10', TASK_ID: '8017', AUTHOR_ID: '5', AUTHOR_NAME: 'Maksim', POST_MESSAGE: 'ok', POST_DATE: '2026-06-01' },
        { ID: '11', TASK_ID: '8017', AUTHOR_ID: '7', POST_MESSAGE: '[USER=5]Maksim[/USER] взгляни', POST_DATE: '2026-06-02' },
      ]),
    )

    const result = await tool.handler({ taskId: 8017 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.commentitem.getlist',
      params: { TASKID: 8017, ORDER: { POST_DATE: 'DESC' } },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.taskId).toBe(8017)
    expect(payload.returned).toBe(2)
    expect(payload.comments[1].text).toContain('[USER=5]')
    expect(payload.comments[0]).toEqual({
      id: 10,
      taskId: 8017,
      authorId: 5,
      authorName: 'Maksim',
      text: 'ok',
      postDate: '2026-06-01',
    })
  })

  it('honors a custom sort order', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ taskId: 1, order: { field: 'id', direction: 'asc' } })
    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.commentitem.getlist',
      params: { TASKID: 1, ORDER: { ID: 'ASC' } },
    })
  })

  it('drops malformed comment entries silently', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([{ ID: '1', TASK_ID: '1', POST_MESSAGE: 'ok' }, { POST_MESSAGE: 'no id' }, null]))
    const result = await tool.handler({ taskId: 1 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.returned).toBe(1)
  })

  it('reports an empty list when Bitrix24 returns none', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    const result = await tool.handler({ taskId: 1 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ taskId: 1, returned: 0, comments: [] })
  })

  it('wraps SDK errors into Bitrix24ToolError, tagging the task id', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 42 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
