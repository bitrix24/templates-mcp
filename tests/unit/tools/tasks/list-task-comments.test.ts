import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24-tenant', () => ({
  useBitrix24Tenant: () => fake.b24,
}))

interface ToolContent {
  content: { type: 'text', text: string }[]
}

const tool = (await import('../../../../server/mcp/tools/tasks/list-task-comments')).default as unknown as {
  handler: (input: {
    taskId: number
    order?: 'asc' | 'desc'
    authorId?: number
    includeSystem?: boolean
    limit?: number
    offset?: number
  }) => Promise<ToolContent>
}

/** Legacy forum rows, deliberately out of date order on the wire. */
const FORUM = [
  {
    ID: '111',
    AUTHOR_ID: '9',
    AUTHOR_NAME: 'Иван',
    AUTHOR_EMAIL: '',
    POST_DATE: '2025-07-31T16:38:53+03:00',
    POST_MESSAGE: 'Крайний срок изменен на: 1 августа, 18:00',
    POST_MESSAGE_HTML: null,
  },
  {
    ID: '51',
    AUTHOR_ID: '9',
    AUTHOR_NAME: 'Иван',
    AUTHOR_EMAIL: '',
    POST_DATE: '2025-07-31T13:11:12+03:00',
    POST_MESSAGE: 'первый',
    POST_MESSAGE_HTML: null,
  },
  {
    ID: '53',
    AUTHOR_ID: '11',
    AUTHOR_NAME: 'Мария',
    AUTHOR_EMAIL: '',
    POST_DATE: '2025-07-31T13:11:53+03:00',
    POST_MESSAGE: 'второй',
    POST_MESSAGE_HTML: null,
  },
]

/** Chat messages: newest-first, one of them system (author_id 0). */
const CHAT = {
  chat_id: 6479,
  messages: [
    { id: 244263, author_id: 9, date: '2026-09-03T22:12:06+03:00', text: 'из чата, свежий' },
    { id: 244259, author_id: 0, date: '2026-09-03T22:11:50+03:00', text: '[USER=9]Иван[/USER] снял отметку о важности задачи' },
  ],
  users: [{ id: 9, name: 'Иван Петров' }],
}

/** Wire the three calls the tool makes, by method name. */
function mockPortal({ chatId = 6479, forum = FORUM, chat = CHAT }: {
  chatId?: number | null
  forum?: unknown[]
  chat?: unknown
} = {}) {
  fake.v2Call.mockImplementation(async (options: { method: string, params?: Record<string, unknown> }) => {
    if (options.method === 'tasks.task.get') {
      return fakeOk({ task: chatId === null ? { id: '4193' } : { id: '4193', chatId } })
    }
    if (options.method === 'task.commentitem.getlist') return fakeOk(forum)
    if (options.method === 'im.dialog.messages.get') return fakeOk(chat)
    throw new Error(`unexpected method ${options.method}`)
  })
}

function payload(result: ToolContent) {
  return JSON.parse(result.content[0]!.text)
}

const methodsCalled = () =>
  fake.v2Call.mock.calls.map((call) => (call[0] as unknown as { method: string }).method)

describe('b24_task_comment_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v3Call.mockReset()
  })

  it('reads BOTH stores — the task chat and the legacy forum — and merges them chronologically', async () => {
    mockPortal()

    const result = payload(await tool.handler({ taskId: 4193 }))

    expect(methodsCalled()).toEqual([
      'tasks.task.get',
      'task.commentitem.getlist',
      'im.dialog.messages.get',
    ])
    expect(fake.v3Call).not.toHaveBeenCalled()
    expect(result.sources).toEqual({ forum: 3, chat: 2 })
    // Oldest-first across both stores; the system chat row is hidden by default.
    expect(result.comments.map((c: { id: number }) => c.id)).toEqual([51, 53, 111, 244263])
    expect(result.total).toBe(5)
    expect(result.matched).toBe(4)
    expect(result.systemHidden).toBe(1)
  })

  it('addresses the chat by its own id and tags each comment with its store', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193 }))

    const chatCall = fake.v2Call.mock.calls
      .map((call) => call[0] as unknown as { method: string, params: Record<string, unknown> })
      .find((call) => call.method === 'im.dialog.messages.get')
    expect(chatCall?.params).toMatchObject({ DIALOG_ID: 'chat6479', LIMIT: 200 })

    const fromChat = result.comments.find((c: { id: number }) => c.id === 244263)
    expect(fromChat).toMatchObject({ source: 'chat', authorId: 9, authorName: 'Иван Петров', isSystem: false })
    expect(result.comments.find((c: { id: number }) => c.id === 51)).toMatchObject({ source: 'forum' })
  })

  it('skips the chat call for a task that has no chat', async () => {
    mockPortal({ chatId: null })
    const result = payload(await tool.handler({ taskId: 23 }))

    expect(methodsCalled()).toEqual(['tasks.task.get', 'task.commentitem.getlist'])
    expect(result.sources).toEqual({ forum: 3, chat: 0 })
  })

  it('surfaces system chat entries on includeSystem: true, flagged and counted', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193, includeSystem: true }))

    expect(result.matched).toBe(5)
    expect(result.systemHidden).toBe(0)
    const system = result.comments.find((c: { id: number }) => c.id === 244259)
    expect(system).toMatchObject({ isSystem: true, authorId: null, authorName: null, source: 'chat' })
  })

  it('leaves the author roll-up free of system entries', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193, includeSystem: true }))
    expect(result.authors).toEqual([
      { id: 9, name: 'Иван', comments: 2 },
      { id: 11, name: 'Мария', comments: 1 },
      { id: 9, name: 'Иван Петров', comments: 1 },
    ])
  })

  it('orders newest-first on order: "desc"', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193, order: 'desc' }))
    expect(result.comments.map((c: { id: number }) => c.id)).toEqual([244263, 111, 53, 51])
  })

  it('filters by authorId across both stores and reports total vs matched', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193, authorId: 9 }))

    expect(result.total).toBe(5)
    expect(result.matched).toBe(3)
    expect(result.comments.map((c: { id: number }) => c.id)).toEqual([51, 111, 244263])
  })

  it('pages with limit / offset without shortening any comment', async () => {
    mockPortal()
    const result = payload(await tool.handler({ taskId: 4193, limit: 1, offset: 1 }))

    expect(result.returned).toBe(1)
    expect(result.offset).toBe(1)
    expect(result.comments[0]).toMatchObject({ id: 53, text: 'второй' })
  })

  it('walks the chat backwards through LAST_ID while pages come back full', async () => {
    const page = (start: number) => ({
      chat_id: 1,
      users: [{ id: 9, name: 'Иван Петров' }],
      messages: Array.from({ length: 200 }, (_, i) => ({
        id: start - i,
        author_id: 9,
        date: '2026-09-03T22:00:00+03:00',
        text: `msg ${start - i}`,
      })),
    })
    const pages = [page(1000), page(800), { chat_id: 1, users: [], messages: [{ id: 599, author_id: 9, text: 'last' }] }]
    let call = 0
    fake.v2Call.mockImplementation(async (options: { method: string }) => {
      if (options.method === 'tasks.task.get') return fakeOk({ task: { id: '1', chatId: 1 } })
      if (options.method === 'task.commentitem.getlist') return fakeOk([])
      if (options.method === 'im.dialog.messages.get') return fakeOk(pages[call++])
      throw new Error('unexpected')
    })

    const result = payload(await tool.handler({ taskId: 1, limit: 1 }))

    const chatCalls = fake.v2Call.mock.calls
      .map((c) => c[0] as unknown as { method: string, params: Record<string, unknown> })
      .filter((c) => c.method === 'im.dialog.messages.get')
    expect(chatCalls).toHaveLength(3)
    expect(chatCalls[1]?.params.LAST_ID).toBe(801)
    expect(chatCalls[2]?.params.LAST_ID).toBe(601)
    expect(result.total).toBe(401)
    expect(result.chatTruncated).toBeUndefined()
  })

  it('reports chatTruncated when the page budget runs out mid-thread', async () => {
    const full = (start: number) => ({
      chat_id: 1,
      users: [],
      messages: Array.from({ length: 200 }, (_, i) => ({ id: start - i, author_id: 9, text: 'x' })),
    })
    let start = 10_000
    fake.v2Call.mockImplementation(async (options: { method: string }) => {
      if (options.method === 'tasks.task.get') return fakeOk({ task: { id: '1', chatId: 1 } })
      if (options.method === 'task.commentitem.getlist') return fakeOk([])
      if (options.method === 'im.dialog.messages.get') {
        const p = full(start)
        start -= 200
        return fakeOk(p)
      }
      throw new Error('unexpected')
    })

    const result = payload(await tool.handler({ taskId: 1, limit: 1 }))
    expect(result.chatTruncated).toBe(true)
    expect(result.total).toBe(1000)
  })

  it('handles an empty thread and an empty SDK payload', async () => {
    mockPortal({ forum: [], chat: { chat_id: 6479, messages: [], users: [] } })
    expect(payload(await tool.handler({ taskId: 4193 }))).toMatchObject({
      total: 0,
      returned: 0,
      authors: [],
      comments: [],
      sources: { forum: 0, chat: 0 },
    })

    fake.v2Call.mockReset()
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    expect(payload(await tool.handler({ taskId: 4193 }))).toMatchObject({ total: 0, comments: [] })
  })

  it('accepts the legacy { result: [...] } envelope from the forum endpoint', async () => {
    mockPortal({ chatId: null, forum: { result: FORUM } as never })
    expect(payload(await tool.handler({ taskId: 23 })).sources.forum).toBe(3)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('ACTION_FAILED_TO_BE_PROCESSED'))
    await expect(tool.handler({ taskId: 4193 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'ACTION_FAILED_TO_BE_PROCESSED',
    })
  })
})
