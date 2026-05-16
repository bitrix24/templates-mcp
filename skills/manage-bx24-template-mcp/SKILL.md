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
2. **Never call Bitrix24 directly.** Always go through `useBitrix24()`. Fallback: `b24.callMethod('rest.method', params)`.
3. **Every tool must have a unit test** in `tests/unit/tools/<name>.test.ts` with the Bitrix24 client mocked.
4. **Every Zod field must have `.describe()`** — the LLM reads it at runtime.
5. **No secrets in code or tests.** Use `useRuntimeConfig()` and `.env`.

## Feedback mechanism

This MCP server exposes `bx24mcp_submit_feedback`. As an AI agent using or developing this MCP, you may invoke it to report issues, suggestions, or positive observations. Each call creates a GitHub issue in `bitrix24/templates-mcp` with the label `agent-feedback`. See [`feedback.md`](./feedback.md) for the calling guide.

## Commit and PR conventions

Full details in `contributing.md` *(lands with MVP)* and root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Short version:

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

Full template lands in `adding-tools.md`.

## When asked to upgrade dependencies

Renovate handles routine updates. For manual upgrades:

1. Read the CHANGELOG.
2. Summarize breaking changes in the PR description.
3. Run the full suite, including integration when `NUXT_BITRIX24_TEST_WEBHOOK_URL` is set.
4. Commit: `chore(deps): bump <package> to <version>`.

## When asked to add a new Bitrix24 method

If the SDK doesn't expose it, use `b24.callMethod('rest.method.name', params)`. Add a one-line comment linking to https://apidocs.bitrix24.com/.

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

## Where to read more

- `contributing.md` — full commit and PR rules (lands soon)
- `adding-tools.md` — tool template and examples (lands soon)
- `testing.md` — running each test layer (lands soon)
- `deployment.md` — `nginx-proxy`, `proxy-net`, health-check (lands soon)
- `troubleshooting.md` — known issues (lands soon)
- [`feedback.md`](./feedback.md) — agent feedback prompts and policy
