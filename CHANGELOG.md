# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — pre-1.0 minor bumps may break the API contract, see [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md).

## [Unreleased]

### Documentation

- **Docs — sweep of post-rollout audit drift (issue #225).** Eight findings resolved in `docs/`: ADDING-TOOLS walkthrough now teaches `useBitrix24Tenant()` (was `useBitrix24()` — every new contributor's first tool silently broke under OAuth); ARCHITECTURE Layers table grew the OAuth dispatcher / OAuth client / token-store rows and dropped the shipped-but-still-`TODO` parity-test note; PROJECT-BRIEF stack-table versions bumped to current (`TS 5→6`, `Nuxt 3→4`, `mcp-toolkit ^0.15→^0.17`, `mcp-sdk ^1.23→^1.29`, `pnpm 9→11`); RUNBOOK Watchtower paragraph now states monitor-only-by-default (was contradicting DEPLOYMENT.md); SECURITY-AUDIT gained a `b24ui-nuxt 2.8.0` audit pass; the localised DXT install guides (`mcp-stdio/INSTALL.{ru,pt-BR}.md`) reduced the recommended webhook scopes to `task` + `user` (had `crm` "for the future" while CRM tools were removed); MANUAL-TEST-PHRASES no longer claims "v3 throughout" (25 of 29 tools are v2); `Last reviewed: 2026-06-13` stamps inserted into ten previously-unstamped docs/skill files. Plus: closes the "no CI guard on the tenant-dispatcher invariant" gap that the docs themselves call out — new test `tests/unit/mcp-stdio/tools.tenant-guard.test.ts` fails the build if any tool under `server/mcp/tools/**` imports or calls `useBitrix24` directly instead of going through `useBitrix24Tenant()`.
- **Deps — esbuild `^0.28.0 → ^0.28.1` ([GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr), HIGH, published 2026-06-11).** Missing binary integrity verification in esbuild's Deno module enables remote code execution via a poisoned `NPM_CONFIG_REGISTRY`. Project consumes esbuild as a devDependency only (DXT/stdio build), so no production runtime exposure — but CI's `pnpm audit --audit-level=moderate` correctly blocked merge until the fix landed. Pinned in `pnpm-workspace.yaml` overrides as `esbuild: '^0.28.1'` (covers all 24 transitive paths via `@bitrix24/b24ui-nuxt` / `@nuxtjs/mcp-toolkit` / vite). Renovate carve-out (`renovate.json`) disables automerge for `esbuild` while the override is active — a human reviewer must drop the override once the transitive `vite` chain ships a fixed version on its own.

### Security

- **OAuth — public HTTP surface hardening (issue #221).** The `/callback` HTML pages (including the one displaying the freshly-minted Bearer) now carry `X-Frame-Options: DENY` + a `default-src 'none'; frame-ancestors 'none'` CSP — a same-site frame can no longer read the token off the page. `/api/oauth/install` gained a per-IP sliding-window rate limit (10/min, raw socket IP, flag-gated; 429 + `Retry-After` + §11 event `oauth.install.deny.rate-limited`) closing the `oauth_state`-flood DoS. The raw `?portal=` value is now capped at 253 chars before it reaches the structured log. The `bx24mcp_submit_feedback` quota is keyed per tenant (`memberId`) under OAuth, so one noisy tenant can't exhaust every other tenant's feedback window; webhook/stdio deployments keep the single global bucket unchanged.
- **OAuth — validate Bitrix24-returned domains/endpoints (defence-in-depth, issue #220).** Token-exchange and refresh responses from Bitrix24 now have their `domain`, `client_endpoint`, and `server_endpoint` fields validated instead of trusted verbatim. A `domain` that fails the allow-list or doesn't match the authorised portal returns `502 EXCHANGE-DOMAIN-MISMATCH` on `/api/oauth/callback` (no tokens written) and is refused on refresh (`oauth.refresh.fail.transient`, `reason: domain-mismatch`, Bearers stay active). A `client_endpoint`/`server_endpoint` URL that fails validation (wrong host, embedded userinfo, or a non-standard port) is replaced with the safe canonical URL and logged as `oauth.endpoint.reject` (WARN). Every per-tenant `B24OAuth` instance now also gets the URL-redacting logger (parity with the webhook client). New shared util `server/utils/portal-validation.ts`; blunts an upstream compromise of `oauth.bitrix24.tech` (DNS/BGP poisoning) that would otherwise redirect a tenant's REST traffic to an attacker host.
- **CI — `zizmor` workflow-security audit is now an ENFORCING gate (issue #178).** The advisory `continue-on-error` is gone: the job blocks the build on any finding in `.github/workflows/**`, pinned to `zizmor 1.25.2` with `online-audits: false` so the gate is deterministic and reproducible against a local `zizmor --offline .github/workflows/` (no surprise failures on unrelated PRs from a live advisory-DB update). The two **high `cache-poisoning`** findings were fixed by dropping the pnpm cache from the `deploy.yml` publish jobs (a shared cache key a lower-privilege branch push could poison → a poisoned published image/DXT); the residual conservative flags + one `superfluous-actions` info are annotated inline with justification. `actionlint` stays advisory pending its own triage (#179) — security findings block, syntax findings warn. Policy: [`docs/SECURITY.md` → Pre-commit & CI scans](./docs/SECURITY.md#pre-commit--ci-scans).
- **Code-quality hardening (issue #222).** The constant-time secret comparator (`timingSafeEqual`), previously copy-pasted into `mcp-auth.ts` / `_health.get.ts` / `callback.get.ts`, was consolidated into `server/utils/auth-helpers.ts` (`timingSafeEqualStr`) so the security-critical primitive can't silently diverge between call sites. The `NUXT_BITRIX24_OAUTH_DB_DIR` path-traversal guard (`resolveDbDir`) now splits on both `/` and `\`, closing a Windows-style `C:\data\..` bypass that the Linux-only `path.sep` split missed. The stdio/DXT `RuntimeConfig` shim now declares all 7 `bitrix24Oauth*` keys so it can't drift out of sync with `nuxt.config.ts`.

### Added

- **Auth — OAuth 2.0 multi-tenant (opt-in, off by default).** A staged rollout (#209, #210, #213, #216, #217) lands a per-user OAuth flow behind `NUXT_BITRIX24_OAUTH_ENABLED`: each end user authorises via `/api/oauth/install → /api/oauth/callback`, receives a per-user Bearer, and every Bitrix24 REST call runs under *their own* identity (no shared service user). Tokens are stored sha256-hashed in a SQLite store on the `bx24_data:/data` volume; an audit-first JSONL log records every credential mutation; `/api/oauth/_health` (gated by a separate `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN`) exposes operator-tier counts. With the flag **off** (the default) behaviour is byte-identical to the webhook-only path — existing deployments are unaffected. **Migration note:** when the flag is on, `NUXT_MCP_AUTH_TOKEN` is bypassed on `/mcp` (the endpoint accepts only per-user Bearers) — migrate clients before flipping it. Operator guide: [`docs/DEPLOYMENT.md` → OAuth 2.0 multi-tenant](./docs/DEPLOYMENT.md#oauth-20-multi-tenant-opt-in); design + threat model: [`docs/OAUTH-DESIGN.md`](./docs/OAUTH-DESIGN.md).
- **OAuth — browser landing form on `/api/oauth/install` (operator UX, issue #232).** A browser opening `/api/oauth/install` with no `?portal=` query now gets a small JS-free HTML form (portal-hostname field with a `PORTAL_ALLOW_LIST_RE`-mirrored `pattern` hint, the requested-scopes list, and the app `client_id` disclosed for anti-phishing) instead of a `400` — a non-technical operator no longer has to hand-craft a query string. The form submits GET back to the same handler, so the server-side allow-list remains the authoritative gate. The deny branches (FLAG-OFF / NOT-CONFIGURED / PORTAL-FORMAT) likewise render friendly HTML for browsers, with a "Start over" link on the user-recoverable one. **CLI / probe callers** (no `text/html` in `Accept` — `curl`, MCP probes, the docker-smoke script) keep the byte-identical JSON body + status contract. Strict CSP throughout (`default-src 'none'; frame-ancestors 'none'; form-action /api/oauth/install` — no scripts, no inline styles, no external assets); shared header/escape helpers extracted to `server/utils/oauth-html.ts`. New §11 event `oauth.install.landing` (DEBUG, carries `ip` + `clientId`); the per-IP rate limiter skips landing renders so an operator F5-ing the form can't 429 themselves off the page. A follow-up for optional branded styling (CSS via a CSP carve-out) is tracked in #233.
- **CI**: `docker-smoke` job builds the production `Dockerfile`, boots three containers — one with a fresh `openssl rand -hex 32` Bearer (port `3000`), one with the `replace-with-secure-token` placeholder (port `3001`), one with `NUXT_BITRIX24_OAUTH_ENABLED=true` + dummy CLIENT_ID/REDIRECT_URL + a tmpfs SQLite dir (port `3002`, issue #224) — all in parallel to avoid the kernel-port-reuse race a `docker rm -f` + same-port re-run hits on busy runners. Pins the externally-observable HTTP contract on every PR. Assertions: `/api/health` → `200 {"status":"ok"}`, container runs as non-root (Dockerfile `USER node` regression guard), `/mcp` → `401` without an `Authorization` header, `401` with a wrong length-matched Bearer (forces the comparator to look at content, not just length), non-`401`/`403`/`503` with the configured Bearer (auth passed), and `503` on the placeholder-token boot (pins the "copied-but-not-configured" gate). The new OAuth-on boot adds: `oauth-schema` plugin runs at boot without crashing, `oauth.sqlite` materialises on cold start, `/api/oauth/install` enforces the portal allow-list AND happy-path 302 with `HttpOnly`/`SameSite=Lax` CSRF cookie, `/api/oauth/callback` 400 gates fire for missing params and unknown state, `/mcp` returns 401 `BEARER-UNKNOWN` (no Bearer **and** with a random unminted Bearer — proves the toolkit-middleware lookup runs), `/api/oauth/_health` 503 `NOT-CONFIGURED` for non-localhost without an admin token (fails-closed). Closes the bring-up + Bearer-auth slice of issue #131 — the self-hosted HTTP path had never been booted in CI.
- `scripts/verify-deployment.sh` — operator-runnable version of the same smoke check, intended for use on a staging host (or production, post-promotion) since it makes no Bitrix24 REST call. **TLS verification is on by default** — pass `--insecure` only for self-signed staging hosts. Token is read from `$NUXT_MCP_AUTH_TOKEN` by default (so it never appears in `/proc/<pid>/cmdline` on shared hosts); `--token <value>` and `--token-stdin` are also accepted. Strict `jq -e '.status == "ok"'` body predicate when `jq` is on PATH, substring match otherwise. Hints distinguish `502/503/504` (proxy reaches an unhealthy upstream) from `000` (TLS / DNS / firewall) so the operator debugs the right layer first. Linked from [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md#verifying-your-deployment).
- `.env.example`: documented (commented-out) `NUXT_AUDIT_DIR` — the OAuth-only audit-log directory knob (`server/utils/audit-log.ts`, default `/data/audit/`) was readable in code but missing from the template, a drift caught by the deploy-path audit.

### Changed

- **BREAKING (tools — hard cut)**: every Bitrix24-talking tool was renamed from the old `bitrix24_<verb>_<entity>` shape to a new `b24_<domain>(_<entity>)*_<action>` convention (issue #129). **Action is always the trailing token; all tokens are singular** — including before `_list` (the dropped plural variant was reconsidered before merge; singular-everywhere is one rule with no exceptions and no irregular-plural traps like `children` / `people` when CRM and other domains land). The `bx24mcp_submit_feedback` meta-tool keeps its prefix on purpose — it does not call Bitrix24, and the distinct prefix is the operator-visible signal that the tool stays inside the MCP server with no portal data leaving. Identity shape `b24_<domain>_me` (currently only `b24_user_me`) is an allowed shape where `me` covers both entity and action; the naming guard restricts `_me` to the `user` domain to keep the prefix from drifting onto other entities without a deliberate convention update.

  Pre-pilot there are no external MCP clients yet, so this lands as a **hard cut**: no aliases, no deprecation period. Forked deployments that hard-code these tool names anywhere (Claude.ai / Cursor / Continue.dev configs, scripted clients, custom system prompts) must update to the new names. **DXT-bundle users:** the `.dxt` you installed in Claude Desktop bakes in the OLD names — delete it and reinstall the new bundle from the **Assets** section of this release's GitHub Release page so Claude sees the new names. A new `0.1.0-alpha.2` tag will be cut after this PR merges to anchor the new names as the baseline. A `tests/unit/mcp-stdio/tool-naming-convention.test.ts` CI guard fails the build if any future tool drifts from the pattern (sibling to the `mcp-stdio/**` parity test).

  Full 29-tool rename map:

  | Old | New |
  |---|---|
  | `bitrix24_create_task` | `b24_task_create` |
  | `bitrix24_list_tasks` | `b24_task_list` |
  | `bitrix24_update_task` | `b24_task_update` |
  | `bitrix24_start_task` | `b24_task_start` |
  | `bitrix24_pause_task` | `b24_task_pause` |
  | `bitrix24_complete_task` | `b24_task_complete` |
  | `bitrix24_defer_task` | `b24_task_defer` |
  | `bitrix24_renew_task` | `b24_task_renew` |
  | `bitrix24_approve_task` | `b24_task_approve` |
  | `bitrix24_disapprove_task` | `b24_task_disapprove` |
  | `bitrix24_rate_task` | `b24_task_rate` |
  | `bitrix24_add_checklist_item` | `b24_task_checklist_item_add` |
  | `bitrix24_complete_checklist_item` | `b24_task_checklist_item_complete` |
  | `bitrix24_renew_checklist_item` | `b24_task_checklist_item_renew` |
  | `bitrix24_delete_checklist_item` | `b24_task_checklist_item_delete` |
  | `bitrix24_list_checklist_items` | `b24_task_checklist_item_list` |
  | `bitrix24_add_task_comment` | `b24_task_comment_add` |
  | `bitrix24_add_task_dependency` | `b24_task_dependency_add` |
  | `bitrix24_remove_task_dependency` | `b24_task_dependency_remove` |
  | `bitrix24_add_task_result` | `b24_task_result_add` |
  | `bitrix24_update_task_result` | `b24_task_result_update` |
  | `bitrix24_delete_task_result` | `b24_task_result_delete` |
  | `bitrix24_list_task_results` | `b24_task_result_list` |
  | `bitrix24_add_elapsed_time` | `b24_task_elapsed_time_add` |
  | `bitrix24_update_elapsed_time` | `b24_task_elapsed_time_update` |
  | `bitrix24_delete_elapsed_time` | `b24_task_elapsed_time_delete` |
  | `bitrix24_list_elapsed_time` | `b24_task_elapsed_time_list` |
  | `bitrix24_current_user` | `b24_user_me` |
  | `bitrix24_find_user` | `b24_user_find` |

  > `bitrix24_find_deal` is **not** in this table — it was removed (CRM out of scope for the pilot), not renamed. See the **Removed** block below. That's why the table has 29 rows for 30 originally-shipped Bitrix24 tools.

- **BREAKING (health payload)**: `/api/health` now returns `{ status, timestamp }` only — the `service` field was removed to avoid a fingerprintable surface. External monitors must key liveness on `status: "ok"`, not on the service name.
- `NUXT_LOG_LEVEL` is now honoured at runtime (`debug` / `info` / `notice` / `warning` (alias `warn`) / `error` / `critical` / `alert` / `emergency`); previously the level was fixed by `NODE_ENV`. Unset/unrecognised falls back to `DEBUG` in development, `INFO` otherwise. The same resolution applies in the stdio/DXT bundle.
- `NUXT_LOG_LEVEL` (or its un-prefixed fallback `LOG_LEVEL`) set to a non-empty but unrecognised value (a typo like `debgu` / `infoo`) now emits a one-shot warning to **stderr** at logger init — names the variable, the bad value, the active `NODE_ENV`, and the fallback level used. The echoed value is capped at 32 chars and run through the webhook-URL redactor before leaving the process, so a variable-name mix-up (e.g. webhook URL accidentally pasted into `NUXT_LOG_LEVEL`) doesn't leak a secret to `journalctl` / `docker logs`. Stderr-only so the stdio MCP transport (which reserves stdout for JSON-RPC) stays clean. Empty / whitespace-only values stay silent (issue #137).
- **BREAKING (tool — `b24_user_find`)**: invalid input now returns `isError: true` (a thrown `Bitrix24ToolError`, code `INVALID_INPUT`) instead of a soft `{ content: [...] }` message with `isError: false` (issue #222). The two semantic-validation failures — mixing free-text `query` with structured filters, and an empty filter — now match every other tool's error protocol. Impact is limited to a client that parsed the error *text* rather than checking the MCP `isError` flag; spec-correct clients and normal agent usage are unaffected.
- **OAuth refresh — distinct `tenant-deleted` event (issue #223).** When an operator uninstall (`deleteTenant()`) removes the `oauth_tokens` row mid-refresh, the refresh now logs `oauth.refresh.fail.tenant-deleted` instead of the misleading `oauth.refresh.fail.invalid-grant`, and deliberately does **not** bump the `lastRefreshFail` field that `/api/oauth/_health` surfaces — a benign uninstall race no longer looks like a revoked credential on an operator dashboard. Runbook entry + §11 taxonomy (with INFO/ERROR levels) updated. Also closes the matching test gaps from the audit: the refresh `expires` (absolute unix-ts) branch, the `verify-deployment.sh` arg-validation paths (empty `--token-stdin`, embedded-CR/LF header-injection guard, unknown flag), `mcp-stdio/**` is now in the coverage scope, and a flaky `useFakeTimers` leak in `token-store.test.ts` is closed.

### Removed

- **BREAKING (tools)**: `bitrix24_find_deal` and the whole `server/mcp/tools/deals/` group are gone. CRM is out of scope for the pilot and will only return after it (see issue #128). Tool count drops from 30 Bitrix24 + 1 meta to **29 Bitrix24 + 1 meta** — this is the live count post-rename, superseding the historical "30 Bitrix24 MCP tools" line in the `[0.1.0-alpha.1]` section below. The landing demo prompt's "Stalled CRM deals" section was reframed as "Stalled active tasks" so the report stays a two-table risk picture without any CRM call. CRM-flavoured examples in `sdk-helpers.ts`, `v3-filter.ts`, `update-task.ts`, `bitrix24.ts`, the agent skill, and `docs/ADDING-TOOLS.md` were swapped for task / user examples; the privacy guidance in `bx24mcp_submit_feedback` and `docs/FEEDBACK.md` still mentions CRM records as an example of data not to paste into issues.

### Security

- `/mcp` returns 503 when `NUXT_MCP_AUTH_TOKEN` is left at the `.env.example` placeholder `replace-with-secure-token`, so a copied-but-unconfigured deployment cannot be guarded by a publicly-known token.
- `bx24mcp_submit_feedback` validates the configured `owner/repo` before calling the GitHub API, and HTML-escapes the `relatedTool` field in the issue body.
- `docker-compose.yml` drops all Linux capabilities and forbids privilege escalation (`cap_drop: [ALL]`, `no-new-privileges`).
- Remediated all open Dependabot/`pnpm audit` advisories. Direct: `nuxt` → `^4.4.6` (GHSA-hg3f-28rg-4jxj middleware bypass, GHSA-g8wj-3cr3-6w7v island cache poisoning, plus transitive `@nuxt/nitro-server`). Transitive deps pinned via `overrides` in `pnpm-workspace.yaml`: `tmp` `^0.2.6` (GHSA-52f5-9888-hmc6), `file-type` `^22.0.1` (GHSA-5v7r-6r5c-r473), `@fastify/static` `^9.1.1` (GHSA-pr96-94w5-mx2h), `qs` `^6.15.2` (GHSA-6rw7-vpxm-498p / CVE-2025-15284). `pnpm audit` is now a blocking CI gate (`--audit-level=moderate`).
- Bumped the reverse-proxy stack to patch upstream nginx CVEs: `nginxproxy/nginx-proxy` 1.6 → **1.11.0** (nginx 1.31.1, fixes CVE-2026-42945 "NGINX Rift" unauthenticated RCE plus six related nginx CVEs; the previous 1.27.x was inside the vulnerable 0.6.27–1.30.0 range) and `nginxproxy/acme-companion` 2.5 → **2.6.3**, both re-pinned by SHA digest. This project does **not** run the Bitrix VMBitrix `bx-nginx` package, so the 1C-Bitrix `bx-nginx` advisory does not apply directly — only the upstream nginx inside our own proxy did. Compose infra images are now kept current by Renovate's `docker-compose` manager (digest + tag, never auto-merged); see [`docs/SECURITY.md`](./docs/SECURITY.md#patching-upstream-cves-in-pinned-images).

### Changed (tooling)

- **CI no longer deploys over SSH.** The `deploy` job (SSH login + `appleboy/ssh-action`, the `rollback.env` mechanism, and all `SSH_HOST` / `SSH_USER` / `SSH_KEY` / `SSH_PORT` / `PROD_HOST` / `DEPLOY_PATH` secrets and variables) was removed, and the workflow renamed `Deploy` → **Build & publish**. CI now stops at pushing the image to GHCR; deployment is the operator's responsibility — automatic via Watchtower (`make watchtower-up`) or manual via the health-gated `make redeploy` on the host. The `dxt` job was split into `dxt-build` (`contents: read`, uploads the `.dxt` artifact) and `dxt-release` (`contents: write`, attaches it to the Release only on `v*` tags) for least-privilege. See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).
- **pnpm upgraded 10.33.4 → 11.5.0** (`packageManager`, pinned with a corepack `+sha512` integrity hash). pnpm v11 promotes `pnpm-workspace.yaml` as the canonical location for `overrides`; the Dockerfile builder stage now copies `pnpm-workspace.yaml` so `--frozen-lockfile` installs apply the overrides. Dev dependencies refreshed within their ranges (`@ai-sdk/openai`, `@commitlint/*`, `ai`, `vitest`, `vue-tsc`); `@types/node` kept on `^22` to track the Node 22 runtime.

## [0.1.0-alpha.1] - 2026-05-19

The first tagged release. Cuts a baseline anchor that ships every tool, every contract, and every operator-facing surface the template offers on day one. Footer of the landing now links here.

### Added

- **30 Bitrix24 MCP tools + 1 meta-tool** under `server/mcp/tools/`:
  - Users (2): `bitrix24_current_user`, `bitrix24_find_user` — connectivity probe and the operator-name-to-id resolver every other tool depends on.
  - Tasks core (4): `bitrix24_create_task`, `bitrix24_list_tasks`, `bitrix24_update_task`, `bitrix24_add_task_comment`.
  - Tasks lifecycle verbs (8): `bitrix24_start_task` / `_pause_task` / `_complete_task` / `_approve_task` / `_disapprove_task` / `_defer_task` / `_renew_task` / `_rate_task`.
  - Tasks checklist (5): `bitrix24_add_checklist_item` / `_list_checklist_items` / `_complete_checklist_item` / `_renew_checklist_item` / `_delete_checklist_item`.
  - Tasks results (4): `bitrix24_add_task_result` / `_list_task_results` / `_update_task_result` / `_delete_task_result`.
  - Tasks elapsed time (4): `bitrix24_add_elapsed_time` / `_list_elapsed_time` / `_update_elapsed_time` / `_delete_elapsed_time`.
  - Task dependencies (2): `bitrix24_add_task_dependency` / `_remove_task_dependency`.
  - CRM deals (1, reference impl): `bitrix24_find_deal` — read-only search by title or structured filters with optional `order`, the canonical "first tool to fork". (Removed in [Unreleased]; see "Removed" above. Post-pilot CRM tools will return under the new `b24_crm_*` namespace.)
  - Meta (1): `bx24mcp_submit_feedback` — the AI agent can file a structured GitHub issue against this repo when something is unclear.

> **Note**: every Bitrix24 tool listed above was **renamed to `b24_<domain>(_<entity>)*_<action>`** in [Unreleased] (issue #129). This section keeps the original names for historical accuracy — for the live names, see the rename table in [Unreleased] / Changed above. The `bx24mcp_*` meta-tool was not touched.
- **Bearer auth** on `/mcp` via `NUXT_MCP_AUTH_TOKEN`.
- **Public `/api/health` probe** (status / service / timestamp only — no fingerprintable version).
- **Bitrix24 SDK** wired via the official [`@bitrix24/b24jssdk-nuxt`](https://www.npmjs.com/package/@bitrix24/b24jssdk-nuxt) with `RestrictionManager` (50 burst, 2 req/sec drain, 3 retries on transient errors) and a webhook-URL redactor at the logger boundary.
- **Test scaffolding**: 389 unit tests across 46 files, an integration suite against a live test portal (`tests/integration/`), and Evalite + DeepSeek tool-selection evals (`tests/evals/`).
- **CI**: lint, typecheck, unit, integration, build, commit-message lint — all gated on every PR.
- **Renovate** for automated dependency updates with explicit policy for `@bitrix24/*` and UI deps.
- **Production deployment** via Docker + `nginx-proxy` + `acme-companion` (hands-off TLS).
- **Landing page** (`app.vue`) on `@bitrix24/b24ui-nuxt`'s `B24App` + `B24Button` primitives, with a `ProsePrompt`-driven "Show me what needs attention across my portal — right now" risk-report prompt that copies / Cursor-deeplinks / Windsurf-deeplinks the full prompt to the operator's IDE.
- **Agent skill** `skills/manage-bx24-template-mcp/` — primary entry-point for AI agents working on this repo (ground rules, when-to-do-X recipes, the new "When asked to do UI / frontend work" section pointing at b24ui's upstream llms.txt and skill).
- **Documentation**: `README.md`, `PROJECT-BRIEF.md` (project spec / source of truth), `docs/FEEDBACK.md` (LGPD / GDPR PII warning + sanitisation + operator setup), `docs/SECURITY-AUDIT.md` (webhook-URL leak audit pass for SDK 1.1.2, supply-chain audit for b24ui-nuxt 2.7.1).

### Security

- SDK webhook URL redactor at the logger boundary (`makeRedactingLogger` in `server/utils/bitrix24.ts`) — defence in depth against accidental credential disclosure in operator logs. Pinned by `tests/unit/utils/sdk-logger-leak.test.ts` and `tests/unit/utils/logger-redactor.test.ts`, both CI gates.
- `bx24mcp_submit_feedback` tool description and Zod `.describe()` carry an LGPD / GDPR PII warning — the destination GitHub repo is public; agents are instructed to report technical faults, not the data that triggered them. Documented at length in `docs/FEEDBACK.md`.
- `/api/health` returns `status` / `service` / `timestamp` only — no `version` / `build` / `commit` fingerprinting surface.
- Toolset filter / pick helpers (`toV3Filter`, defensive against LLM-controlled keys) hardened in the round preceding this release (PR #41). Note: `bitrix24_find_deal` builds its filter from statically-named keys (the LLM controls only the *values*, which are Zod-bounded), so it does not route through `toV3Filter` — that helper guards tools where the LLM supplies filter *keys*.

### Notes

- Pre-1.0 — the public contract (tool names, input schemas, response shapes) may shift before `v0.1.0` final. Subsequent alpha tags will document breaking shifts in their own changelog sections.
- The README will be rewritten for end-users at `v0.1.0` (non-alpha). Until then it serves contributors and forkers.

[Unreleased]: https://github.com/bitrix24/templates-mcp/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/bitrix24/templates-mcp/releases/tag/v0.1.0-alpha.1
