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

const tool = (await import('../../../../server/mcp/tools/tasks/update-task-result')).default as unknown as {
  handler: (input: { resultId: number; text: string }) => Promise<ToolContent>
  inputSchema: { resultId: z.ZodNumber; text: z.ZodString }
}

describe('b24_task_result_update', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('posts to tasks.task.result.update with id + fields.text', async () => {
    fake.v3Call.mockResolvedValue(
      fakeOk({
        item: {
          id: 17,
          taskId: 51,
          text: 'rewritten',
          updatedAt: '2026-04-30T10:25:00+03:00',
          status: 'open',
        },
      }),
    )

    const result = await tool.handler({ resultId: 17, text: 'rewritten' })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.update',
      params: { id: 17, fields: { text: 'rewritten' } },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      updated: true,
      id: 17,
      taskId: 51,
      text: 'rewritten',
      updatedAt: '2026-04-30T10:25:00+03:00',
    })
  })

  it('falls back to a friendly message when Bitrix24 returns no item body', async () => {
    fake.v3Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ resultId: 17, text: 'x' })
    expect(result.content[0]!.text).toMatch(/result 17/i)
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors with the resultId in the fallback', async () => {
    fake.v3Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ resultId: 42, text: 'denied' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('schema rejects empty text and non-positive resultId at the Zod layer', () => {
    expect(tool.inputSchema.text.safeParse('').success).toBe(false)
    expect(tool.inputSchema.resultId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.resultId.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.resultId.safeParse(1.5).success).toBe(false)
  })

  it('schema rejects updated text longer than 10000 chars (memory-DoS guard, matches add_task_result)', () => {
    expect(tool.inputSchema.text.safeParse('a'.repeat(10_000)).success).toBe(true)
    expect(tool.inputSchema.text.safeParse('a'.repeat(10_001)).success).toBe(false)
  })

  it('propagates ACCESSDENIEDEXCEPTION codes (author-only endpoint)', async () => {
    fake.v3Call.mockRejectedValue(
      Object.assign(new Error('Access denied'), {
        code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
      }),
    )
    await expect(tool.handler({ resultId: 42, text: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
    })
  })
})
