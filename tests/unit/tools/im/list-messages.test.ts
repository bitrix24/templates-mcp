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

interface ListInput {
  dialogId: string
  lastId?: number
  limit?: number
}

const tool = (await import('../../../../server/mcp/tools/im/list-messages')).default as unknown as {
  handler: (input: ListInput) => Promise<ToolContent>
}

describe('b24_im_message_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('routes through callV2 on im.dialog.messages.get and resolves author names', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        chat_id: 5869,
        messages: [
          { id: 243049, author_id: 9, date: '2026-09-02T13:05:30+03:00', text: '[USER=1]Сергей Веренцов[/USER] мы?' },
          { id: 243045, author_id: 33, date: '2026-09-02T13:04:45+03:00', text: 'а что Катя хочет?' },
        ],
        users: [
          { id: 9, name: 'Александр Блинов' },
          { id: 33, first_name: 'Максим', last_name: 'Мясищев' },
        ],
      }),
    )

    const result = await tool.handler({ dialogId: 'chat5869' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'im.dialog.messages.get',
      params: { DIALOG_ID: 'chat5869' },
    })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.dialogId).toBe('chat5869')
    expect(payload.returned).toBe(2)
    expect(payload.messages[0]).toEqual({
      id: 243049,
      authorId: 9,
      authorName: 'Александр Блинов',
      text: '[USER=1]Сергей Веренцов[/USER] мы?',
      date: '2026-09-02T13:05:30+03:00',
    })
    expect(payload.messages[1].authorName).toBe('Максим Мясищев')
  })

  it('passes LAST_ID and LIMIT only when provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ messages: [] }))
    await tool.handler({ dialogId: '33', lastId: 100, limit: 5 })
    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'im.dialog.messages.get',
      params: { DIALOG_ID: '33', LAST_ID: 100, LIMIT: 5 },
    })
  })

  it('resolves authorName to null when the user is not in the embedded users list', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ messages: [{ id: 1, author_id: 999, text: 'hi' }], users: [] }))
    const result = await tool.handler({ dialogId: '33' })
    expect(JSON.parse(result.content[0]!.text).messages[0].authorName).toBeNull()
  })

  it('reports an empty list when Bitrix24 returns none', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ messages: [] }))
    const result = await tool.handler({ dialogId: '33' })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ dialogId: '33', returned: 0, messages: [] })
  })

  it('wraps SDK errors and tags the dialog id in the fallback message', async () => {
    fake.v2Call.mockRejectedValue(new Error('dialog not found'))
    await expect(tool.handler({ dialogId: '33' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'dialog not found',
    })
  })
})
