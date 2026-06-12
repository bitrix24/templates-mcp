import { createError, defineEventHandler, getRequestIP, getRequestURL, setResponseHeader } from 'h3'
import { useLogger } from '~/server/utils/logger'

/**
 * Per-IP sliding-window rate limit on `/api/oauth/install` (issue #221).
 *
 * Why this endpoint specifically: install is unauthenticated and, with
 * the OAuth flag on, every hit mints an `oauth_state` row (~200 bytes)
 * in SQLite. Unthrottled, an attacker can grow the DB (and its WAL) at
 * HTTP speed between the 5-minute prune ticks (#211) — a cheap DoS
 * against the token store. Five requests per IP per minute is far above
 * any legitimate use (a human authorises once) and far below a useful
 * flood.
 *
 * Posture notes:
 *   - **Raw socket IP only** (`getRequestIP` without `xForwardedFor`) —
 *     same stance as `/api/oauth/_health`: a client-supplied
 *     `X-Forwarded-For` header must not let an attacker rotate buckets.
 *     Behind the reference nginx proxy all traffic shares the proxy's
 *     IP, which makes the limit *global* across external clients there —
 *     acceptable: 5/min still lets a human through, and operators who
 *     need finer grain can add nginx `limit_req` in front (the limits
 *     compose).
 *   - **Process-local** map, consistent with the single-instance design
 *     (`docs/OAUTH-DESIGN.md §5`). A multi-replica deployment rates per
 *     replica.
 *   - **Bounded memory**: at `MAX_TRACKED_IPS` distinct source IPs the
 *     map is cleared outright rather than LRU-evicted. An attacker who
 *     can rotate >10k source addresses defeats per-IP limiting anyway
 *     (that's network-layer DDoS territory, out of scope per
 *     `docs/SECURITY.md`); the reset just keeps memory flat.
 *   - Flag-gated: with `NUXT_BITRIX24_OAUTH_ENABLED=false` the route
 *     refuses with 503 FLAG-OFF before any DB write, so webhook-only
 *     forks keep byte-identical behaviour (no new 429 surface).
 *
 * §11 taxonomy: `oauth.install.deny.rate-limited` (WARN) with errorCode
 * `RATE-LIMITED`; the 429 carries a standard `Retry-After` header.
 */

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5
const MAX_TRACKED_IPS = 10_000

const hits = new Map<string, number[]>()

/** Test hook — clears all rate-limit buckets. */
export function _resetOauthRateLimitForTests(): void {
  hits.clear()
}

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event)
  if (pathname !== '/api/oauth/install') return
  if (!useRuntimeConfig().bitrix24OauthEnabled) return

  const ip = getRequestIP(event) ?? '<unknown>'
  const now = Date.now()

  let bucket = hits.get(ip)
  if (!bucket) {
    if (hits.size >= MAX_TRACKED_IPS) hits.clear()
    bucket = []
    hits.set(ip, bucket)
  }

  // Slide the window: drop timestamps older than WINDOW_MS.
  while (bucket.length > 0 && bucket[0]! <= now - WINDOW_MS) bucket.shift()

  if (bucket.length >= MAX_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket[0]! + WINDOW_MS - now) / 1000))
    void useLogger().warning('oauth.install.deny.rate-limited', { ip, retryAfterSec })
    setResponseHeader(event, 'retry-after', retryAfterSec)
    throw createError({
      statusCode: 429,
      statusMessage: 'Too many install attempts - retry later',
      data: { errorCode: 'RATE-LIMITED' },
    })
  }

  bucket.push(now)
})
