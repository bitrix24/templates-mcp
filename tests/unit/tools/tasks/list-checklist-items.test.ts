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

describe('b24_task_checklist_item_list', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('calls task.checklistitem.getlist (v2) with just TASKID by default', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk([
        {
          ID: '431',
          TASK_ID: '8017',
          PARENT_ID: 0,
          CREATED_BY: '503',
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
          CREATED_BY: '503',
          TITLE: 'Найти все документы',
          SORT_INDEX: '0',
          IS_COMPLETE: 'Y',
          IS_IMPORTANT: 'N',
          TOGGLED_BY: '503',
          TOGGLED_DATE: '2025-11-10T15:02:30+03:00',
        },
      ]),
    )

    const result = await tool.handler({ taskId: 8017 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.getlist',
      params: { TASKID: 8017 },
    })

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
        createdBy: 503,
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
        createdBy: 503,
        toggledBy: 503,
        toggledDate: '2025-11-10T15:02:30+03:00',
      },
    ])
  })

  it('forwards order with the field mapped to UPPER_SNAKE and direction upper-cased', async () => {
    fake.v2Call.mockResolvedValue(fakeOk([]))

    await tool.handler({ taskId: 1, order: { field: 'sortIndex', direction: 'asc' } })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.getlist',
      params: { TASKID: 1, ORDER: { SORT_INDEX: 'ASC' } },
    })
  })

  it('returns an empty list when Bitrix24 returns no result array', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(null as unknown as unknown[]))

    const result = await tool.handler({ taskId: 99 })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({ taskId: 99, returned: 0, items: [] })
  })

  it('wraps SDK errors with the task id in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('access denied'))
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'access denied',
    })
  })

  it('propagates the SDK error code on access denial (e.g. caller cannot see the task)', async () => {
    fake.v2Call.mockRejectedValue(
      Object.assign(new Error('Access denied'), { code: 'ERROR_CORE' }),
    )
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      code: 'ERROR_CORE',
    })
  })

  it('returns no items when isSuccess=false would have thrown — callV2 throws first, the empty-array fallback is unreachable here (regression guard)', async () => {
    // If the SDK reports !isSuccess, callV2 throws — verifying the handler
    // doesn't swallow that throw into a "0 items" success response.
    fake.v2Call.mockResolvedValue({
      isSuccess: false,
      getData: () => ({ result: undefined }),
      getErrorMessages: () => ['QUERY_LIMIT_EXCEEDED'],
    })
    await expect(tool.handler({ taskId: 7 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
    })
  })
})
