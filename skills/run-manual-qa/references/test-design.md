# Test design — recipes, snippets, regression

The manual test is **generated from the PR's actual diff**, not picked from a fixed list. This file gives you:

- **Part A — Recipes**: change type → which checks to generate.
- **Part B — Always-on regression**: blocks that run every time regardless of the PR.
- **Part C — Pattern snippets**: copy-paste skeletons, fill the placeholders.
- **Part D — Teardown**: clean up what the run created.

Operator-facing phrases (the "say this to the AI agent" lines) render in the chosen language at issue-creation time. Everything structural stays English. Run order: **Inspector first** (deterministic), **then AI agent** (natural language), **teardown last**.

> The commands below assume bash/zsh on Linux/macOS or Git Bash on Windows. `grep -rn …` is GNU grep; on BSD/macOS grep, POSIX character classes still work but escaping differs — prefer running R0 in CI or a GNU-grep shell. `find` is used instead of `ls **` because recursive globs need `shopt -s globstar` (bash) and aren't portable.

---

## Part A — Recipes (change type → checks)

Read `gh pr diff <n>`. For each item below that appears in the diff, generate the listed checks. Compose them per tool — one PR can hit several rows.

### A1. New / renamed MCP tool (`server/mcp/tools/**`)

Generate, for the tool:

- **Smoke (happy path)** — minimal valid call, assert the documented success payload + the effect in the Bitrix24 UI.
- **Valid-minimal boundary** — the smallest accepted value (e.g. `id: 1`, a 1-char title) → passes Zod AND succeeds at REST (guards against an over-tight bound that rejects legal input).
- **Per-field Zod bounds** — one check per schema field: missing required → reject; wrong type → reject; out-of-range (see A4).
- **Error path** — call with a non-existent id / forbidden target → real Bitrix24 code in the message, not generic `BITRIX24_ERROR`.
- **AI-agent disambiguation** — one phrase that should map to *this* tool and at least one near-neighbour it must NOT be confused with (use the snippet in C5). Pull the near-neighbour from sibling tools in the same group.

If the tool reads/lists: also check pagination semantics (`returned < limit` = end; v3 has no `total`) AND an empty result path (filter that matches nothing → `[]`, not an error).

### A2. New `delete_*` / `remove_*` tool (Rule #9 gate)

- Call **without** `confirmDelete` → refuse with `*_NEEDS_CONFIRM`, target named in the message.
- Call **with** `confirmDelete: true` → succeeds, effect gone in UI.
- **AI-agent auto-confirm guard** — a phrase with NO explicit consent ("посмотри запись 5" / "show record 5") → the agent must NOT set `confirmDelete: true` on its own. Only an explicit "да, удали" / "yes, delete" justifies the flag (Rule #9 — auto-confirming defeats the gate).
- Disambiguation: a "show / look at" phrase must NOT trigger the delete tool at all.

### A3. Cascade-destructive delete (Rule #10, stacks on A2)

- Missing the cascade flag (`confirm<Cascade>`) → refuse with `*_NEEDS_CONFIRM`, cascade target named.
- Both `confirmDelete: true` + cascade flag → succeeds, cascade effect visible (e.g. heading + all children gone).
- Batch variant: a cascade target inside the array → refuse **before** the batch call (pre-flight gate), not mid-batch.

### A4. Changed Zod schema / new bounded field

For each bound the diff introduces or changes, generate boundary checks that fail **at the schema level, no REST hit** (plus the at-limit value that must PASS — see A1 valid-minimal):

- numeric id: `0`, `-1`, `1.5`, `"5"` (string) → reject; the min legal value (e.g. `1`) → pass
- capped int (e.g. seconds ≤ max): `0`, max+1, `-1` → reject; exactly max → pass
- capped string (e.g. title, text): max+1 chars → reject; exactly max chars → pass; empty where required → reject
- huge payload (10MB string) → reject (memory guard)
- object field: `{}` where non-empty required → reject with the refine message

Read the actual limits from the tool's Zod schema — don't hard-code numbers from memory, they drift.

### A5. New batch capability (array input on a mutating tool)

- **1 HTTP request proof** — array of N valid ids → assert `batch:true, ok:N, failed:0` AND exactly **one** outgoing request in the Network tab (not N).
- **Mixed partial failure** — array where some ids are invalid/already-actioned → per-id `ok:false` with the real reason, batch does **not** throw.
- **Idempotent repeat** — re-send the same array after a successful run → per-id `ok:false` (already actioned), no throw, no duplicate side-effect.
- **Concurrent duplicate** — two identical calls fired together (an LLM retrying on timeout is real) → exactly one effective success, the other returns idempotent `ok:false` or a clean error, no data corruption.
- **Hard cap** — array over the tool's cap (read it from the schema) without `force` → `BATCH_TOO_LARGE`.
- **Force override** — same oversize array with `force: true` → passes without `QUERY_LIMIT_EXCEEDED` (SDK paces it).

### A6. New / changed error code or typed error

- Trigger the condition → assert the **specific** code/message (e.g. `ACCESSDENIEDEXCEPTION`, `status: 401`, the real Bitrix24 action-not-allowed text), not a generic wrapper.

### A7. v2/v3 migration / SDK-helper refactor

- Static: `grep -rn "callMethod" server/ tests/ --include="*.ts"` empty; `grep -rn "actions\." server/mcp/tools/ --include="*.ts"` → any hit piped through `grep "\.make"` empty (any direct `actions.*.{call,batch}.make` is forbidden in tool handlers, not only `v2`/`v3` — helpers only).
- Behavioural: the migrated tool still returns its payload; batch (if any) still one request.

### A8. Logger / redactor touch (`server/utils/logger*`, `bitrix24.ts`)

- Console shows `[INFO] bx24-template-mcp …`.
- **Provoke a retry**: set `NUXT_LOG_LEVEL=debug`, temporarily point `NUXT_BITRIX24_WEBHOOK_URL` at a wrong/slow host (save the original first), call any tool, confirm retry events appear in the **same** channel as app logs, then restore the URL.
- If a redactor changed: run the leak unit tests named in `manage-bx24-template-mcp/SKILL.md` (`sdk-logger-leak`, `logger-redactor`); confirm no webhook URL in raw logs.

### A9. Text-rendering / i18n-sensitive change

- Create/comment with CJK, Arabic (RTL), and a Latin string → assert the tool fires correctly AND the text renders cleanly in the portal. To check RTL: open the task in Bitrix24 → the title/description/comment field → confirm Arabic reads right-to-left without mojibake or reversed punctuation (RTL inside the LTR UI is the classic break).

### A10. Docs / skill edit

- The touched doc opens and reads end-to-end; cross-references resolve; no stale "(lands soon)" / wrong repo name (`templates-dashboard`).

### A11. Auth middleware / connector change (`server/middleware/*`, MCP route, header format)

- **No token** → request to `/mcp` rejected (401).
- **Wrong token** → rejected (401/403).
- **Correct `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>`** → accepted (tools list).
- If the header name/format changed: update `issue-scaffold.md` connector section in the same PR (Rule #5).

---

## Part B — Always-on regression (every run)

Run regardless of what the PR changed — any diff can break these.

### R0 — Static gates (no portal, no server)

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
grep -rn "callMethod" server/ tests/ --include="*.ts"
grep -rn "consola" --include="*.ts"
grep -rn "actions\." server/mcp/tools/ --include="*.ts" | grep "\.make"
grep -rn "lands soon\|lands with MVP" --include="*.md"
```

- [ ] lint clean
- [ ] typecheck clean
- [ ] test:unit all green (confirm the expected count for the branch)
- [ ] `callMethod` → empty
- [ ] `consola` → empty
- [ ] `actions.*.make` in tools/ → empty (helpers only)
- [ ] `lands soon` → empty

### R1 — Setup + startup banner

Compute the expected tool count first: `find server/mcp/tools -name "*.ts" ! -name "*.test.ts" | wc -l`. Then `pnpm install && pnpm dev`.

- [ ] Console: `[mcp-toolkit] /mcp enabled with N tools` — N matches the count above
- [ ] No `callMethod deprecation` warnings
- [ ] Logger format `[INFO] bx24-template-mcp …` present

### R2 — Auth middleware smoke

The `/mcp` route is Bearer-protected — confirm it on every run (a broken middleware silently exposes or blocks everything).

- [ ] No `Authorization` header → 401
- [ ] Wrong token → 401/403
- [ ] Correct `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>` → tools list returned

---

## Part C — Pattern snippets

Copy, fill placeholders, drop into the generated checklist. Each is a *shape*, not a fixed test.

### C1. CRUD smoke skeleton

```
- [ ] `<tool> { <minimal valid args> }` → <documented success payload>, effect visible in portal
- [ ] `list_<entity> { <filter> }` → finds the created record
- [ ] `list_<entity> { <filter matching nothing> }` → [] (empty, no throw)
- [ ] `update_<entity> { id, fields }` → portal reflects
```

### C2. Lifecycle / state-machine skeleton

```
- [ ] `<transition_tool> { id }` → status <N> (<name>)
```
Repeat per transition; assert the numeric status the API returns.

### C3. Batch skeleton (see A5)

```
- [ ] `<tool> { ids: [a,b,c] }` → batch:true, ok:3, failed:0; Network: 1 request
- [ ] same on already-actioned ids → per-id ok:false, no throw
- [ ] over-cap array, no force → BATCH_TOO_LARGE
- [ ] over-cap array, force:true → passes, no QUERY_LIMIT_EXCEEDED
```

### C4. Zod boundary skeleton (see A4)

```
- [ ] <field>: <below-min / negative / over-max / wrong-type> → reject (no REST hit)
```

### C5. Disambiguation skeleton (AI agent)

```
- [ ] "<phrase that means THIS tool>" → <tool>, not <near-neighbour tool>
```
Always pair the positive with the negative it must avoid.

### C6. i18n skeleton (AI agent)

```
- [ ] <CJK phrase>     → <tool> with the right args
- [ ] <Arabic phrase>  → <tool>; check RTL render in portal
- [ ] <Latin phrase>   → <tool>
```

### C7. Confirm-gate skeleton (see A2/A3)

```
- [ ] `<delete_tool> { id }` (no confirm) → *_NEEDS_CONFIRM, target named
- [ ] `<delete_tool> { id, confirmDelete: true }` → gone in UI
- [ ] AI agent: "<phrase without consent>" → does NOT set confirmDelete (Rule #9)
```

---

## Part D — Teardown (run last)

Every check that creates a record adds it to the teardown list. Clean up in **reverse dependency order** so children go before parents:

```
checklist items / results / elapsed entries / dependencies
  → comments
    → tasks (incl. bulk-seeded pending tasks)
```

- [ ] Delete created child records (`delete_*` with `confirmDelete: true`; batch with `force: true` for the bulk-seeded tasks).
- [ ] Delete created tasks.
- [ ] Close the feedback issue created in the test repo (if A1/feedback was exercised) as `wontfix`.

If the test portal is disposable / snapshot-reset between runs, state that here instead and skip teardown — but say so explicitly; "someone will clean it later" is what poisons the next run's `find_user` / `list_tasks`.

---

## Whole-project scope

No fixed block list. Run R0 + R1 + R2, then list the tools with `find server/mcp/tools -name "*.ts" ! -name "*.test.ts"` and apply the recipes to every tool — exactly as for a PR, treating the whole tree as the diff. Group Inspector checks first, AI-agent checks last, teardown after. The static phrase pack in `docs/MANUAL-TEST-PHRASES.md` is a good source for the AI-agent disambiguation lines.

## Project-specific gotchas

- **Dependency read-back is unavailable** upstream (`manage-bx24-template-mcp/SKILL.md` Ground Rule 7) — verify dependency links in the Gantt UI, not via a read tool.
- **Batch caps differ per tool** — read the cap from each tool's Zod schema (`define-action-tool.ts` / the tool file), don't assume a number.
