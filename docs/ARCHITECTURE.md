# Architecture

15-minute orientation. Authoritative design lives in [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md).

## One tool catalogue, three transports

```
            server/mcp/tools/**  (30 defineMcpTool calls)
                  │
       ┌──────────┴──────────────┐
       │                         │
   Nuxt HTTP                  Stdio (DXT)
   /mcp route                 mcp-stdio/server.ts
   Streamable HTTP            StdioServerTransport
   Bearer auth                process-trust
       │                         │
  ┌────┴────┐                    │
  Remote   Local-HTTP        Claude Desktop
  (Docker) (laptop)          spawns process
```

Same handler code, same `useBitrix24()` singleton, same logger redaction. Only transport + packaging differ.

## Layers

| Layer | File | Notes |
|---|---|---|
| Transport | `@modelcontextprotocol/sdk` (HTTP) / `mcp-stdio/server.ts` (stdio) | toolkit mounts `/mcp`; stdio is bundled separately |
| Auth | `server/middleware/mcp-auth.ts` | Bearer + `timingSafeEqual`. 503 if unset, 401 on mismatch. HTTP only. |
| Tool registry | Nuxt file-glob (HTTP) / `mcp-stdio/tools.ts` (stdio, hand-maintained) | parity check is a TODO — see hot spots |
| Tool handlers | `server/mcp/tools/{tasks,users,meta}/*.ts` | `defineMcpTool` is a no-op passthrough |
| Bitrix24 client | `server/utils/bitrix24.ts` | process-singleton `B24Hook`, logger wrapped in `makeRedactingLogger` |
| REST dispatch | `server/utils/sdk-helpers.ts` | `callV2/callV3/batchV2/batchV3` — only correct path. Direct `actions.*` forbidden. |
| Action factories | `define-action-tool.ts`, `task-lifecycle.ts`, `checklist.ts` | own single-vs-batch dispatch contract |

## Why these picks

- **Nuxt/Nitro** — `useRuntimeConfig`, file routing, opinionated build; `.output` runs anywhere. Cost: Nuxt-isms leak into tool code → DXT needs shims.
- **`@nuxtjs/mcp-toolkit`** — HTTP transport plumbing for free. `defineMcpTool` is a passthrough we depend on. Cost: barrel pulls Nitro virtuals; bypassed for stdio.
- **zod 4** — required by SDK 1.29 + b24jssdk. Cost: `sideEffects:false` breaks esbuild lazy init in DXT bundle → one-line preload in `mcp-stdio/nuxt-shims.ts`.
- **DXT shims (not refactor)** — alternative was rewriting 30 tool files to not use `useRuntimeConfig`. Two 5-line shims won. **Exit criterion:** drop both shims when `@nuxtjs/mcp-toolkit` ships a build that doesn't pull Nitro virtual modules from its `/server` barrel (tracked at `nuxt-modules/mcp-toolkit`), OR when this project moves off Nuxt entirely.
- **Singleton `B24Hook`** — `RestrictionManager` keeps in-process rate-limit state; two clients would race against Bitrix24's leaky bucket.

## Hot spots (audit on every PR that touches them)

1. **Tool registry parity.** New tool under `server/mcp/tools/**` must also land in `mcp-stdio/tools.ts`. `TODO(team)`: write `tests/unit/tools.parity.spec.ts`.
2. **Logger redaction.** New HTTP-talking dep with its own logger may bypass `makeRedactingLogger`. Re-run the audit pattern in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) on every SDK bump.
3. **`useRuntimeConfig` callsites.** Three today (`bitrix24.ts`, `mcp-auth.ts`, `github-feedback.ts`). New callsites break DXT silently — shim only carries fields it explicitly projects.
4. **Webhook URL pattern.** Documented in `manifest.json`, `.env.example`, `README.md`, `INSTALL.*.md`. Keep in sync; Self-Hosted Bitrix24 is supported by the SDK.

## Further reading

- [`DEPLOYMENT.md`](./DEPLOYMENT.md) · [`RUNBOOK.md`](./RUNBOOK.md) · [`SECURITY.md`](./SECURITY.md) · [`REVERSE-PROXY.md`](./REVERSE-PROXY.md)
- [`../mcp-stdio/README.md`](../mcp-stdio/README.md) — DXT internals
- [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — full spec
