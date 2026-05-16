import { B24Hook } from '@bitrix24/b24jssdk'
import { describe, expect, it } from 'vitest'

// Integration suite — only runs when a real Bitrix24 webhook URL is supplied
// via NUXT_BITRIX24_TEST_WEBHOOK_URL. Locally that comes from `.env`; in CI
// it comes from the `BITRIX24_TEST_WEBHOOK_URL` repository secret. When the
// variable is missing (forks, contributors without portal access) the suite
// is skipped instead of failing.
const webhookUrl = process.env.NUXT_BITRIX24_TEST_WEBHOOK_URL?.trim()

if (!webhookUrl) {
  console.warn(
    '[integration] NUXT_BITRIX24_TEST_WEBHOOK_URL is not set — skipping live Bitrix24 checks. '
      + 'Set it locally (.env) or configure the BITRIX24_TEST_WEBHOOK_URL GitHub Actions secret to enable.',
  )
}

const describeIfConfigured = webhookUrl ? describe : describe.skip

describeIfConfigured('Bitrix24 webhook — live integration', () => {
  it('responds to user.current with an authenticated identity', async () => {
    // SDK is constructed lazily inside the test: Vitest still evaluates the
    // describe-callback body when the suite is skipped, so doing this at
    // top-level would crash on contributor machines without the webhook set.
    const b24 = B24Hook.fromWebhookUrl(webhookUrl!)
    const response = await b24.callMethod('user.current', {})
    const user = response.getData()?.result as
      | { ID?: string | number, NAME?: string, EMAIL?: string }
      | undefined

    expect(user, 'user.current returned an empty payload — the webhook may be revoked').toBeDefined()
    expect(user?.ID, 'user.current returned a payload without an ID').toBeDefined()
  }, 15_000)
})
