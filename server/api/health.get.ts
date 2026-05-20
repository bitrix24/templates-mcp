// Public, unauthenticated probe. Keep payload minimal — no service name,
// version, or other fingerprintable surface — the deploy workflow only needs
// `status: 'ok'` to decide whether to roll back.
export default defineEventHandler(() => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}))
