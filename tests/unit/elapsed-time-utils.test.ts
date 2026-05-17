import { describe, expect, it } from 'vitest'
import { toElapsedTimeShort } from '../../server/utils/elapsed-time'

describe('toElapsedTimeShort', () => {
  it('maps the UPPERCASE response shape returned by task.elapseditem.getlist', () => {
    expect(
      toElapsedTimeShort({
        ID: '1',
        TASK_ID: '691',
        USER_ID: '1',
        COMMENT_TEXT: 'finalised the договор',
        SECONDS: '3600',
        // Bitrix24 also ships MINUTES = SECONDS/60 — we intentionally drop it.
        MINUTES: '60',
        SOURCE: '2',
        CREATED_DATE: '2024-05-16T10:33:00+02:00',
        DATE_START: '2024-05-16T10:33:15+02:00',
        DATE_STOP: '2024-05-16T11:33:15+02:00',
      }),
    ).toEqual({
      id: 1,
      taskId: 691,
      userId: 1,
      commentText: 'finalised the договор',
      seconds: 3600,
      createdDate: '2024-05-16T10:33:00+02:00',
      dateStart: '2024-05-16T10:33:15+02:00',
      dateStop: '2024-05-16T11:33:15+02:00',
    })
  })

  it('accepts camelCase fields (forwards-compat if Bitrix24 ever swaps casing)', () => {
    expect(
      toElapsedTimeShort({
        id: 9,
        taskId: 700,
        userId: 5,
        commentText: 'wrote the spec',
        seconds: 1800,
        createdDate: '2025-01-01T00:00:00+00:00',
        dateStart: '2025-01-01T00:00:00+00:00',
        dateStop: '2025-01-01T00:30:00+00:00',
      }),
    ).toMatchObject({ id: 9, taskId: 700, seconds: 1800 })
  })

  it('returns null on shapes missing id or taskId', () => {
    expect(toElapsedTimeShort({ COMMENT_TEXT: 'no ids' })).toBeNull()
    expect(toElapsedTimeShort({ ID: 1 })).toBeNull()
    expect(toElapsedTimeShort(null)).toBeNull()
    expect(toElapsedTimeShort('not an object')).toBeNull()
  })

  it('normalises empty-string date fields to null (distinguishes "never started" from real timestamp)', () => {
    const entry = toElapsedTimeShort({
      ID: 2,
      TASK_ID: 800,
      USER_ID: 3,
      COMMENT_TEXT: 'manual entry, no stopwatch',
      SECONDS: 600,
      CREATED_DATE: '2025-02-01T12:00:00+00:00',
      DATE_START: '',
      DATE_STOP: '',
    })
    expect(entry?.dateStart).toBeNull()
    expect(entry?.dateStop).toBeNull()
    expect(entry?.createdDate).toBe('2025-02-01T12:00:00+00:00')
  })

  it('defaults missing COMMENT_TEXT and SECONDS to stable values', () => {
    // Stopwatch start markers can ship without a comment or with zero seconds;
    // the projection stays shape-stable instead of leaking null/undefined.
    const entry = toElapsedTimeShort({
      ID: 3,
      TASK_ID: 900,
    })
    expect(entry).toEqual({
      id: 3,
      taskId: 900,
      userId: null,
      commentText: '',
      seconds: 0,
      createdDate: null,
      dateStart: null,
      dateStop: null,
    })
  })

  it('coerces stringified ids and seconds (the v2 wire format)', () => {
    const entry = toElapsedTimeShort({
      ID: '15',
      TASK_ID: '999',
      USER_ID: '47',
      SECONDS: '900',
    })
    expect(entry).toMatchObject({ id: 15, taskId: 999, userId: 47, seconds: 900 })
  })
})
