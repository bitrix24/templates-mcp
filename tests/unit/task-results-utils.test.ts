import { describe, expect, it } from 'vitest'
import { toTaskResultShort } from '../../server/utils/task-results'

describe('toTaskResultShort', () => {
  it('maps the v3 response shape returned by tasks.task.result.add', () => {
    expect(
      toTaskResultShort({
        id: 17,
        taskId: 51,
        text: 'Работа выполнена',
        authorId: 1,
        createdAt: '2026-04-30T10:15:00+03:00',
        updatedAt: null,
        status: 'open',
        fileIds: [],
        messageId: null,
      }),
    ).toEqual({
      id: 17,
      taskId: 51,
      text: 'Работа выполнена',
      authorId: 1,
      createdAt: '2026-04-30T10:15:00+03:00',
      updatedAt: null,
      status: 'open',
      messageId: null,
    })
  })

  it('coerces stringified numeric ids to numbers', () => {
    const r = toTaskResultShort({ id: '17', taskId: '51', text: 'x', authorId: '503', messageId: '335' })
    expect(r?.id).toBe(17)
    expect(r?.taskId).toBe(51)
    expect(r?.authorId).toBe(503)
    expect(r?.messageId).toBe(335)
  })

  it('returns null on shapes missing id or taskId', () => {
    expect(toTaskResultShort({ taskId: 51, text: 'x' })).toBeNull()
    expect(toTaskResultShort({ id: 17, text: 'x' })).toBeNull()
    expect(toTaskResultShort(null)).toBeNull()
    expect(toTaskResultShort('not an object')).toBeNull()
  })

  it('handles missing optional fields with null fallbacks', () => {
    const r = toTaskResultShort({ id: 1, taskId: 1, text: 'x' })
    expect(r).toEqual({
      id: 1,
      taskId: 1,
      text: 'x',
      authorId: null,
      createdAt: null,
      updatedAt: null,
      status: null,
      messageId: null,
    })
  })
})
