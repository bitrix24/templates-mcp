import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Bitrix24ErrorCode } from '../../../server/utils/errors'
import { z } from 'zod'
import { fakeOk, makeFakeBitrix24 } from '../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => fake.b24,
}))

interface ToolDef {
  name: string
  description: string
  inputSchema: { taskId: z.ZodType; force?: z.ZodOptional<z.ZodBoolean> }
  handler: (input: {
    taskId: number | number[]
    force?: boolean
  }) => Promise<{ content: { type: 'text'; text: string }[] }>
}

const { defineTaskLifecycleTool } = await import('../../../server/utils/task-lifecycle')

/**
 * Helper for tests that fan out across batch.make rows. Builds an
 * AjaxResult-like row for an OK case carrying the given `task` payload.
 */
function okRow(task: { id: number; title: string; status?: string; responsibleId?: string }) {
  return fakeOk({ task })
}

/** Builds a failure row for batch.make. */
function errRow(message: string) {
  return {
    isSuccess: false,
    getData: () => ({ result: undefined }),
    getErrorMessages: () => [message],
  }
}

describe('defineTaskLifecycleTool', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
  })

  it('rejects non-positive, non-integer, and string taskIds at the schema layer', () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_start',
      method: 'tasks.task.start',
      verb: 'start',
      pastTense: 'started',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    const schema = z.object(tool.inputSchema)
    expect(schema.safeParse({ taskId: 0 }).success).toBe(false)
    expect(schema.safeParse({ taskId: -1 }).success).toBe(false)
    expect(schema.safeParse({ taskId: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ taskId: '5' }).success).toBe(false)
    expect(schema.safeParse({ taskId: 5 }).success).toBe(true)
  })

  it('accepts arrays of positive ints (batch input) and rejects empty / mixed arrays', () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_start',
      method: 'tasks.task.start',
      verb: 'start',
      pastTense: 'started',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    const schema = z.object(tool.inputSchema)
    expect(schema.safeParse({ taskId: [1, 2, 3] }).success).toBe(true)
    expect(schema.safeParse({ taskId: [] }).success).toBe(false)
    expect(schema.safeParse({ taskId: [1, -2] }).success).toBe(false)
    expect(schema.safeParse({ taskId: [1, 1.5] }).success).toBe(false)
    expect(schema.safeParse({ taskId: [1, 2], force: true }).success).toBe(true)
  })

  it('batch mode: dispatches one actions.v2.batch.make and shapes per-id results', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_pause',
      method: 'tasks.task.pause',
      verb: 'pause',
      pastTense: 'paused',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        okRow({ id: 1, title: 'a', status: '2' }),
        errRow('action not allowed'),
        okRow({ id: 3, title: 'c', status: '2' }),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: [1, 2, 3] })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      total: number
      ok: number
      failed: number
      results: { taskId: number; ok: boolean; status?: string | null; error?: string }[]
    }

    expect(fake.v2Batch).toHaveBeenCalledWith({
      calls: [
        ['tasks.task.pause', { taskId: 1 }],
        ['tasks.task.pause', { taskId: 2 }],
        ['tasks.task.pause', { taskId: 3 }],
      ],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
    // Regression guard: classic tasks.task.* must NOT go through the v3 transport.
    expect(fake.v3Batch).not.toHaveBeenCalled()
    expect(payload.batch).toBe(true)
    expect(payload.verb).toBe('paused')
    expect(payload.total).toBe(3)
    expect(payload.ok).toBe(2)
    expect(payload.failed).toBe(1)
    expect(payload.results.map((r) => [r.taskId, r.ok])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ])
    expect(payload.results[1]!.error).toMatch(/action not allowed/)
  })

  it('batch mode preserves input order in the results[] array', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_complete',
      method: 'tasks.task.complete',
      verb: 'complete',
      pastTense: 'completed',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [
        okRow({ id: 10, title: 't10', status: '5' }),
        okRow({ id: 20, title: 't20', status: '5' }),
        okRow({ id: 30, title: 't30', status: '5' }),
        okRow({ id: 40, title: 't40', status: '5' }),
      ],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: [10, 20, 30, 40] })
    const payload = JSON.parse(result.content[0]!.text) as { results: { taskId: number }[] }
    expect(payload.results.map((r) => r.taskId)).toEqual([10, 20, 30, 40])
  })

  it('batch mode rejects > 25 ids by default and accepts the same with force=true', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_start',
      method: 'tasks.task.start',
      verb: 'start',
      pastTense: 'started',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    const ids = Array.from({ length: 26 }, (_, i) => i + 1)

    await expect(tool.handler({ taskId: ids })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: Bitrix24ErrorCode.BATCH_TOO_LARGE,
    })
    expect(fake.v2Batch).not.toHaveBeenCalled()

    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => ids.map(() => okRow({ id: 1, title: 't', status: '3' })),
      getErrorMessages: () => [],
    })
    const result = await tool.handler({ taskId: ids, force: true })
    const payload = JSON.parse(result.content[0]!.text) as { total: number; ok: number }
    expect(payload.total).toBe(26)
    expect(payload.ok).toBe(26)
  })

  it('passes the configured REST method to actions.v2.call.make and shapes the payload uniformly across the seven verbs', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_defer',
      method: 'tasks.task.defer',
      verb: 'defer',
      pastTense: 'deferred',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    fake.v2Call.mockResolvedValue(fakeOk({ task: { id: 1, title: 't', status: '6', responsibleId: '5' } }))

    const payload = JSON.parse((await tool.handler({ taskId: 1 })).content[0]!.text)
    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'tasks.task.defer', params: { taskId: 1 } })
    // Regression guard: classic tasks.task.* must NOT go through the v3 transport.
    expect(fake.v3Call).not.toHaveBeenCalled()
    expect(payload).toEqual({ deferred: true, id: 1, title: 't', status: '6', responsibleId: '5' })
  })

  it('uses the infinitive verb in error fallback messages', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'b24_task_disapprove',
      method: 'tasks.task.disapprove',
      verb: 'disapprove',
      pastTense: 'disapproved',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    fake.v2Call.mockRejectedValue(new Error(''))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'Failed to disapprove Bitrix24 task 7',
    })
  })
})
