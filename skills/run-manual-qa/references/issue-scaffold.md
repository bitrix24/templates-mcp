# Issue scaffold

Canonical English source for the non-block parts of the tracking issue: preamble, the "how to work" section (GitHub Convert-to-issue flow), the preparation/access section, and the placeholder data table. Render these into the test repo at issue-creation time. Operator-facing phrasing may be translated into the chosen language; structure and labels stay English.

> **Keep this file honest.** The prep section mirrors live project structure — `.env.example`, `nuxt.config.ts` (`runtimeConfig`, `NITRO_PORT`), the `/mcp` auth middleware, and the webhook-scope requirements in `README`. **Whenever any of those change, update this file in the same PR.** Triggers: a new/renamed/removed `NUXT_*` or `NITRO_*` variable, a changed default port or endpoint path, a new required webhook scope, a changed connector header, or a new upfront-seed requirement (a new tool that needs pre-existing portal data to test). The data table and parts of the prep are otherwise **generated/trimmed per run** (see below) — only the structural facts are hard-coded here, and those are what must stay in sync.

---

## Preamble

> Manual QA pass. Inspector first, then AI agent.
> A failed check becomes a linked sub-issue via **Convert to issue** (see below).

If Step 1 produced a known-state digest, insert it here as a callout:

> ⚠️ **Watch from last run:** <areas that flaked / still-open fail-issues #N, #M>.

---

## How to work with this checklist

### Mark a check done

Click the `[ ]` box next to an item — it becomes `[x]`. A counter (e.g. `12/87`) appears at the top of the issue. No editing required.

### When something fails — Convert to issue

GitHub turns any checklist item into a linked issue with one button.

1. Hover over the failing line — a circle icon ⊙ appears on the right.
2. Click **Convert to issue** → GitHub creates a new issue linked to this checklist.
3. In the new issue, add: the call made, expected result, actual result, screenshot if any.
4. **Submit new issue.**

The checklist item becomes a clickable link to that issue. Closing the issue auto-checks the item.

| Action | How |
|---|---|
| Check passed | Click the `[ ]` box |
| Check failed | Hover → **Convert to issue** → describe |
| Fix landed | Close the child issue → item auto-checks |

---

## Preparation — before the run

### 1. Access

| What | Where to get it | Why |
|---|---|---|
| GitHub write access to the **test repo** | Repo owner | Create issues via Convert to issue |
| GitHub PAT (fine-grained) | github.com → Settings → Developer settings → Fine-grained tokens | Feedback tool test |
| Bitrix24 test portal | Portal admin | any block touching the portal |
| Incoming webhook on the portal | Bitrix24 → Applications → Webhooks → Inbound | `.env` value |

**Webhook scopes (minimum):** `tasks` rw, `task_comments` rw, `user` read. The task sub-entities (checklist / result / elapsed / dependency) ride on the `tasks` scope — confirm against the portal's scope list if a check 403s. Create it under a **dedicated, non-admin service user**: the access-control check (A6 `ACCESSDENIED`) deliberately needs a non-admin so it can be denied. Grant admin only if a specific check requires cross-user visibility, and revoke it after.
**PAT settings:** repo access = test repo only; permission = `Issues: Read and write`. Copy the token once.

### 2. Local environment

- Node.js 20+ (`node -v`), pnpm (`pnpm -v`).
- `bitrix24/templates-mcp` cloned.
- For PR scope: the PR branch checked out. For whole-project: the merge-target branch, with all in-scope PRs merged (else their tools are absent and the startup tool count won't match).

### 3. `.env` — fill before `pnpm dev`

> 🔒 **Real tokens live only in the local `.env` on your machine. Never paste them into GitHub issues, comments, PR descriptions, or chats.**

Mirror of `.env.example` — if that file gains/renames a variable, update here too.

```bash
NUXT_BITRIX24_WEBHOOK_URL=https://your.bitrix24.com/rest/<service-user-id>/<webhook-code>/
# Must be a real value: leaving the .env.example placeholder
# `replace-with-secure-token` makes /mcp return 503 (treated as "not
# configured"). Worth one R2-auth check: placeholder token → 503, not 401.
NUXT_MCP_AUTH_TOKEN=$(openssl rand -hex 32)
NUXT_GITHUB_FEEDBACK_TOKEN=github_pat_xxxxxxxxxxxxxxxxxx
# Point at the TEST repo, not upstream (.env.example defaults to bitrix24/templates-mcp).
# The feedback-tool check creates a real issue — keep it out of upstream.
NUXT_GITHUB_FEEDBACK_REPO=<test-repo>
NUXT_LOG_LEVEL=info        # raise to debug for the A8 logger/retry checks
NITRO_PORT=3000            # server port; connector URL below must match
# NODE_ENV=production      # host .env only — do NOT uncomment here (Nuxt dev rejects it)
```

Optional, only if the run includes integration tests or evals (see `.env.example`):
`NUXT_BITRIX24_TEST_WEBHOOK_URL` (live integration suite — staging portal only),
`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` (eval LLM),
`NUXT_AUDIT_DIR` (OAuth/Bearer audit log destination; default `/data/audit/`, webhook-only manual QA ignores it).

### 4. On the Bitrix24 portal — seed upfront

Derive this list from the generated checks (Step 2): a check needs pre-existing data when it can't create that data itself (a record owned by *someone else*, an over-cap volume, a pre-known id). Example seeds from a whole-project run:

| What | Why | How |
|---|---|---|
| A task with a known ID | checklist / result checks need a host task | Create in UI or via MCP |
| A user matching the find_user query | find_user / disambiguation | Verify in employee list |
| A second distinct user | disambiguation (multiple matches) | Verify in employee list |
| A record owned by someone else (e.g. a task_result) | access-control (`ACCESSDENIED`) checks | Ask a colleague to create one |
| Bulk pending tasks over the batch cap (e.g. 30) | force-batch / hard-cap checks | Seed via one batch create, not by hand |

### 5. Browser

- DevTools open → **Network** tab → filter `Fetch/XHR` (needed for the A5 "1 request not N" batch proof).

### 6. AI agent connector (after `pnpm dev`)

1. AI agent → Settings → Connectors → Add custom.
2. URL: `http://localhost:<NITRO_PORT>/mcp` (default `http://localhost:3000/mcp`).
3. Header: `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN from .env>`.
4. Confirm the connector lists the tools.

> 🔒 Never paste the real token value into an issue, comment, or screenshot when reporting a connector problem — show the header as `Authorization: Bearer <redacted>`.

### Readiness checklist (pass before the run)

- [ ] GitHub write access to the test repo
- [ ] GitHub PAT created and copied
- [ ] Bitrix24 webhook URL obtained, scopes set, service user used
- [ ] `.env` filled (mirror `.env.example`)
- [ ] Correct branch checked out (PR branch for PR scope; the merge-target for whole-project)
- [ ] Pre-seeded portal data ready (known task id(s), find_user target users, bulk pending tasks) — per the generated data table
- [ ] DevTools open, Network filter = Fetch/XHR
- [ ] AI agent connector configured

---

## Placeholder data table

**Generated per run** — do NOT ship this exact table verbatim. Build it from the checks Step 2 produced: list every `$PLACEHOLDER` those checks reference, its source (collected during the run vs pre-seeded upfront), and where it is used. Drop rows for placeholders the run doesn't touch; add rows for any new placeholder a new tool introduces.

Use **generic placeholder names**, not real colleagues' names — the table ships inside an issue that may live in a public test repo. `$USER_A_ID`, not `$USER_IGOR_ID`.

The table below is an **example shape** (from a whole-project run) — use it as a format guide, not a fixed list:

| Placeholder | Source | Used in |
|---|---|---|
| `$MY_ID` | `b24_user_me` (collected) | most blocks |
| `$USER_A_ID` | `find_user { query }` (collected) | CRUD, disambiguation |
| `$TASK_ID` | `create_task` (collected) | lifecycle, batch, errors, time, deps |
| `$TASK_ID_2` | second portal task (pre-seeded) | dependencies |
| `$TASK_TC_ID`, `$TASK_TC_ID2` | `create_task taskControl:Y` (collected) | approve / disapprove paths |
| `$IDs[1..3]`, `$IDs[1..N]` | bulk `create_task` pending (pre-seeded) | batch happy path / force override |
| `$TASK_<n>` | pre-seeded task on the portal | checklists, results |
| `$CL_*_ID` | `add_checklist_item` (collected) | checklists |
| `$RESULT_ID` | `add_task_result` (collected) | results |
| `$ELAPSED_ID` | `add_elapsed_time` (collected) | elapsed time |

**Teardown reminder:** everything created during the run (tasks, bulk-seeded tasks, child records, the feedback issue) must be cleaned up after — see Part D in `test-design.md`.
