import { beforeEach, describe, expect, it, vi } from 'vitest'
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

interface FindDealInput {
  query?: string
  contactId?: number
  companyId?: number
  stageId?: string
  categoryId?: number
  assignedById?: number
  closedOnly?: boolean
  order?: Record<string, 'ASC' | 'DESC'>
  limit?: number
}

const tool = (await import('../../../../server/mcp/tools/deals/find-deal')).default as unknown as {
  handler: (input: FindDealInput) => Promise<ToolContent>
}

const sampleDeals = [
  {
    ID: '37',
    TITLE: '[А] Сделка',
    TYPE_ID: 'COMPLEX',
    CATEGORY_ID: '1',
    STAGE_ID: 'C1:NEW',
    OPPORTUNITY: '19999.99',
    CURRENCY_ID: 'RUB',
    CONTACT_ID: '12',
    COMPANY_ID: null,
    ASSIGNED_BY_ID: '1',
    CLOSED: 'N',
    DATE_CREATE: '2024-09-02T18:37:18+02:00',
    DATE_MODIFY: '2024-09-02T19:00:00+02:00',
  },
  {
    ID: '42',
    TITLE: '[С] Сделка',
    TYPE_ID: 'COMPLEX',
    CATEGORY_ID: '1',
    STAGE_ID: 'C1:WON',
    OPPORTUNITY: '18500.00',
    CURRENCY_ID: 'RUB',
    CONTACT_ID: null,
    COMPANY_ID: '7',
    ASSIGNED_BY_ID: '6',
    CLOSED: 'Y',
    DATE_CREATE: '2024-07-02T15:38:32+02:00',
    DATE_MODIFY: '2024-08-15T10:22:00+02:00',
  },
]

describe('bitrix24_find_deal', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('maps a free-text query to the %TITLE filter prefix (LIKE) and defaults order to ID DESC', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(sampleDeals))

    const result = await tool.handler({ query: 'Сделка' })

    expect(fake.v2Call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'crm.deal.list',
        params: expect.objectContaining({
          filter: { '%TITLE': 'Сделка' },
          order: { ID: 'DESC' },
          // pin the select so dropping a field (and silently nulling the
          // mapped property) fails loudly here.
          select: expect.arrayContaining([
            'ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'TYPE_ID', 'OPPORTUNITY',
            'CURRENCY_ID', 'CONTACT_ID', 'COMPANY_ID', 'ASSIGNED_BY_ID', 'CLOSED',
            'DATE_CREATE', 'DATE_MODIFY',
          ]),
        }),
      }),
    )

    // Regression guard: classic crm.deal.list must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(2)
    expect(payload.deals[0]).toEqual({
      id: 37,
      title: '[А] Сделка',
      stageId: 'C1:NEW',
      categoryId: 1,
      typeId: 'COMPLEX',
      opportunity: 19999.99,
      currencyId: 'RUB',
      contactId: 12,
      companyId: null,
      assignedById: 1,
      isClosed: false,
      dateCreate: '2024-09-02T18:37:18+02:00',
      dateModify: '2024-09-02T19:00:00+02:00',
    })
    expect(payload.deals[1]!.isClosed).toBe(true)
  })

  it('maps structured filters straight to UPPER_SNAKE keys', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    await tool.handler({
      contactId: 12,
      companyId: 7,
      stageId: 'C1:NEW',
      categoryId: 1,
      assignedById: 6,
      closedOnly: false,
    })

    expect(fake.v2Call).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          filter: {
            CONTACT_ID: 12,
            COMPANY_ID: 7,
            STAGE_ID: 'C1:NEW',
            CATEGORY_ID: 1,
            ASSIGNED_BY_ID: 6,
            CLOSED: 'N',
          },
          // structured-only call still gets the default sort
          order: { ID: 'DESC' },
        }),
      }),
    )
  })

  it('accepts companyId as the sole filter', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ companyId: 7 })
    expect(fake.v2Call).toHaveBeenCalledTimes(1)
    const callArg = fake.v2Call.mock.calls[0]?.[0]
    expect(callArg?.params?.filter).toEqual({ COMPANY_ID: 7 })
  })

  it('encodes closedOnly: true as CLOSED=Y', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ closedOnly: true, query: 'x' })
    const callArg = fake.v2Call.mock.calls[0]?.[0]
    expect(callArg?.params?.filter).toMatchObject({ CLOSED: 'Y' })
  })

  it('combines a free-text query with structured filters (does not reject the mix)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ query: 'Сделка', closedOnly: true })
    const callArg = fake.v2Call.mock.calls[0]?.[0]
    expect(callArg?.params?.filter).toEqual({ '%TITLE': 'Сделка', CLOSED: 'Y' })
  })

  it('passes a custom order through to crm.deal.list (e.g. stale-first by DATE_MODIFY)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ closedOnly: false, order: { DATE_MODIFY: 'ASC' } })
    expect(fake.v2Call).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          filter: { CLOSED: 'N' },
          order: { DATE_MODIFY: 'ASC' },
        }),
      }),
    )
  })

  it('falls back to the default order when an empty order object is passed', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ query: 'x', order: {} })
    const callArg = fake.v2Call.mock.calls[0]?.[0]
    // `{}` is truthy, so a naive `order ?? default` would forward it — the
    // handler must explicitly fall back to { ID: 'DESC' }.
    expect(callArg?.params?.order).toEqual({ ID: 'DESC' })
  })

  it('returns a guidance message and does not call Bitrix24 when no filter is supplied', async () => {
    const result = await tool.handler({})
    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/Provide at least one filter/i)
  })

  const makeDeals = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ID: String(i + 1),
      TITLE: `Deal ${i + 1}`,
      STAGE_ID: 'C1:NEW',
      CATEGORY_ID: '1',
      OPPORTUNITY: '1000.00',
      CURRENCY_ID: 'USD',
      ASSIGNED_BY_ID: '1',
      CLOSED: 'N',
    }))

  it('caps the result count to `limit` and reports truncation via pageSize / truncatedAt', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(makeDeals(15)))

    const result = await tool.handler({ query: 'Deal', limit: 5 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(5)
    expect(payload.truncatedAt).toBe(5)
    expect(payload.pageSize).toBe(15)
  })

  it('honours limit: 1 (the Zod minimum)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(makeDeals(15)))
    const result = await tool.handler({ query: 'Deal', limit: 1 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(1)
    expect(payload.truncatedAt).toBe(1)
  })

  it('flags mayHaveMore when Bitrix24 returns a full page of 50', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(makeDeals(50)))
    const result = await tool.handler({ query: 'Deal', limit: 50 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(50)
    expect(payload.pageSize).toBe(50)
    expect(payload.mayHaveMore).toBe(true)
    // returned exactly `limit` rows out of a 50-row page — no client-side cut
    expect('truncatedAt' in payload).toBe(false)
  })

  it('omits `truncatedAt` and clears mayHaveMore when the page is not full', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([sampleDeals[0]]))
    const result = await tool.handler({ query: 'Сделка', limit: 10 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(1)
    expect(payload.mayHaveMore).toBe(false)
    expect('truncatedAt' in payload).toBe(false)
  })

  it('handles a success envelope with no payload (Bitrix24 returns undefined result)', async () => {
    // callV3 returns `getData()?.result`, which is undefined here; the handler's
    // `?? []` must keep .slice / .map from throwing.
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ query: 'Сделка' })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(0)
    expect(payload.deals).toEqual([])
  })

  it('returns null id / null opportunity when Bitrix24 emits non-numeric values', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk([
        {
          ID: 'not-a-number',
          TITLE: 'Strange',
          OPPORTUNITY: '',
          STAGE_ID: 'C1:NEW',
          CATEGORY_ID: '1',
          ASSIGNED_BY_ID: '1',
          CLOSED: 'N',
        },
      ]),
    )
    const result = await tool.handler({ query: 'Strange' })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.deals[0].id).toBeNull()
    expect(payload.deals[0].opportunity).toBeNull()
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(
      Object.assign(new Error('ACCESS_DENIED'), { code: 'ACCESS_DENIED' }),
    )
    await expect(tool.handler({ query: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'ACCESS_DENIED',
    })
  })
})
