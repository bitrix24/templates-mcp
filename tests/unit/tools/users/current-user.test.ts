import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => fake.b24,
}))

const tool = (await import('../../../../server/mcp/tools/users/current-user')).default as {
  handler: (input: Record<string, never>) => Promise<unknown>
}

describe('b24_user_me', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('calls actions.v2.call.make with user.current and returns the shaped user payload', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        ID: 1,
        NAME: 'Ada',
        LAST_NAME: 'Lovelace',
        // Fields the user.current REST surface does not reliably return
        // (EMAIL is scope-gated, ADMIN/SERVER_NAME are absent) — assert the
        // tool drops them rather than emitting misleading null/false values.
        EMAIL: 'SomeUser@example.com',
        ADMIN: true,
        SERVER_NAME: 'for-test.bitrix24.com',
      }),
    )

    const result = (await tool.handler({})) as {
      content: { type: 'text'; text: string }[]
    }

    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'user.current', params: {} })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({
      id: 1,
      name: 'Ada',
      lastName: 'Lovelace',
    })
  })

  it('returns a friendly message when Bitrix24 has no result', async () => {
    fake.v2Call.mockResolvedValue(fakeOkEmpty())

    const result = (await tool.handler({})) as {
      content: { type: 'text'; text: string }[]
    }

    expect(result.content[0]!.text).toMatch(/no user/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' }))

    await expect(tool.handler({})).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'Unauthorized',
    })
  })
})
