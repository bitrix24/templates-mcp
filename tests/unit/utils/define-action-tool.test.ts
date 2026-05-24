import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../server/utils/errors'
import { z } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

// The factory does not call `useBitrix24` itself — `runOne` / `runBatch`
// callbacks own that. We still mock the module so any incidental import
// resolves cleanly.
vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({}),
}))

const { assertConfirmedDelete, defineActionTool, forceFlagSchema, idOrIdArraySchema, mapBatchRows } = await import(
  '../../../server/utils/define-action-tool'
)

interface ToolDef<TInput> {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (input: TInput) => Promise<{ content: { type: 'text'; text: string }[] }>
}

describe('idOrIdArraySchema', () => {
  it('accepts a positive integer', () => {
    expect(idOrIdArraySchema.safeParse(5).success).toBe(true)
  })

  it('accepts a non-empty array of positive integers', () => {
    expect(idOrIdArraySchema.safeParse([1, 2, 3]).success).toBe(true)
  })

  it('rejects zero, negatives, and floats', () => {
    expect(idOrIdArraySchema.safeParse(0).success).toBe(false)
    expect(idOrIdArraySchema.safeParse(-1).success).toBe(false)
    expect(idOrIdArraySchema.safeParse(1.5).success).toBe(false)
  })

  it('rejects empty arrays and mixed-invalid arrays', () => {
    expect(idOrIdArraySchema.safeParse([]).success).toBe(false)
    expect(idOrIdArraySchema.safeParse([1, -2]).success).toBe(false)
  })
})

describe('forceFlagSchema', () => {
  it('is optional and includes the cap in the description', () => {
    const schema = forceFlagSchema(25)
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse(true).success).toBe(true)
    expect(schema.description).toMatch(/25/)
  })
})

describe('defineActionTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches to runOne when extractIds returns a number', async () => {
    const runOne = vi.fn(async (_input: { id: number | number[] }, id: number) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id }) }],
    }))
    const runBatch = vi.fn()

    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean; error?: string }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne,
      runBatch,
    }) as unknown as ToolDef<{ id: number | number[] }>

    const result = await tool.handler({ id: 42 })
    expect(runOne).toHaveBeenCalledWith({ id: 42 }, 42)
    expect(runBatch).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, id: 42 })
  })

  it('dispatches to runBatch and shapes the summary envelope', async () => {
    const runOne = vi.fn()
    const runBatch = vi.fn(async () => [
      { id: 1, ok: true },
      { id: 2, ok: false, error: 'nope' },
      { id: 3, ok: true },
    ])

    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean; error?: string }>({
      name: 'fake',
      description: 'desc',
      usageNotes: ' batch notes.',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema, force: forceFlagSchema(25) },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne,
      runBatch,
    }) as unknown as ToolDef<{ id: number | number[]; force?: boolean }>

    const result = await tool.handler({ id: [1, 2, 3] })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      total: number
      ok: number
      failed: number
      results: { id: number; ok: boolean }[]
    }
    expect(runOne).not.toHaveBeenCalled()
    expect(payload).toMatchObject({
      batch: true,
      verb: 'done',
      total: 3,
      ok: 2,
      failed: 1,
    })
    expect(payload.results.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('rejects batches exceeding batchCap unless force=true is set', async () => {
    const runBatch = vi.fn(async (_input, ids: number[]) => ids.map((id) => ({ id, ok: true })))

    const tool = defineActionTool<{ id: number | number[]; force?: boolean }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema, force: forceFlagSchema(2) },
      batchCap: 2,
      extractIds: (input) => input.id,
      runOne: vi.fn(),
      runBatch,
    }) as unknown as ToolDef<{ id: number | number[]; force?: boolean }>

    await expect(tool.handler({ id: [1, 2, 3] })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
    expect(runBatch).not.toHaveBeenCalled()

    const ok = await tool.handler({ id: [1, 2, 3], force: true })
    const payload = JSON.parse(ok.content[0]!.text) as { total: number; ok: number }
    expect(payload.total).toBe(3)
    expect(payload.ok).toBe(3)
  })

  it('injects batchSummaryExtras into the summary envelope', async () => {
    const tool = defineActionTool<{ id: number | number[]; ctx: string }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema, ctx: z.string() },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne: vi.fn(),
      runBatch: async (_input, ids) => ids.map((id) => ({ id, ok: true })),
      batchSummaryExtras: (input) => ({ contextKey: input.ctx }),
    }) as unknown as ToolDef<{ id: number | number[]; ctx: string }>

    const result = await tool.handler({ id: [1, 2], ctx: 'task-7' })
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>
    expect(payload).toMatchObject({ batch: true, contextKey: 'task-7', total: 2, ok: 2 })
  })

  it('passes the POST-extractIds array to batchSummaryExtras (not the raw input id)', async () => {
    // Use a non-identity extractIds (sort ascending) to prove that extras
    // receives what the factory passed to runBatch — not the raw input.
    // If extras saw input.id directly, the test would assert [30, 10, 20];
    // because it must see the resolved array, the assertion is [10, 20, 30].
    const extras = vi.fn((_input: unknown, ids: number[]) => ({
      requestedCount: ids.length,
      firstId: ids[0],
    }))
    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema },
      batchCap: 25,
      extractIds: (input) => (Array.isArray(input.id) ? [...input.id].sort((a, b) => a - b) : input.id),
      runOne: vi.fn(),
      runBatch: async (_input, ids) => ids.map((id) => ({ id, ok: true })),
      batchSummaryExtras: extras,
    }) as unknown as ToolDef<{ id: number | number[] }>

    const result = await tool.handler({ id: [30, 10, 20] })
    const payload = JSON.parse(result.content[0]!.text) as {
      requestedCount: number
      firstId: number
      total: number
    }
    // Second arg is the sorted (post-extractIds) array, not the raw input.
    expect(extras).toHaveBeenCalledWith({ id: [30, 10, 20] }, [10, 20, 30])
    expect(payload.firstId).toBe(10)
    expect(payload.requestedCount).toBe(3)
    expect(payload.total).toBe(3)
  })

  it('propagates errors thrown by runOne (does not swallow them into the envelope)', async () => {
    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne: async () => {
        throw new Error('upstream API down')
      },
      runBatch: vi.fn(),
    }) as unknown as ToolDef<{ id: number | number[] }>

    await expect(tool.handler({ id: 7 })).rejects.toThrow('upstream API down')
  })

  it('propagates errors thrown by runBatch (does not swallow them into the envelope)', async () => {
    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema, force: forceFlagSchema(25) },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne: vi.fn(),
      runBatch: async () => {
        throw new Error('batch transport failed')
      },
    }) as unknown as ToolDef<{ id: number | number[]; force?: boolean }>

    await expect(tool.handler({ id: [1, 2, 3] })).rejects.toThrow('batch transport failed')
  })

  it('enters batch mode for a one-element array (does NOT short-circuit to runOne)', async () => {
    // A 1-element array is the explicit batch-mode opt-in per the schema's
    // contract — useful when the caller wants the batch summary envelope.
    const runOne = vi.fn()
    const runBatch = vi.fn(async (_input: unknown, ids: number[]) => ids.map((id) => ({ id, ok: true })))
    const tool = defineActionTool<{ id: number | number[] }, { id: number; ok: boolean }>({
      name: 'fake',
      description: 'desc',
      usageNotes: '',
      pastTense: 'done',
      inputSchema: { id: idOrIdArraySchema },
      batchCap: 25,
      extractIds: (input) => input.id,
      runOne,
      runBatch,
    }) as unknown as ToolDef<{ id: number | number[] }>

    const result = await tool.handler({ id: [42] })
    expect(runOne).not.toHaveBeenCalled()
    expect(runBatch).toHaveBeenCalledWith({ id: [42] }, [42])
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ batch: true, total: 1 })
  })
})

describe('mapBatchRows', () => {
  function okRow<T>(envelope: T) {
    return {
      isSuccess: true,
      getData: () => ({ result: envelope }),
      getErrorMessages: () => [],
    }
  }
  function errRow(messages: string[]) {
    return {
      isSuccess: false,
      getData: () => undefined,
      getErrorMessages: () => messages,
    }
  }

  it('aligns rows with ids in input order and surfaces ok/error per row', () => {
    const rows = [
      okRow({ value: 'first' }),
      errRow(['nope']),
      okRow({ value: 'third' }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any
    const out = mapBatchRows<{ value: string }, { id: number; ok: boolean; value?: string; error?: string }>(
      rows,
      [10, 20, 30],
      'id',
      ({ id, ok, envelope, errorMessages }) => {
        if (!ok) {
          return { id, ok: false, error: errorMessages.join('; ') || `Failed: ${id}` }
        }
        return { id, ok: true, value: envelope?.value }
      },
    )
    expect(out).toEqual([
      { id: 10, ok: true, value: 'first' },
      { id: 20, ok: false, error: 'nope' },
      { id: 30, ok: true, value: 'third' },
    ])
  })

  it('throws Bitrix24ToolError when rows are LONGER than ids (extra-rows drift)', () => {
    const rows = [okRow({ value: 'a' }), okRow({ value: 'b' }), okRow({ value: 'c' })]
    // Pin both the error class (so a stray generic Error wouldn't pass) and
    // the message format (so changes to the message surface in test diffs).
    expect(() =>
      mapBatchRows<{ value: string }, { id: number; ok: boolean }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows as any,
        [1, 2], // shorter than rows — upfront length check rejects
        'id',
        ({ id, ok }) => ({ id, ok }),
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'Bitrix24ToolError',
        message: expect.stringMatching(/SDK rows\/input length mismatch: 3 rows for 2 id entries/),
      }) as unknown as Error,
    )
  })

  it('throws Bitrix24ToolError when rows are SHORTER than ids (missing-rows drift)', () => {
    // The original `id === undefined` per-row check only caught extra
    // rows; missing rows would silently truncate the output. The upfront
    // length assert now catches both directions.
    const rows = [okRow({ value: 'a' })]
    expect(() =>
      mapBatchRows<{ value: string }, { id: number; ok: boolean }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows as any,
        [1, 2, 3], // longer than rows — would silently drop ids without the assert
        'id',
        ({ id, ok }) => ({ id, ok }),
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'Bitrix24ToolError',
        message: expect.stringMatching(/SDK rows\/input length mismatch: 1 rows for 3 id entries/),
      }) as unknown as Error,
    )
  })

  it('uses the errorFallback when SDK returns no error messages', () => {
    const rows = [errRow([])]
    const out = mapBatchRows<unknown, { id: number; ok: boolean; error?: string }>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows as any,
      [9],
      'id',
      ({ id, ok, errorMessages }) => {
        if (!ok) {
          return { id, ok: false, error: errorMessages.join('; ') || `Fallback for ${id}` }
        }
        return { id, ok: true }
      },
    )
    expect(out).toEqual([{ id: 9, ok: false, error: 'Fallback for 9' }])
  })
})

describe('assertConfirmedDelete', () => {
  it('returns silently when confirmed is true', () => {
    expect(() =>
      assertConfirmedDelete('b24_thing_delete', 'thing 5 on parent 1', true),
    ).not.toThrow()
  })

  it('throws DELETE_NEEDS_CONFIRM when confirmed is false', () => {
    expect(() =>
      assertConfirmedDelete('b24_thing_delete', 'thing 5 on parent 1', false),
    ).toThrow(
      expect.objectContaining({
        name: 'Bitrix24ToolError',
        code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      }) as unknown as Error,
    )
  })

  it('throws DELETE_NEEDS_CONFIRM when confirmed is undefined (the schema default)', () => {
    expect(() =>
      assertConfirmedDelete('b24_thing_delete', 'thing 5 on parent 1', undefined),
    ).toThrow(
      expect.objectContaining({
        name: 'Bitrix24ToolError',
        code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      }) as unknown as Error,
    )
  })

  it('interpolates both the target description AND the tool name into the message', () => {
    // The message wording is part of the public contract — consumer-tool
    // tests assert against the target-description substring; this test
    // additionally pins the `Re-call \`<toolName>\`` instruction so the
    // agent sees which exact tool to call back with `confirmDelete: true`.
    // Capture a single throw and assert both substrings against the same
    // error so the test pins ONE end-to-end message rather than two
    // independent throws that could drift apart silently.
    let captured: unknown
    try {
      assertConfirmedDelete('b24_widget_delete', '3 widgets [5, 7, 9] on board 12', false)
    } catch (err) {
      captured = err
    }
    expect(captured).toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
      message: expect.stringContaining('Refusing to delete 3 widgets [5, 7, 9] on board 12') as unknown as string,
    })
    expect(captured).toMatchObject({
      message: expect.stringContaining(
        'Re-call `b24_widget_delete` with `confirmDelete: true`',
      ) as unknown as string,
    })
  })
})
