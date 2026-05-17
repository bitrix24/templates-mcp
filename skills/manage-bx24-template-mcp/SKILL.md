# bx24-template-mcp — Agent Skill

You are working on a Bitrix24 MCP server built on Nuxt + `@nuxtjs/mcp-toolkit`. Read this before making changes.

## Project context

- **Repo**: https://github.com/bitrix24/templates-mcp
- **Prod**: https://prod.example.com/mcp
- **Stack**: Nuxt 3 (Nitro `node-server`), `@nuxtjs/mcp-toolkit`, `@bitrix24/b24jssdk-nuxt`
- **Auth to Bitrix24**: incoming webhook (Phase 1), OAuth (Phase 3)
- **Auth from Claude to us**: Bearer token via middleware
- **Deployment**: Docker behind `nginx-proxy` + `acme-companion` on shared `proxy-net` network. Server is self-sufficient — GH Actions deploys on `v*` tag, no manual ops required
- **Dependency updates**: handled by Renovate Bot (see `renovate.json`)
- **License**: MIT

## Ground rules

1. **One tool per file** in `server/mcp/tools/<group>/<name>.ts`. Discovery is automatic.
2. **Never call Bitrix24 directly.** Always go through `useBitrix24()`, and from there through the typed helpers in `server/utils/sdk-helpers.ts`: `callV3<T>(b24, method, params, errorContext)` for v3 methods (`tasks.task.*`, `crm.*`, …), `callV2<T>(…)` for v2 (`user.*`, `task.commentitem.*`, …), and `batchV3<T>(b24, calls, errorContext)` for bulk operations. The helpers own the `isSuccess` / `getErrorMessages` / transport-error funnel — tool handlers stay short and uniform. Calling `b24.actions.*.{call,batch}.make` directly from a tool handler is forbidden (it duplicates that funnel and drifts over time); the deprecated `b24.callMethod` is doubly forbidden — it disappears in SDK 2.0. See [`adding-tools.md`](./adding-tools.md) for the canonical template.
3. **Every tool must have a unit test** in `tests/unit/tools/<name>.test.ts` with the Bitrix24 client mocked.
4. **Every Zod field must have `.describe()`** — the LLM reads it at runtime.
5. **No secrets in code or tests.** Use `useRuntimeConfig()` and `.env`.
6. **Operators talk in names, not ids.** When a tool needs a `responsibleId` / `userId` / similar, **resolve from a name first** via `bitrix24_find_user`. The decision tree:
   1. Run `bitrix24_find_user { query: "<name from the operator>" }`.
   2. **0 matches** → tell the operator nobody matched and ask for a fuller name or last name.
   3. **1 match** → use that user's `id`. No further questions.
   4. **N > 1 matches** → ask the operator to disambiguate by **last name** (and `position` / `department` if last names also collide). Only ask for a numeric `id` as the **last resort** if natural-language disambiguation fails.
7. **Prefer REST API v3 where it exists; treat the v2 endpoints below as canonical, not "fallback".** Use v3 (apidocs URLs containing `rest-v3/`) for everything that has it. The following families are **v2-canonical and not coming to v3** — don't waste time hunting for a v3 equivalent, just `callV2`: `user.*`, `task.commentitem.*`, `task.checklistitem.*`, `task.elapseditem.*`. Bitrix24's v3 `tasks.template.checklist.*` is for task templates only; it does NOT replace `task.checklistitem.*` for actual tasks. For any other v2 method (e.g. `task.*` legacy CRUD), prefer v3 and document the v2 fallback in the tool's docstring with a link to the apidocs page.
8. **Read the SDK before reinventing it.** Before adding rate limiting, retry, logging, request inspection, or any other cross-cutting concern around Bitrix24 calls — read `@bitrix24/b24jssdk`'s `dist/esm/index.d.ts` for first-class extension points. The SDK already ships a leaky-bucket `RestrictionManager` (configured via `setRestrictionManagerParams` + `ParamsFactory`), retry with adaptive delay, structured logging (`setLogger`), and `getStats()`. Monkey-patching is forbidden (see "Things you must NOT do" below). When in doubt, search the `.d.ts` for `set*` / `add*` / `on*` / `*Manager` / `*Factory` — that's where the hooks live.
9. **Every delete tool requires an explicit `confirmDelete: true` from the agent (UNIVERSAL gate).** Deletion is irreversible from the MCP's side — Bitrix24 does not surface a "trash" or "undo" for the entities we expose. To prevent LLM mis-interpretation ("посмотри запись 5" → tool called `delete_*` instead of `list_*`), every `bitrix24_delete_*` tool MUST add a `confirmDelete: boolean` field to its Zod schema and refuse with `Bitrix24ToolError` code `DELETE_NEEDS_CONFIRM` unless the agent set it to `true`. The error message MUST name the target(s) so the agent shows the operator what they're agreeing to. Applies to BOTH single and batch — the confirm is per-call, not per-id, and the agent MUST receive explicit operator agreement (the operator says "да, удали"; "посмотри" is not consent) before setting the flag — even in batch. Auto-confirming defeats the gate and counts as a Rule #9 violation. The shared schema fragment lives at `server/utils/define-action-tool.ts` (`confirmDeleteSchema()`); use it directly to keep wording uniform across delete tools. Compliant tools: `bitrix24_delete_elapsed_time` (PR #28), `bitrix24_delete_task_result` (PR #31), `bitrix24_delete_checklist_item` (PR #31; stacks with Rule #10 below).

10. **Cascade-destructive deletes need an ADDITIONAL `confirm<Cascade>: true` flag (stacks on Rule #9).** When a Bitrix24 delete method silently destroys more than the named target — e.g. deleting a checklist heading wipes every child item, or deleting a workgroup wipes every task in it — the agent must set BOTH `confirmDelete: true` (from Rule #9 above) AND a cascade-specific `confirm<Cascade>: boolean` flag. Refuse with a typed `Bitrix24ToolError` code `*_NEEDS_CONFIRM` if the cascade flag is missing; the error message MUST name the cascade target and tell the agent how to re-call. The precedent is `bitrix24_delete_checklist_item` + `confirmDeleteHeading` (see `server/utils/checklist.ts` `assertNotHeading` / `assertBatchNoHeadings`); a single pre-flight `callV2` (`task.checklistitem.getlist`) gates both single-id and batch flows. The pre-flight cost is acceptable for destructive ops; for batches use ONE shared pre-flight rather than N individual `get` calls.

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

## When asked to add a new tool

1. Identify the group: `tasks` / `deals` / `contacts` / `users` / `meta`.
2. Create `server/mcp/tools/<group>/<kebab-name>.ts`.
3. Use `defineMcpTool({ name, description, inputSchema, handler })`.
4. Name pattern: `bitrix24_<verb>_<entity>` for Bitrix24 tools, `bx24mcp_<verb>` for meta-tools.
5. Handler uses `useBitrix24()` and returns a string or rich content.
6. Add a unit test mocking `useBitrix24`.
7. Optionally add an eval case in `tests/evals/tool-selection.eval.ts`.
8. Run `pnpm lint && pnpm typecheck && pnpm test`.
9. Commit: `feat(tools): add bitrix24_<name>`.

Full template — including v3 `actions.call.make` usage, `AjaxError` handling, the `useLogger()` recipe, batch-tool conventions, and a copy-paste unit-test skeleton — lives in [`adding-tools.md`](./adding-tools.md).

## When asked to upgrade dependencies

Renovate handles routine updates. For manual upgrades:

1. Read the CHANGELOG.
2. Summarize breaking changes in the PR description.
3. Run the full suite, including integration when `NUXT_BITRIX24_TEST_WEBHOOK_URL` is set.
4. Commit: `chore(deps): bump <package> to <version>`.

## When asked to add a new Bitrix24 method

Use the typed helpers from `server/utils/sdk-helpers.ts`: `callV3<T>(b24, method, params, errorContext)` for v3 endpoints, `callV2<T>(…)` for v2, `batchV3<T>(…)` for bulk. Always include a typed generic on `<T>` matching the REST response shape (e.g. `SingleTaskEnvelope` from `server/types/bitrix24.ts`), and a one-line docstring comment linking to https://apidocs.bitrix24.com/. See [`adding-tools.md`](./adding-tools.md) for the full copy-pasteable template (which also covers the unit-test skeleton with `makeFakeBitrix24` and the persona-walk checklist). Calling `b24.actions.*.{call,batch}.make` directly from a tool handler is forbidden (use the helpers); the deprecated `b24.callMethod` is forbidden and disappears in SDK 2.0.

## Things you must NOT do without asking

- Bypass `useBitrix24()` and call HTTP directly.
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

## Where to read more

- Root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — full commit and PR rules.
- [`adding-tools.md`](./adding-tools.md) — modern tool template (`callV3` / `callV2` / `batchV3` helpers, batch via `actions.v3.batch.make`, `AjaxError` handling, SDK logger, unit-test skeleton).
- [`feedback.md`](./feedback.md) — agent feedback prompts and policy.
- `docs/EVALS.md`, `docs/FEEDBACK.md`, `docs/MANUAL-TEST-PHRASES.md` at the project root — operator-facing guides.

Operator deployment / testing / runbook docs (`docs/DEPLOYMENT.md`, `docs/TESTING.md`, `docs/RUNBOOK.md`, `docs/TROUBLESHOOTING.md`) are tracked in [`docs/README.md`](../../docs/README.md) — they're not yet authored. If a session needs one of them, open an issue rather than improvising local docs that drift from `PROJECT-BRIEF.md`.
