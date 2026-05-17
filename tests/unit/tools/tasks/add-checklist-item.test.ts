import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const callMethod = vi.fn()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod }),
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
}

describe('bitrix24_add_checklist_item', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('creates a new checklist heading when parentId is omitted', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: 431 }) })

    const result = await tool.handler({ taskId: 8017, title: 'QA' })

    expect(callMethod).toHaveBeenCalledWith('task.checklistitem.add', {
      TASKID: 8017,
      FIELDS: { TITLE: 'QA', PARENT_ID: 0 },
    })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ added: true, taskId: 8017, itemId: 431, title: 'QA', parentId: 0 })
  })

  it('forwards parentId / sortIndex / isImportant when provided', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: 475 }) })

    await tool.handler({
      taskId: 13,
      title: 'Подготовить отчет',
      parentId: 457,
      sortIndex: 200,
      isImportant: true,
    })

    expect(callMethod).toHaveBeenCalledWith('task.checklistitem.add', {
      TASKID: 13,
      FIELDS: {
        TITLE: 'Подготовить отчет',
        PARENT_ID: 457,
        SORT_INDEX: 200,
        IS_IMPORTANT: 'Y',
      },
    })
  })

  it('maps isImportant: false to IS_IMPORTANT="N" (explicit no, not omission)', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: 1 }) })

    await tool.handler({ taskId: 1, title: 'x', isImportant: false })
    const args = callMethod.mock.calls[0]![1] as { FIELDS: Record<string, unknown> }
    expect(args.FIELDS).toMatchObject({ IS_IMPORTANT: 'N' })
  })

  it('coerces a stringified id to a number in the response', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: '491' }) })
    const result = await tool.handler({ taskId: 1, title: 'x' })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.itemId).toBe(491)
  })

  it('falls back to a friendly message when Bitrix24 returns no id', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: undefined }) })
    const result = await tool.handler({ taskId: 5, title: 'x' })
    expect(result.content[0]!.text).toMatch(/task 5/)
    expect(result.content[0]!.text).toMatch(/no item id/i)
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    callMethod.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 42, title: 'x' })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })
})
