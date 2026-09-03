import { describe, expect, it } from 'vitest'
import { chatUserNames, toChatCommentShort, toTaskCommentShort } from '../../server/utils/task-comments'

describe('toTaskCommentShort', () => {
  it('maps the UPPERCASE shape returned by task.commentitem.getlist', () => {
    expect(
      toTaskCommentShort(
        {
          POST_MESSAGE_HTML: null,
          ID: '53',
          AUTHOR_ID: '9',
          AUTHOR_NAME: 'Иван Петров',
          AUTHOR_EMAIL: '',
          POST_DATE: '2025-07-31T13:11:53+03:00',
          POST_MESSAGE: '[USER=11]Мария Смирнова[/USER], вы назначены соисполнителем.',
        },
        23,
      ),
    ).toEqual({
      source: 'forum',
      isSystem: false,
      id: 53,
      taskId: 23,
      authorId: 9,
      authorName: 'Иван Петров',
      // Empty AUTHOR_EMAIL normalises to null, not ''.
      authorEmail: null,
      postDate: '2025-07-31T13:11:53+03:00',
      text: '[USER=11]Мария Смирнова[/USER], вы назначены соисполнителем.',
      textHtml: null,
    })
  })

  it('accepts camelCase fields (forwards-compat if Bitrix24 ever swaps casing)', () => {
    expect(
      toTaskCommentShort(
        {
          id: 7,
          authorId: 11,
          authorName: 'Мария Смирнова',
          authorEmail: 'maria@example.com',
          postDate: '2025-08-01T09:00:00+03:00',
          postMessage: 'нашла подходящее решение, выглядит неплохо',
          postMessageHtml: '<p>нашла подходящее решение, выглядит неплохо</p>',
        },
        29,
      ),
    ).toEqual({
      source: 'forum',
      isSystem: false,
      id: 7,
      taskId: 29,
      authorId: 11,
      authorName: 'Мария Смирнова',
      authorEmail: 'maria@example.com',
      postDate: '2025-08-01T09:00:00+03:00',
      text: 'нашла подходящее решение, выглядит неплохо',
      textHtml: '<p>нашла подходящее решение, выглядит неплохо</p>',
    })
  })

  it('never truncates a long body', () => {
    const body = 'а'.repeat(5000)
    expect(toTaskCommentShort({ ID: 1, POST_MESSAGE: body }, 42)?.text).toBe(body)
  })

  it('defaults a missing body to an empty string and unknown author fields to null', () => {
    expect(toTaskCommentShort({ ID: '4' }, 42)).toEqual({
      source: 'forum',
      isSystem: false,
      id: 4,
      taskId: 42,
      authorId: null,
      authorName: null,
      authorEmail: null,
      postDate: null,
      text: '',
      textHtml: null,
    })
  })

  it('returns null for rows without a usable id or non-object rows', () => {
    expect(toTaskCommentShort({ POST_MESSAGE: 'orphan' }, 42)).toBeNull()
    expect(toTaskCommentShort(null, 42)).toBeNull()
    expect(toTaskCommentShort('nope', 42)).toBeNull()
  })
})

describe('toChatCommentShort', () => {
  const names = new Map([[9, 'Иван Петров'], [11, 'Мария Смирнова']])

  it('maps a human chat message and resolves the author name from the users array', () => {
    expect(
      toChatCommentShort(
        {
          id: 244261,
          chat_id: 6479,
          author_id: 9,
          date: '2026-09-03T22:12:06+03:00',
          text: 'QA: первый комментарий [b]жирный[/b]',
          params: { NOTIFY: 'N' },
        },
        4193,
        names,
      ),
    ).toEqual({
      source: 'chat',
      isSystem: false,
      id: 244261,
      taskId: 4193,
      authorId: 9,
      authorName: 'Иван Петров',
      authorEmail: null,
      postDate: '2026-09-03T22:12:06+03:00',
      text: 'QA: первый комментарий [b]жирный[/b]',
      textHtml: null,
    })
  })

  it('flags author_id 0 as system and reports no author (there is no user #0)', () => {
    expect(
      toChatCommentShort(
        { id: 244259, author_id: 0, date: '2026-09-03T22:11:50+03:00', text: '[USER=9]Иван Петров[/USER] снял отметку о важности задачи' },
        4193,
        names,
      ),
    ).toMatchObject({ source: 'chat', isSystem: true, authorId: null, authorName: null })
  })

  it('leaves the name null for an author missing from the users array', () => {
    expect(toChatCommentShort({ id: 1, author_id: 77, text: 'привет' }, 1, names)).toMatchObject({
      authorId: 77,
      authorName: null,
    })
  })

  it('never truncates a long body and tolerates a missing one', () => {
    const long = 'а'.repeat(5000)
    expect(toChatCommentShort({ id: 1, author_id: 9, text: long }, 1, names)?.text).toBe(long)
    expect(toChatCommentShort({ id: 2, author_id: 9 }, 1, names)?.text).toBe('')
  })

  it('returns null for rows without a usable id or non-object rows', () => {
    expect(toChatCommentShort({ author_id: 9, text: 'orphan' }, 1, names)).toBeNull()
    expect(toChatCommentShort(null, 1, names)).toBeNull()
  })
})

describe('chatUserNames', () => {
  it('indexes users by id, preferring `name` and falling back to first + last', () => {
    const map = chatUserNames([
      { id: 9, name: 'Иван Петров', first_name: 'Иван', last_name: 'Петров' },
      { id: '11', name: '', first_name: 'Мария', last_name: 'Смирнова' },
      { id: 12 },
      'nonsense',
      null,
    ])
    expect(map.get(9)).toBe('Иван Петров')
    expect(map.get(11)).toBe('Мария Смирнова')
    expect(map.has(12)).toBe(false)
    expect(map.size).toBe(2)
  })

  it('returns an empty map when the response carried no users array', () => {
    expect(chatUserNames(undefined).size).toBe(0)
  })
})
