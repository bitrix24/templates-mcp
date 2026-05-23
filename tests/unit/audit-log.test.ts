import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AuditLog from '../../server/utils/audit-log'

// Three tests below use POSIX-only semantics: Unix file-mode bits and
// /dev/null as a non-directory device. Both are unavailable on Windows —
// NTFS has no chmod, and /dev/null is not a character device there.
const isWindows = process.platform === 'win32'

/**
 * Forces a fresh module import so the module-level `writeChain` promise
 * resets between tests — without it, a failed write queued in one test
 * would carry its rejected state into the next. Reset is deferred to each
 * `loadFresh()` call (not `beforeEach`) so a test can opt into a clean
 * queue exactly where it needs one.
 */
async function loadFresh(): Promise<typeof AuditLog> {
  vi.resetModules()
  return await import('../../server/utils/audit-log')
}

let tmpDir: string

beforeEach(async () => {
  // Each test gets its own tmpdir + ENV pointer so `resolveAuditDir()`
  // never crosses between tests. The audit module reads the env on every
  // call (no boot-time caching), so a per-test ENV mutation is safe. We
  // do not need to snapshot the pre-test value: `vitest.config.ts` narrows
  // `envPrefix` so `NUXT_AUDIT_DIR` from `.env` (if any) is never loaded
  // into `process.env` for this suite.
  tmpDir = await mkdtemp(path.join(tmpdir(), 'audit-log-test-'))
  process.env.NUXT_AUDIT_DIR = tmpDir
})

afterEach(async () => {
  delete process.env.NUXT_AUDIT_DIR
  vi.useRealTimers()
  await rm(tmpDir, { recursive: true, force: true })
})

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Reads a JSONL file and parses each non-empty line, with a per-line
 * try/catch so a torn write (gone-Bad concurrency) surfaces as a readable
 * failure naming the offending line, not as a generic `SyntaxError`.
 */
async function readJsonlLines(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(file, 'utf8')
  const out: Array<Record<string, unknown>> = []
  raw.split('\n').filter(l => l.length > 0).forEach((line, i) => {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    }
    catch {
      throw new Error(`Line ${i + 1} of ${file} is not valid JSON: ${line}`)
    }
  })
  return out
}

describe('recordAuditEvent — append-only JSONL audit trail (#61)', () => {
  it('writes a well-formed JSONL record with a generated ISO timestamp', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({
      event: 'oauth.upsert',
      portal: 'acme.bitrix24.com',
      userId: '42',
      actor: 'install',
      ip: '203.0.113.7',
      ua: 'curl/8',
    })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: 'oauth.upsert',
      portal: 'acme.bitrix24.com',
      userId: '42',
      actor: 'install',
      ip: '203.0.113.7',
      ua: 'curl/8',
    })
    expect(lines[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('appends — second write does not overwrite the first', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'mcp.create', portal: 'a.bitrix24.com', userId: '1', actor: 'install', mcpTokenId: 'sha256-aa' })
    await recordAuditEvent({ event: 'mcp.revoke', portal: 'a.bitrix24.com', userId: '1', actor: 'user', mcpTokenId: 'sha256-aa' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(2)
    expect(lines[0]!.event).toBe('mcp.create')
    expect(lines[1]!.event).toBe('mcp.revoke')
  })

  it('serialises 100 concurrent calls — observed order matches registration order under the microtask scheduler', async () => {
    // The promise chain `writeChain.then(...)` guarantees that callbacks
    // FIRE in the order they were chained — not a runtime spec, but
    // deterministic in V8. We assert observed order to catch any future
    // refactor that breaks serialisation.
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    const events = Array.from({ length: 100 }, (_, i) => ({
      event: 'mcp.create' as const,
      portal: `portal-${i}.bitrix24.com`,
      userId: String(i),
      actor: 'install' as const,
      mcpTokenId: `sha256-${i.toString(16).padStart(2, '0')}`,
    }))

    await Promise.all(events.map(e => recordAuditEvent(e)))
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(100)
    lines.forEach((line, i) => {
      expect(line.userId).toBe(String(i))
    })
  })

  it('rotates by ISO date — events on different UTC days land in different files', async () => {
    vi.useFakeTimers()
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()

    vi.setSystemTime(new Date('2026-05-19T23:59:59.500Z'))
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'install' })
    await drainAuditQueue()

    vi.setSystemTime(new Date('2026-05-20T00:00:00.500Z'))
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'refresh' })
    await drainAuditQueue()

    const files = (await readdir(tmpDir)).sort()
    expect(files).toEqual(['2026-05-19.jsonl', '2026-05-20.jsonl'])

    const day1 = await readJsonlLines(path.join(tmpDir, '2026-05-19.jsonl'))
    const day2 = await readJsonlLines(path.join(tmpDir, '2026-05-20.jsonl'))
    expect(day1).toHaveLength(1)
    expect(day1[0]!.actor).toBe('install')
    expect(day2).toHaveLength(1)
    expect(day2[0]!.actor).toBe('refresh')
  })

  it('creates the audit directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'does', 'not', 'exist')
    process.env.NUXT_AUDIT_DIR = nested
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'install' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(nested, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(1)
  })

  it('resolveAuditDir falls back to /data/audit when env is unset / empty / whitespace', async () => {
    const { resolveAuditDir } = await loadFresh()

    delete process.env.NUXT_AUDIT_DIR
    expect(resolveAuditDir()).toBe('/data/audit')

    process.env.NUXT_AUDIT_DIR = ''
    expect(resolveAuditDir()).toBe('/data/audit')

    process.env.NUXT_AUDIT_DIR = '   '
    expect(resolveAuditDir()).toBe('/data/audit')

    process.env.NUXT_AUDIT_DIR = '/some/explicit/path'
    expect(resolveAuditDir()).toBe('/some/explicit/path')
  })

  it('resolveAuditDir rejects path-traversal segments in NUXT_AUDIT_DIR', async () => {
    const { resolveAuditDir } = await loadFresh()

    for (const evil of ['../../etc/cron.d', '/foo/../../../etc', '/srv/audit/../../tmp']) {
      process.env.NUXT_AUDIT_DIR = evil
      expect(() => resolveAuditDir()).toThrow(/path-traversal/)
    }
  })

  it('resolveAuditDir rejects a relative NUXT_AUDIT_DIR (cwd footgun)', async () => {
    const { resolveAuditDir } = await loadFresh()

    for (const rel of ['data/audit', './audit', 'audit']) {
      process.env.NUXT_AUDIT_DIR = rel
      expect(() => resolveAuditDir()).toThrow(/absolute path/)
    }
  })

  it.skipIf(isWindows)('creates files with 0o640 mode (owner rw, group r, world none)', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'install' })
    await drainAuditQueue()

    const file = path.join(tmpDir, `${todayKey()}.jsonl`)
    const st = await stat(file)
    // umask on the test host may strip group/world bits — accept either
    // 0o640 (umask 0o027) or 0o600 (umask 0o077) but reject world-readable.
    const perms = st.mode & 0o777
    expect(perms & 0o007).toBe(0) // no world access
    expect(perms & 0o600).toBe(0o600) // owner rw
  })

  it.skipIf(isWindows)('survives a failing write — subsequent writes are not poisoned', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()

    // `/dev/null` is a character device; mkdir of a child under it fails
    // with ENOTDIR for every user including root — portable failure mode.
    // try/finally ensures NUXT_AUDIT_DIR is restored even if the assertion
    // itself throws, preventing env state from leaking to subsequent test code.
    try {
      process.env.NUXT_AUDIT_DIR = '/dev/null/audit-cant-go-here'
      const failing = recordAuditEvent({ event: 'oauth.upsert', portal: 'p', userId: '1', actor: 'install' })
      await expect(failing).rejects.toThrow()
    } finally {
      process.env.NUXT_AUDIT_DIR = tmpDir
    }

    await recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: '1', actor: 'install', mcpTokenId: 'sha256-aa' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.event).toBe('mcp.create')
  })

  it('rejects caller-supplied ts — the timestamp is always server-generated', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    // TypeScript prevents this at compile time; we cast to verify the runtime
    // behaviour: a sneaky caller cannot backdate by passing a `ts` field.
    await recordAuditEvent({
      event: 'oauth.upsert',
      portal: 'p.bitrix24.com',
      userId: '1',
      actor: 'install',
      ts: '2000-01-01T00:00:00.000Z',
    } as unknown as Parameters<typeof recordAuditEvent>[0])
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines[0]!.ts).not.toBe('2000-01-01T00:00:00.000Z')
    expect(String(lines[0]!.ts).slice(0, 4)).toBe(new Date().getUTCFullYear().toString())
  })

  it('rejects mcpTokenId that is not in sha256-<hex> shape (raw-token guard)', async () => {
    const { recordAuditEvent } = await loadFresh()

    // Looks like a raw Bearer (32 alnum, no prefix).
    await expect(
      recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: '1', actor: 'install', mcpTokenId: 'abcdef0123456789abcdef0123456789' }),
    ).rejects.toThrow(/sha256-/)

    // sha256 prefix but wrong charset (uppercase hex).
    await expect(
      recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: '1', actor: 'install', mcpTokenId: 'sha256-ABCDEF' }),
    ).rejects.toThrow(/sha256-/)

    // Empty.
    await expect(
      recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: '1', actor: 'install', mcpTokenId: '' }),
    ).rejects.toThrow(/sha256-/)
  })

  it('accepts full-length sha256-<64-hex> as mcpTokenId (real token-store shape)', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    const full = `sha256-${'a'.repeat(64)}`
    await recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: '1', actor: 'install', mcpTokenId: full })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines[0]!.mcpTokenId).toBe(full)
  })

  it('does not serialise undefined optional fields — they are absent from JSON, not null', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'system' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines[0]).not.toHaveProperty('mcpTokenId')
    expect(lines[0]).not.toHaveProperty('ip')
    expect(lines[0]).not.toHaveProperty('ua')
    expect(Object.keys(lines[0]!).sort()).toEqual(['actor', 'event', 'portal', 'ts', 'userId'])
  })

  it('records oauth.delete with actor=system (uninstall / hard revoke path)', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'oauth.delete', portal: 'p.bitrix24.com', userId: '1', actor: 'system' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines[0]!.event).toBe('oauth.delete')
    expect(lines[0]!.actor).toBe('system')
  })

  it('records actor=refresh for OAuth refresh-token rewrite path', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'refresh' })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines[0]!.event).toBe('oauth.upsert')
    expect(lines[0]!.actor).toBe('refresh')
  })

  it('does not write any token-shaped string to the file (defence in depth)', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({ event: 'mcp.create', portal: 'p.bitrix24.com', userId: '1', actor: 'install', mcpTokenId: `sha256-${'b'.repeat(64)}` })
    await recordAuditEvent({ event: 'oauth.upsert', portal: 'p.bitrix24.com', userId: '1', actor: 'refresh' })
    await drainAuditQueue()

    const raw = await readFile(path.join(tmpDir, `${todayKey()}.jsonl`), 'utf8')

    // Bitrix24 webhook URL secret segment (32+ alnum chars after /rest/<userId>/).
    expect(raw).not.toMatch(/\/rest\/\d+\/[a-z0-9]{20,}/i)
    // OAuth-style refresh / access tokens (Bitrix24 issues 32-char alnum,
    // never with our `sha256-` prefix). Negative-lookbehind excludes our
    // hex strings that legitimately follow `sha256-`.
    expect(raw).not.toMatch(/(?<![a-z0-9-])[a-z0-9]{32}(?![a-z0-9])/i)
  })

  it('drainAuditQueue resolves only after all pending writes settle', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    for (let i = 0; i < 10; i++) {
      void recordAuditEvent({ event: 'mcp.create', portal: 'p', userId: String(i), actor: 'install', mcpTokenId: `sha256-${i}` })
    }
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(lines).toHaveLength(10)
  })

  it.skipIf(isWindows)('drainAuditQueue resolves (does not reject) even when a queued write failed', async () => {
    // The Nitro shutdown hook awaits drainAuditQueue; if a failed write in
    // the chain made drain reject, the close hook would throw on shutdown.
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()

    // try/finally so the env is reset even if the rejects assertion fails.
    try {
      process.env.NUXT_AUDIT_DIR = '/dev/null/nope'
      const failing = recordAuditEvent({ event: 'oauth.upsert', portal: 'p', userId: '1', actor: 'install' })
      await expect(failing).rejects.toThrow()
    } finally {
      delete process.env.NUXT_AUDIT_DIR
    }

    // drain must settle cleanly despite the rejected write sitting in the chain.
    await expect(drainAuditQueue()).resolves.toBeUndefined()
  })

  it('isolates a mid-queue failure — other concurrent writes still land in order', async () => {
    // Write to a real dir, but make exactly one event un-writable by giving
    // it an oversized... no — instead force one failure via a bad token that
    // throws synchronously BEFORE queueing, leaving the rest intact.
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        recordAuditEvent({
          event: 'mcp.create',
          portal: 'p',
          userId: String(i),
          actor: 'install',
          // i === 7 gets a malformed token → rejected at the guard, never queued.
          mcpTokenId: i === 7 ? 'RAW-not-sha256' : `sha256-${i.toString(16)}`,
        }),
      ),
    )
    await drainAuditQueue()

    expect(results[7]!.status).toBe('rejected')
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(19)

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    // 19 successful writes, in registration order, with userId 7 absent.
    expect(lines).toHaveLength(19)
    const ids = lines.map(l => Number(l.userId))
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('truncates oversized free-text fields (DoS / disk-blowup guard)', async () => {
    const { recordAuditEvent, drainAuditQueue } = await loadFresh()
    await recordAuditEvent({
      event: 'oauth.upsert',
      portal: 'p'.repeat(1000),
      userId: '1',
      actor: 'install',
      ua: 'u'.repeat(5000),
      ip: '203.0.113.7',
    })
    await drainAuditQueue()

    const lines = await readJsonlLines(path.join(tmpDir, `${todayKey()}.jsonl`))
    expect(String(lines[0]!.portal).length).toBe(253)
    expect(String(lines[0]!.ua).length).toBe(512)
    expect(lines[0]!.ip).toBe('203.0.113.7')
  })
})
