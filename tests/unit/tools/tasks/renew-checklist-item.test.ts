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

const tool = (await import('../../../../server/mcp/tools/tasks/renew-checklist-item')).default as unknown as {
  handler: (input: { taskId: number; itemId: number | number[]; force?: boolean }) => Promise<ToolContent>
}

/**
 * Every checklist action now pre-flights `task.checklistitem.getlist` to make
 * sure the ids really belong to the task — Bitrix24 resolves items by id
 * alone and would happily act on another task's item (see
 * `assertItemsOnTask`). This fixture covers every id the tests below use.
 */
const CHECKLIST = Array.from({ length: 60 }, (_, i) => ({
  ID: String(i + 1),
  TASK_ID: '13',
  PARENT_ID: '9',
  TITLE: `item ${i + 1}`,
})).concat([
  { ID: '21', TASK_ID: '13', PARENT_ID: '9', TITLE: 'item 21' },
  { ID: '22', TASK_ID: '13', PARENT_ID: '9', TITLE: 'item 22' },
  { ID: '23', TASK_ID: '13', PARENT_ID: '9', TITLE: 'item 23' },
])

/** Answer the pre-flight read; leave every other method to the test's own mock. */
function preflight(items: unknown[] = CHECKLIST) {
  return async (options: { method: string }) => {
    if (options.method === 'task.checklistitem.getlist') return fakeOk(items)
    return fakeOk(true)
  }
}

describe('b24_task_checklist_item_renew', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
    fake.v2Batch.mockReset()
    fake.v2Call.mockImplementation(preflight())
  })

  it('calls task.checklistitem.renew with positional [taskId, itemId]', async () => {
    fake.v2Call.mockResolvedValue(fakeOk(true))

    const result = await tool.handler({ taskId: 13, itemId: 21 })

    expect(fake.v2Call).toHaveBeenCalledWith({
      method: 'task.checklistitem.renew',
      params: [13, 21],
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ renewed: true, taskId: 13, itemId: 21 })
  })

  it('wraps SDK errors with task and item ids in the fallback', async () => {
    fake.v2Call.mockRejectedValue(new Error('action not allowed'))
    await expect(tool.handler({ taskId: 13, itemId: 21 })).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'action not allowed',
    })
  })

  it('batch mode dispatches one v2 batch.make call with renew tuples', async () => {
    fake.v2Batch.mockResolvedValue({
      isSuccess: true,
      getData: () => [fakeOk(true), fakeOk(true)],
      getErrorMessages: () => [],
    })

    const result = await tool.handler({ taskId: 13, itemId: [21, 22] })

    expect(fake.v2Batch).toHaveBeenCalledTimes(1)
    const calls = (fake.v2Batch.mock.calls[0]![0] as unknown as { calls: Array<[string, unknown[]]> }).calls
    expect(calls).toEqual([
      ['task.checklistitem.renew', [13, 21]],
      ['task.checklistitem.renew', [13, 22]],
    ])
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      batch: true,
      verb: 'renewed',
      taskId: 13,
      total: 2,
      ok: 2,
      failed: 0,
    })
  })
})
