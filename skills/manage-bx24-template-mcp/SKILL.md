# bx24-template-mcp — Agent Skill

`Last reviewed: 2026-06-14`

You are working on a Bitrix24 MCP server built on Nuxt + `@nuxtjs/mcp-toolkit`. Read this before making changes.

## Project context

- **Repo**: https://github.com/bitrix24/templates-mcp
- **Prod**: `<YOUR_PROD_URL>/mcp` — replace with your deployed instance URL
- **Stack**: Nuxt 4 (Nitro `node-server`), `@nuxtjs/mcp-toolkit`, `@bitrix24/b24jssdk-nuxt`
- **Auth to Bitrix24**: incoming webhook (default), or OAuth 2.0 multi-tenant (opt-in, landed — `NUXT_BITRIX24_OAUTH_ENABLED`)
- **Auth from Claude to us**: Bearer token via middleware
- **Deployment**: Docker behind `nginx-proxy` + `acme-companion` on shared `proxy-net` network. CI builds and pushes the image to GHCR on `v*` tag; the operator deploys via Watchtower in **monitor-only** mode by default (it notifies on a new `:latest` but does NOT restart — opt into auto-apply by removing `WATCHTOWER_MONITOR_ONLY`) or via `make redeploy` on the host (manual)
- **Dependency updates**: npm & GitHub Actions — Renovate Bot (see `renovate.json`); Dockerfile base images — Dependabot; docker-compose infra images — Renovate's `docker-compose` manager (see `renovate.json`). Transitive-dependency security advisories are patched manually via `overrides` in `pnpm-workspace.yaml` (pnpm v11 location) — Dependabot/Renovate don't open PRs for nested deps. A blocking `pnpm audit --audit-level=moderate` CI job guards against regressions.
- **License**: MIT

## Ground rules

1. **One tool per file** in `server/mcp/tools/<group>/<name>.ts`. Discovery is automatic.
2. **Never call Bitrix24 directly.** Always go through `useBitrix24Tenant()` (the OAuth-aware dispatcher in `~/server/utils/bitrix24-tenant` — see [`../../docs/OAUTH-DESIGN.md`](../../docs/OAUTH-DESIGN.md) §6). With `NUXT_BITRIX24_OAUTH_ENABLED=false` (the production default) it falls back to the webhook singleton, so behaviour is byte-identical to a direct `useBitrix24()` call. When the flag is on, the same call resolves to a per-tenant `B24OAuth` from the request-scoped ALS. **Never call `useBitrix24()` directly from a tool handler** — it bypasses the dispatcher and pins the tool to webhook forever. From the dispatcher result go through the typed helpers in `server/utils/sdk-helpers.ts`: `callV2<T>(b24, method, params, errorContext)` — the **default** for classic methods (`tasks.task.add/list/update/` + the seven lifecycle verbs, `user.*`, `task.commentitem.*`, …), `callV3<T>(…)` — **only** for methods that are v3-only (currently `tasks.task.get`, `tasks.task.result.*`), and `batchV2<T>` / `batchV3<T>(b24, calls, errorContext)` for bulk operations. See the **transport-convention block at the top of `sdk-helpers.ts`** for how to pick v2 vs v3. The helpers own the `isSuccess` / `getErrorMessages` / transport-error funnel — tool handlers stay short and uniform. Calling `b24.actions.*.{call,batch}.make` directly from a tool handler is forbidden (it duplicates that funnel and drifts over time); the deprecated `b24.callMethod` is doubly forbidden — it disappears in SDK 2.0. See [`adding-tools.md`](./adding-tools.md) for the canonical template.
3. **Every tool must have a unit test** in `tests/unit/tools/<group>/<name>.test.ts` with the Bitrix24 client mocked.
4. **Every Zod field must have `.describe()`** — the LLM reads it at runtime.
5. **No secrets in code or tests.** Use `useRuntimeConfig()` and `.env`. When you add/rename/remove a `NUXT_*` / `NITRO_*` variable, change the default port or `/mcp` endpoint, change the connector auth header name/format, alter required webhook scopes, or add a tool needing upfront-seeded portal data, also update the manual-QA scaffold at [`../run-manual-qa/references/issue-scaffold.md`](../run-manual-qa/references/issue-scaffold.md) in the same PR — it mirrors these structural facts. A CI gate enforces the `.env.example` ↔ scaffold pairing.
6. **Operators talk in names, not ids.** When a tool needs a `responsibleId` / `userId` / similar, **resolve from a name first** via `b24_user_find`. The decision tree:
   1. Run `b24_user_find { query: "<name from the operator>" }`.
   2. **0 matches** → tell the operator nobody matched and ask for a fuller name or last name.
   3. **1 match** → use that user's `id`. No further questions.
   4. **N > 1 matches** → ask the operator to disambiguate by **last name** (and `position` / `department` if last names also collide). Only ask for a numeric `id` as the **last resort** if natural-language disambiguation fails.
7. **Default to REST API v2; reach for v3 only where the method is v3-only.** Bitrix24's migration to rest-v3 is gradual and will take a long time, so classic methods (`tasks.task.add/list/update/` + the seven lifecycle verbs, `user.*`, `task.commentitem.*`, `task.checklistitem.*`, `task.elapseditem.*`, `task.dependence.*` — modify only) all go through `callV2`/`batchV2`. The two transports are NOT interchangeable: a classic method on v3 fails with `UNKNOWNDTOPROPERTYEXCEPTION` (wrong field casing) or "restApi:v3 not support method". Use v3 (`callV3`; apidocs URLs containing `rest-v3/` or `/rest/api/`, camelCase DTOs) ONLY for methods that have no working v2 form — currently `tasks.task.get` and `tasks.task.result.*`. Dependency **read-back is unavailable**: `task.item.getdependson` is documented as deprecated upstream and the live-portal smoke (issue #33, 2026-05) confirmed it no longer returns predecessors; `tasks.task.get` does not expose a `dependsOn` field via any documented select. No tool ships for this — operators inspect dependencies via the Bitrix24 UI until upstream restores a read path. Bitrix24's v3 `tasks.template.checklist.*` is for task templates only; it does NOT replace `task.checklistitem.*` for actual tasks. When unsure which transport a method needs, check apidocs (a `/rest/api/` URL + camelCase fields = v3) and default to v2 otherwise.
8. **Read the SDK before reinventing it.** Before adding rate limiting, retry, logging, request inspection, or any other cross-cutting concern around Bitrix24 calls — read `@bitrix24/b24jssdk`'s `dist/esm/index.d.ts` for first-class extension points. The SDK already ships a leaky-bucket `RestrictionManager` (configured via `setRestrictionManagerParams` + `ParamsFactory`), retry with adaptive delay, structured logging (`setLogger`), and `getStats()`. Monkey-patching is forbidden (see "Things you must NOT do" below). When in doubt, search the `.d.ts` for `set*` / `add*` / `on*` / `*Manager` / `*Factory` — that's where the hooks live.
9. **Every destructive tool requires an explicit `confirmDelete: true` from the agent (UNIVERSAL gate).** Deletion is irreversible from the MCP's side — Bitrix24 does not surface a "trash" or "undo" for the entities we expose. The rule applies to ANY tool whose primary effect is to wipe an existing record — whether the trailing action is `_delete` (most common), `_remove` (removes a link / relationship without deleting either endpoint, e.g. `b24_task_dependency_remove`), or any future synonym. To prevent LLM mis-interpretation ("посмотри запись 5" → tool ending in `_delete` instead of `_list`), every such tool MUST add a `confirmDelete: boolean` field to its Zod schema and refuse with `Bitrix24ToolError` code `DELETE_NEEDS_CONFIRM` unless the agent set it to `true`. The error message MUST name the target(s) so the agent shows the operator what they're agreeing to. Applies to BOTH single and batch — the confirm is per-call, not per-id, and the agent MUST receive explicit operator agreement (the operator says "да, удали"; "посмотри" is not consent) before setting the flag — even in batch. Auto-confirming defeats the gate and counts as a Rule #9 violation. The shared schema fragment lives at `server/utils/define-action-tool.ts` (`confirmDeleteSchema()`); use it directly to keep wording uniform across delete tools. The shared gate `assertConfirmedDelete(toolName, targetDescription, confirmed)` lives in the same file (closes #32) — call it from every `*_delete` / `*_remove` tool handler instead of re-implementing the refusal; each callsite formats its own `targetDescription` so the LLM sees a domain-specific message. Compliant tools: `b24_task_elapsed_time_delete` (PR #28), `b24_task_result_delete` (PR #31), `b24_task_checklist_item_delete` (PR #31; stacks with Rule #10 below), `b24_task_dependency_remove` (PR-C).

10. **Cascade-destructive deletes need an ADDITIONAL `confirm<Cascade>: true` flag (stacks on Rule #9).** When a Bitrix24 delete method silently destroys more than the named target — e.g. deleting a checklist heading wipes every child item, or deleting a workgroup wipes every task in it — the agent must set BOTH `confirmDelete: true` (from Rule #9 above) AND a cascade-specific `confirm<Cascade>: boolean` flag. Refuse with a typed `Bitrix24ToolError` code `*_NEEDS_CONFIRM` if the cascade flag is missing; the error message MUST name the cascade target and tell the agent how to re-call. The precedent is `b24_task_checklist_item_delete` + `confirmDeleteHeading` (see `server/utils/checklist.ts` `assertNotHeading` / `assertBatchNoHeadings`); a single pre-flight `callV2` (`task.checklistitem.getlist`) gates both single-id and batch flows. The pre-flight cost is acceptable for destructive ops; for batches use ONE shared pre-flight rather than N individual `get` calls.

## Code review — persona walk

Static review (lint, typecheck, tests, security checklist) catches **engineering** mistakes. It does NOT catch **product** mistakes — tool descriptions that read fine to a developer but confuse a real operator, missing scenarios, hidden assumptions about who is calling the tool.

After the engineering review pass, **walk through every changed tool description and eval case from the perspective of the personas below**. If the persona can't get their job done, or they can't tell what the tool will do, the description is wrong — even if the code is correct.

Use this pass on any PR that adds, renames, or rewrites an MCP tool description, an inputSchema field's `.describe()`, or an eval case.

| Persona | Lens | Catches |
|---|---|---|
| 👷 **Factory director** (RU manufacturing, 200 tasks/day) | Bulk, rate limits, audit trail, idempotency | "operates on one task" missing; double-call returns "not allowed" without explanation; no `closedBy` / `statusChangedBy` in payloads |
| 👩‍⚕️ **Polyclinic HR head** (RU, non-technical, 55+) | Plain-language descriptions, no jargon | "taskControl" / "MARK" / single-letter codes leaking; rejection flow without comment-ordering note; "Pending" vs "Rejected" terminology |
| 💼 **Owner-operator** (small business, conversational) | Speaks in names not ids, fuzzy memory | No `find_task` hint when operator names a task in free text; no rate-limit warning when batching; `MARK=P` jargon |
| 🚀 **DOGE-style auditor** ("Elon walk") | Token cost, file count, abstraction value | 7 tools vs 1 enum; pastTense JSON keys with no signal; bloated README; util/factory naming mismatch |
| 🏭 **Müller** (DE Mittelstand director, GDPR-disciplined) | Auditability, no ambiguity, no surprise mutations | Tool that mutates without echoing what changed; missing "this clears existing data" warnings (e.g. `MARK=null`, `ACCOMPLICES` replace-not-merge); locale-specific date formats |
| 🌙 **Fatima** (UAE retail COO, Arabic + English) | RTL display, multilingual descriptions, Hijri-aware deadlines | BBCode that doesn't render RTL cleanly; date examples only in Gregorian; descriptions assuming Cyrillic operator names |

The personas are **not** test users — they're a debugging lens. The PR ships when their reading of every description matches what the code actually does.

## Scope discipline — follow-ups → GitHub issues, not PR scope creep

Code review (especially persona-walk review) will surface items that are real, valuable, and **out of scope for the PR in front of you**. Examples from the PR #5 walk: bulk operations, `find_task` tool, accept/decline/delegate, normalising stringified ids to numbers, persona audit for DE / UAE operators.

**Default behaviour:** these go to **new GitHub issues**, not into the current PR. A PR titled `feat(tools): X` should ship X — not X plus a refactor of TaskShort plus a new search tool plus a measurement RFC. Scope creep makes PRs harder to review, harder to roll back, and harder to bisect.

**Before opening any follow-up issue:**

1. **Ask the maintainer first.** Surface the list of candidate follow-ups in a comment on the PR (or in the chat). Each candidate as one line: _"<title> — one-sentence reason, surfaced by <persona / review round>"_.
2. **Wait for the green light.** The maintainer decides which become issues, which are noise, which belong in a different repo, and which are already covered elsewhere. The agent's signal-to-noise ratio for follow-ups is mediocre — confirmation prevents tracker pollution.
3. **Only then file.** Each filed issue should:
   - Be in English (the project's documentation language).
   - Have a context paragraph: "what the operator was trying to do that doesn't work today" — not just "we should add X".
   - Cite where it was surfaced (PR number, review round, persona).
   - List concrete acceptance criteria.
   - Be labelled (`enhancement` / `chore` / `rfc` / `docs` / `i18n` / scope).
4. **Cross-link both directions.** Add a "follow-ups filed as #N / #M …" section to the PR body so the squashed commit message + PR description carry the deferred-work trail. Add "surfaced from PR #X review round #Y" to each issue body so reviewers can trace the lineage.

**Anti-pattern to avoid:** the agent opening five issues unilaterally because the persona walk surfaced five gaps. Most maintainers will perceive this as noise, not thoroughness. Ask first, even for items the agent is confident about.

## Feedback mechanism

This MCP server exposes `bx24mcp_submit_feedback`. As an AI agent using or developing this MCP, you may invoke it to report issues, suggestions, or positive observations. Each call creates a GitHub issue in `bitrix24/templates-mcp` with the label `agent-feedback`. See [`feedback.md`](./feedback.md) for the calling guide.

## Commit and PR conventions

Full details in the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Short version:

- [Conventional Commits](https://www.conventionalcommits.org/). Prefixes: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `ci`.
- PR title MUST follow Conventional Commits — it is squashed as the commit message.
- Multiple commits per PR are fine; no rebase/force-push to an open PR.
- Before opening a PR: `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass.
- No unrelated changes.
- Fill in the PR template fully.

## Renovate Bot

Patch updates auto-merge when CI is green. Minor (for 1.x+) and major updates require manual review. `@bitrix24/b24jssdk*` and the MCP stack are critical-path and always need maintainer review. Don't try to bypass Renovate by hand-editing `package.json` unless explicitly asked — that creates churn.

**`@bitrix24/b24jssdk` bumps** carry a credential-leak risk: SDK 1.1.1 already leaks the webhook URL via its HTTP layer's `getLogger().info('post/send', { method: <full-url> })` callsite — we defend with `makeRedactingLogger` in `server/utils/bitrix24.ts` (issue #26). A new SDK version can add fresh leak surfaces. Before merging a bump:

1. Run `pnpm test --run tests/unit/utils/sdk-logger-leak.test.ts` and `pnpm test --run tests/unit/utils/logger-redactor.test.ts`. Both are CI gates.
2. If the static scan fails (new `_logger.*` / `getLogger().*` callsite in the bumped SDK references a URL-shaped identifier), read the new callsite's logged payload. If it includes URL data not covered by our redactor regex, extend the redactor or refuse the bump.
3. If the BASELINE test starts FAILING (sentinel no longer appears in raw logs), SDK upstream may have fixed the leak — re-audit and update `docs/SECURITY-AUDIT.md`.
4. Update the **"Audit pass — SDK <version>"** section of `docs/SECURITY-AUDIT.md` with the new version, callsite count per surface, and a one-line description of each new callsite touching a URL-shaped field.
5. **Check logger-context shape**: `redactValue` in `server/utils/logger-redactor.ts` only recurses into objects with `Object.prototype` (plain object literals). If a bumped SDK starts passing class instances, `Object.create(null)` contexts, `Map`, `Set`, or `Buffer` as the `context` argument, URL-shaped fields inside them bypass redaction. Inspect the new HTTP-layer callsites — if any pass a non-plain-object context, extend `redactValue` to handle that prototype before merging.
6. Re-run the integration suite (`tests/integration/`) against a live portal to confirm no behaviour regressions.

Skipping the audit means trusting the SDK maintainers' judgement about credential disclosure — re-establish that trust on every bump (minor or patch can add a logger callsite as easily as a major).

**`@bitrix24/b24ui-nuxt` and `@bitrix24/b24icons-vue` bumps** sit in the same Bitrix24-org tier as the SDK above but with a lighter risk profile: they're UI primitives (Reka UI + Tailwind 4 + Tailwind Variants), they don't touch credentials, and they don't talk to the network at runtime. The `b24ui-nuxt` package does however inject Nuxt plugins, register components, and pull ~140 transitive dependencies (Reka UI, Tailwind, tanstack/embla/tiptap helpers) — Renovate would auto-merge a patch/minor without anyone looking. Before merging a bump:

1. **Check for new Nuxt `runtimeConfig` keys.** Grep the bumped package's `module.mjs` / dist for `nuxt.options.runtimeConfig` mutations. If a new `public` key appears, audit whether it's harmless (theme defaults) or whether it could leak portal data into the client bundle.
2. **Check for new postinstall / preinstall scripts.** `cat node_modules/@bitrix24/b24ui-nuxt/package.json | jq .scripts` — anything besides `nuxt prepare` triggering on install is a yellow flag.
3. **Check for new outbound network calls at runtime.** Grep the dist for `fetch(`, `axios`, `XMLHttpRequest`, hardcoded `https://` URLs. A UI library that suddenly phones home to a telemetry endpoint is the headline case to catch.
4. **Update `docs/SECURITY-AUDIT.md`** — append an "Audit pass — b24ui-nuxt `<version>`" sub-section with the date, the transitive dep count delta (compared to the previous pinned version, via `pnpm why @bitrix24/b24ui-nuxt`), and one-line notes on each of the three checks above.
5. **Re-run the build and the integration suite** — a bumped UI lib can break SSR (hydration mismatch, server-only API leaking into client code) in ways that lint and typecheck don't catch.

The bar here is lower than for the SDK (no credential-leak surface to defend), but the supply-chain surface is bigger (the dep tree is 7× larger). Skipping the audit is what supply-chain attacks rely on.

## When asked to add a new tool

1. Identify the group: `tasks` / `users` / `meta` — or, if your tool covers a domain the template hasn't touched yet (CRM is the demand-driven post-release expansion zone; calendars, disk, im, … are also fair game), create the directory yourself; that's the explicit "fork and extend" path.
2. Create `server/mcp/tools/<group>/<kebab-name>.ts`.
3. Use `defineMcpTool({ name, description, inputSchema, handler })`.
4. Name pattern: `b24_<domain>(_<entity>)*_<action>` for Bitrix24 tools (e.g. `b24_task_create`, `b24_task_checklist_item_add`, `b24_task_list`); `bx24mcp_<verb>` for meta-tools (use `bx24mcp_` ONLY for tools that don't call the Bitrix24 REST API). **Action is always the trailing token; all tokens are singular** — including before `_list`. Identity-style `b24_<domain>_me` (currently only `b24_user_me`) is an allowed shape where `me` covers both entity and action. The pattern + the singular-everywhere rule + the prefix split are enforced by `tests/unit/mcp-stdio/tool-naming-convention.test.ts`.
5. Handler uses `useBitrix24Tenant()` (the OAuth-aware dispatcher — falls back to the webhook singleton when OAuth is disabled, see [`../../docs/OAUTH-DESIGN.md`](../../docs/OAUTH-DESIGN.md) §6). Never call `useBitrix24()` directly from a tool handler. Return a string or rich content.
6. Add a unit test mocking `useBitrix24Tenant` (see `adding-tools.md` "Tests" for the canonical pattern).
7. Optionally add an eval case in `tests/evals/tool-selection.eval.ts`.
8. Run `pnpm lint && pnpm typecheck && pnpm test`.
9. Commit: `feat(tools): add b24_<name>`.

Full template — including the `callV3` / `callV2` / `batchV2` / `batchV3` helper usage, `AjaxError` handling, the `useLogger()` recipe, batch-tool conventions, and a copy-paste unit-test skeleton — lives in [`adding-tools.md`](./adding-tools.md).

## When asked to do UI / frontend work

The project ships with `@bitrix24/b24ui-nuxt` — the same Vue component system Bitrix24 uses internally (Reka UI + Tailwind CSS + Tailwind Variants). Use it for `app.vue`, any new pages under `pages/`, and any future client-facing surface (OAuth setup wizard, admin panels for managing connectors). Don't introduce parallel UI libs (Headless UI / shadcn-vue / PrimeVue) — the b24ui system is the chosen primitive and the brand pass relies on its semantic tokens.

**Load these before writing any UI** — they replace guesswork:

1. **Component API reference** — https://bitrix24.github.io/b24ui/llms.txt. Machine-readable index of every component, prop, slot, and event. Fetch when you need to know what a component accepts.
2. **UI patterns skill** — https://github.com/bitrix24/b24ui/tree/main/skills/b24-ui-nuxt. Teaches *when to use which component* (decision matrices for Modal vs Slideover, Select vs SelectMenu, Toast vs Alert), conventions, semantic colors, layout patterns, accessibility rules. Read its `SKILL.md` plus the `references/` files relevant to the task at hand.

Hard rules that override personal taste:

- **Wrap the root in `<B24App>`** — required for toasts, tooltips, programmatic overlays.
- **Use semantic color tokens** (`bg-elevated`, `text-description`, `border-muted`, `air-primary`, `air-secondary-no-accent`, …) — never raw Tailwind palette colors like `text-gray-500`. The brand pass rebrands semantics centrally; raw colors leak past it and drift.
- **One solid primary button per view.** Everything else uses lower visual weight (`air-secondary-no-accent`, ghost, link).
- **Icons come from `@bitrix24/b24icons-vue`** with subpath imports — `import { GitHubIcon } from '@bitrix24/b24icons-vue/social'`. Don't pull arbitrary icon packs.

## When asked to upgrade dependencies

Renovate handles routine updates. For manual upgrades:

1. Read the CHANGELOG.
2. Summarize breaking changes in the PR description.
3. Run the full suite, including integration when `NUXT_BITRIX24_TEST_WEBHOOK_URL` is set.
4. Commit: `chore(deps): bump <package> to <version>`.

## When asked to add a new Bitrix24 method

Use the typed helpers from `server/utils/sdk-helpers.ts`: `callV2<T>(b24, method, params, errorContext)` — the default for classic methods, `callV3<T>(…)` — only for v3-only methods (`tasks.task.get`, `tasks.task.result.*`), and `batchV2<T>` / `batchV3<T>(…)` for bulk (match the transport to the method — see Rule #7 and the convention block in `sdk-helpers.ts`). Always include a typed generic on `<T>` matching the REST response shape (e.g. `SingleTaskEnvelope` from `server/types/bitrix24.ts`), and a one-line docstring comment linking to https://apidocs.bitrix24.com/. See [`adding-tools.md`](./adding-tools.md) for the full copy-pasteable template (which also covers the unit-test skeleton with `makeFakeBitrix24` and the persona-walk checklist). Calling `b24.actions.*.{call,batch}.make` directly from a tool handler is forbidden (use the helpers); the deprecated `b24.callMethod` is forbidden and disappears in SDK 2.0.

## Things you must NOT do without asking

- Bypass `useBitrix24Tenant()` and call HTTP directly (or call `useBitrix24()` directly from a tool handler — also forbidden, it pins the tool to webhook).
- Bind the container to a host port (`ports:` in production compose).
- Change the MCP transport.
- Replace the Bitrix24 SDK with a custom HTTP client.
- Add new runtime dependencies without justification.
- Skip tests with `.skip` or `it.only`.
- Modify `LICENSE`.
- Add code under `server/` without a corresponding test in `tests/`.
- Disable middleware or remove auth on `/mcp`.
- Rebase or force-push to an open PR.
- Mix unrelated changes in a single PR.
- Disable Renovate or merge over its objections.
- **Monkey-patch the Bitrix24 SDK.** Don't reassign or wrap methods on `B24Hook` / `B24OAuth` / `RestrictionManager` / any other SDK class. The SDK ships first-class extension points (`setRestrictionManagerParams`, `setLogger`, `ParamsFactory.{getDefault,getEnterprise,getBatchProcessing,getRealtime,fromTariffPlan}`, `getStats`, `getRestrictionManagerParams`). If the feature you need looks like "intercept every call", read the SDK's `.d.ts` for the right hook BEFORE writing a wrapper — patches are a smell that says "I didn't find the right API", not "the API doesn't exist".

## When the operator says "I'm not seeing the debug logs I set"

`server/utils/logger.ts` is strict about what counts as a recognised level: `debug` / `info` / `notice` / `warning` (alias `warn`) / `error` / `critical` / `alert` / `emergency`, case-insensitive. A typo like `NUXT_LOG_LEVEL=debgu` or `LOG_LEVEL=infoo` no longer fails silently — at startup the resolver writes ONE diagnostic line to **stderr** naming the bad value, the active `NODE_ENV`, and the level it fell back to. The value is capped at 32 chars and run through `redactString` first, so an operator who mis-pasted a webhook URL into `NUXT_LOG_LEVEL` doesn't see the secret in `journalctl` / `docker logs`. If an operator reports "I set debug but logs still look quiet" or "the extension prints a weird line at boot", that stderr warning is the first place to look — not in the app log stream itself. Issue #137 / PR #158.

## Where to read more

- Root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — full commit and PR rules.
- [`adding-tools.md`](./adding-tools.md) — modern tool template (`callV2` / `callV3` / `batchV2` / `batchV3` helpers, the v2-vs-v3 transport convention, `AjaxError` handling, SDK logger, unit-test skeleton).
- [`feedback.md`](./feedback.md) — agent feedback prompts and policy.
- `docs/EVALS.md`, `docs/FEEDBACK.md`, `docs/MANUAL-TEST-PHRASES.md` at the project root — operator-facing guides.

Operator docs for deploy, on-call, security, and architecture now live at [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md), [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md), [`docs/SECURITY.md`](../../docs/SECURITY.md), and [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md). First-time host setup is driven by [`scripts/bootstrap.sh`](../../scripts/bootstrap.sh) (sparse-clones the deploy file set for a pinned tag; its `FILES` array is the canonical list) followed by `make bootstrap-check`. For post-deploy verification — health, Bearer-auth contract, placeholder-token gate — point the operator (or run yourself if you have shell access) at [`scripts/verify-deployment.sh`](../../scripts/verify-deployment.sh); see [`docs/DEPLOYMENT.md#verifying-your-deployment`](../../docs/DEPLOYMENT.md#verifying-your-deployment). The remaining unwritten slots tracked in [`docs/README.md`](../../docs/README.md) are `TROUBLESHOOTING.md` (dev/laptop incident slice) and a dedicated `TESTING.md`; if a session needs one of those, open an issue rather than improvising local docs that drift from `PROJECT-BRIEF.md`.
