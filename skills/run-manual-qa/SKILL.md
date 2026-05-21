---
name: run-manual-qa
description: Organize and run a manual QA pass against the bitrix24/templates-mcp MCP server — first through the MCP Inspector, then through an AI agent connector. Use when the user asks to "run manual QA", "test PR #N by hand", "smoke test the project", "прогнать чеклист", or wants a reusable manual-test tracking issue. Test artifacts (tracking issues, results) live in a SEPARATE disposable test repo — never in the upstream bitrix24/templates-mcp.
---

# run-manual-qa — Agent Skill

Manual QA for the Bitrix24 MCP server. The server is exercised twice per run: once through the **MCP Inspector** (deterministic, parameter-level) and once through an **AI agent connector** (natural-language disambiguation). This skill produces a single tracking issue the human clicks through, and archives the result so the next run starts from known state.

## Hard rules

1. **Never write test artifacts into `bitrix24/templates-mcp`.** Tracking issues, fail reports, and result archives go into a **separate disposable test repo** (e.g. `IgorShevchik/for-test-mcp`). The upstream repo only ever receives the skill itself and real PRs — never QA scratch.
2. **Never ask for, store, echo, or commit secrets.** The human supplies every secret (webhook URL, MCP auth token, GitHub PAT) directly into their local `.env`. The skill describes *which* variables are needed and *where they come from* — it never handles the values. If a value looks like a real token in any input, refuse to write it anywhere.
3. **Always ask the three run parameters before doing anything** (see Step 0). Do not assume scope, repo, or language from a previous session.
4. **Test phrases render in the human's chosen language; everything structural is English.** The project's documentation language is English (section titles, labels, archive). Only the operator-facing test phrases (the "say this to the AI agent" lines) use the chosen language.
5. **Keep the scaffold in sync with the project.** [`references/issue-scaffold.md`](./references/issue-scaffold.md) hard-codes structural facts. Update it in the **same PR** whenever the underlying fact changes — not merely when a file is touched. Triggers (by change, not by filename): a `NUXT_*`/`NITRO_*` variable added/renamed/removed; the default port or `/mcp` endpoint path changed; a required webhook scope changed; the connector auth header name/format changed; a new tool that needs upfront-seeded portal data. (A `nuxt.config.ts` refactor that changes none of these needs no scaffold edit.) The data table and seed list are otherwise generated/trimmed per run. A CI gate enforces the `.env.example` ↔ scaffold pairing — see `.github/workflows/`.

> **Tooling note.** Step 0 uses `AskUserQuestion` (Claude Code / Agent SDK). If this skill runs in a plain chat without it, ask the parameter questions inline and wait for the reply. History (Step 1) is read directly — no subagents in the normal path.

## Workflow

### Step 0 — Gather run parameters (ASK, every time)

Use `AskUserQuestion`. Three questions, never assumed:

1. **Scope** — specific PR(s) (collect numbers) **or** whole project?
2. **Test repo URL** — where to create the tracking issue. Reject `bitrix24/templates-mcp`. Default suggestion: the repo used last run (read from archive), else ask.
3. **Test-phrase language** — language for the AI-agent disambiguation lines (RU / EN / …).

Secrets are out of scope — state once that the human wires their own `.env`, then move on.

### Step 1 — Read prior runs and plan with history

Before designing this run, learn what the last runs found:

Two separate signals — don't conflate them. **Keep history tiny in context** — pull one-liners only, never whole issue bodies. Past failures are noise until proven relevant to *this* PR.

1. **Trend — the 3 most recent runs, any age.** No time window: sequential runs show progress and connect to the current PR, and a window would return nothing when runs are weeks apart. 3 is a deliberate, fixed safety net.
   `gh issue list --repo <test-repo> --search "Manual QA in:title" --state all --limit 3`
   plus the newest archive filenames: `gh api repos/<test-repo>/contents/archive --jq '.[].name' | sort | tail -3` (the filename `YYYY-MM-DD-<scope>.md` is itself the one-liner — open a file only on a scope overlap, per step 3). **One line per run, nothing more:** `date | scope | N pass / M fail | open: #X,#Y`. If a run is old or a different scope than the current PR, append `(may not reflect current code)`.
2. **Backlog — every open fail-issue, no limit.** Independent of the 3-run cap, so a bug older than 3 runs is never dropped:
   `gh issue list --repo <test-repo> --label agent-feedback --state open` plus checklist-converted fail-issues. **One line each:** `#N <title>`. Numbers and titles only — do not open the bodies.
3. **Lazy drill-down.** Read a full issue (`gh issue view <N>`) **only when its title/scope overlaps the current PR's surface** (same tool, same area). Otherwise keep just the number. This is the rule that keeps old nightmares out of context.
4. Synthesize a **known-state digest** (a few one-liners): areas that flaked, regressions, still-open failures relevant to this PR. Put it in the new issue's header.

If the test repo is unreachable or empty, note "no history available" and proceed — never block on history. (Escape hatch for a future many-run read: Sonnet subagents — `Agent`, `model: sonnet`, digest-only, no raw bodies/tokens/portal ids. Not needed for 3.)

### Step 2 — Build the test from the actual PR work (PR-driven)

The checklist is **generated from what the PR changed**, not picked from a fixed list. A pre-baked block set goes stale — every PR ships tools, schemas, error codes, and gates that no canned block covers. So read the PR and derive the checks. [`references/test-design.md`](./references/test-design.md) holds the **recipes** (change type → which checks) and **reusable pattern snippets** (copy + fill placeholders).

For each PR in scope:

1. **Read the work.**
   - `gh pr view <n> --repo bitrix24/templates-mcp --json title,body,files`
   - `gh pr diff <n> --repo bitrix24/templates-mcp`
   - Read the PR description for intent, the linked issue for acceptance criteria.
2. **Extract the testable surface** from the diff:
   - New / renamed / removed MCP tools (`server/mcp/tools/`).
   - Each tool's Zod schema — every field, its bounds, its `.describe()`.
   - New or changed error codes (`Bitrix24ToolError` codes, typed messages).
   - Batch capability (array input, hard-cap, `force`).
   - Destructive gates (`confirmDelete`, cascade `confirm<X>` flags).
   - v2/v3 helper usage, logger/redactor touches, auth-middleware/connector changes, docs/skill edits.
3. **Map each extracted item to checks** using the recipes in `test-design.md` (A1–A11). Completeness check after mapping: every new `Bitrix24ToolError` code in the diff has a check (A6); every new/changed Zod field has a boundary check (A4); every new `delete_*`/`remove_*` has a confirm-gate check (A2/A3); any auth/middleware change has an A11 check.
4. **Always append the always-on regression blocks** (R0 static, R1 setup, R2 auth) — they run regardless of PR; any change can break lint/typecheck/startup/auth.

**Whole-project scope** → `find server/mcp/tools -name "*.ts" ! -name "*.test.ts"` and apply the recipes to every tool, treating the whole tree as the diff (see "Whole-project scope" in `test-design.md`).

### Step 3 — Resolve dynamic data

The generated checks use placeholders. Re-state the data table from [`references/issue-scaffold.md`](./references/issue-scaffold.md): which values are **prepared upfront** (test repo URL, pre-seeded task/users, bulk-test tasks) vs **collected during the run** (`$MY_ID`, `$TASK_ID`, …). Trim the table to only the placeholders the generated checks actually use.

### Step 4 — Create the tracking issue

Render into the **test repo** (never upstream):

- Preamble + "how to work" (Convert-to-issue flow) + prep section from [`references/issue-scaffold.md`](./references/issue-scaffold.md).
- The known-state digest from Step 1 as a "⚠️ Watch from last run" callout near the top.
- The checks generated in Step 2, grouped Inspector-first then AI-agent, with operator-facing phrases rendered in the chosen language.

Write the body to a temp file, create with `gh issue create --repo <test-repo> --body-file …`, then delete the temp file. Heredocs with `$(…)` break under `gh` — always use `--body-file`.

### Step 5 — Hand off

Output: the issue URL, the readiness checklist, and a one-line reminder that the human supplies secrets. Run order is always **Inspector first** (deterministic, parameter-level), **then AI agent** (natural-language disambiguation), **then teardown** (Part D in `test-design.md` — clean up created records and the feedback issue).

### Step 6 — Archive (when the human says the run is done)

1. Pull the completed issue: `gh issue view <n> --repo <test-repo> --json title,body,state`.
2. Translate the body to **English**.
3. **Sanitize before saving** — strip anything that identifies a real person or portal: employee names, numeric user ids tied to a person, task titles referencing real people, portal-URL fragments. Replace with generic placeholders (`$USER_A`, `task-123`). If the test repo is public, sanitization is mandatory; if you can't be sure, keep the archive in a **private** repo.
4. Note still-open fail sub-issues: list each as `still-open #N` in the archive so the next run's Step 1 carries them forward.
5. Save the sanitized English snapshot to the test repo at `archive/<YYYY-MM-DD>-<scope>.md`. Commit via a small PR in the test repo (`git add` + `gh pr create`) or `gh api --method PUT repos/<test-repo>/contents/archive/<file> -f message=… -f content=$(base64 …)`. Never upstream.
6. This archive (plus the closed issues) is what Step 1 reads next run — close the loop.

## Recipe quick map (change type → checks)

| PR ships… | Generate… |
|---|---|
| New tool | smoke (happy path) + per-field Zod bounds + error path + AI-agent disambiguation line |
| New `delete_*` / `remove_*` tool | `confirmDelete` gate (refuse without it) + smoke with it |
| Cascade-destructive delete | additional `confirm<Cascade>` gate (stacks on confirmDelete) |
| Batch capability on a tool | 1-HTTP-request proof (Network tab) + mixed partial-failure + hard-cap + `force` override |
| Changed Zod schema | boundary values (0 / negative / over-max / wrong type) |
| New / changed error code | real Bitrix24 code propagates, not generic |
| v2/v3 migration | grep `callMethod` empty, helpers used, no direct `actions.*.make` in tools |
| Logger / redactor touch | leak test + retry events in one channel |
| Auth middleware / connector change | 401 no-token + 401/403 wrong-token + 200 correct-token |
| Text-rendering change | i18n / RTL render check in the portal |
| Docs / skill edit | doc-content checks |

Always-on regression (every run): **R0 static gates**, **R1 setup**, **R2 auth**. Full recipes, snippets, teardown, and whole-project guidance: [`references/test-design.md`](./references/test-design.md).

## Where to read more

- [`references/test-design.md`](./references/test-design.md) — recipes (A1–A11), reusable pattern snippets, always-on regression (R0–R2), teardown, whole-project guidance, project gotchas.
- [`references/issue-scaffold.md`](./references/issue-scaffold.md) — preamble, "how to work" (Convert to issue), prep/access section, data table.
- [`../manage-bx24-template-mcp/SKILL.md`](../manage-bx24-template-mcp/SKILL.md) — the engineering/contribution skill; defines the tools this skill exercises and the v2/v3 helper conventions.
- `docs/MANUAL-TEST-PHRASES.md` — the static phrase pack; source for AI-agent disambiguation lines, especially on a whole-project run.
- `docs/EVALS.md` — automated tool-selection evals (`pnpm test:evals`). Run those first; this manual pass is a complement, not a replacement — it covers UI-visible effects, batch network shape, and live-portal behaviour the evals can't.
