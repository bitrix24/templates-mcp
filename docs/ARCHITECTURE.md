# Architecture

`Last reviewed: 2026-06-14`

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

Same handler code, same OAuth-aware client dispatcher, same logger redaction. Only transport + packaging differ.

## Layers

| Layer | File | Notes |
|---|---|---|
| Transport | `@modelcontextprotocol/sdk` (HTTP) / `mcp-stdio/server.ts` (stdio) | toolkit mounts `/mcp`; stdio is bundled separately |
| Auth (h3) | `server/middleware/mcp-auth.ts` | flag-off: Bearer + `timingSafeEqual` against `NUXT_MCP_AUTH_TOKEN` (503 if unset, 401 on mismatch). Flag-on: defence-in-depth Bearer-prefix check, then yields to the toolkit middleware. |
| Auth (toolkit) | `server/mcp/index.ts` | flag-on Bearer → sha256 → `inspectBearer` → `runWithTenant(...)` so per-request tenant context propagates to every tool. Three §11 deny buckets each carry their own `WWW-Authenticate errorCode`. |
| Tool registry | Nuxt file-glob (HTTP) / `mcp-stdio/tools.ts` (stdio) | parity is CI-enforced (`tools.parity.test.ts`) — see hot spots |
| Tool handlers | `server/mcp/tools/{tasks,users,meta}/*.ts` | `defineMcpTool` is a no-op passthrough |
| Tenant dispatcher | `server/utils/bitrix24-tenant.ts` | the `useBitrix24Tenant()` every tool calls. Flag-off → returns the webhook singleton; flag-on → resolves the per-tenant `B24OAuth` from ALS. Tool code never knows which it got. |
| Bitrix24 client (webhook) | `server/utils/bitrix24.ts` | process-singleton `B24Hook`, logger wrapped in `makeRedactingLogger` |
| Bitrix24 client (OAuth) | `server/utils/bitrix24-oauth.ts` | per-tenant `B24OAuth` LRU-cached at 100, custom refresh callback persists via `useTokenStore`, redacting logger attached on construction (defence-in-depth on the SDK's log surface) |
| OAuth token store | `server/utils/token-store.ts` (+ `server/plugins/oauth-schema.ts`) | SQLite, sha256-hashed Bearers, audit-first invariant on every mutation, schema-bootstrap plugin runs at boot |
| REST dispatch | `server/utils/sdk-helpers.ts` | `callV2/callV3/batchV2/batchV3` — only correct path. Direct `actions.*` forbidden. |
| Action factories | `define-action-tool.ts`, `task-lifecycle.ts`, `checklist.ts` | own single-vs-batch dispatch contract |

## Why these picks

- **Nuxt/Nitro** — `useRuntimeConfig`, file routing, opinionated build; `.output` runs anywhere. Cost: Nuxt-isms leak into tool code → DXT needs shims.
- **`@nuxtjs/mcp-toolkit`** — HTTP transport plumbing for free. `defineMcpTool` is a passthrough we depend on. Cost: barrel pulls Nitro virtuals; bypassed for stdio.
- **zod 4** — required by SDK 1.29 + b24jssdk. Cost: `sideEffects:false` breaks esbuild lazy init in DXT bundle → one-line preload in `mcp-stdio/nuxt-shims.ts`.
- **DXT shims (not refactor)** — alternative was rewriting 30 tool files to not use `useRuntimeConfig`. Two 5-line shims won. **Exit criterion:** drop both shims when `@nuxtjs/mcp-toolkit` ships a build that doesn't pull Nitro virtual modules from its `/server` barrel (tracked at `nuxt-modules/mcp-toolkit`), OR when this project moves off Nuxt entirely.
- **Singleton `B24Hook`** — `RestrictionManager` keeps in-process rate-limit state; two clients would race against Bitrix24's leaky bucket.

## Hot spots (audit on every PR that touches them)

1. **Tool registry parity.** New tool under `server/mcp/tools/**` must also land in `mcp-stdio/tools.ts`. CI-enforced by `tests/unit/mcp-stdio/tools.parity.test.ts` — a missing registry entry fails the build.
2. **Tenant-dispatcher invariant.** Tool handlers MUST resolve their client via `useBitrix24Tenant()` from `server/utils/bitrix24-tenant.ts`, never `useBitrix24()` directly. Direct webhook calls bypass the OAuth dispatcher and silently break multi-tenant mode. CI-enforced by `tests/unit/mcp-stdio/tools.tenant-guard.test.ts` — a tool file under `server/mcp/tools/**` that imports or calls `useBitrix24` directly fails the build with the offending path. See [`OAUTH-DESIGN.md` §6](./OAUTH-DESIGN.md#6-mcp-bearer--tenant-token-coupling) and `docs/ADDING-TOOLS.md`.
3. **Logger redaction.** Every Bitrix24-talking client (webhook + per-tenant OAuth) gets `makeRedactingLogger` wrapped on construction. A new HTTP-talking dep with its own logger may bypass it — re-run the audit pattern in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) on every SDK bump.
4. **`useRuntimeConfig` callsites.** Many — anything under `server/utils/`, `server/api/oauth/`, `server/mcp/index.ts`, `server/middleware/*.ts`, `server/plugins/oauth-schema.ts`. New callsites that read fields not projected by `mcp-stdio/nuxt-shims.ts` break DXT silently — the shim only carries fields it explicitly forwards.
5. **Webhook URL pattern.** Documented in `manifest.json`, `.env.example`, `README.md`, `INSTALL.*.md`. Keep in sync; Self-Hosted Bitrix24 is supported by the SDK.
6. **OAuth event taxonomy.** Every new `oauth.*` or `mcp.auth.*` log line must be registered in `docs/OAUTH-DESIGN.md` §11. The doc is normative; a divergent log line breaks the operator's grep-the-log workflow.

## Further reading

- [`DEPLOYMENT.md`](./DEPLOYMENT.md) · [`RUNBOOK.md`](./RUNBOOK.md) · [`SECURITY.md`](./SECURITY.md) · [`REVERSE-PROXY.md`](./REVERSE-PROXY.md)
- [`../mcp-stdio/README.md`](../mcp-stdio/README.md) — DXT internals
- [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — full spec
