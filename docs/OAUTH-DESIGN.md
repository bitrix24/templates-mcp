# OAuth 2.0 design — multi-tenant auth (shipped)

`Last reviewed: 2026-06-15`

> **Status: SHIPPED.** The implementation is live behind the `NUXT_BITRIX24_OAUTH_ENABLED` feature flag (off by default) — landed across #209 → #210 → #213 → #216 → #218, operator docs in #219 (§10 has the full rollout table). This document remains the **normative design reference**: threat model, token-store contract, §11 event taxonomy.
>
> **Doc-vs-code drift policy.** If implementation diverges from this document, `OAUTH-DESIGN.md` is updated in the same PR that introduces the divergence. This file is normative until superseded.

## 1. Why

Phase 1 binds the MCP to a single Bitrix24 portal via an **incoming webhook**. The webhook executes every REST call as its creator (see README "Quick start" and `.env.example`), so:

- The MCP inherits one user's permissions for *all* callers, regardless of who is on the Claude end.
- A dedicated service account is the least-bad workaround (PR #57), but it does not solve the underlying mismatch: there is no per-user identity.
- One MCP instance serves exactly one portal. Multi-tenant — *"multiple users connect their own portals"* (`PROJECT-BRIEF.md:996`) — is impossible.

OAuth 2.0 via `B24OAuth` (shipped by `@bitrix24/b24jssdk`) replaces both shortcomings: each end user logs in with their own Bitrix24 account, and every REST call runs under that user's identity and permissions on whichever portal they belong to.

## 2. Goals / non-goals

**In scope (this design + the follow-up implementation PRs):**

1. Per-user authorization: REST calls run under the end user's Bitrix24 identity.
2. Multi-tenant on the HTTP transport: one MCP instance serves N portals × M users.
3. Coexistence with the webhook flow: webhook stays as the dev / single-tenant fallback. Both transports compile and pass tests; only one is wired at runtime per deployment.
4. Token persistence with refresh-on-expiry handled inside `useBitrix24OAuth()` so tool code stays unchanged.
5. **App-registration shape: marketplace application.** Required to satisfy the Phase-3 DoD ("multiple users connect their own portals"). Local-app is supported as a dev / single-tenant fallback path but not the recommended production shape.
6. **OAuth scope set: `user` + `task`** to start, matching what the current tool catalogue exercises. The scope string is hard-coded in the install URL and mirrored in `.env.example` comments; PRs that add new tools must also update the scope (added to `docs/ADDING-TOOLS.md` checklist).

**Out of scope (explicit):**

1. **DXT stdio transport (`mcp-stdio/`)** — **shipped via #207** (OOB code-paste flow) and **redesigned via #247** (credential storage moved from build-time esbuild bake to Claude Desktop `user_config`). Both `CLIENT_ID` and `CLIENT_SECRET` are now operator-supplied at install time through three `user_config` fields (`bitrix24_portal_host`, `bitrix24_oauth_client_id`, `bitrix24_oauth_client_secret`); Claude Desktop stores the secret under `sensitive: true` in the OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret subject to availability). The bundle reads them at runtime via `NUXT_BITRIX24_DXT_OAUTH_*` env vars projected into `mcp-stdio/nuxt-shims.ts` — no build-time literals, no fork-specific CI secrets. The DXT flow itself is the official Bitrix24 OOB protocol (`apidocs.bitrix24.ru/api-reference/oauth/index.html` — "приложение без обратного адреса"): `/oauth/authorize/?client_id=…` with no `redirect_uri`, Bitrix24 shows a 30-second `code` on the consent page, user pastes it into the `bx24mcp_oauth_paste_code` tool, the bundle exchanges `code + client_id + client_secret` for tokens against `oauth.bitrix24.tech/oauth/token/`, persists them to `<user-data>/bx24-template-mcp/oauth.json` (mode 0o600, atomic tmp+rename), and silently refreshes via SDK's `setCustomRefreshAuth` on 401. Caveats that remain: (a) the consent code lives ~30 s — UX is paste-immediately; (b) Bitrix24 doesn't publish PKCE, so a long-lived `CLIENT_SECRET` is still required (per-install in the keychain instead of per-build in the bundle — strictly better, not solved); (c) refresh rotation runs inside the DXT process. See `mcp-stdio/README.md` § "OAuth mode" and `mcp-stdio/INSTALL.{ru,pt-BR}.md` for the operator flow.
2. **High-availability multi-instance.** SQLite-on-disk assumes a single Nitro process with the volume mounted. Horizontal scale needs a different store; called out under "Future hardening".
3. **Encryption at rest of refresh tokens.** Plaintext refresh tokens in SQLite are no worse than the webhook secret in `.env` today. Encryption is tracked as a follow-up (envelope encryption with a KMS / `age` / OS keychain). **Audit log + encryption are P1-pre-enterprise-launch** — see §12.
4. **Automatic migration from existing webhook deployments.** Operators flip the flag, register a Bitrix24 OAuth application, and tell their users to re-authorize. No data migration — webhook flow has no per-user state to migrate. An upgrade runbook is in §10.
5. **`bx24mcp_submit_feedback`** keeps using the GitHub PAT — it is not portal-bound.

**Cross-cutting invariants for other Phase-3 features:**

- **Batch operations** (`PROJECT-BRIEF.md:996`) MUST resolve their client via `useBitrix24Tenant(event)`, never `useBitrix24()` directly. A batch call carries the tenant identity of the MCP Bearer that initiated it. This invariant is binding on any PR that lands batch support, even if it precedes OAuth implementation in calendar order.

## 3. End-to-end flow

```
                       ┌──────────────┐
                  1.   │   End user   │
                ┌─────►│   (browser)  │
                │      └──────┬───────┘
                │             │
                │       /api/oauth/install
                │             ▼
                │      ┌──────────────┐
                │   2. │  MCP server  │  generates state nonce,
                │      │   (Nitro)    │  sets first-party cookie
                │      └──────┬───────┘
                │             │
                │      302 to Bitrix24 /oauth/authorize/
                │             ▼
                │      ┌──────────────┐
                │   3. │   Bitrix24   │  user logs in,
                │      │    portal    │  consents to scopes
                │      └──────┬───────┘
                │             │
                │      302 ?code=…&state=…&domain=…&member_id=…
                │             │
                │             ▼
                │      ┌──────────────┐
                │   4. │   End user   │  follows redirect
                │      │   (browser)  │
                │      └──────┬───────┘
                │             │
                │       /api/oauth/callback
                │             ▼
                │      ┌──────────────┐
                │   5. │  MCP server  │  validates state + cookie,
                │      │              │  exchanges code → tokens,
                │      │              │  upserts oauth_tokens,
                │      │              │  mints mcp_tokens row
                │      └──────┬───────┘
                │             │
                │      HTML page: raw Bearer (shown once),
                │      Cache-Control: no-store,
                │      paste-into-Claude/Cursor/Windsurf instructions
                └─────────────┘

(Steady state)

┌────────────┐  POST /mcp + Bearer X       ┌──────────────────┐
│  Claude /  │ ──────────────────────────► │   MCP middleware │
│  Cursor /  │                             │   sha256(Bearer) │
│  Windsurf  │                             │   → tenant       │
└────────────┘                             │   tools run via  │
                                           │   useBitrix24Tenant
                                           └──────────────────┘
```

Steps 1–5 happen once per (portal × user). The install page is reachable through the landing at `/` (CTA "Install on your portal", picks `?portal=<host>`); the final HTML page after step 5 includes paste instructions for **Claude, Cursor, and Windsurf** clients — see issue tracker for the open UX question on cross-client.

## 4. Environment variables

Added to `.env.example` (commented, optional — webhook still works without them):

```
# Bitrix24 — OAuth (Phase 3). Leave NUXT_BITRIX24_OAUTH_ENABLED=false to keep
# the webhook flow. When enabled, the webhook env vars are still read for the
# health-check tool but are not used for tenant calls.
NUXT_BITRIX24_OAUTH_ENABLED=false
NUXT_BITRIX24_OAUTH_CLIENT_ID=
NUXT_BITRIX24_OAUTH_CLIENT_SECRET=
NUXT_BITRIX24_OAUTH_REDIRECT_URL=https://prod.example.com/api/oauth/callback
NUXT_BITRIX24_OAUTH_SCOPE=user,task                  # see §2.6 — update when tools grow
NUXT_BITRIX24_OAUTH_DB_DIR=/data                      # mounted volume; see §10 + docker-compose. Filename `oauth.sqlite` is fixed in code (decided 2026-06-04 — operator picks the dir, not the file name; the dir conventionally holds future OAuth artefacts too)
```

`NUXT_BITRIX24_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` come from the Bitrix24 marketplace application registration. `_REDIRECT_URL` must exactly match what is registered on the Bitrix24 side. `_DB_DIR` points at the directory on a named docker volume that will hold `oauth.sqlite` — `docker-compose.yml` and `docker-compose.example.yml` declare `bx24_data:/data` for this (the audit log from #67 lives in the same volume under `audit/`).

## 5. Token store — SQLite

**Why SQLite-on-disk:**

- Single dependency (`better-sqlite3`), no new container, no network hop.
- Sync API — fits inside the MCP request path without forcing every tool to become async-aware about token resolution.
- File on a Docker volume — trivial to back up (`cp oauth.sqlite oauth.sqlite.bak`), trivial to inspect (`sqlite3 oauth.sqlite '.dump'`).
- The deployment is already single-instance on `nginx-proxy` (see `docker-compose.yml`); HA was never on the table for MVP.

**Build cost.** `better-sqlite3` is a native module (`node-gyp` compile at install). Dockerfile becomes multi-stage: build stage gets `build-base` / `python3` / `make`; runtime stage keeps only the compiled `.node` artefact. GH Actions runners (ubuntu-latest) already have these. Renovate patch bumps trigger a native rebuild — added ~20 s to CI Build job per bump, acceptable.

**I/O latency.** `better-sqlite3` blocks the Node event loop for the duration of every query. Fast under normal load (WAL reads in microseconds on local SSD) but pathologically slow on NFS / throttled Docker volumes / network-mounted storage. Operators MUST mount `NUXT_BITRIX24_OAUTH_DB_DIR` on local SSD or `tmpfs`-with-periodic-flush, not on a shared network volume. Documented in §10 upgrade runbook.

**Schema (initial):**

```sql
CREATE TABLE oauth_tokens (
  member_id        TEXT NOT NULL,           -- Bitrix24 portal identifier (stable across renames)
  user_id          INTEGER NOT NULL,        -- Bitrix24 user id on that portal
  portal_domain    TEXT NOT NULL,           -- e.g. "acme.bitrix24.com" (informational; can change)
  access_token     TEXT NOT NULL,
  refresh_token    TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,       -- unix seconds
  scope            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (member_id, user_id)          -- one row per (portal × user); N portals × M users
);

CREATE TABLE mcp_tokens (
  bearer_hash      TEXT PRIMARY KEY,        -- sha256 of the Bearer; raw value never persisted
  member_id        TEXT NOT NULL,
  user_id          INTEGER NOT NULL,
  label            TEXT,                    -- user-supplied "MacBook Claude"
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER,                 -- nullable; NULL = active
  FOREIGN KEY (member_id, user_id) REFERENCES oauth_tokens(member_id, user_id) ON DELETE CASCADE
);

CREATE TABLE oauth_state (
  state            TEXT PRIMARY KEY,        -- 32-byte hex nonce
  portal           TEXT NOT NULL,           -- allow-listed bitrix24 host
  client_id        TEXT NOT NULL,           -- pinned at install
  csrf_cookie      TEXT NOT NULL,           -- bound to user's browser session
  expires_at       INTEGER NOT NULL         -- unix seconds; 5-min TTL
);

CREATE INDEX idx_oauth_user ON oauth_tokens(user_id);
CREATE INDEX idx_mcp_member_user ON mcp_tokens(member_id, user_id);
CREATE INDEX idx_state_expires ON oauth_state(expires_at);
```

**The composite PK `(member_id, user_id)`** is intentional: one portal can have many MCP users, each with their own OAuth token row. Without it, the second user on the same portal would overwrite the first's tokens and silently impersonate them — a fundamental violation of per-user identity (the whole reason we're doing OAuth).

**Refresh strategy.** `useBitrix24OAuth(memberId, userId)` checks `access_expires_at` on every call. If expired (or expiring within 60 s), it refreshes via the SDK's `B24OAuth` refresh hook, writes the new tokens back via `UPDATE oauth_tokens` in a single transaction. On refresh failure (HTTP 400 `invalid_grant` — refresh token revoked or app uninstalled), the row is **not** deleted; `markRefreshFailed(memberId, userId)` stamps `revoked_at` only on `mcp_tokens` rows that point at *that specific* `(member_id, user_id)` pair — other users on the same portal are untouched. The MCP responds 401 to the agent with "tenant disconnected — re-authorize at /api/oauth/install".

**Locking.** `better-sqlite3` is synchronous. The token store sets `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL` explicitly in `bootstrapSchema` — neither is a SQLite default. `synchronous = NORMAL` trades `FULL` durability (survive an OS-level crash mid-write) for ≈2× write throughput; this is acceptable here because the deployment uses a local Docker volume, not NFS, and the audit log preserves the credential-mutation timeline regardless of a power-loss DB tear. Per-tenant token refresh is serialised by an in-process mutex keyed on `(member_id, user_id)`. **Known edge case:** if a `B24OAuth` instance is evicted from the LRU cache (§7) while a refresh is in flight, a concurrent call after eviction will create a second instance with its own mutex. The collision is idempotent — both refresh attempts write the same new tokens — but logs the event so we can size the LRU correctly. **Multi-process is out of scope** (single-instance deploy); a multi-replica run would need the mutex itself in SQLite.

`consumeState` uses `DELETE … RETURNING` (SQLite ≥ 3.35) so the read-and-delete is a single atomic statement — closes the TOCTOU window during a rolling Nitro restart where two processes may briefly overlap, even though intra-process concurrency is impossible with sync `better-sqlite3`.

**File permissions.** `oauth.sqlite` is created with `0600` (owner read/write only). The volume mount is narrowed to `0700` by the Nitro process on **every** start via an explicit `chmodSync(dir, 0o700)` — Linux `mkdir(2)` ignores its `mode` flag on a pre-existing directory, so without the explicit chmod the operator's volume-driver default permissions would leak through. The DB file is created by `better-sqlite3` at the process umask (typically `0644`) and narrowed to `0600` immediately after open; the race window between the two is mitigated by the parent dir's `0700` (non-owner uids in the same container can't traverse into it). The Nitro process runs as a non-root user (per `Dockerfile`); only that uid can read the file from inside the container.

## 6. MCP Bearer ↔ tenant token coupling

**The hardest part.** Today there is exactly one `NUXT_MCP_AUTH_TOKEN`; everyone with that token gets every tool call. With OAuth, the Bearer must identify *which* tenant the caller is.

**Chosen approach: per-user Bearer minted at install.**

- At step 5 in the flow above, the MCP generates a fresh `crypto.randomBytes(32).toString('hex')` Bearer (256 bits of entropy), stores `sha256(bearer)` + `member_id` + `user_id` in `mcp_tokens`, and presents the raw value to the user *once* with paste instructions.
- `server/middleware/mcp-auth.ts` no longer compares against a single constant when the OAuth flag is on: it yields to the toolkit middleware in `server/mcp/index.ts`, which hashes the incoming Bearer with sha256 and looks up the row via `inspectBearer(hash)` (PR-2c-bearer / #217). Match → wrap `next()` in `runWithTenant({memberId, userId, requestId}, …)`. No match → 401 with errorCode `BEARER-UNKNOWN`. Revoked row (`revoked_at IS NOT NULL`) → 401 `BEARER-REVOKED`. Active row whose `oauth_tokens` parent was deleted → 401 `BEARER-ORPHAN` (CASCADE prevents this but we log defensively).
- Tools call `useBitrix24Tenant()` which dispatches:
  - if `NUXT_BITRIX24_OAUTH_ENABLED=false` → returns the webhook singleton (`useBitrix24()`) as today.
  - if `NUXT_BITRIX24_OAUTH_ENABLED=true` → returns `useBitrix24OAuth(tenant.memberId, tenant.userId)`, where `tenant` comes from the per-request context (see §7 on `AsyncLocalStorage`).

**Why not portal-scoped Bearer (single token per portal, every user shares it):** simpler, but loses per-user identity exactly where we want it most — task authorship, "who said what" in comments, `currentUser` semantics. Defeats the point of moving off webhooks.

**Why not OIDC-style id_token in the Bearer:** Bitrix24's OAuth flow does not issue id_tokens. Rolling our own JWT is more moving parts than a DB-backed opaque token.

## 7. Code surface

**New files:**

- `server/utils/bitrix24-oauth.ts` — `useBitrix24OAuth(memberId, userId): Promise<B24OAuth>`. The function is `async` because token refresh hits HTTP; the SQLite read itself is sync via `better-sqlite3`. Cached per `(memberId, userId)` in a process-local LRU (100 entries, see §5 eviction note). Refresh logic + mutex live here. Wraps the SDK's `B24OAuth` constructor.
- `server/utils/token-store.ts` — thin wrapper over `better-sqlite3`. Functions: `getTokens(memberId, userId)`, `upsertTokens(row)`, `markRefreshFailed(memberId, userId)`, `deleteTenant(memberId, userId)`, `findByBearerHash(hash)` (hot-path lookup — filters revoked rows, returns `BearerLookup | undefined`), `inspectBearer(hash)` (middleware lookup — does NOT filter revoked, returns `BearerInspection | undefined` carrying `revokedAt` so the caller can tell `bearer-unknown` from `bearer-revoked`; added in PR-2c-bearer #217), `createMcpToken(memberId, userId, label)`, `revokeMcpToken(bearerHash)`, `createState(...)`, `consumeState(state)`, `pruneExpiredStates()`, `listMcpTokens(memberId, userId)` (active Bearers for a tenant, newest-first — used by the `bx24mcp_list_sessions` operator tool; returns `bearerHashPrefix` not the full hash; landed with issue #212). No ORM, prepared statements only.
- `server/utils/bitrix24-tenant.ts` — `useBitrix24Tenant(): TypeB24`. Reads the per-request tenant context from `AsyncLocalStorage`. The dispatcher tools use. `TypeB24` is the SDK-exported structural interface that both `B24Hook` and `B24OAuth` implement (confirmed against `@bitrix24/b24jssdk@1.1.2` `.d.ts` — see "Typing" below), so no union and no local alias are needed.
- `server/utils/request-context.ts` — `AsyncLocalStorage<TenantContext>` and `runWithTenant(ctx: TenantContext, fn)` helper. The MCP middleware wraps every request body in this context so tool handlers (which do not receive `event` from `@nuxtjs/mcp-toolkit`) can still resolve the tenant. The `TenantContext` shape is `{ memberId, userId, requestId? }` — `requestId` is an **optional** 16-byte hex correlation id introduced by PR-2d as forward-compat for §11's observability contract; PR-2c populates it inside the middleware wrap, but the field stays optional so test fixtures that construct `TenantContext` with just `{memberId, userId}` keep compiling. PR-2c should also ship a `getRequestId(): string` helper that throws when the field is `undefined` — that's the runtime guard against "middleware not wired" bugs sliding into staging unseen.
- `server/api/oauth/install.get.ts` — generates `state`, validates `?portal=` against an allow-list regex (see §8), sets a first-party `SameSite=Lax` CSRF cookie, redirects to `https://<portal>/oauth/authorize/?client_id=…&state=…&redirect_uri=…&scope=<NUXT_BITRIX24_OAUTH_SCOPE>`. As an operator-UX convenience, a browser (`Accept: text/html`) hitting the route with no `?portal=` gets a tiny HTML landing form instead of the JSON 400 (the form's GET submission re-enters the same handler with `?portal=` filled in). CLI callers without `text/html` in their `Accept` header — `curl`, MCP probes, the docker-smoke script — keep the byte-identical JSON **body and status code** (the response now also carries `X-Frame-Options: DENY` and a strict CSP, even on JSON throws — uniform contract); behind-the-scenes the rate-limit middleware (#221) skips landing-form renders (no `?portal=`) so F5-ing the form cannot self-ban the operator from the very page they're using.
- `server/api/oauth/callback.get.ts` — verifies `state` matches the cookie + portal + client_id, consumes it, exchanges `code` for tokens, upserts `oauth_tokens`, mints a `mcp_tokens` row, renders a minimal HTML page with the Bearer + paste instructions. Sends `Cache-Control: no-store, no-cache` + `Pragma: no-cache`.
- `server/plugins/oauth-schema.ts` — runs `CREATE TABLE IF NOT EXISTS` on Nitro startup when `NUXT_BITRIX24_OAUTH_ENABLED=true`.

**Changed files:**

- `server/middleware/mcp-auth.ts` — Bearer comparison routes through the token store when OAuth is enabled; otherwise behaves exactly as today. The single-token webhook path stays so dev / webhook deployments don't break. Wraps the request in `AsyncLocalStorage` context.
- `server/utils/sdk-helpers.ts` — `callV3`, `callV2`, `batchV3` are reparameterised from `b24: B24Hook` to `b24: TypeB24`. Mechanical widening (4 helper signatures); no behaviour change, ships independently of PR-2.
- All tools in `server/mcp/tools/**` — replace `useBitrix24()` with `useBitrix24Tenant()`. Mechanical, one line per tool, three sub-PRs (tasks / checklists / meta) to keep blast radius small (§10 PR-4 split).

**Unchanged:** `server/utils/logger-redactor.ts` is **extended** in PR-3, not unchanged — see §8.

### Typing — resolved by upstream `TypeB24`

`@bitrix24/b24jssdk@1.1.2` already exports the structural interface we need:

```ts
declare abstract class AbstractB24 implements TypeB24 { ... }
declare class B24Hook  extends AbstractB24 implements TypeB24 { ... }
declare class B24OAuth extends AbstractB24 implements TypeB24 { ... }
```

`TypeB24` covers the full surface tool handlers touch — `auth`, `actions.v3.*`, `actions.v2.*`, `tools`, `init/destroy`, `get/setLogger`, `getTargetOrigin*`. The OAuth-only methods (`setCallbackRefreshAuth`, `setCustomRefreshAuth`, `initIsAdmin`, `offClientSideWarning`) live on `B24OAuth` and are used only in the factory layer (`server/utils/bitrix24-oauth.ts`), never inside handlers.

The migration on our side is one mechanical change: replace `b24: B24Hook` with `b24: TypeB24` in `server/utils/sdk-helpers.ts` (4 signatures). `useBitrix24()` keeps returning `B24Hook`; `useBitrix24OAuth()` returns `B24OAuth`; `useBitrix24Tenant()` returns `TypeB24` and dispatches between them. No union, no local alias, no upstream PR.

### Event reachability in tool handlers — resolved by `mcp-toolkit` middleware

`@nuxtjs/mcp-toolkit`'s `defineMcpTool` handler signature is `async ({ input }) => …` — the h3 `event` is *not* passed through. The solution is `AsyncLocalStorage`, plugged in via the toolkit's first-class `middleware` hook on `defineMcpHandler` (typed `McpMiddleware`, see `@nuxtjs/mcp-toolkit/dist/runtime/server/mcp/definitions/handlers.d.ts` L46 and the dispatcher at `dist/runtime/server/mcp/utils.js` L191-209):

```ts
// server/mcp/index.ts (new file in PR-2)
import { defineMcpHandler } from '@nuxtjs/mcp-toolkit/server'
import { tenantContext, resolveTenantFromBearer } from '~/server/utils/request-context'

export default defineMcpHandler({
  middleware: async (event, next) => {
    const ctx = await resolveTenantFromBearer(event)   // SQLite lookup
    return tenantContext.run(ctx, () => next())
  },
})
```

`useBitrix24Tenant()` (no args) reads `tenantContext.getStore()`.

Confirmed empirically by `tests/unit/als-propagation.test.ts` (spike for #60, five cases including N=20 concurrent-call cross-tenant leak protection). The toolkit's `middleware → next() → handler()` chain is plain `await` (no `setImmediate`, no Worker, no event-emitter hop), and the MCP SDK transport preserves ALS across dispatch — verified by sending two concurrent `tools/call` requests each in its own ALS scope and reading back distinct values.

## 8. Security

1. **Bearer raw value is shown once.** After the install page, only `sha256(bearer)` is in the DB. Loss → user re-authorizes (cheap). No password-reset flow. The callback HTML response sends `Cache-Control: no-store, no-cache` and `Pragma: no-cache`; the Bearer is never embedded in any URL (only in the HTML body).
2. **`state` CSRF guard — bound, not just random.** The `state` is a 32-byte hex nonce **persisted in the `oauth_state` table** with a 5-minute TTL. It is bound to:
   - The portal host (`?portal=` from `/install`).
   - The `client_id` (so a state generated against one Bitrix24 app cannot be replayed against another).
   - A first-party `SameSite=Lax; HttpOnly; Secure` CSRF cookie set on `/install` and validated on `/callback`.

   The callback rejects (400) any state that fails any of the three bindings. Persisting state in SQLite (not in process memory) means in-flight authorize flows survive process restarts during deploys.
3. **Portal allow-list.** The `?portal=` query parameter is validated against `PORTAL_ALLOW_LIST_RE` (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bitrix24\.(com|ru|eu|de|by|kz|ua)$`) before any redirect. Anything else returns 400. Prevents the install endpoint from being used as an open redirector. Since issue #220 the regex lives in `server/utils/portal-validation.ts` and is **shared** by `install.get.ts`, `callback.get.ts` (validating the exchange-response `domain`), and the refresh path in `bitrix24-oauth.ts` — one rule, three Bitrix24-facing surfaces, so they cannot drift. The same module's `validateClientEndpoint` / `validateServerEndpoint` guard the `client_endpoint` / `server_endpoint` URLs the SDK consumes on refresh (HTTPS-only, no userinfo, no non-standard port, hostname must match the stored portal / a known central OAuth host).
4. **Redirect URI** is locked at the Bitrix24 app level *and* re-checked server-side against `NUXT_BITRIX24_OAUTH_REDIRECT_URL`.
5. **Constant-time Bearer comparison is gone — by design.** The middleware looks up `sha256(bearer)` in SQLite. A DB lookup is not constant-time (existence-vs-not-exists differs in WAL hit / miss). The trade-off is explicit: 256 bits of entropy in the Bearer (from `crypto.randomBytes(32)`) makes a timing oracle on existence statistically irrelevant. If a future audit disagrees, the mitigation is to perform the lookup unconditionally and constant-time-compare the result against a sentinel.
6. **SHA-256 brute-force at rest.** SHA-256 is fast; a DB exfiltration combined with low-entropy Bearers would be brute-forceable on GPU. Mitigation is upstream entropy: `crypto.randomBytes(32)` ≥ 256 bits. Threat model documented in `docs/SECURITY.md` once it lands (issue #50 follow-up).
7. **Refresh tokens at rest in SQLite are plaintext** for v1. Encryption is a tracked follow-up — see §12. The webhook secret today is also plaintext in `.env` / `runtimeConfig`, so v1 is no worse than the current bar. File permissions, volume mode, container user are tightened in §5.
8. **Logger redactor extension.** The existing `WEBHOOK_URL_RE` in `server/utils/logger-redactor.ts` matches the `/rest/<userId>/<secret>/` shape — it does **not** catch OAuth URLs (`?code=…`, `?refresh_token=…`, `?client_secret=…`). **PR-2c** extends the redactor with an `OAUTH_URL_RE` (or query-param-level scrubbing) and pins both with unit tests (§9 + the redactor invariant in §11). The numbering changed during rollout: the original plan parked the redactor in PR-3, but §11 made the redactor a pre-condition for any OAuth log line, so it lands together with the handlers that produce those lines. Until then, callback and refresh handlers must not log the raw URL — only `member_id`, `user_id`, and the bare event name (`oauth.exchange.ok`, `oauth.refresh.fail`, etc.).
9. **CORS.** `/api/oauth/install` and `/api/oauth/callback` are first-party (the user clicks a link in their own browser). No `Access-Control-Allow-Origin: *`. No `OPTIONS` handler.
10. **GitHub Security Advisories** stays the disclosure channel; see `docs/SECURITY-AUDIT.md`.

## 9. Tests

**Unit (new, all in `tests/unit/`):**

- **`token-store.test.ts`** — full CRUD against in-memory SQLite (`new Database(':memory:')`): `upsertTokens` idempotency, composite-PK uniqueness for `(member_id, user_id)`, `findByBearerHash` lookups for found / not-found / revoked / orphan-row (CASCADE wiped `oauth_tokens` but `mcp_tokens` somehow survived), `markRefreshFailed(memberId, userId)` stamps `revoked_at` only on rows matching *both* fields (other users on same portal untouched), `createState` / `consumeState` honour TTL.
- **`bitrix24-oauth.refresh.test.ts`** — expiry detection (now+60s window), refresh success path writes new tokens in one transaction, refresh failure (`invalid_grant`, network error, 5xx) calls `markRefreshFailed` and propagates 401 upward.
- **`bitrix24-oauth.race.test.ts`** — `Promise.all([10× useBitrix24OAuth(same memberId, same userId)])` with an expired token: stub HTTP refresh counts calls; expected count = 1; all 10 promises resolve with the same access_token. Validates the per-`(member_id, user_id)` mutex.
- **`mcp-auth.test.ts`** — middleware behaviour with `OAUTH_ENABLED=true`: (a) unknown Bearer → 401; (b) revoked Bearer (`revoked_at IS NOT NULL`) → 401; (c) orphan Bearer (no matching `oauth_tokens` row) → 401; (d) valid Bearer → tenant context populated. Same suite with `OAUTH_ENABLED=false` confirms the single-token webhook path is unchanged.
- **`oauth-install.test.ts`** — `?portal=javascript:alert(1)` → 400; `?portal=evil.example.com` → 400; `?portal=acme.bitrix24.com` → 302 with valid state + cookie. CSRF cookie attributes: `SameSite=Lax; HttpOnly; Secure`.
- **`oauth-callback.test.ts`** — HTTP mocked via `msw`: `code` reuse (`invalid_grant`) → 400, 5xx from Bitrix24 → 502, success → 200 with Bearer in HTML body and `Cache-Control: no-store` header. State mismatch (wrong cookie / wrong portal / wrong client_id) → 400. HTML escaping: `?portal=` injection cannot reach the rendered Bearer page.
- **`logger-redactor.oauth.test.ts`** — `makeRedactingLogger` scrubs `code=`, `client_secret=`, `refresh_token=`, `access_token=` query params from OAuth-shaped URLs. Pins the regex on three concrete URL fixtures.

**Integration (`tests/integration/oauth.test.ts`):**

- Gated behind `NUXT_BITRIX24_OAUTH_TEST_*` env vars; uses a real Bitrix24 local-app on the test portal. Optional, like the existing webhook integration suite. Round-trip: install → mock browser follow → callback → mint Bearer → call `bitrix24_current_user` via `/mcp` → assert user identity matches the portal account.

**HTTP mocking dependency.** No HTTP mock library is in `package.json` today. **PR-2c adds `msw` as a devDependency** (Node-handler mode, no monkey-patching). The choice is documented here; reviewers expect it.

**Eval layer.** Tool-selection evals are unchanged but must run with `NUXT_BITRIX24_OAUTH_ENABLED=false`. If the flag default ever flips to `true`, a dedicated eval pass with OAuth fixtures is added.

**CI matrix.** `package.json` gains two test scripts: `test:unit:webhook` (`NUXT_BITRIX24_OAUTH_ENABLED=false vitest run`) and `test:unit:oauth` (`NUXT_BITRIX24_OAUTH_ENABLED=true vitest run`). The CI `Unit tests` job runs both sequentially; failure in either fails the job.

## 10. Rollout

This sequence is **strictly ordered**. Every step except the last is reversible by flipping `NUXT_BITRIX24_OAUTH_ENABLED` back to `false`.

The actual landed order **inverts** the original PR-2/PR-3/PR-4 plan after PR-2a — the tool-catalogue swap was promoted ahead of install/callback because the dispatcher's flag-off branch makes the swap a behavioural no-op, so doing it first kept the install/callback PR's diff focused. Both numbering schemes are used in this doc; treat them as aliases:

| Plan | Landed | What |
|---|---|---|
| PR-1 | merged | design doc (this file) |
| PR-2 | PR-2a (#209) | scaffolding (dispatcher, ALS, env, deps) |
| —    | PR-2b (#210) | token store (SQLite, audit-first) |
| PR-4 | PR-2d (#213) | tool-catalogue swap to `useBitrix24Tenant()` |
| PR-3 | **PR-2c** (#216) | install/callback routes + B24OAuth factory + refresh + logger-redactor extension + `pruneExpiredStates` scheduler + `/api/oauth/_health` (§11). **Bearer middleware → split out** (see below). |
| —    | PR-2c-bearer (#217) | Bearer middleware: `Bearer → inspectBearer → runWithTenant({memberId, userId, requestId})` on `/mcp` via `server/mcp/index.ts`'s `defineMcpHandler({ middleware })`. Three §11 deny branches (bearer-unknown / -revoked / -orphan) each with a distinct errorCode + `WWW-Authenticate` header. **This is the last wire.** After this lands the OAuth flow is end-to-end usable. |
| PR-5 | #219 | operator docs (README + DEPLOYMENT.md OAuth section + finalized `.env.example` + migration warning). Completes the rollout. |

1. **PR-1 (this PR):** design doc only. See frontmatter.
2. **PR-2a (#209):** scaffolding behind `NUXT_BITRIX24_OAUTH_ENABLED=false`. New files compile, new env vars in `.env.example` (rebased on top of #49's `.env.example` changes — PR-2a ships only OAuth-specific lines, no overlap with stdio config), dispatcher in `bitrix24-tenant.ts`, `AsyncLocalStorage` plumbing in `request-context.ts`, `B24Client` type alias and `sdk-helpers.ts` reparameterisation. Tools still hit the webhook path because the flag is off. Zero behaviour change for existing deployments. `docker-compose.yml` and `docker-compose.example.yml` get a `volumes:` section for `oauth_data:/data`.
3. **PR-2b (#210):** SQLite token store + Nitro schema-bootstrap plugin behind the same flag. Three tables (`oauth_tokens`, `mcp_tokens`, `oauth_state`), audit-first invariant on every mutation, `consumeState` atomic via `DELETE … RETURNING`. Builder stage adds `python3 make g++` for `better-sqlite3`. Zero runtime impact when the flag is off.
4. **PR-2d (#213, this PR):** swap `useBitrix24()` → `useBitrix24Tenant()` across the whole tool catalogue (`server/mcp/tools/**` + `server/utils/{task-lifecycle,checklist}.ts`). Behaviourally a no-op while the flag is off — the dispatcher returns the same webhook singleton. Ships before PR-2c so PR-2c's review focuses purely on the install/callback diff. Originally numbered PR-4a/4b/4c (per-domain split); the split is collapsed because flag-off ⇒ zero blast radius. Adds `tests/_setup.ts` (Nuxt-autoimport stubs) and a new `§11 Observability/debugging` design section anchoring PR-2c's logging contract.
5. **PR-2c (#216):** install + callback routes, `useBitrix24OAuth(memberId, userId)` factory with a process-local LRU cache + refresh-on-expiry, logger-redactor OAuth extension (`OAUTH_URL_RE` + `OAUTH_JSON_RE`), `/api/oauth/_health` endpoint per §11, `pruneExpiredStates` `setInterval` scheduler (closes #211), `getRequestId()` strict accessor (closes #214). Fetch is mocked in tests via `vi.stubGlobal('fetch', …)` (no `msw` dependency added — one fetch site didn't justify it). Still flag-gated. Between #216 and #217, an operator could complete `/install → /callback` and receive a Bearer, but `/mcp` still authenticated with `NUXT_MCP_AUTH_TOKEN` — the callback HTML page warned the user about this with a yellow "⚠ Not active yet" banner. PR-2c-bearer (#217, step 6 below) removed that banner once `/mcp` started accepting the Bearer.

6. **PR-2c-bearer (#217):** Bearer middleware on `/mcp` via `server/mcp/index.ts`'s `defineMcpHandler({ middleware })`. Extracts `Authorization: Bearer`, hashes with sha256, resolves through the new `TokenStore.inspectBearer` verb (which distinguishes the three `mcp.auth.deny.bearer-*` branches), and on the happy path wraps `next()` in `runWithTenant({memberId, userId, requestId}, …)`. Every 401 carries a `WWW-Authenticate: Bearer error="invalid_token", errorCode="…"` header. `server/middleware/mcp-auth.ts` early-returns when the flag is on so the toolkit middleware owns auth. **This is the last wire**: after #217 the OAuth flow is end-to-end usable.
7. **PR-4 split (deferred / cherry-pick on demand):** if PR-2d's review surfaces a real domain-specific concern, the swap can be cherry-picked into:
   - **PR-4a** — tasks domain (`bitrix24_create_task`, `*_list_tasks`, `*_update_task`, lifecycle, results, comments). Swap `useBitrix24()` → `useBitrix24Tenant()`.
   - **PR-4b** — checklists domain.
   - **PR-4c** — users + meta (`bitrix24_current_user`, `bitrix24_find_user`, `bx24mcp_submit_feedback` *not changed* — see §2 non-goals).

   Each sub-PR ships its own integration smoke. If any sub-PR breaks, the flag stays off and the others can still merge.
8. **PR-5 (operator docs):** update README, `.env.example` (final form), `docs/DEPLOYMENT.md` (from #49). Soften the "service user" recommendation to "service user OR OAuth — see OAUTH-DESIGN.md". Webhook stays as fallback indefinitely. **Must include:** an explicit `⚠ NUXT_MCP_AUTH_TOKEN is bypassed on /mcp when NUXT_BITRIX24_OAUTH_ENABLED=true` migration note — operators who used the legacy token for /mcp need to migrate clients to Bearer auth BEFORE flipping the flag.

**Upgrade runbook for existing webhook deployments** (operator-facing, lands in PR-5 in long form, summarised here):

1. Register a marketplace application on your Bitrix24 portal; record `CLIENT_ID` and `CLIENT_SECRET`.
2. Mount a persistent volume at `/data` (or wherever `NUXT_BITRIX24_OAUTH_DB_DIR` points). Confirm it is on local SSD, not NFS.
3. Set the OAuth env vars in `.env` (or your secrets manager).
4. Restart with `NUXT_BITRIX24_OAUTH_ENABLED=true`.
5. Each end user visits `https://<your-mcp>/api/oauth/install?portal=<theirportal>`, completes authorize, copies the Bearer into their Claude / Cursor / Windsurf connector.
6. Old `NUXT_MCP_AUTH_TOKEN` continues to work for the webhook path during transition; remove it from each client when the user has migrated.
7. Rollback: `NUXT_BITRIX24_OAUTH_ENABLED=false` + restart. SQLite file stays on disk; nothing is lost. Audit-log JSONL entries emitted during the enabled period (`oauth.upsert`, `mcp.create`, `mcp.revoke`, `oauth.delete`) persist under `NUXT_AUDIT_DIR` after rollback — by design (the credential-mutation timeline is the whole point of the audit log). A SOC analyst inspecting the log post-rollback will see events that no longer correspond to live DB rows; this is intentional, not corruption.

## 11. Observability / debugging (PR-2c contract)

OAuth failure modes are operator-debuggable only if every reject/throw lands a *single, grep-able, structured log line* that names the cause and a *user-visible error code* on the rendered HTML. Both PR-2c and the future operator-facing tooling (issue #212) inherit this contract — without it, "Bearer doesn't work" support tickets degenerate into a tail-the-logs guessing game.

**Logging spine (PR-2c implementation).**

- Every OAuth code path threads a per-request `requestId` (16-byte hex, generated at MCP middleware entry) through ALS alongside the tenant context (`server/utils/request-context.ts` already owns the AsyncLocalStorage scope from PR-2a; PR-2d extended `TenantContext` with the optional `requestId?: string` field as forward-compat). Every log line emitted inside that scope carries `requestId` automatically via a logger child binding, so a single curl-paste-into-jq retrieves the whole timeline. **Visibility caveat:** the structured logger writes to STDOUT, which means `docker logs`, the container runtime, log-shippers (Fluent Bit, Vector), and any aggregator (ELK, Datadog, Loki) downstream all see `requestId`, `memberId`, `userId`, and `event` — operator-visible in practice means "anyone with read access to the log pipeline". This is appropriate for the use case (forensic timeline) but MUST be acknowledged when sizing the access matrix; the audit-log JSONL (PR-2b) lives under tighter file perms (`0640`, parent `0750`) and is the canonical persistence layer for compliance, not stdout.
  ```sh
  jq -r 'select(.requestId == "a1b2…") | "\(.ts) \(.level) \(.event) \(.subject // "")"' nuxt.log
  ```
- Every OAuth event uses a stable `event: '<area>.<action>.<outcome>'` field — not free-text. The taxonomy below is kept in lockstep with the handlers; an entry without a "(deferred)" note is emitted by code that's already merged.

  Install (`/api/oauth/install`):
  - `oauth.install.start` (INFO, emitted on every request that REACHES the portal allow-list check — so it follows the flag-off / not-configured gates but precedes the regex check. Logs `portal` (sanitised + 253-capped) and `clientId`. **NOT** emitted on FLAG-OFF, NOT-CONFIGURED, or the browser landing-form render — those return early)
  - `oauth.install.deny.flag-off` (WARN — `NUXT_BITRIX24_OAUTH_ENABLED=false`)
  - `oauth.install.deny.not-configured` (ERROR — flag on but `CLIENT_ID`/`REDIRECT_URL` missing)
  - `oauth.install.deny.portal-format` (WARN — `portal` failed the allow-list regex, which covers BOTH a malformed hostname and an unlisted TLD; there is no separate `portal-host` event — the single regex is the one gate)
  - `oauth.install.landing` (DEBUG, browser landing form — emitted when a browser (`Accept: text/html`) hits `/api/oauth/install` with no `?portal=` and we render the tiny HTML form. Quiet on purpose; doesn't mint state or set cookies, so it doesn't belong in INFO. Carries `ip` and `clientId` (marketplace app id — public, not a secret). Useful as a soft signal: a spike of `landing` events with no following `oauth.install.start` from the same IP suggests users opening the page and bouncing — could be a copy-paste issue with the URL in operator docs. The landing render is **excluded from the per-IP rate-limit** middleware so an operator F5-ing the form can't self-429 from the page itself; only `?portal=`-bearing submissions count toward the bucket)
  - `oauth.install.ok` (INFO — state minted, redirect issued; logs only `statePrefix`, the first 8 hex chars)
  - `oauth.install.deny.rate-limited` (WARN, issue #221 — emitted by `server/middleware/oauth-rate-limit.ts` when one source IP exceeds **10** install requests per minute; flag-gated, raw socket IP only (never `X-Forwarded-For`), process-local window. The 429 carries errorCode `RATE-LIMITED` + a standard `Retry-After` header. Behind the reference nginx proxy all external clients share the proxy's IP — the limit is then effectively global per replica, which still admits a human and still starves a flood; operators wanting finer grain add nginx `limit_req` in front. If `getRequestIP` returns `undefined` (rare — some test transports), all such requests share a single `<unknown>` bucket per route)

  Callback (`/api/oauth/callback`):
  - `oauth.callback.start` (INFO)
  - `oauth.callback.deny.flag-off` (WARN)
  - `oauth.callback.deny.not-configured` (ERROR)
  - `oauth.callback.deny.params-missing` (WARN — `code` or `state` absent)
  - `oauth.callback.deny.state-missing` (WARN — nonce never existed; possibly a probe)
  - `oauth.callback.deny.state-expired` (INFO — TTL expiry, expected when a user abandons mid-flow; distinct from `state-missing` so the operator can tell a slow user from a probe)
  - `oauth.callback.deny.state-cookie-mismatch` (WARN)
  - `oauth.callback.state-row-corrupt` (ERROR — persisted state row had an empty csrf binding, a corrupt-DB guard → 500, not 400)
  - `oauth.callback.deny.rate-limited` (WARN, issue #221 round-3 — emitted by the same `server/middleware/oauth-rate-limit.ts` when one source IP exceeds **30** callback requests per minute; same posture as the install gate (flag-gated, raw socket IP, per-route bucket). The looser cap accommodates operator retries and browser-back without false 429s while still capping a junk-`state` flood. Surfaces the same shared errorCode `RATE-LIMITED` + `Retry-After`)
  - `oauth.callback.domain-absent` (WARN — Bitrix24 omitted `?domain=`; the portal↔callback binding can't be checked, the other three §8 bindings still hold)
  - `oauth.callback.deny.state-portal-mismatch` (WARN)
  - `oauth.callback.deny.state-client-mismatch` (WARN)
  - `oauth.callback.exchange.fail` (ERROR — `reason` is one of `network` / `non-json` / `bitrix24-error` / `bad-user-id` / `bad-member-id` / `domain-mismatch`; logs `httpStatus` + the Bitrix24 error code, NEVER the raw URL or body. `domain-mismatch` (issue #220): the exchange response `domain` failed the allow-list or disagreed with the validated `stateRow.portal` — refused before any DB write, `expected`/`got` logged truncated)
  - `oauth.callback.exchange.ok` (INFO — tokens persisted, Bearer minted; logs `bearerHashPrefix`, never the raw Bearer)

  Refresh (`useBitrix24OAuth` factory):
  - `oauth.refresh.start` (INFO) / `oauth.refresh.ok` (INFO) / `oauth.refresh.fail.invalid-grant` (ERROR) / `oauth.refresh.fail.transient` (ERROR) / `oauth.refresh.fail.tenant-deleted` (ERROR) (the `transient` bucket is network errors / 5xx / non-JSON / `domain-mismatch`; `invalid-grant` triggers `markRefreshFailed`. `domain-mismatch` (issue #220): the refresh response `domain` failed the allow-list or disagreed with the stored `portalDomain` — refused before any DB write, Bearers stay active so the user retries. `tenant-deleted` (issue #223): a concurrent `deleteTenant()` (operator uninstall) removed the `oauth_tokens` row between the SDK's expiry check and the refresh read — a benign uninstall race, NOT a revoked credential. It does **not** call `markRefreshFailed` (the CASCADE already dropped this tenant's Bearers), does **not** bump the `lastRefreshFail` health field (that signal is reserved for genuine credential-refresh failures — see `_health`), and carries its OWN event so an alert on `invalid-grant` isn't tripped by an uninstall. Distinct from `invalid-grant`, which means the refresh token itself was rejected by Bitrix24)
  - `oauth.endpoint.reject` (WARN, issue #220 — emitted by `validateClientEndpoint` / `validateServerEndpoint` in `server/utils/portal-validation.ts` when the upstream-supplied `client_endpoint` / `server_endpoint` URL fails the allow-list, carries userinfo, or specifies a non-standard port. Fields: `field` (`client_endpoint` | `server_endpoint`), `raw` (truncated to 200 chars), `expectedHost` / `expectedHosts`, `memberId`, `userId`, `reason`. **Never throws** — the safe canonical URL is substituted instead, so a single occurrence is benign but a repeated one signals an upstream anomaly worth alerting on)
  - `oauth.factory.lru.evicted` (DEBUG — LRU eviction signal so the operator can size the cache)

  Health (`/api/oauth/_health`):
  - `oauth.health.deny.flag-off` (WARN)
  - `oauth.health.deny.not-configured` (WARN — neither localhost nor admin token)
  - `oauth.health.deny.admin-token-missing` / `oauth.health.deny.admin-token-invalid` (WARN)
  - `oauth.health.ok` (INFO — counts + refresh status)

  Dispatch (`useBitrix24Tenant`, from PR-2d):
  - `oauth.tenant.dispatch.no-tenant-scope` / `oauth.tenant.dispatch.bad-user-id` (ERROR — wiring bugs)

  MCP auth middleware (`server/mcp/index.ts` — `defineMcpHandler({ middleware })`):
  - `mcp.auth.ok` (INFO — happy path, logs `memberId`, `userId`, `requestId`, `bearerHashPrefix`)
  - `mcp.auth.deny.bearer-unknown` (WARN — no `Authorization: Bearer`, or no matching `mcp_tokens` row)
  - `mcp.auth.deny.bearer-revoked` (WARN — `mcp_tokens` row exists with `revoked_at` set)
  - `mcp.auth.deny.bearer-orphan` (ERROR — `mcp_tokens` row active but `oauth_tokens` parent deleted; impossible under the CASCADE, but log defensively in case of a manual SQLite edit)
- Each `*.deny.*` and `*.fail.*` path carries an `errorCode` ≤ 32 chars, uppercased. For the `*.deny.*` events the code IS the suffix after the last dot (`oauth.callback.deny.state-cookie-mismatch` → `STATE-COOKIE-MISMATCH`, `…state-expired` → `STATE-EXPIRED`, `mcp.auth.deny.bearer-revoked` → `BEARER-REVOKED`). The `oauth.callback.exchange.fail` event is the exception: a single event name covers several distinct failure causes, so it carries a **compound** code naming the cause rather than the event suffix — one of `EXCHANGE-NETWORK`, `EXCHANGE-NON-JSON`, `EXCHANGE-FAIL`, `EXCHANGE-BAD-USER-ID`, `EXCHANGE-BAD-MEMBER-ID`, `EXCHANGE-DOMAIN-MISMATCH` (the `reason` field in the log line mirrors the code; `EXCHANGE-DOMAIN-MISMATCH` is the issue #220 defence — Bitrix24 returned a `domain` that failed the allow-list or didn't match the authorised portal). The same code is surfaced to the user in the rendered HTML on `/callback` failure and in the WWW-Authenticate header on the MCP 401 (via the middleware in `server/mcp/index.ts`), so the operator can grep logs for the exact string the user pasted into Slack. One more code follows the suffix rule but is worth calling out because it is the only **429** in the taxonomy (every other code is a 401/400/502/503) and the only one emitted from an h3 middleware rather than a route handler: `RATE-LIMITED`. It is SHARED by two distinct events — `oauth.install.deny.rate-limited` (10/min/IP) and `oauth.callback.deny.rate-limited` (30/min/IP) — both detailed in the per-event bullets above. The response carries a `Retry-After` header on both surfaces.

  Example `WWW-Authenticate` header on a 401 (RFC 6750 §3 + the §11 `errorCode` extension):
  ```
  WWW-Authenticate: Bearer error="invalid_token", errorCode="BEARER-UNKNOWN", error_description="Bearer not recognised"
  ```

**Logger redactor (PR-2c extends).**

The redactor (`server/utils/logger-redactor.ts`) already scrubs webhook URLs. PR-2c adds the OAuth surface — see §8 invariant #8. The redactor is the **only** guarantee that OAuth secrets don't reach the JSONL sink; it MUST run *before* any structured logger call inside an OAuth code path. The unit test in `tests/unit/logger-redactor.oauth.test.ts` pins fixtures for the four shapes that leak OAuth material:

  1. `logger.<level>(msg, { url: '…?code=…' })` — structured field named `url`.
  2. `logger.<level>(msg, { redirectUrl: '…?refresh_token=…' })` — same shape, different field name.
  3. `` logger.<level>(`callback failed: ${err.message}`) `` — template literal with a fetched-URL substring in `err.message` (e.g. `node-fetch` includes the URL in the message).
  4. `logger.<level>(msg, { body: JSON.stringify(response) })` — response-body field that may carry `access_token` / `refresh_token`.

The redactor walks both the message string AND every value in the structured payload (recursively for plain objects, capped at depth 4) and replaces matches of `OAUTH_URL_RE` / `OAUTH_SECRET_RE` (covering `code=`, `client_secret=`, `access_token=`, `refresh_token=`) with `[redacted]`. **Lint is a best-effort secondary defence**, not the primary one: a `no-restricted-syntax` rule flags `logger.<level>(…, { url })` and `logger.<level>(…, { redirectUrl })` literal call shapes against `?refresh_token` / `?code=` substrings, but it cannot catch the template-literal and response-body shapes (Items 3 and 4) by AST alone — those rely on the runtime redactor. PR-2c lands the redactor extension, the four fixture tests, and the lint rule together; reviewers MUST NOT accept new code that logs OAuth-shaped strings without the redactor in the call path.

**PR-2c commit ordering (enforced at review time).** Inside PR-2c the commits MUST land in this order:
1. `feat(security): extend logger-redactor for OAuth surface` — adds `OAUTH_URL_RE` / `OAUTH_SECRET_RE` + the four `tests/unit/logger-redactor.oauth.test.ts` fixtures. This commit ships ZERO OAuth-logging callers. The redactor tests go green before any caller exists.
2. `feat(auth): install + callback routes` (and subsequent) — the first commits that actually call `logger.<level>(...)` with OAuth-shaped data. The redactor is now load-bearing.

Reversing this order means a window where a reviewer is asked to accept `logger.info('oauth.callback.ok', { url: req.url })` while the redactor still passes `url` through unchanged. The reviewer can mentally redact, but a flaky test or a force-push would land the raw URL in JSONL. The ordering removes that class of mistake.

**Health surface (PR-2c implementation).**

`GET /api/oauth/_health` (operator-only) returns JSON:
```json
{
  "enabled": true,
  "tenants": 12,          // count of oauth_tokens rows
  "bearers": 47,          // count of active mcp_tokens rows (revoked_at IS NULL)
  "pendingStates": 3,     // count of oauth_state rows whose expires_at > now
  "lastRefreshOk": 1748000055,   // unix seconds, or null if no refresh yet
  "lastRefreshFail": null,
  "processStartedAt": 1748000000 // unix seconds — distinguishes "null because
                                 // just restarted" from "null, never refreshed"
}
```
**No `dbPath`** — a filesystem path is infrastructure topology that aids a post-auth attacker / a misconfigured-nginx exposure. Counts + refresh timestamps are all a readiness probe needs.
No PII, no tokens, no portal hosts in the body — counts only. The endpoint is also the readiness target for orchestrators (`kubelet`, `docker-compose healthcheck`); rolling up "is OAuth wired" into one HTTP call beats greping logs at deploy time.

**Authentication choice for `_health` — privilege separation matters.** Re-using `NUXT_MCP_AUTH_TOKEN` (the token agents present to call tools) would mean a compromised agent — prompt injection, jailbreak, leaked DXT bundle — can read fleet-level OAuth counts. The counts themselves are not PII, but the principle (agent-tier credential vs. operator-tier surface) matters. Two acceptable patterns:

  - **Network-level isolation (recommended for the reference template).** Bind the route to `127.0.0.1`-only inside the container and expose it through a separate nginx `location /api/oauth/_health` block with `allow <ops-cidr>; deny all;`. No application-level token; ops infra owns access. This is consistent with how `/metrics`-style endpoints land in most production deployments. The handler reads the **raw socket IP** (`getRequestIP(event)` with NO `xForwardedFor`), so a client-supplied `X-Forwarded-For` header cannot spoof the localhost check. **Deployment caveat:** some Nitro presets (Cloudflare, Vercel, and any custom preset that populates `event.context.clientAddress` from `CF-Connecting-IP` / `X-Forwarded-For`) would make the localhost check trust a forwarded header again. The reference `node-server` preset does NOT do this. Forks on an edge preset MUST use the admin-token mode instead of relying on localhost isolation. Loopback detection accepts the whole `127.0.0.0/8` range + `::1`.
  - **Dedicated `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` env var** if network isolation is infeasible (e.g. forks running on shared single-host setups). PR-2c documents both options in `.env.example`; the route is unreachable until ONE of them is configured (fails closed). NEVER fall back to `NUXT_MCP_AUTH_TOKEN`.

**Concrete gate — PR-2c MUST implement this, not just promise it.** "Fails closed" is a code requirement, not a doc claim. The route handler starts with:

```ts
// server/api/oauth/_health.get.ts (PR-2c)
export default defineEventHandler((event) => {
  const { oauthAdminToken } = useRuntimeConfig()
  const fromLocalhost = isLocalhostOnly(event) // 127.0.0.1 / ::1 / unix socket
  if (!oauthAdminToken && !fromLocalhost) {
    throw createError({ statusCode: 503, statusMessage: 'health endpoint not configured' })
  }
  if (oauthAdminToken && !timingSafeEqualBearer(event, oauthAdminToken)) {
    throw createError({ statusCode: 401, statusMessage: 'admin token required' })
  }
  // … return counts
})
```

CI test that pins the contract (mandatory in PR-2c's `tests/unit/oauth-health.test.ts`):
- Default config (`NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` unset, no nginx) + remote source IP → expect `503`.
- `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` set + no Bearer → expect `401`.
- `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` set + wrong Bearer → expect `401`.
- `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` set + correct Bearer → expect `200` + counts shape.

Without these tests the route ships open on first deploy.

**Operator CLI smoke (deferred to a future surface, not #212).**

Issue #212 landed as a single **MCP tool** (`bx24mcp_list_sessions`) — operator already sits in a Claude/Cursor session, asks "list my Bearers", agent calls the tool. A node CLI (`pnpm oauth:list`) opening `oauth.sqlite` read-only stays a sensible operator-tier surface but adds CLI scaffolding (argv parsing, `--member-id` / `--user-id` / `--json` flags, integration test) for a use-case the MCP tool already covers; intentionally not folded into #212 to keep that PR tight. A future issue can wrap the existing `listMcpTokens()` public function in a one-screen `scripts/oauth-list.ts`.

**Debug-level traces (`NUXT_LOG_LEVEL=debug`).**

When the level is `debug`, additional lines are emitted but ONLY in pre-prod (`NUXT_LOG_LEVEL=info` is the production default per `.env.example`):
- `oauth.install.state.created` — logs the first 8 hex chars of the state (full nonce is a secret).
- `oauth.callback.state.compare` — logs `cookieEq`, `portalEq`, `clientIdEq` booleans (NOT the values themselves).
- `oauth.refresh.cache.hit` / `…cache.miss` — logs the LRU activity for the `useBitrix24OAuth` cache so we can size it from real traffic.

**What's deliberately NOT included.**

- No Prometheus/OpenTelemetry hookup in PR-2c. The logger sink is the contract; an OTel exporter can read structured logs later. Adding the dependency now grows the runtime image and the audit surface for no v1 win.
- No per-tenant "audit my session" tool. Operators have `/api/oauth/_health` for fleet-level visibility and the audit JSONL for per-user trails; per-tenant introspection is the `bitrix24_revoke_my_session` follow-up in §12.

## 12. Future hardening

Tracked as separate GitHub issues opened when this PR merges. Items marked **P1-pre-enterprise** must land before any enterprise pilot announcement; the rest are best-effort.

- **P1-pre-enterprise.** Audit log of every `oauth_tokens.upsert` / `mcp_tokens.create` / `revoke`, surfaced as a JSONL file under `/data/audit/` for compliance use cases (GDPR data-subject requests, SOC2 access logs).
- **P1-pre-enterprise.** Encryption at rest of refresh tokens (envelope encryption: per-deploy key from KMS / `age` / OS keychain; SQLite cell encryption is the implementation detail).
- HA store (Postgres or Redis behind a `TOKEN_STORE_DRIVER` env var) — only when multi-instance is on the table.
- A `bitrix24_revoke_my_session` MCP tool that lets the agent self-revoke its own Bearer (graceful logout from Claude).
- Multi-Bearer-per-user (one per device), already supported by the schema; UI in the install page is just "Generate another token".
- Refresh-token rotation on every use (RFC 6749 §10.4 best practice).

## 13. Open questions

All PR-2-blocking questions are resolved (moved to the list below). Remaining items are non-blocking.

1. **Install URL discovery.** Lands on the existing landing at `/` (`app.vue`) as a "Connect your Bitrix24" CTA that picks `?portal=<host>` via a small form. The landing already imports `@bitrix24/b24ui-nuxt`, so the CTA is one `<B24Button>`. Tracked in the install/landing PR.
2. **`bitrix24_current_user` semantics under OAuth.** Under webhook it returns the webhook owner; under OAuth it returns the Bearer-owning user — same name, sharper semantics. One-line tool-description update in PR-4c.
3. **Sunsetting the webhook path.** Recommendation: keep it indefinitely as the dev / single-tenant / stdio fallback. README is restructured in PR-5 to lead with OAuth and present webhook as the alternate.
**Resolved (moved from open questions):**

- ~~App type — local vs marketplace.~~ Marketplace (§2.5). Local-app supported for dev/test.
- ~~Scope set.~~ `user,task` to start (§2.6, §4). Updated when tools grow.
- ~~DXT/OOB tenant-binding shape.~~ **Decision (2026-06-04): option (b) — a parallel `useBitrix24OAuthDxt()` dispatcher in `mcp-stdio/`, aliased in the stdio shim so tool handlers stay identical between HTTP and DXT.** Rejected (a) `useBitrix24Tenant(ctx?: TenantContext)` because a sync caller that forgets to pass `ctx` on the DXT path falls through to ALS, reads `undefined`, and crashes far from the cause — a silent-error-class no static analysis catches. The HTTP dispatcher `useBitrix24Tenant()` (in `server/utils/bitrix24-tenant.ts`) keeps its current ALS-only contract; the DXT-OAuth PR (after issue #207 ships) adds its own dispatcher that reads tenant from `user_config`. **Does not gate PR-2b/2c/2d** (all HTTP).
- ~~OAuth-database env-var shape — `_PATH` (file) vs `_DIR` (folder).~~ **Decision (2026-06-04): `NUXT_BITRIX24_OAUTH_DB_DIR` — operator picks the directory, the filename `oauth.sqlite` is fixed in code.** Cleaner when future OAuth artefacts (key files, encrypted exports, migration backups) land in the same directory; also matches how `NUXT_AUDIT_DIR` already works.
- ~~SDK typing — `B24Hook | B24OAuth` structural fit for `callV3` / `callV2` / `batchV3`.~~ Both classes extend `AbstractB24` and implement the SDK-exported `TypeB24` interface (`@bitrix24/b24jssdk@1.1.2`, `dist/esm/index.d.ts` L2267-2361, L4533, L5314). The full surface tool handlers touch — `auth`, `actions.v3.*`, `actions.v2.*`, `tools` — is on `TypeB24`. Migration is `s/B24Hook/TypeB24/` in `server/utils/sdk-helpers.ts` (4 signatures); no local alias, no upstream PR. See §7 "Typing — resolved by upstream `TypeB24`". Issue #59 closed as resolved.
- ~~`AsyncLocalStorage` propagation through `@nuxtjs/mcp-toolkit`.~~ Confirmed by `tests/unit/als-propagation.test.ts` (5 cases — single call, N=20 concurrent calls with cross-tenant leak guard, MISS-outside-scope sanity, setImmediate-deep-async survival, throw-path survival). The toolkit exposes a first-class `middleware` hook on `defineMcpHandler` (`McpMiddleware` in `dist/runtime/server/mcp/definitions/handlers.d.ts` L46, dispatched at `dist/runtime/server/mcp/utils.js` L191-209) — `als.run(ctx, () => next())` is the canonical seam. No toolkit fork, no explicit event-threading. See §7 "Event reachability in tool handlers — resolved by `mcp-toolkit` middleware". Issue #60 closed as resolved.
