import { Buffer } from 'node:buffer'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { createError, defineEventHandler, getHeader, getRequestURL } from 'h3'

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event)

  // Only guard /mcp and /mcp/* — paths like /mcphacked must not bypass auth
  // but also must not require it (404 from the router is fine).
  if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return

  const expected = useRuntimeConfig().mcpAuthToken
  // Treat the `.env.example` placeholder as "not configured": an operator who
  // copied the example without running `openssl rand -hex 32` must not end up
  // with a guessable, publicly-documented token guarding /mcp.
  if (!expected || expected === 'replace-with-secure-token') {
    // Service-unavailable: not configured, not the caller's fault. Surfacing
    // 500 here would leak misconfiguration to anonymous callers.
    throw createError({
      statusCode: 503,
      statusMessage: 'MCP endpoint is not available',
    })
  }

  const header = getHeader(event, 'authorization')
  if (!header) {
    throw createError({ statusCode: 401, statusMessage: 'Missing Authorization header' })
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()

  if (!token || !timingSafeEqual(token, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid bearer token' })
  }
})

function timingSafeEqual(a: string, b: string): boolean {
  // crypto.timingSafeEqual throws if the buffers differ in length, so length
  // is checked first. Length leak is acceptable: our tokens are fixed-length
  // hex from `openssl rand -hex 32`.
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
