import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24-tenant', () => ({
  useBitrix24Tenant: () => fake.b24,
}))

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/im/list-dialogs')).default as unknown as {
  handler: (input: { limit?: number; offset?: number }) => Promise<ToolContent>
}

describe('b24_im_dialog_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('routes through callV2 on im.recent.list and shapes the response', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        items: [
          {
            id: 'chat5869',
            type: 'chat',
            title: 'Сделать интеграции MCP',
            message: { id: 1, text: '[USER=1]Сергей[/USER] взгляни', author_id: 9, date: '2026-09-02T13:05:30+03:00' },
            unread: true,
            counter: 3,
          },
          { id: 9, type: 'user', title: 'Александр Блинов', message: { text: 'спс)' }, unread: false, counter: 0 },
        ],
        hasMore: true,
      }),
    )

    const result = await tool.handler({})

    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'im.recent.list', params: {} })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.returned).toBe(2)
    expect(payload.hasMore).toBe(true)
    expect(payload.dialogs[0]).toEqual({
      dialogId: 'chat5869',
      type: 'chat',
      title: 'Сделать интеграции MCP',
      unread: true,
      unreadCount: 3,
      lastMessageText: '[USER=1]Сергей[/USER] взгляни',
      lastMessageAuthorId: 9,
      lastMessageDate: '2026-09-02T13:05:30+03:00',
    })
    // Personal dialog id coerces to a string for a predictable output shape.
    expect(payload.dialogs[1].dialogId).toBe('9')
    expect(payload.dialogs[1].type).toBe('user')
  })

  it('passes LIMIT / OFFSET only when provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ items: [] }))
    await tool.handler({ limit: 10, offset: 20 })
    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'im.recent.list', params: { LIMIT: 10, OFFSET: 20 } })
  })

  it('drops rows with no id', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ items: [{ type: 'user' }, { id: 5, type: 'user' }] }))
    const result = await tool.handler({})
    expect(JSON.parse(result.content[0]!.text).returned).toBe(1)
  })

  it('reports hasMore: false when Bitrix24 omits it', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ items: [] }))
    const result = await tool.handler({})
    expect(JSON.parse(result.content[0]!.text)).toEqual({ returned: 0, hasMore: false, dialogs: [] })
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('insufficient scope'))
    await expect(tool.handler({})).rejects.toMatchObject({ name: 'Bitrix24ToolError' })
  })
})
