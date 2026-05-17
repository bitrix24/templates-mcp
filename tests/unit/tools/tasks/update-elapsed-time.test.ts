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

const tool = (await import('../../../../server/mcp/tools/tasks/update-elapsed-time')).default as unknown as {
  handler: (input: {
    taskId: number
    itemId: number
    seconds?: number
    comment?: string
    userId?: number
  }) => Promise<ToolContent>
}

describe('bitrix24_update_elapsed_time', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('updates only the fields the operator changed (sparse ARFIELDS on the wire)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, seconds: 1200 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.elapseditem.update',
      params: { TASKID: 691, ITEMID: 5, ARFIELDS: { SECONDS: 1200 } },
    })
  })

  it('distinguishes empty-string COMMENT_TEXT (explicit clear) from omitted (no-op)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, comment: '' })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { ARFIELDS: Record<string, unknown> } }
    expect(args.params.ARFIELDS).toEqual({ COMMENT_TEXT: '' })
    // Crucially, SECONDS / USER_ID are NOT in ARFIELDS — they would be
    // overwritten if we'd sent them through.
    expect('SECONDS' in args.params.ARFIELDS).toBe(false)
  })

  it('combines multiple field changes into a single update call', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null))
    await tool.handler({ taskId: 691, itemId: 5, seconds: 900, comment: 'updated', userId: 47 })

    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { ARFIELDS: Record<string, unknown> } }
    expect(args.params.ARFIELDS).toEqual({ SECONDS: 900, COMMENT_TEXT: 'updated', USER_ID: 47 })

    const payload = JSON.parse(
      (await tool.handler({ taskId: 691, itemId: 5, seconds: 900, comment: 'updated', userId: 47 })).content[0]!.text,
    )
    expect(payload).toEqual({
      updated: true,
      taskId: 691,
      itemId: 5,
      seconds: 900,
      comment: 'updated',
      userId: 47,
    })
  })

  it('refuses an update with no changes (NO_CHANGES error code)', async () => {
    await expect(tool.handler({ taskId: 691, itemId: 5 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'NO_CHANGES',
    })
    // The handler short-circuits — no wire call should have been made.
    expect(fake.v2Call).not.toHaveBeenCalled()
  })

  it('wraps SDK errors (e.g. ACCESS_DENIED from non-author edits) into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 5, itemId: 7, seconds: 600 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
