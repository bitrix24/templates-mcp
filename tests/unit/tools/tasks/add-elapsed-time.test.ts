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

const tool = (await import('../../../../server/mcp/tools/tasks/add-elapsed-time')).default as unknown as {
  handler: (input: {
    taskId: number
    seconds: number
    comment?: string
    userId?: number
  }) => Promise<ToolContent>
  inputSchema: {
    taskId: z.ZodNumber
    seconds: z.ZodNumber
    comment: z.ZodOptional<z.ZodString>
    userId: z.ZodOptional<z.ZodNumber>
  }
}

describe('b24_task_elapsed_time_add', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('posts to task.elapseditem.add with TASKID + ARFIELDS shape', async () => {
    // Bitrix24 returns the new id as a bare integer at `result`.
    fake.v2Call.mockResolvedValue(fakeOk(5))
    const result = await tool.handler({ taskId: 691, seconds: 113, comment: 'fixed the bug' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.elapseditem.add',
      params: {
        TASKID: 691,
        ARFIELDS: {
          SECONDS: 113,
          COMMENT_TEXT: 'fixed the bug',
        },
      },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      added: true,
      id: 5,
      taskId: 691,
      seconds: 113,
      comment: 'fixed the bug',
    })
  })

  it('omits COMMENT_TEXT default and userId when neither is provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(7))
    await tool.handler({ taskId: 100, seconds: 60 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      params: { ARFIELDS: { SECONDS: number; COMMENT_TEXT: string; USER_ID?: number } }
    }
    expect(args.params.ARFIELDS.SECONDS).toBe(60)
    expect(args.params.ARFIELDS.COMMENT_TEXT).toBe('')
    // USER_ID must NOT appear when the operator didn't supply one — Bitrix24
    // falls back to the webhook user, and an explicit field would force the
    // wire to include it.
    expect('USER_ID' in args.params.ARFIELDS).toBe(false)
  })

  it('includes USER_ID only when the operator supplied one (logging on behalf of)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(8))
    await tool.handler({ taskId: 100, seconds: 1800, userId: 47 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      params: { ARFIELDS: { USER_ID?: number } }
    }
    expect(args.params.ARFIELDS.USER_ID).toBe(47)

    const payload = JSON.parse((await tool.handler({ taskId: 100, seconds: 1800, userId: 47 })).content[0]!.text)
    expect(payload.userId).toBe(47)
  })

  it('coerces a stringified id in the wire response (Bitrix24 v2 quirk)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk('15' as unknown as number))
    const payload = JSON.parse((await tool.handler({ taskId: 1, seconds: 60 })).content[0]!.text)
    expect(payload.id).toBe(15)
  })

  it('falls back to a friendly message when Bitrix24 returns no body', async () => {
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 99, seconds: 60 })
    expect(result.content[0]!.text).toMatch(/task 99/)
    expect(result.content[0]!.text).toMatch(/unexpected body shape/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 5, seconds: 60 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('schema rejects non-positive / zero / float seconds', () => {
    expect(tool.inputSchema.seconds.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(1.5).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(60).success).toBe(true)
  })

  it('schema caps seconds at 86400 (unit-confusion guard)', () => {
    // Catches the "I meant minutes" mistake — 1440 minutes ≠ 1440 seconds.
    expect(tool.inputSchema.seconds.safeParse(86_400).success).toBe(true)
    expect(tool.inputSchema.seconds.safeParse(86_401).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(1_000_000).success).toBe(false)
  })

  it('schema caps comment at 4000 chars (memory-DoS guard)', () => {
    expect(tool.inputSchema.comment.safeParse('a'.repeat(4_000)).success).toBe(true)
    expect(tool.inputSchema.comment.safeParse('a'.repeat(4_001)).success).toBe(false)
  })
})
