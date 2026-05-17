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

const tool = (await import('../../../../server/mcp/tools/tasks/delete-task-result')).default as unknown as {
  handler: (input: { resultId: number }) => Promise<ToolContent>
}

describe('bitrix24_delete_task_result', () => {
  beforeEach(() => {
    fake.v3Call.mockReset()
  })

  it('posts to tasks.task.result.delete with { id }', async () => {
    fake.v3Call.mockResolvedValue(fakeOk({ result: true }))

    const result = await tool.handler({ resultId: 17 })

    expect(fake.v3Call).toHaveBeenCalledWith({
      method: 'tasks.task.result.delete',
      params: { id: 17 },
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ deleted: true, resultId: 17 })
  })

  it('wraps SDK errors with the resultId in the fallback', async () => {
    fake.v3Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ resultId: 42 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
