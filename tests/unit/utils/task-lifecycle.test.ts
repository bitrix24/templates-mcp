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
  inputSchema: { taskId: z.ZodNumber }
  handler: (input: { taskId: number }) => Promise<{ content: { type: 'text'; text: string }[] }>
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
