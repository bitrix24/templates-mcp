# Contributing to bx24-template-mcp

Thanks for considering a contribution. This document describes how to land code.

## Quick start

```bash
git clone https://github.com/bitrix24/templates-mcp.git
cd templates-mcp
cp .env.example .env
# edit .env: set NUXT_BITRIX24_WEBHOOK_URL and NUXT_MCP_AUTH_TOKEN
pnpm install
pnpm dev
```

Verify the server is up:

```bash
curl http://localhost:3000/api/health
```

Open Nuxt DevTools (in the browser console it prints the URL) and pick the MCP Inspector tab to debug tools interactively.

## Branches

- Base branch is `main`.
- Feature branches: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- Agent-authored branches: `claude/<short-name>-<random>`.
- No work directly on `main`. Branch protection enforces PR + green CI.

## Conventional Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/).

Prefixes: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `ci`, `perf`, `build`, `revert`.
Optional scopes: `tools`, `client`, `auth`, `deploy`, `evals`, `skill`, `feedback`, `deps`, `docs`, `ci`.

Examples:

```
feat(tools): add list-deals
fix(client): handle 429 from Bitrix24 with exponential backoff
docs(adding-tools): clarify Zod describe step
chore(deps): bump @nuxtjs/mcp-toolkit to 0.15.3
ci: run evals only when DEEPSEEK_API_KEY secret is set
```

`commitlint` rejects invalid messages in CI.

## Pull Requests

- PR title must follow Conventional Commits — it is squashed into the commit message.
- Fill in every section of the PR template.
- Multiple commits per PR are fine. **Do not** rebase or force-push to an open PR.
- Don't mix unrelated changes — one concern per PR.
- Link the issue: `Closes #N` or `Refs #N`.
- Don't edit tracking labels in the template (`<!-- /track -->`).

### Before opening a PR

Run locally:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

All three must pass. The CI re-runs them — and your PR will be blocked if anything fails.

### CI gates

On every PR:

1. `pnpm install --frozen-lockfile`
2. `commitlint` checks PR title and every commit
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test` (unit; evals run only when `DEEPSEEK_API_KEY` secret is present)
6. Integration tests run only when `NUXT_BITRIX24_TEST_WEBHOOK_URL` secret is present

Branch protection on `main` requires every gate green.

## Tests

Every code-bearing PR adds or updates tests. Three layers:

| Layer | Command | When |
|---|---|---|
| Unit | `pnpm test:unit` | Always |
| Integration | `pnpm test:integration` | When you change network behavior, requires `NUXT_BITRIX24_TEST_WEBHOOK_URL` (point at an isolated test portal — see Secrets) |
| Evals | `pnpm test:evals` | When you add or change a tool description, requires `DEEPSEEK_API_KEY` |

See `docs/TESTING.md` for details *(lands with MVP)*.

## Adding a new MCP tool

Short version:

1. Pick a group: `tasks` / `deals` / `contacts` / `users` / `meta`.
2. Create `server/mcp/tools/<group>/<kebab-name>.ts` (file-based discovery).
3. Use `defineMcpTool({ name, description, inputSchema, handler })`.
4. Name pattern: `bitrix24_<verb>_<entity>` for Bitrix24 tools, `bx24mcp_<verb>` for meta-tools.
5. Every Zod field gets `.describe()` — the LLM reads it at runtime.
6. Call Bitrix24 via `useBitrix24()`. Never bypass.
7. Add a unit test in `tests/unit/tools/<name>.test.ts` mocking `useBitrix24`.
8. Optionally add an eval case in `tests/evals/tool-selection.eval.ts`.
9. Commit: `feat(tools): add bitrix24_<name>`.

Full guide lands in `docs/ADDING-TOOLS.md` *(lands with MVP)*.

## Secrets

- Never commit secrets. `.env` is gitignored; `.env.example` is the contract.
- CI secrets live in GitHub Actions. Production secrets live in the server `.env` only.
- If you accidentally commit a secret: rotate it immediately, then open a PR removing it (history scrub is a separate operation).
- `NUXT_BITRIX24_TEST_WEBHOOK_URL` (locally) and `BITRIX24_TEST_WEBHOOK_URL` (GitHub Actions secret) must point at an isolated/staging Bitrix24 portal — the integration suite issues live REST calls and should never run against production data.
- The `Integration tests (Bitrix24)` CI job is informational: it is skipped on forks and emits a warning (not a failure) when the secret is absent, so do not promote it to a required status check.

## Dependency updates

[Renovate Bot](./renovate.json) handles routine updates.

- Patch + digest: auto-merged when CI is green.
- Minor (1.x+): manual review.
- Minor (0.x): manual review (semver pre-1.0 minor is breaking).
- Major: always manual review, `needs-review` label.
- `@bitrix24/b24jssdk*` and the MCP stack: always manual review.

Don't bypass Renovate by hand-editing `package.json` for routine bumps. Coordinated upgrades (multiple related packages) are fine — explain why in the PR.

## Reporting bugs and proposing features

- Bugs: open a [bug_report](./.github/ISSUE_TEMPLATE/bug_report.md) issue.
- Features: open a [feature_request](./.github/ISSUE_TEMPLATE/feature_request.md) issue.
- AI-agent feedback (issues found by automated callers): automatic via `bx24mcp_submit_feedback` — see [`docs/FEEDBACK.md`](./docs/FEEDBACK.md).

## Code of conduct

Be kind, be direct, assume good intent. No personal attacks. Maintainers reserve the right to close discussions that drift from the technical issue at hand.
