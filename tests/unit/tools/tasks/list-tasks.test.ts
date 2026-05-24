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

interface ListInput {
  filter?: Record<string, unknown>
  order?: Record<string, 'asc' | 'desc'>
  select?: string[]
  start?: number
}

const tool = (await import('../../../../server/mcp/tools/tasks/list-tasks')).default as unknown as {
  handler: (input: ListInput) => Promise<ToolContent>
}

describe('b24_task_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('passes UPPERCASE filter/order/select/start through unchanged (back-compat) and shapes the response', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        tasks: [
          { id: '1', title: 'one', status: '2', deadline: null, responsibleId: '5' },
          { id: '2', title: 'two', status: '3', deadline: '2026-06-01', responsibleId: '5' },
        ],
        total: 17,
      }),
    )

    const result = await tool.handler({
      filter: { RESPONSIBLE_ID: 5, '!STATUS': 5 },
      order: { DEADLINE: 'asc' },
      select: ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID'],
      start: 0,
    })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.list',
      params: {
        filter: { RESPONSIBLE_ID: 5, '!STATUS': 5 },
        order: { DEADLINE: 'asc' },
        select: ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID'],
        start: 0,
      },
    })

    // Regression guard: classic tasks.task.list must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.total).toBe(17)
    expect(payload.returned).toBe(2)
    expect(payload.tasks.map((t: { id: string }) => t.id)).toEqual(['1', '2'])
  })

  it('translates camelCase filter/order/select keys to UPPER_SNAKE on the wire (v3-friendly input)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ tasks: [], total: 0 }))

    await tool.handler({
      filter: { responsibleId: 5, '!status': 5, '>=deadline': '2026-06-01T00:00:00+03:00', '%title': 'договор' },
      order: { deadline: 'asc' },
      select: ['id', 'title', 'responsibleId'],
      start: 50,
    })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.list',
      params: {
        filter: {
          RESPONSIBLE_ID: 5,
          '!STATUS': 5,
          '>=DEADLINE': '2026-06-01T00:00:00+03:00',
          '%TITLE': 'договор',
        },
        order: { DEADLINE: 'asc' },
        select: ['ID', 'TITLE', 'RESPONSIBLE_ID'],
        start: 50,
      },
    })
  })

  it('accepts a mix of camelCase and UPPERCASE keys in the same filter', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ tasks: [], total: 0 }))

    await tool.handler({ filter: { responsibleId: 5, STATUS: 3, '%title': 'foo' } })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { filter: Record<string, unknown> } }
    expect(args.params.filter).toEqual({ RESPONSIBLE_ID: 5, STATUS: 3, '%TITLE': 'foo' })
  })

  it('applies sensible defaults when filter/order/select/start are omitted', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ tasks: [], total: 0 }))
    await tool.handler({})

    const args = fake.v2Call.mock.calls[0]![0] as unknown as {
      params: { filter: object; order: object; select: string[]; start: number }
    }
    expect(args.params.filter).toEqual({})
    expect(args.params.order).toEqual({ ID: 'desc' })
    expect(args.params.select).toEqual(['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID', 'CREATED_DATE', 'PRIORITY'])
    expect(args.params.start).toBe(0)
  })

  it('drops malformed task entries silently', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        tasks: [{ id: 1, title: 'ok' }, { TITLE: 'no id' }, null],
        total: 3,
      }),
    )
    const result = await tool.handler({})
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.total).toBe(3)
    expect(payload.returned).toBe(1)
  })

  it('reports total = 0 / tasks = [] on empty result', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ tasks: [], total: 0 }))
    const result = await tool.handler({})
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ total: 0, returned: 0, tasks: [] })
  })

  it('reports total = null when Bitrix24 omits the field (no silent lie about pagination)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ tasks: [{ id: 1, title: 'a' }] }))
    const result = await tool.handler({})
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.total).toBeNull()
    expect(payload.returned).toBe(1)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('connection lost'))
    await expect(tool.handler({})).rejects.toMatchObject({ name: 'Bitrix24ToolError' })
  })
})
