import { describe, expect, it } from 'vitest'
import {
  extractTasks,
  normalizeBitrix24Filter,
  normalizeBitrix24Key,
  normalizeBitrix24Order,
  normalizeBitrix24Select,
  toTaskShort,
} from '../../server/utils/tasks'

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

describe('normalizeBitrix24Key', () => {
  it('passes UPPER_SNAKE keys through unchanged', () => {
    expect(normalizeBitrix24Key('RESPONSIBLE_ID')).toBe('RESPONSIBLE_ID')
    expect(normalizeBitrix24Key('TITLE')).toBe('TITLE')
    expect(normalizeBitrix24Key('STATUS_CHANGED_DATE')).toBe('STATUS_CHANGED_DATE')
  })

  it('converts plain camelCase to UPPER_SNAKE', () => {
    expect(normalizeBitrix24Key('responsibleId')).toBe('RESPONSIBLE_ID')
    expect(normalizeBitrix24Key('title')).toBe('TITLE')
    expect(normalizeBitrix24Key('createdDate')).toBe('CREATED_DATE')
    expect(normalizeBitrix24Key('statusChangedDate')).toBe('STATUS_CHANGED_DATE')
    expect(normalizeBitrix24Key('id')).toBe('ID')
  })

  it('preserves operator prefixes on camelCase keys', () => {
    expect(normalizeBitrix24Key('!status')).toBe('!STATUS')
    expect(normalizeBitrix24Key('>=deadline')).toBe('>=DEADLINE')
    expect(normalizeBitrix24Key('<=createdDate')).toBe('<=CREATED_DATE')
    expect(normalizeBitrix24Key('%title')).toBe('%TITLE')
    expect(normalizeBitrix24Key('>responsibleId')).toBe('>RESPONSIBLE_ID')
  })

  it('preserves operator prefixes on already-UPPERCASE keys', () => {
    expect(normalizeBitrix24Key('!STATUS')).toBe('!STATUS')
    expect(normalizeBitrix24Key('>=DEADLINE')).toBe('>=DEADLINE')
    expect(normalizeBitrix24Key('%TITLE')).toBe('%TITLE')
  })

  it('handles PascalCase without producing a leading underscore', () => {
    expect(normalizeBitrix24Key('Title')).toBe('TITLE')
    expect(normalizeBitrix24Key('Deadline')).toBe('DEADLINE')
    expect(normalizeBitrix24Key('ResponsibleId')).toBe('RESPONSIBLE_ID')
    expect(normalizeBitrix24Key('>=Deadline')).toBe('>=DEADLINE')
    expect(normalizeBitrix24Key('!Status')).toBe('!STATUS')
  })
})

describe('normalizeBitrix24Filter / Order / Select', () => {
  it('translates every key of a filter object; values untouched', () => {
    expect(
      normalizeBitrix24Filter({
        responsibleId: 5,
        '%title': 'договор',
        '>=deadline': '2026-06-01T00:00:00+03:00',
      }),
    ).toEqual({
      RESPONSIBLE_ID: 5,
      '%TITLE': 'договор',
      '>=DEADLINE': '2026-06-01T00:00:00+03:00',
    })
  })

  it('mixes camelCase and UPPERCASE without collisions or surprise mutation', () => {
    expect(normalizeBitrix24Filter({ responsibleId: 5, STATUS: 3 })).toEqual({
      RESPONSIBLE_ID: 5,
      STATUS: 3,
    })
  })

  it('translates order keys but keeps asc/desc values', () => {
    expect(normalizeBitrix24Order({ deadline: 'asc', createdDate: 'desc' })).toEqual({
      DEADLINE: 'asc',
      CREATED_DATE: 'desc',
    })
  })

  it('translates select field arrays', () => {
    expect(normalizeBitrix24Select(['id', 'title', 'responsibleId', 'STATUS'])).toEqual([
      'ID',
      'TITLE',
      'RESPONSIBLE_ID',
      'STATUS',
    ])
  })

  it('throws on duplicate filter keys after normalisation (silent-drop guard)', () => {
    expect(() =>
      normalizeBitrix24Filter({ responsibleId: 5, RESPONSIBLE_ID: 7 }),
    ).toThrow(/Duplicate Bitrix24 filter key/)
  })

  it('throws on duplicate order keys after normalisation', () => {
    expect(() =>
      normalizeBitrix24Order({ deadline: 'asc' as const, DEADLINE: 'desc' as const }),
    ).toThrow(/Duplicate Bitrix24 order key/)
  })

  it('deduplicates select array entries after normalisation', () => {
    expect(normalizeBitrix24Select(['id', 'ID', 'title', 'Title'])).toEqual(['ID', 'TITLE'])
  })

  it('drops prototype-pollution-shaped keys (verbatim and operator-prefixed)', () => {
    // JSON.parse makes __proto__ an own enumerable key (an object literal would
    // not), reproducing how an LLM-routed payload reaches the normaliser.
    expect(normalizeBitrix24Filter(JSON.parse('{"__proto__":1,"%TITLE":"x"}'))).toEqual({
      '%TITLE': 'x',
    })
    expect(normalizeBitrix24Filter(JSON.parse('{"!__proto__":1,"STATUS":3}'))).toEqual({
      STATUS: 3,
    })
    expect(normalizeBitrix24Order(JSON.parse('{"__proto__":"asc","DEADLINE":"desc"}'))).toEqual({
      DEADLINE: 'desc',
    })
    expect(normalizeBitrix24Select(['__proto__', 'constructor', 'prototype', 'title'])).toEqual([
      'TITLE',
    ])
  })
})
