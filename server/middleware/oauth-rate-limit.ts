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
 *   - **Bounded memory, true LRU**: at `MAX_TRACKED_IPS` distinct source
 *     IPs the LEAST-recently-used bucket is evicted one at a time (each
 *     request moves its IP to the MRU end). A hot IP — a real flood or an
 *     attacker hammering one address — is always MRU, so the churn of
 *     10k other IPs can never evict its bucket and reset its counter.
 *     (Insertion-order or flush-all eviction would let the attacker reset
 *     their own window by rotating throwaway IPs.) An attacker who can
 *     rotate >10k addresses *and* keep them all recently-active defeats
 *     per-IP limiting anyway — network-layer DDoS, out of scope per
 *     `docs/SECURITY.md`.
 *   - Flag-gated: with `NUXT_BITRIX24_OAUTH_ENABLED=false` the route
 *     refuses with 503 FLAG-OFF before any DB write, so webhook-only
 *     forks keep byte-identical behaviour (no new 429 surface).
 *   - Unknown source IP: if `getRequestIP(event)` returns `undefined`
 *     (rare — Node/Nitro resolves it for any direct TCP connection, but
 *     some test harnesses or exotic transports may not), all such
 *     requests share a single `<unknown>` bucket and are limited
 *     together. Production behind nginx always has the proxy's IP, so
 *     this is a test-only / defensive edge, not a real shared-fate channel.
 *
 * §11 taxonomy: `oauth.install.deny.rate-limited` (WARN) with errorCode
 * `RATE-LIMITED`; the 429 carries a standard `Retry-After` header.
 */

const WINDOW_MS = 60_000
// 10/min/IP: a human authorises once, a flood does thousands — 10 starves
// the oauth_state-flood vector with comfortable headroom. The headroom is
// load-bearing for CI: the docker-smoke OAuth-on gate (#227) runs
// `scripts/manual-qa-pr2c.sh`, which makes 5 `/api/oauth/install` probes
// from one IP in one run. Keep MAX_PER_WINDOW comfortably above that probe
// count — if you add install probes to that script, bump this too.
const MAX_PER_WINDOW = 10
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

  // True LRU on the IP map: every touched IP is re-inserted at the MRU end
  // (Map preserves insertion order; delete-then-set moves a key to the
  // back). Eviction at capacity removes the FRONT — the least-recently-used
  // IP, which is by definition idle. This is what makes the limit
  // tamper-resistant: an actively-requesting IP (a real flood, or an
  // attacker hammering one address) is always MRU, so the churn of 10k
  // other IPs can never evict its bucket and reset its counter. A
  // flush-all or insertion-order eviction would let the attacker's own
  // bucket be wiped.
  let bucket = hits.get(ip)
  if (bucket) {
    hits.delete(ip)
  }
  else {
    if (hits.size >= MAX_TRACKED_IPS) {
      const lru = hits.keys().next().value
      if (lru !== undefined) hits.delete(lru)
    }
    bucket = []
  }
  hits.set(ip, bucket)

  // Slide the window: drop timestamps strictly older than WINDOW_MS. The
  // strict `<` (a hit exactly WINDOW_MS old still counts) matches the
  // feedback-quota window in `github-feedback.ts` — the two windows keep
  // identical boundary semantics.
  while (bucket.length > 0 && bucket[0]! < now - WINDOW_MS) bucket.shift()

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
