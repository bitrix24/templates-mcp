# OAuth 2.0 design — design doc, not yet implemented

> **Status: DRAFT — design only.** No code in this document is shipped. The goal of this PR is to lock the contract before any implementation lands. Implementation follows in separate PRs behind a `NUXT_BITRIX24_OAUTH_ENABLED` feature flag (off by default), so this design can land in `main` without changing runtime behaviour.
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

1. **DXT stdio transport (`mcp-stdio/` from PR #49) — deferred, not impossible.** Earlier drafts ruled this out as "fundamentally incompatible with stdio". That was wrong: Bitrix24 OAuth supports an **out-of-band (OOB) code-paste flow** for applications without a permanent address (officially documented at `apidocs.bitrix24.ru/api-reference/oauth/index.html` — "В партнерском кабинете можно зарегистрировать приложение, которое не будет иметь «обратного адреса»"). User clicks `/oauth/authorize/?client_id=…` (no `redirect_uri`), Bitrix24 shows a short `code` on its own page, user pastes the code into a DXT `user_config` field, the DXT exchanges code + `client_id` + `client_secret` for tokens on `oauth.bitrix24.tech/oauth/token/`. No callback, no loopback listener. Three caveats: (a) the code lives only 30 s — UX is paste-immediately; (b) Bitrix24 does **not** advertise PKCE in the doc, so the `client_secret` must ship inside the `.dxt` bundle (acceptable parity with the current `NUXT_BITRIX24_WEBHOOK_URL`-in-`user_config` model, but a real OAuth-best-practice smell — documented as such for forks); (c) refresh-token rotation logic must run inside the DXT process. **Deferred to a follow-up** because the v1 OAuth surface (HTTP / multi-tenant) doesn't depend on it, and `.dxt` users today get sufficient ergonomics from the webhook flow. Tracked in **issue #207** with its own design questions (chiefly: does the DXT path reuse `useBitrix24Tenant()` with an explicit context argument, or get a parallel `useBitrix24OAuthDxt()` dispatcher — see §12 Q4). The `.dxt` bundle keeps the webhook flow as its primary path indefinitely; OAuth-in-DXT lands when there's a clear customer need (e.g. service-user retirement requirement in regulated forks).
2. **High-availability multi-instance.** SQLite-on-disk assumes a single Nitro process with the volume mounted. Horizontal scale needs a different store; called out under "Future hardening".
3. **Encryption at rest of refresh tokens.** Plaintext refresh tokens in SQLite are no worse than the webhook secret in `.env` today. Encryption is tracked as a follow-up (envelope encryption with a KMS / `age` / OS keychain). **Audit log + encryption are P1-pre-enterprise-launch** — see §11.
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
NUXT_BITRIX24_OAUTH_DB_PATH=/data/oauth.sqlite       # mounted volume; see §10 + docker-compose
```

`NUXT_BITRIX24_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` come from the Bitrix24 marketplace application registration. `_REDIRECT_URL` must exactly match what is registered on the Bitrix24 side. `_DB_PATH` points at a named docker volume — `docker-compose.yml` and `docker-compose.example.yml` get a `volumes:` section in PR-2 binding `oauth_data:/data`.

## 5. Token store — SQLite

**Why SQLite-on-disk:**

- Single dependency (`better-sqlite3`), no new container, no network hop.
- Sync API — fits inside the MCP request path without forcing every tool to become async-aware about token resolution.
- File on a Docker volume — trivial to back up (`cp oauth.sqlite oauth.sqlite.bak`), trivial to inspect (`sqlite3 oauth.sqlite '.dump'`).
- The deployment is already single-instance on `nginx-proxy` (see `docker-compose.yml`); HA was never on the table for MVP.

**Build cost.** `better-sqlite3` is a native module (`node-gyp` compile at install). Dockerfile becomes multi-stage: build stage gets `build-base` / `python3` / `make`; runtime stage keeps only the compiled `.node` artefact. GH Actions runners (ubuntu-latest) already have these. Renovate patch bumps trigger a native rebuild — added ~20 s to CI Build job per bump, acceptable.

**I/O latency.** `better-sqlite3` blocks the Node event loop for the duration of every query. Fast under normal load (WAL reads in microseconds on local SSD) but pathologically slow on NFS / throttled Docker volumes / network-mounted storage. Operators MUST mount `_DB_PATH` on local SSD or `tmpfs`-with-periodic-flush, not on a shared network volume. Documented in §10 upgrade runbook.

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

**Locking.** `better-sqlite3` is synchronous and uses WAL mode by default. Per-tenant token refresh is serialised by an in-process mutex keyed on `(member_id, user_id)`. **Known edge case:** if a `B24OAuth` instance is evicted from the LRU cache (§7) while a refresh is in flight, a concurrent call after eviction will create a second instance with its own mutex. The collision is idempotent — both refresh attempts write the same new tokens — but logs the event so we can size the LRU correctly. **Multi-process is out of scope** (single-instance deploy); a multi-replica run would need the mutex itself in SQLite.

**File permissions.** `oauth.sqlite` is created with `0600` (owner read/write only). The docker volume mount is `0700`. The Nitro process runs as a non-root user (per `Dockerfile`); only that uid can read the file from inside the container.

## 6. MCP Bearer ↔ tenant token coupling

**The hardest part.** Today there is exactly one `NUXT_MCP_AUTH_TOKEN`; everyone with that token gets every tool call. With OAuth, the Bearer must identify *which* tenant the caller is.

**Chosen approach: per-user Bearer minted at install.**

- At step 5 in the flow above, the MCP generates a fresh `crypto.randomBytes(32).toString('hex')` Bearer (256 bits of entropy), stores `sha256(bearer)` + `member_id` + `user_id` in `mcp_tokens`, and presents the raw value to the user *once* with paste instructions.
- `server/middleware/mcp-auth.ts` no longer compares against a single constant: it hashes the incoming Bearer with sha256 and looks up the row via `findByBearerHash(hash)`. Match → stash `(member_id, user_id)` on a per-request context. No match (or `revoked_at IS NOT NULL`) → 401.
- Tools call `useBitrix24Tenant()` which dispatches:
  - if `NUXT_BITRIX24_OAUTH_ENABLED=false` → returns the webhook singleton (`useBitrix24()`) as today.
  - if `NUXT_BITRIX24_OAUTH_ENABLED=true` → returns `useBitrix24OAuth(tenant.memberId, tenant.userId)`, where `tenant` comes from the per-request context (see §7 on `AsyncLocalStorage`).

**Why not portal-scoped Bearer (single token per portal, every user shares it):** simpler, but loses per-user identity exactly where we want it most — task authorship, "who said what" in comments, `currentUser` semantics. Defeats the point of moving off webhooks.

**Why not OIDC-style id_token in the Bearer:** Bitrix24's OAuth flow does not issue id_tokens. Rolling our own JWT is more moving parts than a DB-backed opaque token.

## 7. Code surface

**New files:**

- `server/utils/bitrix24-oauth.ts` — `useBitrix24OAuth(memberId, userId): Promise<B24OAuth>`. The function is `async` because token refresh hits HTTP; the SQLite read itself is sync via `better-sqlite3`. Cached per `(memberId, userId)` in a process-local LRU (100 entries, see §5 eviction note). Refresh logic + mutex live here. Wraps the SDK's `B24OAuth` constructor.
- `server/utils/token-store.ts` — thin wrapper over `better-sqlite3`. Functions: `getTokens(memberId, userId)`, `upsertTokens(row)`, `markRefreshFailed(memberId, userId)`, `findByBearerHash(hash)`, `createMcpToken(memberId, userId, label)`, `revokeMcpToken(bearerHash)`, `createState(...)`, `consumeState(state)`. No ORM, prepared statements only.
- `server/utils/bitrix24-tenant.ts` — `useBitrix24Tenant(): TypeB24`. Reads the per-request tenant context from `AsyncLocalStorage`. The dispatcher tools use. `TypeB24` is the SDK-exported structural interface that both `B24Hook` and `B24OAuth` implement (confirmed against `@bitrix24/b24jssdk@1.1.2` `.d.ts` — see "Typing" below), so no union and no local alias are needed.
- `server/utils/request-context.ts` — `AsyncLocalStorage<{ tenant?: { memberId, userId } }>` and `runWithRequestContext(event, fn)` helper. The MCP middleware wraps every request body in this context so tool handlers (which do not receive `event` from `@nuxtjs/mcp-toolkit`) can still resolve the tenant.
- `server/api/oauth/install.get.ts` — generates `state`, validates `?portal=` against an allow-list regex (see §8), sets a first-party `SameSite=Lax` CSRF cookie, redirects to `https://<portal>/oauth/authorize/?client_id=…&state=…&redirect_uri=…&scope=<NUXT_BITRIX24_OAUTH_SCOPE>`.
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
3. **Portal allow-list.** The `?portal=` query parameter is validated against `^[a-z0-9-]+\.bitrix24\.(com|ru|eu|de|by|kz|ua)$` before any redirect. Anything else returns 400. Prevents the install endpoint from being used as an open redirector.
4. **Redirect URI** is locked at the Bitrix24 app level *and* re-checked server-side against `NUXT_BITRIX24_OAUTH_REDIRECT_URL`.
5. **Constant-time Bearer comparison is gone — by design.** The middleware looks up `sha256(bearer)` in SQLite. A DB lookup is not constant-time (existence-vs-not-exists differs in WAL hit / miss). The trade-off is explicit: 256 bits of entropy in the Bearer (from `crypto.randomBytes(32)`) makes a timing oracle on existence statistically irrelevant. If a future audit disagrees, the mitigation is to perform the lookup unconditionally and constant-time-compare the result against a sentinel.
6. **SHA-256 brute-force at rest.** SHA-256 is fast; a DB exfiltration combined with low-entropy Bearers would be brute-forceable on GPU. Mitigation is upstream entropy: `crypto.randomBytes(32)` ≥ 256 bits. Threat model documented in `docs/SECURITY.md` once it lands (issue #50 follow-up).
7. **Refresh tokens at rest in SQLite are plaintext** for v1. Encryption is a tracked follow-up — see §11. The webhook secret today is also plaintext in `.env` / `runtimeConfig`, so v1 is no worse than the current bar. File permissions, volume mode, container user are tightened in §5.
8. **Logger redactor extension.** The existing `WEBHOOK_URL_RE` in `server/utils/logger-redactor.ts` matches the `/rest/<userId>/<secret>/` shape — it does **not** catch OAuth URLs (`?code=…`, `?refresh_token=…`, `?client_secret=…`). PR-3 extends the redactor with an `OAUTH_URL_RE` (or query-param-level scrubbing) and pins both with unit tests (§9). Until then, callback and refresh handlers must not log the raw URL — only `member_id`, `user_id`, and the bare event name (`oauth.exchange.ok`, `oauth.refresh.fail`, etc.).
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

**HTTP mocking dependency.** No HTTP mock library is in `package.json` today. **PR-3 adds `msw` as a devDependency** (Node-handler mode, no monkey-patching). The choice is documented here; reviewers expect it.

**Eval layer.** Tool-selection evals are unchanged but must run with `NUXT_BITRIX24_OAUTH_ENABLED=false`. If the flag default ever flips to `true`, a dedicated eval pass with OAuth fixtures is added.

**CI matrix.** `package.json` gains two test scripts: `test:unit:webhook` (`NUXT_BITRIX24_OAUTH_ENABLED=false vitest run`) and `test:unit:oauth` (`NUXT_BITRIX24_OAUTH_ENABLED=true vitest run`). The CI `Unit tests` job runs both sequentially; failure in either fails the job.

## 10. Rollout

This sequence is **strictly ordered**. Every step except the last is reversible by flipping `NUXT_BITRIX24_OAUTH_ENABLED` back to `false`.

1. **PR-1 (this PR):** design doc only. See frontmatter.
2. **PR-2 (after #49 merges):** scaffolding behind `NUXT_BITRIX24_OAUTH_ENABLED=false`. New files compile, new env vars in `.env.example` (rebased on top of #49's `.env.example` changes — PR-2 ships only OAuth-specific lines, no overlap with stdio config), dispatcher in `bitrix24-tenant.ts`, `AsyncLocalStorage` plumbing in `request-context.ts`, `B24Client` type alias and `sdk-helpers.ts` reparameterisation. Tools still hit the webhook path because the flag is off. SQLite schema bootstrap runs only when the flag is on. Zero behaviour change for existing deployments. `docker-compose.yml` and `docker-compose.example.yml` get a `volumes:` section for `oauth_data:/data`.
3. **PR-3:** install + callback routes, token store CRUD, refresh logic, Bearer middleware extension, logger-redactor OAuth extension. Adds `msw` and `better-sqlite3` to dependencies. Still flag-gated. Manual end-to-end smoke against a test portal in the test plan.
4. **PR-4 (split per domain to keep blast radius small):**
   - **PR-4a** — tasks domain (`bitrix24_create_task`, `*_list_tasks`, `*_update_task`, lifecycle, results, comments). Swap `useBitrix24()` → `useBitrix24Tenant()`.
   - **PR-4b** — checklists domain.
   - **PR-4c** — users + meta (`bitrix24_current_user`, `bitrix24_find_user`, `bx24mcp_submit_feedback` *not changed* — see §2 non-goals).

   Each sub-PR ships its own integration smoke. If any sub-PR breaks, the flag stays off and the others can still merge.
5. **PR-5 (operator docs):** update README, `.env.example` (final form), `docs/DEPLOYMENT.md` (from #49). Soften the "service user" recommendation to "service user OR OAuth — see OAUTH-DESIGN.md". Webhook stays as fallback indefinitely.

**Upgrade runbook for existing webhook deployments** (operator-facing, lands in PR-5 in long form, summarised here):

1. Register a marketplace application on your Bitrix24 portal; record `CLIENT_ID` and `CLIENT_SECRET`.
2. Mount a persistent volume at `/data` (or wherever `NUXT_BITRIX24_OAUTH_DB_PATH` points). Confirm it is on local SSD, not NFS.
3. Set the OAuth env vars in `.env` (or your secrets manager).
4. Restart with `NUXT_BITRIX24_OAUTH_ENABLED=true`.
5. Each end user visits `https://<your-mcp>/api/oauth/install?portal=<theirportal>`, completes authorize, copies the Bearer into their Claude / Cursor / Windsurf connector.
6. Old `NUXT_MCP_AUTH_TOKEN` continues to work for the webhook path during transition; remove it from each client when the user has migrated.
7. Rollback: `NUXT_BITRIX24_OAUTH_ENABLED=false` + restart. SQLite file stays on disk; nothing is lost.

## 11. Future hardening

Tracked as separate GitHub issues opened when this PR merges. Items marked **P1-pre-enterprise** must land before any enterprise pilot announcement; the rest are best-effort.

- **P1-pre-enterprise.** Audit log of every `oauth_tokens.upsert` / `mcp_tokens.create` / `revoke`, surfaced as a JSONL file under `/data/audit/` for compliance use cases (GDPR data-subject requests, SOC2 access logs).
- **P1-pre-enterprise.** Encryption at rest of refresh tokens (envelope encryption: per-deploy key from KMS / `age` / OS keychain; SQLite cell encryption is the implementation detail).
- HA store (Postgres or Redis behind a `TOKEN_STORE_DRIVER` env var) — only when multi-instance is on the table.
- A `bitrix24_revoke_my_session` MCP tool that lets the agent self-revoke its own Bearer (graceful logout from Claude).
- Multi-Bearer-per-user (one per device), already supported by the schema; UI in the install page is just "Generate another token".
- Refresh-token rotation on every use (RFC 6749 §10.4 best practice).

## 12. Open questions

All PR-2-blocking questions are resolved (moved to the list below). Remaining items are non-blocking.

1. **Install URL discovery.** Lands on the existing landing at `/` (`app.vue`) as a "Connect your Bitrix24" CTA that picks `?portal=<host>` via a small form. The landing already imports `@bitrix24/b24ui-nuxt`, so the CTA is one `<B24Button>`. Tracked in the install/landing PR.
2. **`bitrix24_current_user` semantics under OAuth.** Under webhook it returns the webhook owner; under OAuth it returns the Bearer-owning user — same name, sharper semantics. One-line tool-description update in PR-4c.
3. **Sunsetting the webhook path.** Recommendation: keep it indefinitely as the dev / single-tenant / stdio fallback. README is restructured in PR-5 to lead with OAuth and present webhook as the alternate.
4. 🟡 **DXT/OOB tenant-binding shape — blocks the DXT-OAuth track (PR after #207), NOT the HTTP PR-2 series.** The HTTP path feeds the tenant into `useBitrix24Tenant()` via `AsyncLocalStorage` set by the MCP middleware (§6, §7). The stdio/DXT path has no per-request h3 scope — the tenant is fixed for the life of the process (the one user who completed the OOB paste). Two candidate shapes, **decision required before the DXT-OAuth PR opens** so the dispatcher API doesn't churn after it ships: **(a)** widen `useBitrix24Tenant(ctx?: TenantContext)` so DXT passes the stored tenant explicitly while HTTP keeps reading ALS; **(b)** a parallel `useBitrix24OAuthDxt()` dispatcher, aliased in the stdio shim so tool code stays identical. Leaning **(b)** (explicit > implicit, no "forgot the arg → silent ALS-miss" trap). Tracked in **issue #207**; this question does not gate PR-2a/2b/2c/2d (all HTTP).

**Resolved (moved from open questions):**

- ~~App type — local vs marketplace.~~ Marketplace (§2.5). Local-app supported for dev/test.
- ~~Scope set.~~ `user,task` to start (§2.6, §4). Updated when tools grow.
- ~~SDK typing — `B24Hook | B24OAuth` structural fit for `callV3` / `callV2` / `batchV3`.~~ Both classes extend `AbstractB24` and implement the SDK-exported `TypeB24` interface (`@bitrix24/b24jssdk@1.1.2`, `dist/esm/index.d.ts` L2267-2361, L4533, L5314). The full surface tool handlers touch — `auth`, `actions.v3.*`, `actions.v2.*`, `tools` — is on `TypeB24`. Migration is `s/B24Hook/TypeB24/` in `server/utils/sdk-helpers.ts` (4 signatures); no local alias, no upstream PR. See §7 "Typing — resolved by upstream `TypeB24`". Issue #59 closed as resolved.
- ~~`AsyncLocalStorage` propagation through `@nuxtjs/mcp-toolkit`.~~ Confirmed by `tests/unit/als-propagation.test.ts` (5 cases — single call, N=20 concurrent calls with cross-tenant leak guard, MISS-outside-scope sanity, setImmediate-deep-async survival, throw-path survival). The toolkit exposes a first-class `middleware` hook on `defineMcpHandler` (`McpMiddleware` in `dist/runtime/server/mcp/definitions/handlers.d.ts` L46, dispatched at `dist/runtime/server/mcp/utils.js` L191-209) — `als.run(ctx, () => next())` is the canonical seam. No toolkit fork, no explicit event-threading. See §7 "Event reachability in tool handlers — resolved by `mcp-toolkit` middleware". Issue #60 closed as resolved.
