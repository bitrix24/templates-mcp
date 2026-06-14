// https://github.com/mattpocock/evalite
import { defineConfig } from 'evalite/config'

export default defineConfig({
  // 30s per case is plenty for a single DeepSeek round-trip.
  testTimeout: 30_000,

  // Modest parallelism — DeepSeek is fine with bursts, but we don't want to
  // hammer the free-tier quota on a flaky network.
  maxConcurrency: 4,

  // No scoreThreshold yet (issue #223 item 4 — DEFERRED, blocked on a baseline).
  // Setting a floor is the goal: without it a description rewrite that drops
  // tool-disambiguation accuracy (e.g. 95% → 60%) still passes silently. But
  // the floor MUST be calibrated against a real baseline first — picking a
  // number blind risks either a false CI failure (floor above the true
  // baseline) or a useless gate (floor below the regression it should catch).
  //
  // To land this:
  //   1. Run `pnpm test:evals` a few times with DEEPSEEK_API_KEY set, record
  //      the steady-state score for the "Bitrix24 tool selection" suite.
  //   2. Set `scoreThreshold: { 'Bitrix24 tool selection': <baseline - margin> }`
  //      (the issue suggests ~0.80 on the assumption the baseline sits well
  //      above it — confirm against the recorded number before committing).
  //   3. Wire `pnpm test:evals` into a CI job gated on DEEPSEEK_API_KEY
  //      (tracked separately) so the threshold actually enforces.
  // Until step 1 is done the eval just reports a score; nothing gates on it.
  //
  // Target: land steps 1-2 by v0.1.1 (a baseline can only be recorded once the
  // pilot has a DEEPSEEK_API_KEY available); step 3 rides with #194 (coverage
  // gate in CI). Tracked so "deferred" doesn't quietly become permanent.
})
