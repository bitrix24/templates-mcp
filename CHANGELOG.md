# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — pre-1.0 minor bumps may break the API contract, see [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md).

## [Unreleased]

### Removed

- **BREAKING (tools)**: `bitrix24_find_deal` and the whole `server/mcp/tools/deals/` group are gone. CRM is out of scope for the pilot and will only return after it (see issue #128). Tool count drops from 30 Bitrix24 + 1 meta to **29 Bitrix24 + 1 meta**. The landing demo prompt's "Stalled CRM deals" section was reframed as "Stalled active tasks" so the report stays a two-table risk picture without any CRM call. CRM-flavoured examples in `sdk-helpers.ts`, `v3-filter.ts`, `update-task.ts`, `bitrix24.ts`, the agent skill, and `docs/ADDING-TOOLS.md` were swapped for task / user examples; the privacy guidance in `bx24mcp_submit_feedback` and `docs/FEEDBACK.md` still mentions CRM records as an example of data not to paste into issues.

### Changed

- **BREAKING (health payload)**: `/api/health` now returns `{ status, timestamp }` only — the `service` field was removed to avoid a fingerprintable surface. External monitors must key liveness on `status: "ok"`, not on the service name.
- `NUXT_LOG_LEVEL` is now honoured at runtime (`debug` / `info` / `notice` / `warning` (alias `warn`) / `error` / `critical` / `alert` / `emergency`); previously the level was fixed by `NODE_ENV`. Unset/unrecognised falls back to `DEBUG` in development, `INFO` otherwise. The same resolution applies in the stdio/DXT bundle.

### Security

- `/mcp` returns 503 when `NUXT_MCP_AUTH_TOKEN` is left at the `.env.example` placeholder `replace-with-secure-token`, so a copied-but-unconfigured deployment cannot be guarded by a publicly-known token.
- `bx24mcp_submit_feedback` validates the configured `owner/repo` before calling the GitHub API, and HTML-escapes the `relatedTool` field in the issue body.
- `docker-compose.yml` drops all Linux capabilities and forbids privilege escalation (`cap_drop: [ALL]`, `no-new-privileges`).

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
  - CRM deals (1, reference impl): `bitrix24_find_deal` — read-only search by title or structured filters with optional `order`, the canonical "first tool to fork".
  - Meta (1): `bx24mcp_submit_feedback` — the AI agent can file a structured GitHub issue against this repo when something is unclear.
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
