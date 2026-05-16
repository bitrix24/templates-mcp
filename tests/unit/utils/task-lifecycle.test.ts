import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const callMethod = vi.fn()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod }),
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

describe('defineTaskLifecycleTool', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('rejects non-positive, non-integer, and string taskIds at the schema layer', () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_start_task',
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
      name: 'bitrix24_start_task',
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

  it('batch mode: returns a summary payload with per-id results', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_pause_task',
      method: 'tasks.task.pause',
      verb: 'pause',
      pastTense: 'paused',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    callMethod
      .mockResolvedValueOnce({ getData: () => ({ result: { task: { id: 1, title: 'a', status: '2' } } }) })
      .mockRejectedValueOnce(new Error('action not allowed'))
      .mockResolvedValueOnce({ getData: () => ({ result: { task: { id: 3, title: 'c', status: '2' } } }) })

    const result = await tool.handler({ taskId: [1, 2, 3] })
    const payload = JSON.parse(result.content[0]!.text) as {
      batch: boolean
      verb: string
      total: number
      ok: number
      failed: number
      results: { taskId: number; ok: boolean; status?: string | null; error?: string }[]
    }

    expect(callMethod).toHaveBeenCalledTimes(3)
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

  it('batch mode preserves input order even when calls resolve out of order', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_complete_task',
      method: 'tasks.task.complete',
      verb: 'complete',
      pastTense: 'completed',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    callMethod.mockImplementation(async (_method: string, params: { taskId: number }) => ({
      getData: () => ({ result: { task: { id: params.taskId, title: `t${params.taskId}`, status: '5' } } }),
    }))

    const result = await tool.handler({ taskId: [10, 20, 30, 40] })
    const payload = JSON.parse(result.content[0]!.text) as { results: { taskId: number }[] }
    expect(payload.results.map((r) => r.taskId)).toEqual([10, 20, 30, 40])
  })

  it('batch mode rejects > 25 ids by default and accepts the same with force=true', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_start_task',
      method: 'tasks.task.start',
      verb: 'start',
      pastTense: 'started',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    const ids = Array.from({ length: 26 }, (_, i) => i + 1)

    await expect(tool.handler({ taskId: ids })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'BATCH_TOO_LARGE',
    })

    callMethod.mockResolvedValue({ getData: () => ({ result: { task: { id: 1, title: 't', status: '3' } } }) })
    const result = await tool.handler({ taskId: ids, force: true })
    const payload = JSON.parse(result.content[0]!.text) as { total: number; ok: number }
    expect(payload.total).toBe(26)
    expect(payload.ok).toBe(26)
  })

  it('passes the configured REST method to useBitrix24 and shapes the payload uniformly across the seven verbs', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_defer_task',
      method: 'tasks.task.defer',
      verb: 'defer',
      pastTense: 'deferred',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    callMethod.mockResolvedValue({
      getData: () => ({ result: { task: { id: 1, title: 't', status: '6', responsibleId: '5' } } }),
    })

    const payload = JSON.parse((await tool.handler({ taskId: 1 })).content[0]!.text)
    expect(callMethod).toHaveBeenCalledWith('tasks.task.defer', { taskId: 1 })
    expect(payload).toEqual({ deferred: true, id: 1, title: 't', status: '6', responsibleId: '5' })
  })

  it('uses the infinitive verb in error fallback messages', async () => {
    const tool = defineTaskLifecycleTool({
      name: 'bitrix24_disapprove_task',
      method: 'tasks.task.disapprove',
      verb: 'disapprove',
      pastTense: 'disapproved',
      description: 'irrelevant',
      taskIdHint: 'irrelevant',
    }) as unknown as ToolDef

    callMethod.mockRejectedValue(new Error(''))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'Failed to disapprove Bitrix24 task 7',
    })
  })
})
