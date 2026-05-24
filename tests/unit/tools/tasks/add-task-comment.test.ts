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

interface CommentInput {
  taskId: number
  text: string
  authorId?: number
}

const tool = (await import('../../../../server/mcp/tools/tasks/add-task-comment')).default as unknown as {
  handler: (input: CommentInput) => Promise<ToolContent>
}

describe('b24_task_comment_add', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('posts to task.commentitem.add (v2) with TASKID and FIELDS.POST_MESSAGE', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(3141))

    const result = await tool.handler({ taskId: 8017, text: 'smoke comment' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.commentitem.add',
      params: { TASKID: 8017, FIELDS: { POST_MESSAGE: 'smoke comment' } },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ posted: true, taskId: 8017, commentId: 3141 })
  })

  it('passes AUTHOR_ID only when authorId is provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(1))

    await tool.handler({ taskId: 1, text: 'as someone else', authorId: 503 })
    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FIELDS: Record<string, unknown> } }
    expect(args.params.FIELDS).toEqual({ POST_MESSAGE: 'as someone else', AUTHOR_ID: 503 })
  })

  it('handles a missing comment id with a friendly message', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(undefined as unknown as number))
    const result = await tool.handler({ taskId: 5, text: 'x' })
    expect(result.content[0]!.text).toMatch(/no comment id/i)
    expect(result.content[0]!.text).toMatch(/task 5/)
  })

  it('wraps SDK errors and tags the task id in the fallback message', async () => {
    fake.v2Call.mockRejectedValue(new Error('insufficient permissions'))
    await expect(tool.handler({ taskId: 42, text: 'denied' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'insufficient permissions',
    })
  })
})
