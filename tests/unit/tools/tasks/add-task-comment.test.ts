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

interface CommentInput {
  taskId: number
  text: string
  authorId?: number
}

const tool = (await import('../../../../server/mcp/tools/tasks/add-task-comment')).default as unknown as {
  handler: (input: CommentInput) => Promise<ToolContent>
}

describe('bitrix24_add_task_comment', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('posts to task.commentitem.add with TASKID and FIELDS.POST_MESSAGE', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: 3141 }) })

    const result = await tool.handler({ taskId: 8017, text: 'smoke comment' })

    expect(callMethod).toHaveBeenCalledWith('task.commentitem.add', {
      TASKID: 8017,
      FIELDS: { POST_MESSAGE: 'smoke comment' },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ posted: true, taskId: 8017, commentId: 3141 })
  })

  it('passes AUTHOR_ID only when authorId is provided', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: 1 }) })

    await tool.handler({ taskId: 1, text: 'as someone else', authorId: 503 })
    const args = callMethod.mock.calls[0]![1] as { FIELDS: Record<string, unknown> }
    expect(args.FIELDS).toEqual({ POST_MESSAGE: 'as someone else', AUTHOR_ID: 503 })
  })

  it('handles a missing comment id with a friendly message', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: undefined }) })
    const result = await tool.handler({ taskId: 5, text: 'x' })
    expect(result.content[0]!.text).toMatch(/no comment id/i)
    expect(result.content[0]!.text).toMatch(/task 5/)
  })

  it('wraps SDK errors and tags the task id in the fallback message', async () => {
    callMethod.mockRejectedValue(new Error('insufficient permissions'))
    await expect(tool.handler({ taskId: 42, text: 'denied' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'insufficient permissions',
    })
  })
})
