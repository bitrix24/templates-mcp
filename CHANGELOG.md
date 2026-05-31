# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — pre-1.0 minor bumps may break the API contract, see [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md).

## [Unreleased]

### Added

- **CI**: `docker-smoke` job builds the production `Dockerfile`, boots two containers — one with a fresh `openssl rand -hex 32` Bearer (port `3000`), one with the `replace-with-secure-token` placeholder (port `3001`, in parallel — avoids the kernel-port-reuse race a `docker rm -f` + same-port re-run hits on busy runners) — and pins the externally-observable HTTP contract on every PR. Assertions: `/api/health` → `200 {"status":"ok"}`, container runs as non-root (Dockerfile `USER node` regression guard), `/mcp` → `401` without an `Authorization` header, `401` with a wrong length-matched Bearer (forces the comparator to look at content, not just length), non-`401`/`403`/`503` with the configured Bearer (auth passed), and `503` on the placeholder-token boot (pins the "copied-but-not-configured" gate). Closes the bring-up + Bearer-auth slice of issue #131 — the self-hosted HTTP path had never been booted in CI.
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
