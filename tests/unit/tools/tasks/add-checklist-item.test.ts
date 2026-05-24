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

interface AddInput {
  taskId: number
  title: string
  parentId?: number
  sortIndex?: number
  isImportant?: boolean
}

const tool = (await import('../../../../server/mcp/tools/tasks/add-checklist-item')).default as unknown as {
  handler: (input: AddInput) => Promise<ToolContent>
  inputSchema: { title: z.ZodString; taskId: z.ZodNumber }
}

describe('b24_task_checklist_item_add', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('creates a new checklist heading when parentId is omitted (PARENT_ID: 0 pinned on wire)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(431))

    const result = await tool.handler({ taskId: 8017, title: 'QA' })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.add',
      params: { TASKID: 8017, FIELDS: { TITLE: 'QA', PARENT_ID: 0 } },
    })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ added: true, taskId: 8017, itemId: 431, title: 'QA', parentId: 0 })
  })

  it('forwards parentId / sortIndex / isImportant when provided', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(475))

    await tool.handler({
      taskId: 13,
      title: 'Подготовить отчет',
      parentId: 457,
      sortIndex: 200,
      isImportant: true,
    })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.add',
      params: {
        TASKID: 13,
        FIELDS: {
          TITLE: 'Подготовить отчет',
          PARENT_ID: 457,
          SORT_INDEX: 200,
          IS_IMPORTANT: 'Y',
        },
      },
    })
  })

  it('maps isImportant: false to IS_IMPORTANT="N" (explicit no, not omission)', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(1))

    await tool.handler({ taskId: 1, title: 'x', isImportant: false })
    const args = fake.v2Call.mock.calls[0]![0] as unknown as { params: { FIELDS: Record<string, unknown> } }
    expect(args.params.FIELDS).toMatchObject({ IS_IMPORTANT: 'N' })
  })

  it('coerces a stringified id to a number in the response', async () => {
    fake.v2Call.mockResolvedValue(fakeOk('491' as unknown as number))
    const result = await tool.handler({ taskId: 1, title: 'x' })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.itemId).toBe(491)
  })

  it('falls back to a friendly message when Bitrix24 returns no id', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(undefined as unknown as number))
    const result = await tool.handler({ taskId: 5, title: 'x' })
    expect(result.content[0]!.text).toMatch(/task 5/)
    expect(result.content[0]!.text).toMatch(/no item id/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 42, title: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('schema rejects empty title at the Zod layer', () => {
    const parsed = tool.inputSchema.title.safeParse('')
    expect(parsed.success).toBe(false)
  })

  it('schema rejects titles longer than 255 chars (memory-DoS guard)', () => {
    expect(tool.inputSchema.title.safeParse('a'.repeat(255)).success).toBe(true)
    expect(tool.inputSchema.title.safeParse('a'.repeat(256)).success).toBe(false)
    // A wildly oversized payload — the kind of blob that protects against
    // memory exhaustion if an agent passes raw HTML / log files / base64 data.
    expect(tool.inputSchema.title.safeParse('a'.repeat(10_000_000)).success).toBe(false)
  })

  it('schema rejects non-positive taskId at the Zod layer', () => {
    expect(tool.inputSchema.taskId.safeParse(0).success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(-1).success).toBe(false)
    expect(tool.inputSchema.taskId.safeParse(1.5).success).toBe(false)
  })
})
