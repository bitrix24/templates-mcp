import { vi, type Mock } from 'vitest'

/**
 * Shared mock factory for `useBitrix24()` across unit tests.
 *
 * Returns a tuple of `vi.fn()` instances — one per SDK action entry point —
 * and a `b24` object whose shape matches the real `B24Hook`:
 *   - `actions.v3.call.make`
 *   - `actions.v3.batch.make`
 *   - `actions.v2.call.make`
 *   - `actions.v2.batch.make`
 *
 * Tests pass the matching fn into `mockResolvedValue` / `mockRejectedValue`
 * for setup. Each mocked `.make()` returns a Promise<AjaxResult-like>; build
 * one via {@link fakeOk} or {@link fakeOkEmpty}.
 */

/** Shape of an AjaxResult-like object that the SDK helpers consume. */
export type FakeAjaxResult<T = unknown> = {
  isSuccess: boolean
  getData: () => { result: T }
  getErrorMessages: () => string[]
}

/** Build a successful AjaxResult-like object carrying `result`. */
export function fakeOk<T>(result: T): FakeAjaxResult<T> {
  return {
    isSuccess: true,
    getData: () => ({ result }),
    getErrorMessages: () => [],
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

/** Args signature: a single options object with `method` + `params`. */
type MakeArgs = [options: { method: string; params?: Record<string, unknown> }]

/**
 * Mock signature for `actions.v3.call.make` and `actions.v2.call.make`. The
 * real return type is `Promise<AjaxResult<T>>`; tests stub it with
 * {@link FakeAjaxResult} or {@link fakeOk}.
 */
export type CallMakeMock = Mock<(...args: MakeArgs) => Promise<FakeAjaxResult>>

/**
 * Mock signature for `actions.v3.batch.make`. With `returnAjaxResult: true`
 * the SDK upgrades `getData()` to return an array of full AjaxResults; tests
 * supply that array directly. The outer envelope is a `Result`, not an
 * `AjaxResult` — modelled minimally here.
 */
export type FakeBatchResult = {
  isSuccess: boolean
  getData: () => FakeAjaxResult[]
  getErrorMessages: () => string[]
}
export type BatchMakeMock = Mock<(...args: MakeArgs) => Promise<FakeBatchResult>>

export interface FakeBitrix24Client {
  /** Mock for `b24.actions.v3.call.make`. */
  v3Call: CallMakeMock
  /** Mock for `b24.actions.v3.batch.make`. */
  v3Batch: BatchMakeMock
  /** Mock for `b24.actions.v2.call.make`. */
  v2Call: CallMakeMock
  /** Mock for `b24.actions.v2.batch.make`. */
  v2Batch: BatchMakeMock
  /** The stand-in `B24Hook` for `useBitrix24()`. */
  b24: {
    actions: {
      v3: { call: { make: CallMakeMock }; batch: { make: BatchMakeMock } }
      v2: { call: { make: CallMakeMock }; batch: { make: BatchMakeMock } }
    }
  }
}

export function makeFakeBitrix24(): FakeBitrix24Client {
  const v3Call = vi.fn() as unknown as CallMakeMock
  const v3Batch = vi.fn() as unknown as BatchMakeMock
  const v2Call = vi.fn() as unknown as CallMakeMock
  const v2Batch = vi.fn() as unknown as BatchMakeMock
  return {
    v3Call,
    v3Batch,
    v2Call,
    v2Batch,
    b24: {
      actions: {
        v3: { call: { make: v3Call }, batch: { make: v3Batch } },
        v2: { call: { make: v2Call }, batch: { make: v2Batch } },
      },
    },
  }
}
