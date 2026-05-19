// Public, unauthenticated probe. Keep payload minimal — no version or other
// fingerprintable surface — the deploy workflow only needs `status: 'ok'` to
// decide whether to roll back.
export default defineEventHandler(() => ({
  status: 'ok',
  service: 'bx24-template-mcp',
  timestamp: new Date().toISOString(),
}))
