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

const tool = (await import('../../../../server/mcp/tools/tasks/add-task-dependency')).default as unknown as {
  handler: (input: {
    taskIdTo: number
    taskIdFrom: number | number[]
    linkType: number
    force?: boolean
  }) => Promise<ToolContent>
  inputSchema: {
    taskIdTo: z.ZodNumber
    taskIdFrom: z.ZodType<number | number[]>
    linkType: z.ZodNumber
    force: z.ZodOptional<z.ZodBoolean>
  }
}

describe('b24_task_dependency_add', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('single mode: posts task.dependence.add with the camelCase wire shape', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: 50, linkType: 2 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.dependence.add',
      params: { taskIdFrom: 50, taskIdTo: 100, linkType: 2 },
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      linked: true,
      taskIdTo: 100,
      taskIdFrom: 50,
      linkType: 2,
    })
  })

  it('batch mode: dispatches one batchV2 round-trip and shapes per-id results, carrying taskIdTo + linkType into the summary', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk([]),
        // Bitrix24 returns ILLEGAL_NEW_LINK when the same pair already
        // has a dependency — per-row failure that must not abort the
        // batch.
        {
          isSuccess: false,
          getData: () => ({ result: null }),
          getErrorMessages: () => ['ILLEGAL_NEW_LINK: link already exists'],
        },
        fakeOk([]),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: [5, 7, 9], linkType: 2 })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      taskIdTo: number
      linkType: number
      total: number
      ok: number
      failed: number
      results: { taskIdFrom: number; ok: boolean; error?: string }[]
    }

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledWith({
      calls: [
        ['task.dependence.add', { taskIdFrom: 5, taskIdTo: 100, linkType: 2 }],
        ['task.dependence.add', { taskIdFrom: 7, taskIdTo: 100, linkType: 2 }],
        ['task.dependence.add', { taskIdFrom: 9, taskIdTo: 100, linkType: 2 }],
      ],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
    expect(payload).toMatchObject({
      batch: true,
      verb: 'linked',
      taskIdTo: 100,
      linkType: 2,
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

  it('batch mode rejects > 50 ids by default and accepts the same with force=true', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)

    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: ids, linkType: 2 }),
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
        await tool.handler({ taskIdTo: 100, taskIdFrom: ids, linkType: 2, force: true })
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
    const result = await tool.handler({ taskIdTo: 100, taskIdFrom: [5], linkType: 2 })

    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      taskIdTo: number
      linkType: number
      results: { taskIdFrom: number; ok: boolean }[]
    }
    expect(payload).toMatchObject({ batch: true, taskIdTo: 100, linkType: 2 })
    expect(payload.results[0]!.taskIdFrom).toBe(5)
  })

  it('wraps SDK errors into Bitrix24ToolError on single mode (e.g. ACTION_NOT_ALLOWED)', async () => {
    fake.v2Call.mockRejectedValue(
      Object.assign(new Error('cannot create cycle'), { code: 'ACTION_NOT_ALLOWED' }),
    )
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: 50, linkType: 2 }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'cannot create cycle',
    })
  })

  it('wraps SDK errors into Bitrix24ToolError on batch mode (network throw aborts the whole batch)', async () => {
    fake.v2Batch.mockRejectedValue(new Error('timeout'))
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: [5, 7, 9], linkType: 2 }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'timeout',
    })
  })

  it('refuses single self-loop (taskIdFrom === taskIdTo) before any wire call (INVALID_INPUT)', async () => {
    // Bitrix24 server-side rejects with ACTION_NOT_ALLOWED, but that
    // code is shared with cycle detection and rights failures — the
    // client-side refusal gives the LLM a precise reason and saves a
    // wasted round-trip.
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: 100, linkType: 2 }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.INVALID_INPUT,
      message: expect.stringMatching(/self-loop on task 100/) as unknown as string,
    })
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('refuses batch self-loops and names the offending taskIdFrom values', async () => {
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: [5, 100, 9, 100], linkType: 2 }),
    ).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.INVALID_INPUT,
      // Offenders listed so the operator knows which ids to drop without
      // having to reason from a generic ACTION_NOT_ALLOWED.
      message: expect.stringMatching(/Offending taskIdFrom values: 100, 100/) as unknown as string,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('schema accepts a positive int taskIdTo and rejects 0 / negatives / floats', () => {
    // Mirrors the schema-pin on linkType — guards against silent
    // constraint drift that would let bad ids through to the wire.
    expect(tool.inputSchema.taskIdTo.safeParse(100).success).toBe(true)
    expect(tool.inputSchema.taskIdTo.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.taskIdTo.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.taskIdTo.safeParse(1.5).success).toBe(false)
  })

  it('schema accepts every valid linkType (0..3) and rejects out-of-range / non-integer values', () => {
    // Pins the `z.number().int().min(0).max(3)` contract. If someone
    // widens the range or relaxes the integer constraint, the tool
    // description (which enumerates 0..3 with operator semantics) goes
    // stale silently — this guard catches that drift.
    expect(tool.inputSchema.linkType.safeParse(0).success).toBe(true) // SS
    expect(tool.inputSchema.linkType.safeParse(1).success).toBe(true) // SF
    expect(tool.inputSchema.linkType.safeParse(2).success).toBe(true) // FS (default operator intent)
    expect(tool.inputSchema.linkType.safeParse(3).success).toBe(true) // FF
    expect(tool.inputSchema.linkType.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.linkType.safeParse(4).success).toBe(false)
    expect(tool.inputSchema.linkType.safeParse(1.5).success).toBe(false)
    // No string coercion — must arrive as a number on the wire.
    expect(tool.inputSchema.linkType.safeParse('2').success).toBe(false)
  })

  it('does NOT require confirmDelete — adds are not destructive (Rule #9 applies to delete tools only)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    // No confirmDelete field on input — must succeed.
    await expect(
      tool.handler({ taskIdTo: 100, taskIdFrom: 50, linkType: 2 }),
    ).resolves.toBeDefined()
    expect(fake.v2Call).toHaveBeenCalledTimes(1)
  })
})
