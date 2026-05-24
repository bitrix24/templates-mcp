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

const tool = (await import('../../../../server/mcp/tools/tasks/delete-task-result')).default as unknown as {
  handler: (input: { resultId: number; confirmDelete?: boolean }) => Promise<ToolContent>
  inputSchema: { resultId: z.ZodNumber; confirmDelete: z.ZodOptional<z.ZodBoolean> }
}

describe('b24_task_result_delete', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('posts to tasks.task.result.delete with { id } when confirmDelete: true', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ result: true }))

    const result = await tool.handler({ resultId: 17, confirmDelete: true })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.delete',
      params: { id: 17 },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, resultId: 17 })
  })

  it('refuses without confirmDelete: true and names the target in the message (Ground Rule #9)', async () => {
    await expect(tool.handler({ resultId: 42 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringMatching(/task result 42/) as unknown as string,
    })
    // Explicit `false` path must produce the same error shape (name +
    // code + message format) — pins symmetry vs. `undefined`.
    await expect(tool.handler({ resultId: 42, confirmDelete: false })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringMatching(/task result 42/) as unknown as string,
    })
    // No wire call should have fired in either refusal path.
    expect(fake.v3Call).not.toHaveBeenCalled()
  })

  it('wraps SDK errors with the resultId in the fallback', async () => {
    fake.v3Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ resultId: 42, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('treats `result: false` from Bitrix24 as a non-throw — callV3 succeeded, the server merely refused', async () => {
    // Bitrix24 sometimes returns `{ result: false }` when the delete target
    // does not exist (no-op rather than 404). callV3 doesn't inspect the
    // payload — it only checks isSuccess. The tool should still respond
    // with `deleted: true` so the agent doesn't loop on retries.
    fake.v3Call.mockResolvedValue(fakeOk({ result: false }))
    const result = await tool.handler({ resultId: 999999, confirmDelete: true })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, resultId: 999999 })
  })

  it('propagates ACCESSDENIEDEXCEPTION codes (author-only endpoint)', async () => {
    fake.v3Call.mockRejectedValue(
      Object.assign(new Error('Access denied'), {
        code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
      }),
    )
    await expect(tool.handler({ resultId: 42, confirmDelete: true })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
    })
  })

  it('schema rejects non-positive resultId at the Zod layer', () => {
    expect(tool.inputSchema.resultId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.resultId.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.resultId.safeParse(1.5).success).toBe(false)
  })

  it('schema accepts confirmDelete as optional boolean', () => {
    expect(tool.inputSchema.confirmDelete.safeParse(undefined).success).toBe(true)
    expect(tool.inputSchema.confirmDelete.safeParse(true).success).toBe(true)
    expect(tool.inputSchema.confirmDelete.safeParse(false).success).toBe(true)
    // Zod's strict boolean — `"true"` string is rejected; no coercion bypass.
    expect(tool.inputSchema.confirmDelete.safeParse('true').success).toBe(false)
    expect(tool.inputSchema.confirmDelete.safeParse(1).success).toBe(false)
  })
})
