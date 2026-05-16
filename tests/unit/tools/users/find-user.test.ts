import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const callMethod = vi.fn()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod }),
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

interface FindInput {
  query?: string
  firstName?: string
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

describe('bitrix24_find_user', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('uses FIND for a free-text query and returns trimmed user objects', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: sampleUsers }) })

    const result = await tool.handler({ query: 'Игорь' })

    expect(callMethod).toHaveBeenCalledWith('user.search', {
      FILTER: { FIND: 'Игорь' },
      sort: 'ID',
      order: 'ASC',
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
    callMethod.mockResolvedValue({ getData: () => ({ result: [sampleUsers[0]] }) })

    await tool.handler({ firstName: 'Игорь', lastName: 'Шевченко' })

    expect(callMethod).toHaveBeenCalledWith('user.search', {
      FILTER: { NAME: 'Игорь', LAST_NAME: 'Шевченко' },
      sort: 'ID',
      order: 'ASC',
    })
  })

  it('passes WORK_POSITION when `position` is supplied alone', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: [] }) })

    await tool.handler({ position: 'backend' })

    expect(callMethod).toHaveBeenCalledWith('user.search', {
      FILTER: { WORK_POSITION: 'backend' },
      sort: 'ID',
      order: 'ASC',
    })
  })

  it('returns a guidance message and does not call Bitrix24 when no filter is supplied', async () => {
    const result = await tool.handler({})
    expect(callMethod).not.toHaveBeenCalled()
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
    callMethod.mockResolvedValue({ getData: () => ({ result: many }) })

    const result = await tool.handler({ query: 'Иван', limit: 3 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.matches).toBe(3)
    expect(payload.truncatedAt).toBe(3)
    expect(payload.totalReturned).toBe(15)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    callMethod.mockRejectedValue(Object.assign(new Error('OPERATION_TIME_LIMIT'), { code: 'OPERATION_TIME_LIMIT' }))
    await expect(tool.handler({ query: 'X' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'OPERATION_TIME_LIMIT',
    })
  })
})
