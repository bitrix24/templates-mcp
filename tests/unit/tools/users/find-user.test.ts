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

interface FindInput {
  query?: string
  firstName?: string
  secondName?: string
  lastName?: string
  position?: string
  limit?: number
}

const tool = (await import('../../../../server/mcp/tools/users/find-user')).default as unknown as {
  handler: (input: FindInput) => Promise<ToolContent>
}

const sampleUsers = [
  {
    ID: '5',
    ACTIVE: true,
    NAME: 'Игорь',
    LAST_NAME: 'Шевченко',
    SECOND_NAME: '',
    EMAIL: '[email protected]',
    WORK_POSITION: 'Backend developer',
    UF_DEPARTMENT: [1, 7],
    IS_ONLINE: 'Y',
  },
  {
    ID: '12',
    ACTIVE: true,
    NAME: 'Игорь',
    LAST_NAME: 'Петров',
    EMAIL: '[email protected]',
    WORK_POSITION: 'Project manager',
    UF_DEPARTMENT: [3],
    IS_ONLINE: 'N',
  },
]

describe('b24_user_find', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('uses FIND for a free-text query and returns trimmed user objects', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(sampleUsers))

    const result = await tool.handler({ query: 'Игорь' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'user.search',
      params: { FILTER: { FIND: 'Игорь' }, sort: 'ID', order: 'ASC' },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(2)
    expect(payload.users).toEqual([
      {
        id: 5,
        firstName: 'Игорь',
        lastName: 'Шевченко',
        secondName: null,
        email: '[email protected]',
        position: 'Backend developer',
        departmentIds: [1, 7],
        active: true,
        isOnline: true,
      },
      {
        id: 12,
        firstName: 'Игорь',
        lastName: 'Петров',
        secondName: null,
        email: '[email protected]',
        position: 'Project manager',
        departmentIds: [3],
        active: true,
        isOnline: false,
      },
    ])
  })

  it('maps structured firstName / lastName to NAME / LAST_NAME (no FIND)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([sampleUsers[0]]))

    await tool.handler({ firstName: 'Игорь', lastName: 'Шевченко' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'user.search',
      params: { FILTER: { NAME: 'Игорь', LAST_NAME: 'Шевченко' }, sort: 'ID', order: 'ASC' },
    })
  })

  it('disambiguates by patronymic via SECOND_NAME', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    await tool.handler({ firstName: 'Игорь', secondName: 'Сергеевич' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'user.search',
      params: { FILTER: { NAME: 'Игорь', SECOND_NAME: 'Сергеевич' }, sort: 'ID', order: 'ASC' },
    })
  })

  it('passes WORK_POSITION when `position` is supplied alone', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    await tool.handler({ position: 'backend' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'user.search',
      params: { FILTER: { WORK_POSITION: 'backend' }, sort: 'ID', order: 'ASC' },
    })
  })

  it('returns a guidance message and does not call Bitrix24 when no filter is supplied', async () => {
    const result = await tool.handler({})
    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/Provide at least one of/i)
  })

  it('caps the result count to `limit` (default 10) and reports truncation', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ID: String(i + 1),
      NAME: 'Иван',
      LAST_NAME: `Surname${i}`,
      ACTIVE: true,
      UF_DEPARTMENT: [],
    }))
    fake.v2Call.mockResolvedValue(fakeOk(many))

    const result = await tool.handler({ query: 'Иван', limit: 3 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(3)
    expect(payload.truncatedAt).toBe(3) // present only because we truncated
    expect(payload.returnedByApi).toBe(15)
  })

  it('omits `truncatedAt` when no truncation happened', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([sampleUsers[0]]))
    const result = await tool.handler({ query: 'Игорь', limit: 10 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(1)
    expect(payload.returnedByApi).toBe(1)
    expect('truncatedAt' in payload).toBe(false)
  })

  it('rejects mixing free-text query with structured filters', async () => {
    const result = await tool.handler({ query: 'Игорь', lastName: 'Шевченко' })
    expect(fake.v2Call).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/Use either `query`/i)
  })

  it('returns `id: null` instead of NaN when Bitrix24 emits a non-numeric ID', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk([{ ID: 'not-a-number', NAME: 'Strange', LAST_NAME: 'User', ACTIVE: true, UF_DEPARTMENT: [] }]),
    )
    const result = await tool.handler({ query: 'Strange' })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.users[0].id).toBeNull()
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(Object.assign(new Error('OPERATION_TIME_LIMIT'), { code: 'OPERATION_TIME_LIMIT' }))
    await expect(tool.handler({ query: 'X' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'OPERATION_TIME_LIMIT',
    })
  })
})
