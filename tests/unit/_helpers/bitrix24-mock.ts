import { vi, type MockInstance } from 'vitest'

/**
 * Shared mock factory for `useBitrix24()` across unit tests.
 *
 * Returns a tuple of `vi.fn()` instances — one per SDK action entry point —
 * and a `b24` object whose shape matches the real `B24Hook`: `actions.v3.call.make`,
 * `actions.v3.batch.make`, `actions.v2.call.make`. Tests pass the matching
 * fn into `mockResolvedValue` / `mockRejectedValue` for their setup.
 *
 * Each mocked `.make()` returns a Promise<AjaxResult-like>. Tests provide
 * the AjaxResult shape themselves — minimal stub is
 * `{ isSuccess: true, getData: () => ({ result: {...} }), getErrorMessages: () => [] }`.
 */
export type FakeAjaxResult<T = unknown> = {
  isSuccess: boolean
  getData: () => { result: T }
  getErrorMessages: () => string[]
}

export function fakeOk<T>(result: T): FakeAjaxResult<T> {
  return {
    isSuccess: true,
    getData: () => ({ result }),
    getErrorMessages: () => [],
  }
}

export function fakeError(message: string): FakeAjaxResult<never> {
  return {
    isSuccess: false,
    getData: () => ({ result: undefined as never }),
    getErrorMessages: () => [message],
  }
}

/**
 * Like {@link fakeOk} but yields a success result with `result: undefined` so
 * tests can probe the "Bitrix24 returned no payload" defensive branches in
 * tool handlers. `isSuccess: true` keeps the happy-path code reachable; only
 * `getData().result` is missing.
 */
export function fakeOkEmpty(): FakeAjaxResult<undefined> {
  return {
    isSuccess: true,
    getData: () => ({ result: undefined }),
    getErrorMessages: () => [],
  }
}

export interface FakeBitrix24Client {
  v3Call: MockInstance
  v3Batch: MockInstance
  v2Call: MockInstance
  b24: {
    actions: {
      v3: { call: { make: MockInstance }; batch: { make: MockInstance } }
      v2: { call: { make: MockInstance } }
    }
  }
}

export function makeFakeBitrix24(): FakeBitrix24Client {
  const v3Call = vi.fn()
  const v3Batch = vi.fn()
  const v2Call = vi.fn()
  return {
    v3Call,
    v3Batch,
    v2Call,
    b24: {
      actions: {
        v3: { call: { make: v3Call }, batch: { make: v3Batch } },
        v2: { call: { make: v2Call } },
      },
    },
  }
}
