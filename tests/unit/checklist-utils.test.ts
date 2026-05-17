import { describe, expect, it, vi } from 'vitest'

// `server/utils/checklist.ts` mixes a pure parser (`toChecklistItemShort`)
// with a Nuxt-dependent factory (`defineChecklistActionTool`). The mocks
// below let us exercise the pure parser without bootstrapping Nitro.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))
vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => ({ callMethod: vi.fn() }),
}))

const { toChecklistItemShort } = await import('../../server/utils/checklist')

describe('toChecklistItemShort', () => {
  it('maps the UPPERCASE response shape returned by task.checklistitem.getlist', () => {
    expect(
      toChecklistItemShort({
        ID: '477',
        TASK_ID: '8017',
        PARENT_ID: '431',
        CREATED_BY: '503',
        TITLE: 'Подготовить договор',
        SORT_INDEX: '2',
        IS_COMPLETE: 'Y',
        IS_IMPORTANT: 'N',
        TOGGLED_BY: '503',
        TOGGLED_DATE: '2025-11-10T15:02:30+03:00',
      }),
    ).toEqual({
      id: 477,
      taskId: 8017,
      parentId: 431,
      title: 'Подготовить договор',
      sortIndex: 2,
      isComplete: true,
      isImportant: false,
      createdBy: 503,
      toggledBy: 503,
      toggledDate: '2025-11-10T15:02:30+03:00',
    })
  })

  it('treats parentId 0 as a checklist heading (not a regular item)', () => {
    const heading = toChecklistItemShort({
      ID: '431',
      TASK_ID: '8017',
      PARENT_ID: 0,
      TITLE: 'Чек-лист 1',
      SORT_INDEX: '0',
      IS_COMPLETE: 'N',
      IS_IMPORTANT: 'N',
      TOGGLED_BY: null,
      TOGGLED_DATE: '',
    })
    expect(heading?.parentId).toBe(0)
    expect(heading?.createdBy).toBeNull()
    expect(heading?.toggledBy).toBeNull()
    // An empty TOGGLED_DATE string is normalised to null so the agent can
    // distinguish "never toggled" from a valid timestamp.
    expect(heading?.toggledDate).toBeNull()
  })

  it('accepts camelCase fields too (forwards-compat if Bitrix24 ever swaps casing)', () => {
    const item = toChecklistItemShort({
      id: 10,
      taskId: 99,
      parentId: 0,
      title: 'x',
      sortIndex: 1,
      isComplete: 'N',
      isImportant: 'Y',
      createdBy: 47,
      toggledBy: null,
      toggledDate: null,
    })
    expect(item).toMatchObject({ id: 10, taskId: 99, isComplete: false, isImportant: true, createdBy: 47 })
  })

  it('treats unexpected boolean encodings as false (pins to literal "Y")', () => {
    // Bitrix24 v2 ships boolean fields as "Y" / "N". Anything else is drift —
    // we surface false rather than silently accepting a truthy-but-wrong wire.
    const item = toChecklistItemShort({
      ID: 1,
      TASK_ID: 1,
      TITLE: 'x',
      IS_COMPLETE: 1, // numeric — not in the contract
      IS_IMPORTANT: true, // boolean — not in the contract
    })
    expect(item?.isComplete).toBe(false)
    expect(item?.isImportant).toBe(false)
  })

  it('returns null on shapes missing id / taskId / title', () => {
    expect(toChecklistItemShort({ TITLE: 'no ids' })).toBeNull()
    expect(toChecklistItemShort({ ID: 1, TASK_ID: 2 })).toBeNull()
    expect(toChecklistItemShort(null)).toBeNull()
    expect(toChecklistItemShort('not an object')).toBeNull()
  })
})
