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

interface ListInput {
  taskId: number
  order?: {
    field:
      | 'id'
      | 'parentId'
      | 'createdBy'
      | 'title'
      | 'sortIndex'
      | 'isComplete'
      | 'isImportant'
      | 'toggledBy'
      | 'toggledDate'
    direction: 'asc' | 'desc'
  }
}

const tool = (await import('../../../../server/mcp/tools/tasks/list-checklist-items')).default as unknown as {
  handler: (input: ListInput) => Promise<ToolContent>
}

describe('bitrix24_list_checklist_items', () => {
  beforeEach(() => {
    callMethod.mockReset()
  })

  it('calls task.checklistitem.getlist with just TASKID by default', async () => {
    callMethod.mockResolvedValue({
      getData: () => ({
        result: [
          {
            ID: '431',
            TASK_ID: '8017',
            PARENT_ID: 0,
            TITLE: 'Чек-лист 1',
            SORT_INDEX: '0',
            IS_COMPLETE: 'N',
            IS_IMPORTANT: 'N',
            TOGGLED_BY: null,
            TOGGLED_DATE: '',
          },
          {
            ID: '433',
            TASK_ID: '8017',
            PARENT_ID: '431',
            TITLE: 'Найти все документы',
            SORT_INDEX: '0',
            IS_COMPLETE: 'Y',
            IS_IMPORTANT: 'N',
            TOGGLED_BY: '503',
            TOGGLED_DATE: '2025-11-10T15:02:30+03:00',
          },
        ],
      }),
    })

    const result = await tool.handler({ taskId: 8017 })

    expect(callMethod).toHaveBeenCalledWith('task.checklistitem.getlist', { TASKID: 8017 })

    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.taskId).toBe(8017)
    expect(payload.returned).toBe(2)
    expect(payload.items).toEqual([
      {
        id: 431,
        taskId: 8017,
        parentId: 0,
        title: 'Чек-лист 1',
        sortIndex: 0,
        isComplete: false,
        isImportant: false,
        toggledBy: null,
        toggledDate: null,
      },
      {
        id: 433,
        taskId: 8017,
        parentId: 431,
        title: 'Найти все документы',
        sortIndex: 0,
        isComplete: true,
        isImportant: false,
        toggledBy: 503,
        toggledDate: '2025-11-10T15:02:30+03:00',
      },
    ])
  })

  it('forwards order with the field mapped to UPPER_SNAKE and direction upper-cased', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: [] }) })

    await tool.handler({ taskId: 1, order: { field: 'sortIndex', direction: 'asc' } })

    expect(callMethod).toHaveBeenCalledWith('task.checklistitem.getlist', {
      TASKID: 1,
      ORDER: { SORT_INDEX: 'ASC' },
    })
  })

  it('returns an empty list when Bitrix24 returns no result array', async () => {
    callMethod.mockResolvedValue({ getData: () => ({ result: null }) })

    const result = await tool.handler({ taskId: 99 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ taskId: 99, returned: 0, items: [] })
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    callMethod.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })
})
