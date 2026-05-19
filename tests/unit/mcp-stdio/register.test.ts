import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { registerToolFromDefinition } from '../../../mcp-stdio/register'

/**
 * Unit tests for the stdio tool-registration helper. The helper wraps every
 * tool's handler in a result-normaliser + error-funnel so that tool code
 * (which still returns whatever shape the modern template recommends —
 * string / number / plain object / SDK ToolResult) reaches the SDK as a
 * `{ content: [...] }`-shaped ToolResult.
 *
 * Failure mode the suite catches: a regression in the normaliser turns
 * non-string / non-Result returns into garbage on the wire, breaking every
 * tool in the DXT bundle silently (no schema error — just empty content).
 */

interface CapturedCall {
  name: string
  options: unknown
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>
}

function makeFakeServer() {
  const calls: CapturedCall[] = []
  const fake = {
    registerTool: vi.fn((name: string, options: unknown, handler: CapturedCall['handler']) => {
      calls.push({ name, options, handler })
      return { name }
    }),
  } as unknown as McpServer
  return { server: fake, calls }
}

describe('registerToolFromDefinition', () => {
  it('throws if `name` is missing (stdio bundle has no auto-discovery to fill it)', () => {
    const { server } = makeFakeServer()
    expect(() =>
      registerToolFromDefinition(server, {
        handler: async () => 'ok',
      }),
    ).toThrow(/explicit `name`/)
  })

  it('forwards `name`, options bag, and a wrapped handler to `server.registerTool`', () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, {
      name: 'demo_tool',
      title: 'Demo',
      description: 'desc',
      inputSchema: { kind: 'shape' },
      outputSchema: { kind: 'shape' },
      annotations: { readOnly: true },
      group: 'demo',
      tags: ['a', 'b'],
      inputExamples: [{ input: {} }],
      _meta: { custom: 1 },
      handler: async () => 'ok',
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.name).toBe('demo_tool')
    expect(call.options).toMatchObject({
      title: 'Demo',
      description: 'desc',
      inputSchema: { kind: 'shape' },
      _meta: { custom: 1, inputExamples: [{ input: {} }], group: 'demo', tags: ['a', 'b'] },
    })
  })

  it('wraps a string return into `{ content: [{ type: text }] }`', async () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, { name: 't', handler: async () => 'hello' })
    const call = calls[0]!
    const result = await call.handler({}, undefined)
    expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })

  it('coerces number / boolean returns into a text content block', async () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, { name: 't1', handler: async () => 42 })
    registerToolFromDefinition(server, { name: 't2', handler: async () => true })
    const r1 = await calls[0]!.handler({}, undefined)
    const r2 = await calls[1]!.handler({}, undefined)
    expect(r1).toEqual({ content: [{ type: 'text', text: '42' }] })
    expect(r2).toEqual({ content: [{ type: 'text', text: 'true' }] })
  })

  it('JSON-stringifies a plain object that has no SDK ToolResult shape', async () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, {
      name: 't',
      handler: async () => ({ ok: true, count: 3 }),
    })
    const call = calls[0]!
    const result = (await call.handler({}, undefined)) as { content: Array<{ text: string }> }
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, count: 3 })
  })

  it('passes through a value that already looks like an SDK ToolResult', async () => {
    const { server, calls } = makeFakeServer()
    const preBuilt = { content: [{ type: 'text', text: 'pre-built' }], isError: false }
    registerToolFromDefinition(server, { name: 't', handler: async () => preBuilt })
    const call = calls[0]!
    expect(await call.handler({}, undefined)).toEqual(preBuilt)
  })

  it('funnels a thrown Error into `{ isError: true, content: [<message>] }`', async () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, {
      name: 't',
      handler: async () => {
        throw new Error('boom')
      },
    })
    const call = calls[0]!
    expect(await call.handler({}, undefined)).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    })
  })

  it('funnels a non-Error throw via String() coercion', async () => {
    const { server, calls } = makeFakeServer()
    registerToolFromDefinition(server, {
      name: 't',
      handler: async () => {
        throw 'string-as-error'
      },
    })
    const call = calls[0]!
    expect(await call.handler({}, undefined)).toEqual({
      content: [{ type: 'text', text: 'string-as-error' }],
      isError: true,
    })
  })
})
