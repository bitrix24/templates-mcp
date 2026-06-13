import { createError, defineEventHandler, getRequestIP, getRequestURL, setResponseHeader } from 'h3'
import { useLogger } from '~/server/utils/logger'

/**
 * Per-IP sliding-window rate limit on the unauthenticated OAuth HTTP
 * surface (issue #221): `/api/oauth/install` and `/api/oauth/callback`.
 *
 * Why these endpoints specifically:
 *   - **install**: unauthenticated and, with the OAuth flag on, every
 *     hit mints an `oauth_state` row (~200 bytes) in SQLite. Unthrottled,
 *     an attacker can grow the DB (and its WAL) at HTTP speed between
 *     the 5-minute prune ticks (#211) — a cheap DoS against the token
 *     store.
 *   - **callback**: unauthenticated and every hit with a `?state=` runs
 *     `consumeState()` (SQLite DELETE). Cheaper than install (no row is
 *     minted), but a sustained junk-`state` flood is still a SQLite-write
 *     pressure DoS, secondary to the install vector but worth pinning.
 *
 * Per-route limits — different threat models, different headroom:
 *   - install: 10/min/IP. A human authorises once; the CI smoke probe
 *     makes 5 install calls in one run (`manual-qa-pr2c.sh`), so 10
 *     gives 2× headroom. If you add install probes to that script, bump
 *     the install limit too.
 *   - callback: 30/min/IP. A legitimate flow hits callback once per
 *     install, but the higher cap absorbs operator retries / browser
 *     back-button / partial-flow re-auth without false 429s, while
 *     still capping a flood at ~hundreds of writes/hour per IP.
 *
 * Posture notes:
 *   - **Raw socket IP only** (`getRequestIP` without `xForwardedFor`) —
 *     same stance as `/api/oauth/_health`: a client-supplied
 *     `X-Forwarded-For` header must not let an attacker rotate buckets.
 *     Behind the reference nginx proxy all traffic shares the proxy's
 *     IP, which makes the limit *global* across external clients there —
 *     acceptable: 10/min still lets a human through, and operators who
 *     need finer grain can add nginx `limit_req` in front (the limits
 *     compose).
 *   - **Process-local** map, consistent with the single-instance design
 *     (`docs/OAUTH-DESIGN.md §5`). A multi-replica deployment rates per
 *     replica. Single-threaded Node.js event loop guarantees no TOCTOU
 *     between `hits.get` / `hits.delete` / `hits.set`.
 *   - **Per-route buckets**: install and callback are accounted
 *     separately (key is `${pathname}:${ip}`), so install's tighter
 *     limit doesn't get consumed by callback retries. The same IP
 *     hitting both routes has two independent counters.
 *   - **Bounded memory, true LRU**: at `MAX_TRACKED_IPS` distinct
 *     `(route, ip)` keys the LEAST-recently-used bucket is evicted one
 *     at a time (each request moves its key to the MRU end). A hot key —
 *     a real flood or an attacker hammering one address — is always
 *     MRU, so the churn of 10k other keys can never evict its bucket
 *     and reset its counter. (Insertion-order or flush-all eviction
 *     would let the attacker reset their own window by rotating
 *     throwaway IPs.) An attacker who can rotate >10k addresses *and*
 *     keep them all recently-active defeats per-IP limiting anyway —
 *     network-layer DDoS, out of scope per `docs/SECURITY.md`.
 *   - Flag-gated: with `NUXT_BITRIX24_OAUTH_ENABLED=false` the routes
 *     refuse with 503 FLAG-OFF before any DB write, so webhook-only
 *     forks keep byte-identical behaviour (no new 429 surface).
 *   - Unknown source IP: if `getRequestIP(event)` returns `undefined`
 *     (rare — Node/Nitro resolves it for any direct TCP connection, but
 *     some test harnesses or exotic transports may not), all such
 *     requests share a single `<unknown>` bucket per route and are
 *     limited together. Production behind nginx always has the proxy's
 *     IP, so this is a test-only / defensive edge, not a real
 *     shared-fate channel.
 *
 * §11 taxonomy: `oauth.install.deny.rate-limited` and
 * `oauth.callback.deny.rate-limited` (both WARN) — both surface the
 * shared errorCode `RATE-LIMITED` (the only 429 in the taxonomy); the
 * 429 carries a standard `Retry-After` header.
 */

const WINDOW_MS = 60_000
const MAX_TRACKED_IPS = 10_000

interface RouteLimit {
  /** Max requests per `WINDOW_MS` per source IP for this route. */
  maxPerWindow: number
  /** §11 deny event logged on the refused hit. */
  eventName: string
  /** HTTP `statusMessage` body for the 429. */
  errorMessage: string
}

// Per-route limits. The shared errorCode is RATE-LIMITED — both routes
// surface the same code per §11 (the only 429 in the taxonomy).
const ROUTE_LIMITS: Record<string, RouteLimit> = {
  '/api/oauth/install': {
    maxPerWindow: 10,
    eventName: 'oauth.install.deny.rate-limited',
    errorMessage: 'Too many install attempts - retry later',
  },
  '/api/oauth/callback': {
    maxPerWindow: 30,
    eventName: 'oauth.callback.deny.rate-limited',
    errorMessage: 'Too many callback attempts - retry later',
  },
}

const hits = new Map<string, number[]>()

/** Test hook — clears all rate-limit buckets. */
export function _resetOauthRateLimitForTests(): void {
  hits.clear()
}

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  const limit = ROUTE_LIMITS[url.pathname]
  if (!limit) return
  if (!useRuntimeConfig().bitrix24OauthEnabled) return

  // #232 review (security): on `/api/oauth/install`, a browser hit
  // WITHOUT `?portal=` is a pure landing-form render — no `oauth_state`
  // row gets minted, the rate-limit threat model (DB-write flood) does
  // NOT apply. Skip the counter so a tab F5-er can't self-ban from the
  // very form they're trying to use. A submitted `?portal=` IS counted
  // as before. Same surface, two costs; only the costly half is rated.
  if (url.pathname === '/api/oauth/install' && !url.searchParams.get('portal')) {
    return
  }

  const ip = getRequestIP(event) ?? '<unknown>'
  // Key buckets by (route, ip) so install's tighter 10/min limit isn't
  // consumed by callback hits and vice versa. Same IP, two surfaces,
  // two independent counters.
  const key = `${url.pathname}:${ip}`
  const now = Date.now()

  // True LRU on the bucket map: every touched key is re-inserted at the
  // MRU end (Map preserves insertion order; delete-then-set moves a key
  // to the back). Eviction at capacity removes the FRONT — the
  // least-recently-used key, which is by definition idle. This is what
  // makes the limit tamper-resistant: an actively-requesting key (a
  // real flood, or an attacker hammering one address) is always MRU,
  // so the churn of 10k other keys can never evict its bucket and
  // reset its counter. A flush-all or insertion-order eviction would
  // let the attacker's own bucket be wiped.
  let bucket = hits.get(key)
  if (bucket) {
    hits.delete(key)
  }
  else {
    if (hits.size >= MAX_TRACKED_IPS) {
      const lru = hits.keys().next().value
      if (lru !== undefined) hits.delete(lru)
    }
    bucket = []
  }
  hits.set(key, bucket)

  // Slide the window: drop timestamps strictly older than WINDOW_MS. The
  // strict `<` (a hit exactly WINDOW_MS old still counts) matches the
  // feedback-quota window in `github-feedback.ts` — the two windows keep
  // identical boundary semantics.
  while (bucket.length > 0 && bucket[0]! < now - WINDOW_MS) bucket.shift()

  if (bucket.length >= limit.maxPerWindow) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket[0]! + WINDOW_MS - now) / 1000))
    void useLogger().warning(limit.eventName, { ip, retryAfterSec })
    setResponseHeader(event, 'retry-after', retryAfterSec)
    throw createError({
      statusCode: 429,
      statusMessage: limit.errorMessage,
      data: { errorCode: 'RATE-LIMITED' },
    })
  }

  bucket.push(now)
})
