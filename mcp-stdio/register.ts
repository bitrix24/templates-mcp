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

// Tool callback shape from the SDK: `(args, extra) => result | Promise<result>`.
// We treat both args and extra as opaque — every tool already validates `args`
// against its own zod schema before consuming it, and `extra` (sessionId,
// progress token, …) is passed through untouched.
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => unknown

interface ToolDefinition {
  // The toolkit's type allows `name` to be undefined because the HTTP build
  // auto-derives it from the filename. The stdio bundle doesn't run that
  // discovery, so every tool MUST set `name` explicitly. We accept the
  // wider type here and fail loudly at registration time below.
  name?: string
  title?: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: unknown
  _meta?: Record<string, unknown>
  group?: string
  tags?: string[]
  inputExamples?: unknown
  handler: ToolHandler
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
  if (!tool.name) {
    throw new Error(
      'Stdio bundle requires every tool to declare an explicit `name` — '
        + 'filename-based discovery is not wired in this transport.',
    )
  }
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

  const normalizedHandler: ToolHandler = async (args, extra) => {
    try {
      return normalizeToolResult(await tool.handler(args, extra))
    } catch (error) {
      return normalizeErrorToResult(error)
    }
  }

  // `McpServer.registerTool` is the public registration API; the SDK's
  // signature is intentionally broad (options bag, callback). Cast the
  // options to keep our local typing local — every field above maps 1:1 to
  // the SDK's expected shape, but the SDK's exported types are not stable
  // enough across minors to depend on directly.
  return server.registerTool(
    tool.name,
    options as Parameters<McpServer['registerTool']>[1],
    normalizedHandler as Parameters<McpServer['registerTool']>[2],
  )
}
