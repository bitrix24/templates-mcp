import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import {
  consumeFeedbackQuota,
  createGithubIssue,
  formatIssueBody,
  GithubFeedbackError,
  sanitizeDetails,
  sanitizeToolName,
  stripHostileChars,
} from '~/server/utils/github-feedback'

/**
 * Meta-tool that lets the AI agent surface its experience with this MCP
 * server. Each call creates a labelled GitHub issue in
 * `NUXT_GITHUB_FEEDBACK_REPO` (default: bitrix24/templates-mcp).
 *
 * See docs/FEEDBACK.md for when an agent should call this.
 */
export default defineMcpTool({
  name: 'bx24mcp_submit_feedback',
  description:
    'Submit feedback about the bx24-template-mcp server itself. Use this to report a problem, suggest an improvement, or share a positive observation about your experience using this MCP. Each call creates a GitHub issue in the project repository. Rate-limited to 5 attempts per hour (failed attempts count too). PRIVACY: the issue is created in a PUBLIC GitHub repository — do not include personal data (names, phone numbers, email addresses, government IDs, customer details from CRM records) in `summary` or `details`. Describe the technical problem, not the data that triggered it. This matters specifically for portals subject to GDPR, LGPD, or similar privacy regimes.',
  inputSchema: {
    kind: z
      .enum(['positive', 'issue', 'suggestion'])
      .describe('Type of feedback: positive observation, problem report, or improvement suggestion.'),
    summary: z
      .string()
      .min(5)
      .max(200)
      .describe('One-line summary that becomes the GitHub issue title.'),
    details: z
      .string()
      .min(10)
      .describe(
        'Full details: what happened, what was expected, why it matters. Up to ~10000 characters; longer input is truncated. DO NOT include any personal data — the issue is public. Describe what went wrong technically, not who was involved or which record triggered it.',
      ),
    relatedTool: z
      .string()
      .optional()
      .describe(
        'Name of the related MCP tool, if applicable (e.g. "b24_user_me"). Becomes a "tool:<name>" label.',
      ),
    severity: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .describe(
        'How urgent this is. Optional. Use "low" for nits / cosmetic / confusing description; "medium" when the workflow was disrupted but you recovered; "high" when a tool failed in a way that blocks the user-visible task. Skip entirely if unsure — that signals "no opinion".',
      ),
  },
  handler: async ({ kind, summary, details, relatedTool, severity }) => {
    const quota = consumeFeedbackQuota()
    if (!quota.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Feedback rate limit reached. Try again in about ${quota.resetInSeconds} seconds. (5 attempts per hour, including failures.)`,
          },
        ],
      }
    }

    // Strip hostile chars BEFORE collapsing whitespace so a bidi RLO can't
    // survive into the GitHub issue title (visible in the repo's issue list).
    const safeSummary = stripHostileChars(summary).replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
    if (!safeSummary) {
      // Zod's min(5) check ran before sanitisation, so an input made entirely
      // of hostile chars (bidi/zero-width/controls) can pass it and reduce to
      // empty here. The slot is already consumed — same trade-off as a tight
      // retry loop.
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Feedback summary became empty after sanitisation. Send a summary that contains printable characters.',
          },
        ],
      }
    }
    const safeDetails = sanitizeDetails(details)
    const safeTool = relatedTool ? sanitizeToolName(relatedTool) : ''

    const labels = ['agent-feedback', `feedback:${kind}`]
    if (safeTool) labels.push(`tool:${safeTool}`)
    if (severity) labels.push(`severity:${severity}`)

    try {
      const issue = await createGithubIssue({
        title: `[agent-feedback/${kind}] ${safeSummary}`,
        body: formatIssueBody({
          kind,
          details: safeDetails,
          relatedTool: safeTool || undefined,
          severity,
        }),
        labels,
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: `Feedback submitted as ${issue.url} (#${issue.number}). Thank you — this will be triaged by a maintainer.`,
          },
        ],
      }
    } catch (err) {
      if (err instanceof GithubFeedbackError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to submit feedback: ${err.message} The maintainer will need to fix the GitHub integration. Do not retry — your input has not been recorded.`,
            },
          ],
        }
      }
      throw err
    }
  },
})
