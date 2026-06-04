/**
 * Regression test for #60 — `AsyncLocalStorage` propagates through MCP SDK dispatch.
 *
 * Confirms that an ALS scope set around `client.callTool()` is still readable
 * inside the tool handler when the call is routed through the MCP SDK
 * transport. Underpins the OAuth per-request tenant binding planned in
 * `docs/OAUTH-DESIGN.md §7` (Event reachability — resolved by mcp-toolkit
 * middleware).
 *
 * Covers: the MCP SDK transport + dispatch chain, including cross-tenant
 * isolation under N=20 truly-parallel calls (one transport pair per call),
 * ALS survival across `setImmediate`, and ALS readability before a throw.
 *
 * Does NOT cover: the `@nuxtjs/mcp-toolkit` `createMcpHandler` → `middleware`
 * → `next()` chain. Desk-verified against the toolkit's `McpMiddleware` type
 * (in its `definitions/handlers.d.ts`). End-to-end toolkit coverage lands
 * with PR-2c (the OAuth scaffolding step in `docs/OAUTH-DESIGN.md §10`), when
 * `server/mcp/index.ts` exists to host the middleware — tracked in #65.
 *
 * If this fails after an `@modelcontextprotocol/sdk` or `@nuxtjs/mcp-toolkit`
 * upgrade, see `docs/OAUTH-DESIGN.md §7` for the design rationale before
 * "fixing" the test. This file sits on the standard `pnpm test:unit` CI
 * path, so a Renovate/Dependabot bump that breaks ALS-through-dispatch is
 * held automatically by a red check.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it } from 'vitest'

const tenantContext = new AsyncLocalStorage<{ memberId: string, userId: string }>()

/** Returns the first text-content entry from a `tools/call` result, or undefined. */
function firstText(result: CallToolResult): string | undefined {
  const item = result.content[0]
  return item?.type === 'text' ? item.text : undefined
}

interface Pair {
  client: Client
  close: () => Promise<void>
}

/**
 * Creates an isolated `McpServer` + `Client` pair connected via
 * `InMemoryTransport` and registers a `read_tenant_from_als` tool whose
 * handler returns whatever `tenantContext.getStore()` resolves to at the
 * moment of invocation. The optional `handler` hook runs before the store
 * is read, letting individual tests inject async delays or throws.
 *
 * Each pair holds two EventEmitter-based transports; tests MUST close them
 * (handled centrally by the `afterEach` teardown below).
 */
async function buildPair(opts?: { handler?: () => Promise<void> }): Promise<Pair> {
  const server = new McpServer({ name: 'als-spike', version: '0.0.0' })

  server.registerTool(
    'read_tenant_from_als',
    { description: 'Returns the tenant value visible via AsyncLocalStorage at handler time.' },
    async () => {
      if (opts?.handler) await opts.handler()
      const store = tenantContext.getStore()
      return {
        content: [{ type: 'text', text: store ? `${store.memberId}:${store.userId}` : 'MISS' }],
      }
    },
  )

  const client = new Client({ name: 'als-spike-client', version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const openPairs: Pair[] = []
afterEach(async () => {
  await Promise.all(openPairs.splice(0).map(p => p.close()))
})

/** Builds a pair and registers it for centralised teardown in `afterEach`. */
async function makePair(opts?: { handler?: () => Promise<void> }): Promise<Pair> {
  const pair = await buildPair(opts)
  openPairs.push(pair)
  return pair
}

describe('AsyncLocalStorage propagates through MCP SDK tools/call dispatch (#60)', () => {
  it('handler sees the tenant set around the client.callTool() invocation', async () => {
    const { client } = await makePair()
    const result = await tenantContext.run({ memberId: 'portal-A', userId: '42' }, () =>
      client.callTool({ name: 'read_tenant_from_als' }),
    )
    expect(firstText(result as CallToolResult)).toBe('portal-A:42')
  })

  it('20 concurrent calls each see their own context (cross-tenant leak guard)', async () => {
    const tenants = Array.from({ length: 20 }, (_, i) => ({
      memberId: `portal-${i}`,
      userId: String(i),
    }))

    // Build every transport pair OUTSIDE any tenant scope — the connect /
    // registerTool machinery runs with NO context bound. This is the strong
    // form of the guard: if the SDK ever captured the async context at
    // connect time (e.g. AsyncResource.bind on the transport's onmessage),
    // a dispatch-path ALS regression would be MASKED by connect-time
    // binding. Connecting outside `run()` forces the context to flow through
    // the `callTool()` dispatch path, which is the property production relies
    // on. (One transport pair per call also avoids a shared FIFO transport
    // serializing what looks parallel.)
    const clients = await Promise.all(tenants.map(() => makePair().then(p => p.client)))

    const results = await Promise.all(
      tenants.map((t, i) =>
        tenantContext.run(t, () => clients[i]!.callTool({ name: 'read_tenant_from_als' })),
      ),
    )

    results.forEach((r, i) => {
      expect(firstText(r as CallToolResult), `tenant index ${i}`).toBe(
        `${tenants[i]!.memberId}:${tenants[i]!.userId}`,
      )
    })
  })

  it('handler reads MISS when called outside any ALS scope (sanity check)', async () => {
    const { client } = await makePair()
    const result = await client.callTool({ name: 'read_tenant_from_als' })
    expect(firstText(result as CallToolResult)).toBe('MISS')
  })

  it('the tenant scope does not leak past the runWithTenant boundary', async () => {
    // After `tenantContext.run(...)` resolves, code outside it must read
    // `undefined`. PR-2c's dispatcher refuses to fall back to webhook when
    // a stale tenant lingers, so a scope that bled past its `run()` would be
    // a cross-tenant leak class. Native ALS gives this for free, but pinning
    // it protects against a future wrapper that captures the store globally.
    const { client } = await makePair()
    const inside = await tenantContext.run({ memberId: 'portal-Z', userId: '7' }, async () => {
      await client.callTool({ name: 'read_tenant_from_als' })
      return tenantContext.getStore()
    })
    expect(inside).toEqual({ memberId: 'portal-Z', userId: '7' })
    expect(tenantContext.getStore()).toBeUndefined()
  })

  // End-to-end coverage through the real `@nuxtjs/mcp-toolkit`
  // `createMcpHandler → middleware → next()` chain lands with PR-2c, when
  // `server/mcp/index.ts` exists to host the middleware. Tracked in #65.
  it.todo('ALS propagates through the toolkit middleware chain (e2e, #65)')

  it('ALS survives a deep async hop (setImmediate) inside the handler', async () => {
    const { client } = await makePair({
      handler: () => new Promise<void>(resolve => setImmediate(resolve)),
    })
    const result = await tenantContext.run({ memberId: 'portal-deep', userId: '7' }, () =>
      client.callTool({ name: 'read_tenant_from_als' }),
    )
    expect(firstText(result as CallToolResult)).toBe('portal-deep:7')
  })

  it('ALS is readable inside the handler before a throw (error path)', async () => {
    let seenStore: string | undefined
    const { client } = await makePair({
      handler: async () => {
        const store = tenantContext.getStore()
        seenStore = store ? `${store.memberId}:${store.userId}` : 'MISS'
        throw new Error('handler-fail')
      },
    })
    const result = await tenantContext.run({ memberId: 'portal-err', userId: '9' }, () =>
      client.callTool({ name: 'read_tenant_from_als' }),
    )
    expect(seenStore).toBe('portal-err:9')
    expect((result as CallToolResult).isError).toBe(true)
  })
})
