/**
 * Token-bucket rate limiter for outbound Bitrix24 REST calls.
 *
 * Bitrix24 enforces ~2 req/sec on the REST layer; bursts above that get
 * `QUERY_LIMIT_EXCEEDED`. LLM-driven agents parallelise tool calls
 * aggressively, so a batched action ("закрой все мои задачи") can blow
 * through that limit and leave the batch half-applied.
 *
 * This module exposes a single `acquireBitrix24Token()` that returns once a
 * token is available. Wrap every outgoing call to `B24Hook.callMethod` with
 * it (see `useBitrix24` in `bitrix24.ts`) and the rate is enforced
 * automatically — no per-tool plumbing.
 *
 * Defaults: `capacity: 5` burst, `refillRatePerSec: 2`. Tuned to stay under
 * Bitrix24's documented cap with one token of headroom for cohabiting
 * traffic (UI calls, integrations).
 *
 * Process-wide singleton. Tests reset it via `vi.resetModules()` — same
 * pattern as `useBitrix24`.
 */

export interface RateLimiterOptions {
  /** Maximum tokens in the bucket (= maximum burst size). */
  capacity: number
  /** How fast tokens replenish, in tokens per second. */
  refillRatePerSec: number
}

const DEFAULTS: RateLimiterOptions = { capacity: 5, refillRatePerSec: 2 }

let opts: RateLimiterOptions = DEFAULTS
let tokens = opts.capacity
let lastRefill = Date.now()
let pending: Array<() => void> = []
let drainScheduled = false

function refill(now: number): void {
  const elapsedSec = (now - lastRefill) / 1000
  if (elapsedSec <= 0) return
  tokens = Math.min(opts.capacity, tokens + elapsedSec * opts.refillRatePerSec)
  lastRefill = now
}

function drain(): void {
  drainScheduled = false
  const now = Date.now()
  refill(now)
  while (pending.length > 0 && tokens >= 1) {
    tokens -= 1
    const resolve = pending.shift()!
    resolve()
  }
  if (pending.length > 0 && !drainScheduled) {
    drainScheduled = true
    // Time until the next whole token is available.
    const waitMs = Math.ceil(((1 - tokens) / opts.refillRatePerSec) * 1000)
    setTimeout(drain, Math.max(1, waitMs))
  }
}

/**
 * Acquire one token. Resolves immediately if tokens are available, otherwise
 * waits until the bucket refills enough. FIFO across pending waiters.
 */
export function acquireBitrix24Token(): Promise<void> {
  return new Promise((resolve) => {
    pending.push(resolve)
    if (!drainScheduled) {
      // Try to satisfy immediately; if not enough tokens, drain() schedules
      // itself.
      drain()
    }
  })
}

/**
 * Test-only — never imported from production code. Resets the bucket to a
 * clean state with the given options. Without args, restores defaults.
 *
 * Production paths drop the singleton via `vi.resetModules()` (same as
 * `useBitrix24`); this helper exists for tests that want to override the
 * limiter shape (e.g. a fast bucket for burst tests) without forcing a
 * module reload between cases.
 */
export function __resetBitrix24RateLimiterForTests(overrides?: Partial<RateLimiterOptions>): void {
  opts = { ...DEFAULTS, ...overrides }
  tokens = opts.capacity
  lastRefill = Date.now()
  pending = []
  drainScheduled = false
}
