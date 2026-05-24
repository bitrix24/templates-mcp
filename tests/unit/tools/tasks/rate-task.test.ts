import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../../server/utils/errors'
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

const tool = (await import('../../../../server/mcp/tools/tasks/rate-task')).default as unknown as {
  handler: (input: {
    taskId: number | number[]
    rating: 'positive' | 'negative' | 'none'
    force?: boolean
  }) => Promise<ToolContent>
}

describe('b24_task_rate', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('maps positive rating to MARK=P via actions.v2.call.make on tasks.task.update', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 7, title: 'done well' } }))

    const result = await tool.handler({ taskId: 7, rating: 'positive' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.update',
      params: { taskId: 7, fields: { MARK: 'P' } },
    })
    // Regression guard: classic tasks.task.update must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rated: true,
      id: 7,
      title: 'done well',
      rating: 'positive',
      mark: 'P',
    })
  })

  it('maps negative rating to MARK=N', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 8, title: 'redo' } }))

    await tool.handler({ taskId: 8, rating: 'negative' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.update',
      params: { taskId: 8, fields: { MARK: 'N' } },
    })
  })

  it('maps none to MARK=null to clear an existing rating', async () => {
    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 9, title: 'unrated' } }))

    const result = await tool.handler({ taskId: 9, rating: 'none' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'tasks.task.update',
      params: { taskId: 9, fields: { MARK: null } },
    })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.rating).toBe('none')
    expect(payload.mark).toBeNull()
  })

  it('falls back to a re-list message when Bitrix24 returns no task body', async () => {
    fake.v2Call.mockResolvedValue(fakeOkEmpty())
    const result = await tool.handler({ taskId: 42, rating: 'positive' })
    expect(result.content[0]!.text).toMatch(/42/)
    expect(result.content[0]!.text).toMatch(/Re-list/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 7, rating: 'positive' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('batch mode: dispatches one actions.v2.batch.make and shapes per-id results', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        fakeOk({ task: { id: 10, title: 'a' } }),
        { isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['action not allowed'] },
        fakeOk({ task: { id: 30, title: 'c' } }),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: [10, 20, 30], rating: 'negative' })

    expect(fake.v2Batch).toHaveBeenCalledWith({
      calls: [
        ['tasks.task.update', { taskId: 10, fields: { MARK: 'N' } }],
        ['tasks.task.update', { taskId: 20, fields: { MARK: 'N' } }],
        ['tasks.task.update', { taskId: 30, fields: { MARK: 'N' } }],
      ],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
    // Regression guard: classic tasks.task.update must NOT go through the v3 batch transport.
    expect(fake.v3Batch).not.toHaveBeenCalled()

    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      rating: string
      mark: string
      total: number
      ok: number
      failed: number
      results: { taskId: number; ok: boolean }[]
    }
    expect(payload).toMatchObject({ batch: true, rating: 'negative', mark: 'N', total: 3, ok: 2, failed: 1 })
    expect(payload.results.map((r) => [r.taskId, r.ok])).toEqual([
      [10, true],
      [20, false],
      [30, true],
    ])
  })

  it('batch mode rejects > 25 ids without force (no SDK call made)', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => i + 1)
    await expect(tool.handler({ taskId: ids, rating: 'positive' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()
  })

  it('batch mode accepts > 25 ids with force=true', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => i + 1)
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map((id) => fakeOk({ task: { id, title: `t${id}`, status: '3' } })),
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: ids, rating: 'positive', force: true })
    const payload = JSON.parse(result.content[0]!.text) as { total: number; ok: number }
    expect(payload.total).toBe(26)
    expect(payload.ok).toBe(26)
    expect(fake.v3Batch).not.toHaveBeenCalled()
  })
})
