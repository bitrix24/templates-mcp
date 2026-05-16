import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBitrix24RateLimiterForTests, acquireBitrix24Token } from '../../server/utils/rate-limiter'

describe('acquireBitrix24Token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetBitrix24RateLimiterForTests({ capacity: 5, refillRatePerSec: 2 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves immediately for the first N acquisitions up to capacity (burst)', async () => {
    const results = await Promise.all([
      acquireBitrix24Token(),
      acquireBitrix24Token(),
      acquireBitrix24Token(),
      acquireBitrix24Token(),
      acquireBitrix24Token(),
    ])
    expect(results).toHaveLength(5)
  })

  it('back-pressures the 6th acquisition by ~500ms with refillRate=2/sec', async () => {
    for (let i = 0; i < 5; i += 1) await acquireBitrix24Token()

    let resolved = false
    void acquireBitrix24Token().then(() => {
      resolved = true
    })

    // Yield to flush the promise microtask queue without advancing the clock.
    await Promise.resolve()
    expect(resolved).toBe(false)

    // 1 token at 2/sec = 500ms.
    await vi.advanceTimersByTimeAsync(499)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(2)
    expect(resolved).toBe(true)
  })

  it('preserves FIFO order across pending waiters', async () => {
    for (let i = 0; i < 5; i += 1) await acquireBitrix24Token()

    const order: number[] = []
    const a = acquireBitrix24Token().then(() => order.push(1))
    const b = acquireBitrix24Token().then(() => order.push(2))
    const c = acquireBitrix24Token().then(() => order.push(3))

    // Wait for three tokens to drip (1500ms at 2/sec).
    await vi.advanceTimersByTimeAsync(1600)
    await Promise.all([a, b, c])

    expect(order).toEqual([1, 2, 3])
  })

  it('paces 10 acquisitions over ~2.5s (5 burst + 5 at 2/sec)', async () => {
    const start = Date.now()
    const timestamps: number[] = []
    const all = Promise.all(
      Array.from({ length: 10 }, () =>
        acquireBitrix24Token().then(() => timestamps.push(Date.now() - start)),
      ),
    )

    // First 5 are immediate; remaining 5 need 0.5/1.0/1.5/2.0/2.5s.
    await vi.advanceTimersByTimeAsync(2600)
    await all

    expect(timestamps).toHaveLength(10)
    // First 5 land at t=0 (synchronously). The 6th lands ~500ms in.
    expect(timestamps.slice(0, 5).every((t) => t <= 5)).toBe(true)
    expect(timestamps[5]).toBeGreaterThanOrEqual(500)
    expect(timestamps[9]).toBeLessThanOrEqual(2600)
  })

  it('honours custom options via the test reset helper', async () => {
    __resetBitrix24RateLimiterForTests({ capacity: 1, refillRatePerSec: 10 })

    await acquireBitrix24Token() // consumes the only token

    let resolved = false
    void acquireBitrix24Token().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    // 1 / 10 = 100ms.
    await vi.advanceTimersByTimeAsync(101)
    expect(resolved).toBe(true)
  })
})
