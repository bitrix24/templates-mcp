import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhFeedback from '../../../../server/utils/github-feedback'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const createGithubIssue = vi.fn()
const consumeFeedbackQuota = vi.fn()

vi.mock('~/server/utils/github-feedback', async () => {
  const actual = await vi.importActual<typeof GhFeedback>(
    '../../../../server/utils/github-feedback',
  )
  return {
    ...actual,
    createGithubIssue,
    consumeFeedbackQuota,
  }
})

interface ToolContent {
  content: { type: 'text'; text: string }[]
}

interface ToolInput {
  kind: 'positive' | 'issue' | 'suggestion'
  summary: string
  details: string
  relatedTool?: string
  severity?: 'low' | 'medium' | 'high'
}

const tool = (await import('../../../../server/mcp/tools/meta/submit-feedback')).default as unknown as {
  // The toolkit's handler signature is (args, extra) — our tests don't supply
  // `extra`, so the cast is intentionally narrower than the production type.
  handler: (input: ToolInput) => Promise<ToolContent>
}

const validInput: ToolInput = {
  kind: 'issue',
  summary: 'tool description was ambiguous',
  details: 'Calling b24_user_me, the description hinted at task creation but no such tool exists.',
  relatedTool: 'b24_user_me',
  severity: 'medium',
}

describe('bx24mcp_submit_feedback', () => {
  beforeEach(() => {
    createGithubIssue.mockReset()
    consumeFeedbackQuota.mockReset()
    consumeFeedbackQuota.mockReturnValue({ ok: true, remaining: 4, resetInSeconds: 3600 })
  })

  it('creates a GitHub issue with the expected labels and returns the URL', async () => {
    createGithubIssue.mockResolvedValue({
      url: 'https://github.com/bitrix24/templates-mcp/issues/7',
      number: 7,
    })

    const result = await tool.handler(validInput)

    expect(createGithubIssue).toHaveBeenCalledOnce()
    const call = createGithubIssue.mock.calls[0]![0] as {
      title: string
      body: string
      labels: string[]
    }
    expect(call.title).toBe('[agent-feedback/issue] tool description was ambiguous')
    expect(call.labels).toEqual([
      'agent-feedback',
      'feedback:issue',
      'tool:b24_user_me',
      'severity:medium',
    ])
    expect(result.content[0]!.text).toContain('https://github.com/bitrix24/templates-mcp/issues/7')
    expect(result.content[0]!.text).toContain('#7')
  })

  it('omits the tool label when relatedTool sanitises to empty', async () => {
    createGithubIssue.mockResolvedValue({
      url: 'https://github.com/bitrix24/templates-mcp/issues/8',
      number: 8,
    })

    await tool.handler({ ...validInput, relatedTool: '!!!' })

    const call = createGithubIssue.mock.calls[0]![0] as { labels: string[] }
    // `toContain` with an asymmetric matcher silently passes — use a real
    // predicate so the assertion actually verifies the absence.
    expect(call.labels.some((l) => l.startsWith('tool:'))).toBe(false)
  })

  it('omits the severity label when severity is absent', async () => {
    createGithubIssue.mockResolvedValue({
      url: 'https://github.com/bitrix24/templates-mcp/issues/9',
      number: 9,
    })

    const { severity: _omit, ...withoutSeverity } = validInput
    await tool.handler(withoutSeverity)

    const call = createGithubIssue.mock.calls[0]![0] as { labels: string[] }
    expect(call.labels.some((l) => l.startsWith('severity:'))).toBe(false)
  })

  it('flattens newlines in the summary so the GitHub title stays single-line', async () => {
    createGithubIssue.mockResolvedValue({
      url: 'https://example/1',
      number: 1,
    })

    await tool.handler({ ...validInput, summary: 'line one\nline two\r\nline three' })

    const call = createGithubIssue.mock.calls[0]![0] as { title: string }
    expect(call.title).toBe('[agent-feedback/issue] line one line two line three')
  })

  it('strips hostile chars (bidi/zero-width) from the summary before it lands in the GitHub title', async () => {
    createGithubIssue.mockResolvedValue({ url: 'https://example/2', number: 2 })

    // \u escapes — embedding the literal chars here would be a Trojan Source
    // vector against future reviewers.
    const RLO = '\u202e'
    const ZWSP = '\u200b'
    await tool.handler({
      ...validInput,
      summary: `feature${RLO} request${ZWSP}: do thing`,
    })

    const call = createGithubIssue.mock.calls[0]![0] as { title: string }
    expect(call.title).toBe('[agent-feedback/issue] feature request: do thing')
    // Use a Unicode property class so the assertion stays readable without
    // literal hostile chars in the source.
    expect(/\p{Bidi_Control}|\u200b|\u200c|\u200d|\ufeff/u.test(call.title)).toBe(false)
  })

  it('rejects an all-hostile-chars summary that survives Zod min(5) but reduces to empty', async () => {
    createGithubIssue.mockResolvedValue({ url: 'https://example/3', number: 3 })

    // Ten characters of hostile-only content — passes Zod min(5).max(200),
    // post-strip the safeSummary is empty.
    const RLO = '\u202e'
    const ZWSP = '\u200b'
    const allHostile = `${RLO}${ZWSP}${RLO}${ZWSP}${RLO}${ZWSP}${RLO}${ZWSP}${RLO}${ZWSP}`

    const result = await tool.handler({ ...validInput, summary: allHostile })

    expect(createGithubIssue).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/empty after sanitisation/i)
    expect(result.content[0]!.text).toMatch(/printable characters/i)
  })

  it('returns a rate-limit message instead of calling GitHub when quota is exhausted', async () => {
    consumeFeedbackQuota.mockReturnValue({ ok: false, remaining: 0, resetInSeconds: 1200 })

    const result = await tool.handler(validInput)

    expect(createGithubIssue).not.toHaveBeenCalled()
    expect(result.content[0]!.text).toMatch(/rate limit/i)
    expect(result.content[0]!.text).toContain('1200')
  })

  it('returns a friendly message and does not throw on GithubFeedbackError', async () => {
    const { GithubFeedbackError } = await import('../../../../server/utils/github-feedback')
    createGithubIssue.mockRejectedValue(
      new GithubFeedbackError('GitHub rejected the feedback token (401/403).', 'UPSTREAM'),
    )

    const result = await tool.handler(validInput)
    expect(result.content[0]!.text).toMatch(/Failed to submit feedback/)
    expect(result.content[0]!.text).toMatch(/Do not retry/)
  })

  it('re-throws unknown errors so the toolkit can surface them to the agent', async () => {
    createGithubIssue.mockRejectedValue(new Error('something else broke'))
    await expect(tool.handler(validInput)).rejects.toThrow('something else broke')
  })
})
