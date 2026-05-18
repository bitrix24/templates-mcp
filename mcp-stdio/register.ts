/**
 * Minimal port of `registerToolFromDefinition` from `@nuxtjs/mcp-toolkit`.
 *
 * We don't import the toolkit's helper directly because its `/server` barrel
 * pulls in `cache.js` (Nitro's `defineCachedFunction`) and `listings.js`
 * (Nuxt virtual modules) — both of which require a Nuxt build context that
 * doesn't exist in a standalone stdio entrypoint.
 *
 * The cache feature is unused across every tool in `server/mcp/tools/**`
 * (no `cache:` option declared), so the port drops that branch entirely. If
 * a future tool adopts caching, that branch needs to come back here, backed
 * by an in-process LRU instead of Nitro storage.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

interface ToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: unknown
  _meta?: Record<string, unknown>
  group?: string
  tags?: string[]
  inputExamples?: unknown
  handler: (...args: unknown[]) => unknown
}

interface ToolResult {
  content?: Array<{ type: string; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

function normalizeToolResult(result: unknown): ToolResult {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] }
  }
  if (typeof result === 'number' || typeof result === 'boolean') {
    return { content: [{ type: 'text', text: String(result) }] }
  }
  if (
    typeof result === 'object'
    && result !== null
    && !('content' in result)
    && !('structuredContent' in result)
    && !('isError' in result)
  ) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
  return result as ToolResult
}

function normalizeErrorToResult(error: unknown): ToolResult {
  if (error instanceof Error) {
    return { content: [{ type: 'text', text: error.message }], isError: true }
  }
  return { content: [{ type: 'text', text: String(error) }], isError: true }
}

export function registerToolFromDefinition(server: McpServer, tool: ToolDefinition) {
  const options = {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    _meta: {
      ...tool._meta,
      ...(tool.inputExamples != null && { inputExamples: tool.inputExamples }),
      ...(tool.group != null && { group: tool.group }),
      ...(tool.tags?.length && { tags: tool.tags }),
    },
  }

  const normalizedHandler = async (...args: unknown[]) => {
    try {
      return normalizeToolResult(await tool.handler(...args))
    } catch (error) {
      return normalizeErrorToResult(error)
    }
  }

  return (server as unknown as {
    registerTool: (name: string, options: unknown, handler: typeof normalizedHandler) => unknown
  }).registerTool(tool.name, options, normalizedHandler)
}
