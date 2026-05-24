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

interface UpdateInput {
  taskId: number
  fields: Record<string, unknown>
}

const tool = (await import('../../../../server/mcp/tools/tasks/update-task')).default as unknown as {
  handler: (input: UpdateInput) => Promise<ToolContent>
  inputSchema: { taskId: z.ZodType; fields: z.ZodType }
}

describe('b24_task_update', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('passes taskId and fields through and returns the updated summary', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        task: {
          id: 11,
          title: 'renamed',
          deadline: '2026-06-01T18:00:00+03:00',
          responsibleId: '5',
          status: '3',
        },
      }),
    )

    const result = await tool.handler({
      taskId: 11,
      fields: { TITLE: 'renamed', DEADLINE: '2026-06-01T18:00:00+03:00' },
    })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.update',
      params: { taskId: 11, fields: { TITLE: 'renamed', DEADLINE: '2026-06-01T18:00:00+03:00' } },
    })

    // Regression guard: classic tasks.task.update must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()

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
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 99, fields: { TITLE: 'x' } })
    expect(result.content[0]!.text).toMatch(/99/)
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('rejects non-UPPER_SNAKE_CASE field keys at the schema layer (no arbitrary keys into REST)', () => {
    const fields = tool.inputSchema.fields
    expect(fields.safeParse({ TITLE: 'ok' }).success).toBe(true)
    expect(fields.safeParse({ RESPONSIBLE_ID: 5, UF_CRM_TASK: ['D_10'] }).success).toBe(true)
    expect(fields.safeParse({ title: 'lower' }).success).toBe(false)
    expect(fields.safeParse({ 'weird-key': 1 }).success).toBe(false)
    expect(fields.safeParse({ '1TITLE': 1 }).success).toBe(false) // must start with a letter
    // JSON.parse makes __proto__ a real own enumerable key (unlike an object
    // literal) — the regex must reject it since it isn't UPPER_SNAKE_CASE.
    expect(fields.safeParse(JSON.parse('{"__proto__":1}')).success).toBe(false)
    expect(fields.safeParse({ A1: 1 }).success).toBe(true) // single letter + digit is valid
    expect(fields.safeParse({}).success).toBe(false) // still must be non-empty
  })

  it('wraps SDK errors and includes the task id in the fallback message', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7, fields: { STATUS: 5 } })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
