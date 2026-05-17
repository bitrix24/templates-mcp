import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
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
  inputSchema: { taskId: z.ZodNumber }
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
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      taskId: 100,
      returned: 3,
      dependsOn: [5, 7, 9],
    })
  })

  it('returns an empty dependsOn array when the task has no predecessors', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
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

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      taskId: 100,
      returned: 3,
      dependsOn: [5, 7, 9],
    })
  })

  it('handles the nested { result: [...] } envelope shape some portal versions ship', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ result: [5, 7] }))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      taskId: 100,
      returned: 2,
      dependsOn: [5, 7],
    })
  })

  it('drops invalid entries (non-numeric, zero, negative) instead of leaking junk through', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([5, 'not-a-number', 0, -3, 9]))

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
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

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      taskId: 100,
      returned: 0,
      dependsOn: [],
    })
  })

  it('returns empty list when callV2 returns null (deprecated endpoint may yield null on some portal versions)', async () => {
    // `callV2` returns `getData()?.result` which can be `null` on some v2
    // endpoints (the deprecated `task.item.getdependson` is a candidate —
    // legacy endpoints sometimes nullify the result rather than empty-array
    // it). The tool's defensive fallback must produce dependsOn:[] in this
    // case, not throw. Pins the contract for issue #33 live-smoke triage.
    fake.v2Call.mockResolvedValue({
      isSuccess: true,
      getData: () => ({ result: null }),
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 100 })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      taskId: 100,
      returned: 0,
      dependsOn: [],
    })
  })

  it('attaches a _warning field on every response (deprecated endpoint visibility)', async () => {
    // CTO finding (round 3): the deprecated endpoint's defensive empty-
    // array fallback can silently hide a server-side decommission. An
    // in-band `_warning` field surfaces the risk on every call so the
    // operator/agent sees it even if the live-smoke gate (#33) slips.
    fake.v2Call.mockResolvedValue(fakeOk([5]))

    const result = await tool.handler({ taskId: 100 })

    const payload = JSON.parse(result.content[0]!.text) as {
      _warning?: string
    }
    expect(payload._warning).toMatch(/deprecated/i)
    expect(payload._warning).toMatch(/#33/)
  })

  it('schema accepts a positive integer and rejects 0 / negatives / floats', () => {
    expect(tool.inputSchema.taskId.safeParse(100).success).toBe(true)
    expect(tool.inputSchema.taskId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(1.5).success).toBe(false)
  })

  it('wraps SDK errors into Bitrix24ToolError with the failing taskId in the fallback message', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 100 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
