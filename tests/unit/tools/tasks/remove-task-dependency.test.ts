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

const tool = (await import('../../../../server/mcp/tools/tasks/remove-task-dependency')).default as unknown as {
  handler: (input: {
    taskIdTo: number
    taskIdFrom: number | number[]
    confirmDelete?: boolean
    force?: boolean
  }) => Promise<ToolContent>
  inputSchema: {
    taskIdTo: z.ZodNumber
    taskIdFrom: z.ZodType<number | number[]>
    confirmDelete: z.ZodOptional<z.ZodBoolean>
    force: z.ZodOptional<z.ZodBoolean>
  }
}

describe('b24_task_dependency_remove', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('single mode: posts task.dependence.delete with the camelCase wire shape (confirmDelete: true)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: 50, confirmDelete: true })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.dependence.delete',
      params: { taskIdFrom: 50, taskIdTo: 100 },
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      unlinked: true,
      taskIdTo: 100,
      taskIdFrom: 50,
    })
  })

  it('batch mode: dispatches one batchV2 round-trip and shapes per-id results (confirmDelete: true)', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk([]),
        // Bitrix24 reuses the ILLEGAL_NEW_LINK code for "link doesn't
        // exist" on delete — per-row failure preserved by the factory.
        {
          isSuccess: false,
          getData: () => ({ result: null }),
          getErrorMessages: () => ['ILLEGAL_NEW_LINK: link does not exist'],
        },
        fakeOk([]),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: [5, 7, 9], confirmDelete: true })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      taskIdTo: number
      total: number
      ok: number
      failed: number
      results: { taskIdFrom: number; ok: boolean; error?: string }[]
    }

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledWith({
      calls: [
        ['task.dependence.delete', { taskIdFrom: 5, taskIdTo: 100 }],
        ['task.dependence.delete', { taskIdFrom: 7, taskIdTo: 100 }],
        ['task.dependence.delete', { taskIdFrom: 9, taskIdTo: 100 }],
      ],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
    expect(payload).toMatchObject({
      batch: true,
      verb: 'unlinked',
      taskIdTo: 100,
      total: 3,
      ok: 2,
      failed: 1,
    })
    expect(payload.results.map((r) => [r.taskIdFrom, r.ok])).toEqual([
      [5, true],
      [7, false],
      [9, true],
    ])
    expect(payload.results[1]!.error).toMatch(/ILLEGAL_NEW_LINK/)
  })

  it('refuses single removal without confirmDelete: true and names the target in the message (Ground Rule #9)', async () => {
    await expect(tool.handler({ taskIdTo: 100, taskIdFrom: 50 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      // Message must name the pair so the operator sees exactly which
      // link they're agreeing to remove.
      message: expect.stringMatching(/dependency link 50 → task 100/) as unknown as string,
    })
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: 50, confirmDelete: false }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('refuses batch removal without confirmDelete: true and names the targets (Ground Rule #9)', async () => {
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: [5, 7, 9] }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringMatching(/3 dependency link\(s\) \[5, 7, 9\] → task 100/) as unknown as string,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('mentions the tool name in the re-call instruction (shared helper interpolation)', async () => {
    await expect(tool.handler({ taskIdTo: 100, taskIdFrom: 50 })).rejects.toMatchObject({
      message: expect.stringContaining(
        'Re-call `b24_task_dependency_remove` with `confirmDelete: true`',
      ) as unknown as string,
    })
  })

  it('batch mode rejects > 50 ids by default and accepts the same with force=true', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: ids, confirmDelete: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map(() => fakeOk([])),
      getErrorMessages: () => [],
    })
    const payload = JSON.parse(
      (
        await tool.handler({ taskIdTo: 100, taskIdFrom: ids, confirmDelete: true, force: true })
      ).content[0]!.text,
    ) as { total: number; ok: number }
    expect(payload.total).toBe(51)
    expect(payload.ok).toBe(51)
  })

  it('single-element array [5] enters batch mode (does NOT short-circuit to runOne)', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [fakeOk([])],
      getErrorMessages: () => [],
    })
    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: [5], confirmDelete: true })

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      total: number
      taskIdTo: number
      results: { taskIdFrom: number; ok: boolean }[]
    }
    expect(payload).toMatchObject({ batch: true, total: 1, taskIdTo: 100 })
    expect(payload.results[0]!.taskIdFrom).toBe(5)
  })

  it('wraps SDK errors into Bitrix24ToolError on single mode', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: 50, confirmDelete: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('wraps SDK errors into Bitrix24ToolError on batch mode (network throw aborts the whole batch)', async () => {
    fake.v2Batch.mockRejectedValue(new Error('timeout'))
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: [5, 7, 9], confirmDelete: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'timeout',
    })
  })

  it('schema accepts a positive int taskIdTo and rejects 0 / negatives / floats', () => {
    // Mirrors the schema-pin on confirmDelete — guards against silent
    // constraint drift that would let bad ids through to the wire.
    expect(tool.inputSchema.taskIdTo.safeParse(100).success).toBe(true)
    expect(tool.inputSchema.taskIdTo.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.taskIdTo.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.taskIdTo.safeParse(1.5).success).toBe(false)
  })

  it('schema accepts confirmDelete as optional boolean, rejects coerced string/number forms', () => {
    // Mirrors the schema-pin block on delete-task-result / delete-checklist-item.
    // Pins the wire-side contract of `confirmDeleteSchema()` for this tool —
    // a future refactor of the shared schema must not silently change
    // coercion behaviour for the delete-dependency path.
    expect(tool.inputSchema.confirmDelete.safeParse(undefined).success).toBe(true)
    expect(tool.inputSchema.confirmDelete.safeParse(true).success).toBe(true)
    expect(tool.inputSchema.confirmDelete.safeParse(false).success).toBe(true)
    // Zod's strict boolean — `"true"` string is rejected; no coercion bypass.
    expect(tool.inputSchema.confirmDelete.safeParse('true').success).toBe(false)
    expect(tool.inputSchema.confirmDelete.safeParse(1).success).toBe(false)
    expect(tool.inputSchema.confirmDelete.safeParse(null).success).toBe(false)
  })

  it('confirm gate STILL fires when force=true bypasses BATCH_TOO_LARGE on >50 ids (same precedence as delete_elapsed_time)', async () => {
    // Mirrors the precedence test on delete_elapsed_time — BATCH_TOO_LARGE
    // is raised by the factory BEFORE runBatch runs, so an unconfirmed
    // 51-id call hits the cap first; once force=true overrides the cap,
    // the confirm gate (inside runBatch) fires.
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: ids }),
    ).rejects.toMatchObject({ code: Bitrix24ErrorCode.BATCH_TOO_LARGE })

    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: ids, force: true }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
    })

    expect(fake.v2Batch).not.toHaveBeenCalled()
  })
})
