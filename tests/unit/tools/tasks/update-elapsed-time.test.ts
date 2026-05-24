import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../../server/utils/errors'
import type { z } from 'zod'
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

const tool = (await import('../../../../server/mcp/tools/tasks/update-elapsed-time')).default as unknown as {
  handler: (input: {
    taskId: number
    itemId: number
    seconds?: number
    comment?: string
    userId?: number
  }) => Promise<ToolContent>
  inputSchema: {
    seconds: z.ZodOptional<z.ZodNumber>
    comment: z.ZodOptional<z.ZodString>
    userId: z.ZodOptional<z.ZodNumber>
  }
}

describe('b24_task_elapsed_time_update', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('updates only the fields the operator changed (sparse ARFIELDS on the wire)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, seconds: 1200 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.elapseditem.update',
      params: { TASKID: 691, ITEMID: 5, ARFIELDS: { SECONDS: 1200 } },
    })
  })

  it('distinguishes empty-string COMMENT_TEXT (explicit clear) from omitted (no-op)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, comment: '' })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { ARFIELDS: Record<string, unknown> } }
    expect(args.params.ARFIELDS).toEqual({ COMMENT_TEXT: '' })
    // Crucially, SECONDS / USER_ID are NOT in ARFIELDS — they would be
    // overwritten if we'd sent them through.
    expect('SECONDS' in args.params.ARFIELDS).toBe(false)
  })

  it('combines multiple field changes into a single update call', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, seconds: 900, comment: 'updated', userId: 47 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { ARFIELDS: Record<string, unknown> } }
    expect(args.params.ARFIELDS).toEqual({ SECONDS: 900, COMMENT_TEXT: 'updated', USER_ID: 47 })

    const payload = JSON.parse(
      (await tool.handler({ taskId: 691, itemId: 5, seconds: 900, comment: 'updated', userId: 47 })).content[0]!.text,
    )
    expect(payload).toEqual({
      updated: true,
      taskId: 691,
      itemId: 5,
      seconds: 900,
      comment: 'updated',
      userId: 47,
    })
  })

  it('refuses an update with no changes (NO_CHANGES error code)', async () => {
    await expect(tool.handler({ taskId: 691, itemId: 5 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.NO_CHANGES,
    })
    // The handler short-circuits — no wire call should have been made.
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('treats `comment: ""` as a real change (explicit clear) — does NOT trigger NO_CHANGES', async () => {
    // Edge of the semantics: empty-string is a deliberate operator
    // action ("wipe the comment"), distinguishable from undefined (no-op).
    // Without this guard, the LLM's "clear it" intent would hit the
    // NO_CHANGES refusal and look like a bug.
    fake.v2Call.mockResolvedValue(fakeOk(null))
    const result = await tool.handler({ taskId: 691, itemId: 5, comment: '' })

    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ updated: true, taskId: 691, itemId: 5, comment: '' })
  })

  it('wraps SDK errors (e.g. ACCESS_DENIED from non-author edits) into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 5, itemId: 7, seconds: 600 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('schema rejects non-positive / zero / float / >86400 seconds (same guards as add)', () => {
    expect(tool.inputSchema.seconds.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(1.5).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(86_400).success).toBe(true)
    expect(tool.inputSchema.seconds.safeParse(86_401).success).toBe(false)
    expect(tool.inputSchema.seconds.safeParse(undefined).success).toBe(true)
  })

  it('schema rejects comment longer than 4000 chars (memory-DoS guard)', () => {
    expect(tool.inputSchema.comment.safeParse('a'.repeat(4_000)).success).toBe(true)
    expect(tool.inputSchema.comment.safeParse('a'.repeat(4_001)).success).toBe(false)
    expect(tool.inputSchema.comment.safeParse('').success).toBe(true) // empty is fine — explicit-clear
  })

  it('schema rejects non-positive / zero / float userId', () => {
    expect(tool.inputSchema.userId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.userId.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.userId.safeParse(1.5).success).toBe(false)
    expect(tool.inputSchema.userId.safeParse(47).success).toBe(true)
  })
})
