import { describe, expect, it } from 'vitest'
import { callV3, callV2, batchV3, batchV2 } from '../../../server/utils/sdk-helpers'
import { Bitrix24ToolError } from '../../../server/utils/errors'
import { makeFakeBitrix24, fakeOk, fakeOkEmpty } from '../_helpers/bitrix24-mock'

describe('callV3', () => {
  it('returns the result payload on success', async () => {
    const { b24, v3Call } = makeFakeBitrix24()
    v3Call.mockResolvedValue(fakeOk({ id: 42 }))
    const result = await callV3<{ id: number }>(b24 as never, 'tasks.task.get', { taskId: 42 }, 'ctx')
    expect(result).toEqual({ id: 42 })
  })

  it('returns undefined when Bitrix24 succeeds with empty body', async () => {
    const { b24, v3Call } = makeFakeBitrix24()
    v3Call.mockResolvedValue(fakeOkEmpty())
    const result = await callV3(b24 as never, 'tasks.task.start', {}, 'ctx')
    expect(result).toBeUndefined()
  })

  it('throws Bitrix24ToolError when isSuccess is false', async () => {
    const { b24, v3Call } = makeFakeBitrix24()
    v3Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['NOT_FOUND'] })
    await expect(callV3(b24 as never, 'tasks.task.get', {}, 'fallback ctx')).rejects.toThrow('NOT_FOUND')
    await expect(callV3(b24 as never, 'tasks.task.get', {}, 'fallback ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })

  it('uses errorContext fallback when getErrorMessages returns empty', async () => {
    const { b24, v3Call } = makeFakeBitrix24()
    v3Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => [] })
    await expect(callV3(b24 as never, 'method', {}, 'my fallback')).rejects.toThrow('my fallback')
  })

  it('wraps transport throws as Bitrix24ToolError', async () => {
    const { b24, v3Call } = makeFakeBitrix24()
    v3Call.mockRejectedValue(new Error('network timeout'))
    await expect(callV3(b24 as never, 'method', {}, 'ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })
})

describe('callV2', () => {
  it('returns result on success with object params', async () => {
    const { b24, v2Call } = makeFakeBitrix24()
    v2Call.mockResolvedValue(fakeOk({ ID: '7' }))
    const result = await callV2<{ ID: string }>(b24 as never, 'user.current', {}, 'ctx')
    expect(result).toEqual({ ID: '7' })
  })

  it('returns result on success with positional array params', async () => {
    const { b24, v2Call } = makeFakeBitrix24()
    v2Call.mockResolvedValue(fakeOk(true))
    const result = await callV2(b24 as never, 'task.checklistitem.complete', [1, 99], 'ctx')
    expect(result).toBe(true)
  })

  it('throws Bitrix24ToolError when isSuccess is false', async () => {
    const { b24, v2Call } = makeFakeBitrix24()
    v2Call.mockResolvedValue({ isSuccess: false, getData: () => ({ result: undefined }), getErrorMessages: () => ['ACCESS_DENIED'] })
    await expect(callV2(b24 as never, 'user.get', {}, 'ctx')).rejects.toThrow('ACCESS_DENIED')
  })

  it('wraps transport throws as Bitrix24ToolError', async () => {
    const { b24, v2Call } = makeFakeBitrix24()
    v2Call.mockRejectedValue(new Error('timeout'))
    await expect(callV2(b24 as never, 'user.get', {}, 'ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })
})

describe('batchV3', () => {
  it('returns array of AjaxResult rows on success', async () => {
    const { b24, v3Batch } = makeFakeBitrix24()
    const rows = [fakeOk(1), fakeOk(2)]
    v3Batch.mockResolvedValue({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
    const result = await batchV3<number>(b24 as never, [['tasks.task.start', { taskId: 1 }], ['tasks.task.start', { taskId: 2 }]], 'ctx')
    expect(result).toHaveLength(2)
    expect(result).toStrictEqual(rows)
  })

  it('throws Bitrix24ToolError when top-level isSuccess is false', async () => {
    const { b24, v3Batch } = makeFakeBitrix24()
    v3Batch.mockResolvedValue({ isSuccess: false, getData: () => [], getErrorMessages: () => ['BATCH_FAILED'] })
    await expect(batchV3(b24 as never, [], 'ctx')).rejects.toThrow('BATCH_FAILED')
    await expect(batchV3(b24 as never, [], 'ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })

  it('does not throw for per-row failures (isHaltOnError: false semantics)', async () => {
    const { b24, v3Batch } = makeFakeBitrix24()
    const rows = [fakeOk(1), { isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['ROW_ERR'] }]
    v3Batch.mockResolvedValue({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
    const result = await batchV3(b24 as never, [], 'ctx')
    expect(result).toHaveLength(2)
    expect(result[1]?.isSuccess).toBe(false)
  })

  it('keeps the rows when the SDK marks the envelope failed for a per-row error', async () => {
    // This is the shape the real SDK produces: `returnAjaxResult: true` fills
    // the rows AND copies each row error onto the envelope, so `isSuccess` is
    // false whenever any single call failed. Throwing here used to discard the
    // rows — and with them the answer to "which ids actually went through".
    const { b24, v3Batch } = makeFakeBitrix24()
    const rows = [fakeOk(1), { isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['ROW_ERR'] }]
    v3Batch.mockResolvedValue({ isSuccess: false, getData: () => rows, getErrorMessages: () => ['ROW_ERR'] })
    const result = await batchV3(b24 as never, [], 'ctx')
    expect(result).toHaveLength(2)
    expect(result[0]?.isSuccess).toBe(true)
    expect(result[1]?.isSuccess).toBe(false)
  })

  it('wraps transport throws as Bitrix24ToolError', async () => {
    const { b24, v3Batch } = makeFakeBitrix24()
    v3Batch.mockRejectedValue(new Error('transport error'))
    await expect(batchV3(b24 as never, [], 'ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })
})

describe('batchV2', () => {
  it('returns array of AjaxResult rows on success', async () => {
    const { b24, v2Batch } = makeFakeBitrix24()
    const rows = [fakeOk(true)]
    v2Batch.mockResolvedValue({ isSuccess: true, getData: () => rows, getErrorMessages: () => [] })
    const result = await batchV2<boolean>(b24 as never, [['task.checklistitem.complete', [1, 5]]], 'ctx')
    expect(result).toHaveLength(1)
    expect(result).toStrictEqual(rows)
  })

  it('throws Bitrix24ToolError when the envelope failed AND no rows came back', async () => {
    const { b24, v2Batch } = makeFakeBitrix24()
    v2Batch.mockResolvedValue({ isSuccess: false, getData: () => [], getErrorMessages: () => ['V2_FAILED'] })
    await expect(batchV2(b24 as never, [], 'ctx')).rejects.toThrow('V2_FAILED')
  })

  it('throws when the envelope failed and getData returned nothing at all', async () => {
    const { b24, v2Batch } = makeFakeBitrix24()
    v2Batch.mockResolvedValue({ isSuccess: false, getData: () => null as never, getErrorMessages: () => [] })
    await expect(batchV2(b24 as never, [], 'my ctx')).rejects.toThrow('my ctx')
  })

  it('keeps the rows when the SDK marks the envelope failed for a per-row error', async () => {
    // Real-SDK shape — see the batchV3 counterpart. Live repro was
    // `b24_task_pause { taskId: [good, good, missing] }`: both good tasks were
    // paused, but the tool answered with a single bare error.
    const { b24, v2Batch } = makeFakeBitrix24()
    const rows = [
      fakeOk(true),
      { isSuccess: false, getData: () => ({ result: null }), getErrorMessages: () => ['Действие над задачей не разрешено'] },
    ]
    v2Batch.mockResolvedValue({
      isSuccess: false,
      getData: () => rows,
      getErrorMessages: () => ['Действие над задачей не разрешено'],
    })
    const result = await batchV2(b24 as never, [], 'ctx')
    expect(result).toHaveLength(2)
    expect(result[0]?.isSuccess).toBe(true)
    expect(result[1]?.getErrorMessages()).toContain('Действие над задачей не разрешено')
  })

  it('wraps transport throws as Bitrix24ToolError', async () => {
    const { b24, v2Batch } = makeFakeBitrix24()
    v2Batch.mockRejectedValue(new Error('timeout'))
    await expect(batchV2(b24 as never, [], 'ctx')).rejects.toBeInstanceOf(Bitrix24ToolError)
  })
})
