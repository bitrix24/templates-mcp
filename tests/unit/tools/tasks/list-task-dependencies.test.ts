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

const tool = (await import('../../../../server/mcp/tools/tasks/list-task-dependencies')).default as unknown as {
  handler: (input: { taskId: number }) => Promise<ToolContent>
}

describe('bitrix24_list_task_dependencies', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('posts task.item.getdependson with { TASKID } and returns the predecessor ids', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([5, 7, 9]))

    const result = await tool.handler({ taskId: 100 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.item.getdependson',
      params: { TASKID: 100 },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 3,
      dependsOn: [5, 7, 9],
    })
  })

  it('returns an empty dependsOn array when the task has no predecessors', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 0,
      dependsOn: [],
    })
  })

  it('coerces numeric-string ids that legacy v2 portals sometimes return', async () => {
    // Bitrix24 v2 endpoints occasionally ship numeric ids as strings;
    // `toNumber` normalises them so the tool's downstream wire shape is
    // stable.
    fake.v2Call.mockResolvedValue(fakeOk(['5', '7', '9']))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 3,
      dependsOn: [5, 7, 9],
    })
  })

  it('handles the nested { result: [...] } envelope shape some portal versions ship', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ result: [5, 7] }))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 2,
      dependsOn: [5, 7],
    })
  })

  it('drops invalid entries (non-numeric, zero, negative) instead of leaking junk through', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([5, 'not-a-number', 0, -3, 9]))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 2,
      dependsOn: [5, 9],
    })
  })

  it('returns an empty list when the wire shape is unrecognisable (defensive default)', async () => {
    // Bitrix24 sometimes returns an object payload on edge cases — the
    // tool defaults to an empty `dependsOn` rather than throwing so the
    // agent doesn't loop on "I just need the list" prompts.
    fake.v2Call.mockResolvedValue(fakeOk({ something: 'unexpected' }))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      taskId: 100,
      returned: 0,
      dependsOn: [],
    })
  })

  it('wraps SDK errors into Bitrix24ToolError with the failing taskId in the fallback message', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 100 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
