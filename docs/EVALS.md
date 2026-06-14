# Automated tool-selection evals

`Last reviewed: 2026-06-14`

## What this is

[`docs/MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md) lists ~80 natural-language phrases you'd manually paste into Claude to verify the MCP. Doing that by hand for 80 phrases on every change is the kind of toil that doesn't get done.

This doc describes the **automated alternative**: an [Evalite](https://github.com/mattpocock/evalite) suite that runs a curated subset of those phrases through **DeepSeek** (an OpenAI-compatible budget LLM) with our tool definitions, and reports which tool the LLM picked first for each phrase.

It is **not** a replacement for the manual phrase pack. The eval covers ~20–30 unambiguous cases — the manual pack covers edge cases, multilingual variations, and queries that require human judgement to verify. Run the eval on every change; run the manual pack before each release.

## What gets measured

For each case in `tests/evals/tool-selection.eval.ts`:

1. The eval registers all current MCP tool definitions with the AI SDK (`description` + `inputSchema`).
2. DeepSeek receives the natural-language phrase as a user prompt.
3. DeepSeek returns a tool call (or text).
4. The scorer checks: does the **first toolName** match `expected`?
5. Score = 1.0 on match, 0.0 on miss. Average score across cases reported.

Tool handlers **do not execute** — the AI SDK omits `execute`, so we only measure *selection* quality, not execution correctness (that's what unit tests are for).

## Running locally

Cost per full run is roughly **$0.002 of DeepSeek tokens** — cheap enough to run on every meaningful change.

```bash
# One-time: register at deepseek.com → settings → API keys → create
export DEEPSEEK_API_KEY=sk-...

# Optional override (defaults to https://api.deepseek.com)
# export DEEPSEEK_BASE_URL=https://api.deepseek.com

pnpm test:evals
```

Sample output:

```
EVALITE running...

 ✓ tests/evals/tool-selection.eval.ts  (23 evals)
 ✓ Bitrix24 tool selection
   ✓ first-tool-exact-match: 21/23 (91%)

      Score  91%
 Eval Files  1
      Evals  23
   Duration  18s
```

Failed cases are listed with: the phrase, the expected tool, the chosen tool, and DeepSeek's reasoning if available.

## Running without a key

`pnpm test:evals` is safe to run without `DEEPSEEK_API_KEY` — the eval registers as **skipped** and the command exits with code 0. CI relies on this: the eval workflow runs only when the secret is configured at the repo level.

## Adding new cases

Edit the `CASES` array in `tests/evals/tool-selection.eval.ts`. Each case is:

```ts
{
  input: '<the natural-language phrase the LLM sees>',
  expected: '<the tool name we want it to call first>',
  notes: '<optional one-liner explaining why this is the right tool>',
}
```

Rules of thumb for good cases:

- **Unambiguous.** If a human reviewer could disagree about which tool should be called first, the case isn't a good signal — leave it for the manual phrase pack.
- **One concept per case.** "Создай задачу для Игоря с дедлайном пятница и приоритетом высокий" tests three things; split into "for Igor" (find_user), "deadline Friday" (create_task), "priority high" (create_task with priority). Granular cases fail in informative ways.
- **Cover at least one phrase per tool.** New tool → new case.
- **Multilingual cases get a numeric id.** When the i18n probe is the point, remove the user-resolution variable by using an explicit numeric id (see `docs/MANUAL-TEST-PHRASES.md` § 14).
- **No PII / no secrets.** The phrase is sent to DeepSeek.

## Scoring threshold

Currently disabled — `evalite.config.ts` does **not** set `scoreThreshold`, so the eval reports without enforcing pass/fail. Once we have a stable baseline (a few real runs in a row at the same score), we'll turn on `scoreThreshold: 80` so the suite hard-fails any regression that drops more than ~20% of cases.

## Why DeepSeek

- OpenAI-compatible API (works with `@ai-sdk/openai`, no special provider).
- Cheap enough to make eval runs disposable.
- Strong instruction-following for tool selection.
- Not Claude — testing the description on a different model surface reveals fragility a Claude-only test would miss.

If you prefer a different OpenAI-compatible model, swap the `baseURL` and `model('…')` string in `tests/evals/tool-selection.eval.ts`.

## CI integration

The CI workflow (`.github/workflows/ci.yml`) does **not** run evals by default — adding `DEEPSEEK_API_KEY` to repo secrets unlocks a nightly eval workflow (queued in `PROJECT-BRIEF.md` Phase 2). For now operators run the eval manually before merging tool-description changes.

## Trace storage

Evalite stores trace data in a local SQLite DB. The path is `.gitignored`. To browse traces interactively:

```bash
pnpm exec evalite serve   # runs the eval suite once and serves the UI on :3006
pnpm exec evalite watch   # same UI, re-runs on file changes (best for iterating on cases)
```

Available subcommands (run `pnpm exec evalite --help` to see all flags):

| Command | What it does |
|---|---|
| `evalite` | Default — runs evals once and exits (what `pnpm test:evals` calls). |
| `evalite run` | Same as the default. |
| `evalite serve` | Runs once + serves the UI at `http://localhost:3006`. |
| `evalite watch` | Watch mode: UI + re-runs on file changes. |
| `evalite export --output dir/` | Static HTML bundle for CI artifacts. |
