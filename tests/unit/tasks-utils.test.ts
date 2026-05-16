import { describe, expect, it } from 'vitest'
import { extractTasks, toTaskShort } from '../../server/utils/tasks'

describe('toTaskShort', () => {
  it('reads camelCase fields (v3 response shape)', () => {
    expect(
      toTaskShort({
        id: 7,
        title: 'demo',
        status: '2',
        deadline: '2026-05-20T18:00:00+03:00',
        responsibleId: '5',
        createdDate: '2026-05-16T08:00:00+03:00',
        priority: '1',
      }),
    ).toEqual({
      id: 7,
      title: 'demo',
      status: '2',
      deadline: '2026-05-20T18:00:00+03:00',
      responsibleId: '5',
      createdDate: '2026-05-16T08:00:00+03:00',
      priority: '1',
    })
  })

  it('reads UPPERCASE fields (legacy response shape)', () => {
    expect(
      toTaskShort({
        ID: '7',
        TITLE: 'demo',
        STATUS: '2',
        DEADLINE: '2026-05-20T18:00:00+03:00',
        RESPONSIBLE_ID: '5',
      }),
    ).toMatchObject({ id: '7', title: 'demo', status: '2', responsibleId: '5' })
  })

  it('returns null when id or title is missing', () => {
    expect(toTaskShort({ TITLE: 'no id' })).toBeNull()
    expect(toTaskShort({ ID: 1 })).toBeNull()
    expect(toTaskShort(null)).toBeNull()
    expect(toTaskShort('not an object')).toBeNull()
  })

  it('omits absent optional fields rather than emitting nulls', () => {
    const result = toTaskShort({ id: 1, title: 'minimal' })
    expect(result).toEqual({
      id: 1,
      title: 'minimal',
      status: undefined,
      deadline: undefined,
      responsibleId: undefined,
      createdDate: undefined,
      priority: undefined,
    })
  })
})

describe('extractTasks', () => {
  it('handles list response shape ({ tasks: [] })', () => {
    const out = extractTasks({
      tasks: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
      ],
    })
    expect(out.map((t) => t.id)).toEqual([1, 2])
  })

  it('handles single-task response shape ({ task: {} })', () => {
    const out = extractTasks({ task: { id: 42, title: 'created' } })
    expect(out).toEqual([{ id: 42, title: 'created', status: undefined, deadline: undefined, responsibleId: undefined, createdDate: undefined, priority: undefined }])
  })

  it('drops malformed entries instead of throwing', () => {
    const out = extractTasks({
      tasks: [{ id: 1, title: 'ok' }, { TITLE: 'no id' }, null, 'string'],
    })
    expect(out.map((t) => t.id)).toEqual([1])
  })

  it('returns [] for null / non-object / unrelated input', () => {
    expect(extractTasks(null)).toEqual([])
    expect(extractTasks(undefined)).toEqual([])
    expect(extractTasks({ otherKey: 'whatever' })).toEqual([])
    expect(extractTasks('plain string')).toEqual([])
  })
})
