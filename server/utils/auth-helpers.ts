import { Buffer } from 'node:buffer'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'

/**
 * Constant-time string comparison for secrets (issue #222 — was copy-pasted
 * into `mcp-auth.ts`, `_health.get.ts`, and `callback.get.ts`; consolidated
 * here so the security-critical primitive can't silently diverge between
 * call sites).
 *
 * `crypto.timingSafeEqual` throws if the two buffers differ in length, so a
 * length check runs first and short-circuits. The length comparison is NOT
 * constant-time — the length of the operand leaks. That is acceptable for
 * every caller here: all compared values are fixed-length tokens (64-hex
 * `openssl rand -hex 32` Bearers / admin tokens, 64-hex CSRF nonces), so the
 * length is a public constant and reveals nothing about the secret.
 *
 * Empty-string guard: two empty strings ARE equal length and would compare
 * equal here. Callers that read a possibly-empty persisted value (e.g. the
 * CSRF cookie binding in `callback.get.ts`) must reject the empty case BEFORE
 * calling this — see the `STATE-ROW-CORRUPT` guard there. This helper does
 * not special-case empty input because some callers legitimately compare
 * empty-vs-nonempty (which returns false on the length check anyway).
 *
 * SCOPE: use this ONLY for fixed-length tokens whose length is a public
 * constant (Bearers, admin tokens, CSRF nonces). The early length check leaks
 * the operand length — harmless for those, but a leak for a variable-length
 * secret (e.g. a user password). Do NOT use this for variable-length secrets;
 * reach for a constant-time primitive that pads instead of short-circuiting.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
