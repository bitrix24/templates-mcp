import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

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

const tool = (await import('../../../../server/mcp/tools/tasks/add-task-result')).default as unknown as {
  handler: (input: { taskId: number; text: string }) => Promise<ToolContent>
  inputSchema: { text: z.ZodString; taskId: z.ZodNumber }
}

describe('b24_task_result_add', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('posts to tasks.task.result.add with { fields: { taskId, text } }', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({
        item: {
          id: 17,
          taskId: 51,
          text: 'Done',
          authorId: 1,
          createdAt: '2026-04-30T10:15:00+03:00',
          status: 'open',
          messageId: null,
        },
      }),
    )

    const result = await tool.handler({ taskId: 51, text: 'Done' })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.add',
      params: { fields: { taskId: 51, text: 'Done' } },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      added: true,
      id: 17,
      taskId: 51,
      text: 'Done',
      authorId: 1,
      createdAt: '2026-04-30T10:15:00+03:00',
      updatedAt: null,
      status: 'open',
      messageId: null,
    })
  })

  it('surfaces messageId when the result was promoted from a chat message', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({
        item: {
          id: 18,
          taskId: 51,
          text: 'From chat',
          authorId: 1,
          createdAt: '2026-04-30T10:25:00+03:00',
          status: 'open',
          messageId: 335,
        },
      }),
    )
    const payload = JSON.parse((await tool.handler({ taskId: 51, text: 'From chat' })).content[0]!.text)
    expect(payload.messageId).toBe(335)
  })

  it('coerces stringified ids in the wire response', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({ item: { id: '17', taskId: '51', text: 'x', authorId: '503' } }),
    )
    const payload = JSON.parse((await tool.handler({ taskId: 51, text: 'x' })).content[0]!.text)
    expect(payload.id).toBe(17)
    expect(payload.taskId).toBe(51)
    expect(payload.authorId).toBe(503)
  })

  it('falls back to a friendly message when Bitrix24 returns no item body', async () => {
    fake.v3Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 5, text: 'x' })
    expect(result.content[0]!.text).toMatch(/task 5/)
    expect(result.content[0]!.text).toMatch(/no result body/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v3Call.mockRejectedValue(
      Object.assign(new Error('access denied'), { code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION' }),
    )
    await expect(tool.handler({ taskId: 42, text: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('schema rejects empty text and non-positive taskId', () => {
    expect(tool.inputSchema.text.safeParse('').success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(-1).success).toBe(false)
  })

  it('schema rejects result text longer than 10000 chars (memory-DoS guard)', () => {
    expect(tool.inputSchema.text.safeParse('a'.repeat(10_000)).success).toBe(true)
    expect(tool.inputSchema.text.safeParse('a'.repeat(10_001)).success).toBe(false)
    // Wildly oversized — protects against agents pasting log files or
    // base64 blobs into a result.
    expect(tool.inputSchema.text.safeParse('a'.repeat(10_000_000)).success).toBe(false)
  })
})
