import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const tool = (await import('../../../../server/mcp/tools/tasks/list-elapsed-time')).default as unknown as {
  handler: (input: {
    taskId?: number
    filter?: Record<string, unknown>
    order?: Record<string, 'asc' | 'desc'>
    select?: string[]
    start?: number
  }) => Promise<ToolContent>
}

describe('b24_task_elapsed_time_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('routes through task.elapseditem.getlist with default ORDER/FILTER/SELECT/PARAMS', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([] as unknown[]))
    await tool.handler({})

    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      method: string
      params: {
        ORDER: Record<string, string>
        FILTER: Record<string, unknown>
        SELECT: string[]
        PARAMS: { NAV_PARAMS: { iNumPage: number; nPageSize: number } }
      }
    }
    expect(args.method).toBe('task.elapseditem.getlist')
    expect(args.params.ORDER).toEqual({ ID: 'desc' })
    expect(args.params.FILTER).toEqual({}) // no filter when nothing supplied
    expect(args.params.SELECT).toEqual([
      'ID',
      'TASK_ID',
      'USER_ID',
      'COMMENT_TEXT',
      'SECONDS',
      'CREATED_DATE',
      'DATE_START',
      'DATE_STOP',
    ])
    expect(args.params.PARAMS.NAV_PARAMS.nPageSize).toBe(50)
    // No start → iNumPage = 1 (first page).
    expect(args.params.PARAMS.NAV_PARAMS.iNumPage).toBe(1)
  })

  it('translates the top-level taskId convenience field into FILTER.TASK_ID', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ taskId: 691 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(args.params.FILTER).toEqual({ TASK_ID: 691 })
  })

  it('normalises camelCase filter keys + operator prefixes to UPPER_SNAKE on the wire', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({
      filter: {
        userId: 5,
        '>=createdDate': '2025-01-01T00:00:00+00:00',
        '%commentText': 'договор',
      },
    })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(args.params.FILTER).toEqual({
      USER_ID: 5,
      '>=CREATED_DATE': '2025-01-01T00:00:00+00:00',
      '%COMMENT_TEXT': 'договор',
    })
  })

  it('does NOT override an explicit filter.taskId with the convenience field', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    // Two ways of specifying the same field — `filter` wins, no duplicate-key
    // collision because the convenience-merge guard checks both spellings.
    await tool.handler({ taskId: 99, filter: { taskId: 700 } })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(args.params.FILTER).toEqual({ TASK_ID: 700 })
  })

  it('parses the UPPERCASE wire response into camelCase entries', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk([
        {
          ID: '1',
          TASK_ID: '691',
          USER_ID: '5',
          COMMENT_TEXT: 'spec review',
          SECONDS: '1800',
          CREATED_DATE: '2025-05-16T10:00:00+02:00',
          DATE_START: '2025-05-16T09:30:00+02:00',
          DATE_STOP: '2025-05-16T10:00:00+02:00',
        },
        {
          ID: '2',
          TASK_ID: '691',
          USER_ID: '5',
          COMMENT_TEXT: 'follow-up call',
          SECONDS: '900',
          CREATED_DATE: '2025-05-16T11:00:00+02:00',
          DATE_START: '',
          DATE_STOP: '',
        },
      ]),
    )

    const payload = JSON.parse((await tool.handler({ taskId: 691 })).content[0]!.text) as {
      returned: number
      entries: Array<{ id: number; commentText: string; seconds: number; dateStart: string | null }>
    }
    expect(payload.returned).toBe(2)
    expect(payload.entries[0]).toMatchObject({ id: 1, seconds: 1800, commentText: 'spec review' })
    // Empty DATE_START on the wire normalises to null in the projection.
    expect(payload.entries[1]?.dateStart).toBeNull()
  })

  it('returns 0 entries when Bitrix24 ships an empty array', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    const payload = JSON.parse((await tool.handler({ taskId: 999 })).content[0]!.text)
    expect(payload).toEqual({ returned: 0, entries: [] })
  })

  it('tolerates the legacy `{ result: [...] }` shape on the unwrapped response', async () => {
    // Defensive — `callV2` unwraps `result`, but older SDK / endpoint
    // variants occasionally leave the wrapper in place.
    fake.v2Call.mockResolvedValue(fakeOk({ result: [{ ID: 1, TASK_ID: 1, SECONDS: 60 }] }))
    const payload = JSON.parse((await tool.handler({})).content[0]!.text)
    expect(payload.returned).toBe(1)
  })

  it('converts `start` offset into 1-based `iNumPage` for Bitrix24 v2 getlist', async () => {
    // start=100 / pageSize=50 + 1 = page 3
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({
      order: { createdDate: 'asc' },
      select: ['id', 'seconds'],
      start: 100,
    })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      params: {
        ORDER: Record<string, string>
        SELECT: string[]
        PARAMS: { NAV_PARAMS: { iNumPage: number; nPageSize: number } }
      }
    }
    expect(args.params.ORDER).toEqual({ CREATED_DATE: 'asc' })
    expect(args.params.SELECT).toEqual(['ID', 'SECONDS'])
    expect(args.params.PARAMS.NAV_PARAMS.iNumPage).toBe(3)
    expect(args.params.PARAMS.NAV_PARAMS.nPageSize).toBe(50)
  })

  it('rounds sub-page `start` offsets DOWN to the start of the containing page', async () => {
    // start=75 → page 2 (offset 50-99). Operator must pass multiples of
    // 50; non-multiples lose the intra-page offset (documented behaviour).
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ start: 75 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      params: { PARAMS: { NAV_PARAMS: { iNumPage: number } } }
    }
    expect(args.params.PARAMS.NAV_PARAMS.iNumPage).toBe(2)
  })

  it('does NOT override an explicit `filter: { !taskId: ... }` with the convenience field (operator-prefix guard)', async () => {
    // Without the prefix-stripped guard, taskId=91 would inject
    // `TASK_ID: 91` alongside `!TASK_ID: 5`, producing a contradictory
    // filter that Bitrix24 silently swallows.
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ taskId: 91, filter: { '!taskId': 5 } })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(args.params.FILTER).toEqual({ '!TASK_ID': 5 })
  })

  it('does NOT override an explicit `filter: { TASK_ID: ... }` (UPPERCASE form of convenience guard)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ taskId: 99, filter: { TASK_ID: 800 } })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(args.params.FILTER).toEqual({ TASK_ID: 800 })
  })

  it('operator-prefix guard covers ALL prefixes — not just `!`', async () => {
    // The convenience-merge guard strips /^[!%<>=]+/ before comparing to
    // taskId/TASK_ID. Pin the full operator vocabulary so a regex tweak
    // can't silently drop a prefix from the closed set.
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ taskId: 100, filter: { '>=taskId': 50 } })
    const call1 = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(call1.params.FILTER).toEqual({ '>=TASK_ID': 50 })

    fake.v2Call.mockClear()
    await tool.handler({ taskId: 100, filter: { '%taskId': '5' } })
    const call2 = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FILTER: Record<string, unknown> } }
    expect(call2.params.FILTER).toEqual({ '%TASK_ID': '5' })
  })

  it('schema constrains start to [0, 100_000] (lower + upper bounds)', () => {
    // Reach into the handler input by parsing the schema directly via the
    // exported tool — the runtime would Zod-reject before the handler runs.
    // (The tool default export is a McpToolDefinition; the start schema
    // lives in inputSchema.start.)
    const startSchema = (tool as unknown as { inputSchema: { start: { safeParse: (v: unknown) => { success: boolean } } } }).inputSchema.start
    expect(startSchema.safeParse(0).success).toBe(true)
    expect(startSchema.safeParse(100_000).success).toBe(true)
    // Upper bound — DoS guard.
    expect(startSchema.safeParse(100_001).success).toBe(false)
    // Lower bound — nonnegative() rejects negatives.
    expect(startSchema.safeParse(-1).success).toBe(false)
    // Non-integers.
    expect(startSchema.safeParse(1.5).success).toBe(false)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('rate limit hit'))
    await expect(tool.handler({})).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'rate limit hit',
    })
  })
})
