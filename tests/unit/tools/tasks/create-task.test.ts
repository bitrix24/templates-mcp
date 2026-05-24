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

interface CreateInput {
  title: string
  responsibleId: number
  description?: string
  deadline?: string
  groupId?: number
  priority?: '0' | '1' | '2'
  accomplices?: number[]
  auditors?: number[]
}

const tool = (await import('../../../../server/mcp/tools/tasks/create-task')).default as unknown as {
  handler: (input: CreateInput) => Promise<ToolContent>
}

describe('b24_task_create', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('passes UPPERCASE fields and returns the new task summary', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({ task: { id: 3731, title: 'PR test', responsibleId: '5', deadline: null } }),
    )

    const result = await tool.handler({
      title: 'PR test',
      responsibleId: 5,
      description: 'body',
      deadline: '2026-05-20T18:00:00+03:00',
      priority: '2',
    })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.add',
      params: {
        fields: {
          TITLE: 'PR test',
          RESPONSIBLE_ID: 5,
          DESCRIPTION: 'body',
          DEADLINE: '2026-05-20T18:00:00+03:00',
          PRIORITY: '2',
        },
      },
    })

    // Regression guard: classic tasks.task.add must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toMatchObject({ created: true, id: 3731, title: 'PR test', responsibleId: '5' })
  })

  it('omits optional fields when not provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 1, title: 'minimal' } }))

    await tool.handler({ title: 'minimal', responsibleId: 1 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { fields: Record<string, unknown> } }
    expect(Object.keys(args.params.fields).sort()).toEqual(['RESPONSIBLE_ID', 'TITLE'])
  })

  it('passes ACCOMPLICES and AUDITORS arrays only when non-empty', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 1, title: 'x' } }))

    await tool.handler({ title: 'x', responsibleId: 1, accomplices: [], auditors: [10, 20] })
    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { fields: Record<string, unknown> } }
    expect(args.params.fields.ACCOMPLICES).toBeUndefined()
    expect(args.params.fields.AUDITORS).toEqual([10, 20])
  })

  it('falls back to a friendly message when Bitrix24 returns no task body', async () => {
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ title: 't', responsibleId: 1 })
    expect(result.content[0]!.text).toMatch(/no task body/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(Object.assign(new Error('quota exceeded'), { code: 'QUERY_LIMIT_EXCEEDED' }))
    await expect(tool.handler({ title: 't', responsibleId: 1 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'QUERY_LIMIT_EXCEEDED',
    })
  })
})
