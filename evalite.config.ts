// https://github.com/mattpocock/evalite
import { defineConfig } from 'evalite/config'

export default defineConfig({
  // 30s per case is plenty for a single DeepSeek round-trip.
  testTimeout: 30_000,

  // Modest parallelism — DeepSeek is fine with bursts, but we don't want to
  // hammer the free-tier quota on a flaky network.
  maxConcurrency: 4,

  // No scoreThreshold yet. Once we have a baseline from a few real runs we'll
  // turn this on at ~80% — until then the eval just reports a score; CI can
  // gate on it explicitly when desired.
})
