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

interface FindDealInput {
  query?: string
  contactId?: number
  companyId?: number
  stageId?: string
  categoryId?: number
  assignedById?: number
  closedOnly?: boolean
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
    fake.v3Call.mockReset()
  })

  it('maps a free-text query to the %TITLE filter prefix (LIKE)', async () => {
    fake.v3Call.mockResolvedValue(fakeOk(sampleDeals))

    const result = await tool.handler({ query: 'Сделка' })

    const callArg = fake.v3Call.mock.calls[0]?.[0]
    expect(callArg?.method).toBe('crm.deal.list')
    expect(callArg?.params).toMatchObject({
      filter: { '%TITLE': 'Сделка' },
      order: { ID: 'DESC' },
    })

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
    fake.v3Call.mockResolvedValue(fakeOk([]))

    await tool.handler({
      contactId: 12,
      stageId: 'C1:NEW',
      categoryId: 1,
      assignedById: 6,
      closedOnly: false,
    })

    const callArg = fake.v3Call.mock.calls[0]?.[0]
    expect(callArg?.params).toMatchObject({
      filter: {
        CONTACT_ID: 12,
        STAGE_ID: 'C1:NEW',
        CATEGORY_ID: 1,
        ASSIGNED_BY_ID: 6,
        CLOSED: 'N',
      },
    })
  })

  it('encodes closedOnly: true as CLOSED=Y', async () => {
    fake.v3Call.mockResolvedValue(fakeOk([]))
    await tool.handler({ closedOnly: true, query: 'x' })
    const callArg = fake.v3Call.mock.calls[0]?.[0]
    expect(callArg?.params?.filter).toMatchObject({ CLOSED: 'Y' })
  })

  it('returns a guidance message and does not call Bitrix24 when no filter is supplied', async () => {
    const result = await tool.handler({})
    expect(fake.v3Call).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/Provide at least one filter/i)
  })

  it('caps the result count to `limit` (default 10) and reports truncation', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ID: String(i + 1),
      TITLE: `Deal ${i + 1}`,
      STAGE_ID: 'C1:NEW',
      CATEGORY_ID: '1',
      OPPORTUNITY: '1000.00',
      CURRENCY_ID: 'USD',
      ASSIGNED_BY_ID: '1',
      CLOSED: 'N',
    }))
    fake.v3Call.mockResolvedValue(fakeOk(many))

    const result = await tool.handler({ query: 'Deal', limit: 5 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(5)
    expect(payload.truncatedAt).toBe(5)
    expect(payload.returnedByApi).toBe(15)
  })

  it('omits `truncatedAt` when no truncation happened', async () => {
    fake.v3Call.mockResolvedValue(fakeOk([sampleDeals[0]]))
    const result = await tool.handler({ query: 'Сделка', limit: 10 })
    const payload = JSON.parse(result.content[0]!.text)
    expect('truncatedAt' in payload).toBe(false)
  })

  it('returns null id / null opportunity when Bitrix24 emits non-numeric values', async () => {
    fake.v3Call.mockResolvedValue(
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
    fake.v3Call.mockRejectedValue(
      Object.assign(new Error('ACCESS_DENIED'), { code: 'ACCESS_DENIED' }),
    )
    await expect(tool.handler({ query: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'ACCESS_DENIED',
    })
  })
})
