import { B24Hook } from '@bitrix24/b24jssdk'
import { acquireBitrix24Token } from '~/server/utils/rate-limiter'

let client: B24Hook | null = null

/**
 * Returns a process-singleton Bitrix24 client backed by the incoming webhook
 * configured via NUXT_BITRIX24_WEBHOOK_URL.
 *
 * The returned `B24Hook` is monkey-patched so that every `callMethod` first
 * acquires a token from the client-side rate limiter (see `rate-limiter.ts`).
 * This protects against `QUERY_LIMIT_EXCEEDED` when LLM agents parallelise
 * tool calls or when batch tools (issue #7) loop over many ids. No tool code
 * needs to know about the limiter.
 *
 * Phase 1 uses the webhook flow only. Phase 3 will introduce useBitrix24OAuth()
 * alongside this helper without changing its signature.
 *
 * The cache lives in module scope, so tests that need a clean state should
 * `vi.resetModules()` and re-import this module — we deliberately do not
 * export a reset hook to avoid leaking test-only API into production builds.
 */
export function useBitrix24(): B24Hook {
  if (client) return client

  const { bitrix24WebhookUrl } = useRuntimeConfig()
  if (!bitrix24WebhookUrl) {
    throw new Error('NUXT_BITRIX24_WEBHOOK_URL is not configured')
  }

  // SDK 1.1+ no longer accepts a raw URL in the constructor — the helper
  // parses portal host, user id, and secret out of the webhook URL.
  client = B24Hook.fromWebhookUrl(bitrix24WebhookUrl)

  // Gate every outbound REST call through the token bucket. We bind the
  // original `callMethod` once and replace the method on the instance, so
  // the SDK's internal `this` semantics are preserved.
  const originalCallMethod = client.callMethod.bind(client)
  client.callMethod = (async (...args: Parameters<B24Hook['callMethod']>) => {
    await acquireBitrix24Token()
    return originalCallMethod(...args)
  }) as B24Hook['callMethod']

  return client
}
