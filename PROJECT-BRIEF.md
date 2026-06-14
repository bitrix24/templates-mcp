# Bitrix24 MCP Server — Project Brief

> **Status**: active development, pre-v1. This document is the source of truth for what we are building. Shipped tooling lives on `main`; new capabilities branch off `feat/*` or `claude/*`.

## Goal

Build a **starter template** for Model Context Protocol (MCP) servers on top of Bitrix24, so anyone forking the repo gets a production-grade Nuxt + Nitro project with the auth, throttling, logging, and test scaffolding already wired up. Ship a small, honest set of example tools (tasks, users, meta) — and the structure to add their own. The template itself must stay production-ready, testable, extensible, and easy to maintain. Start small, grow incrementally.

## Project coordinates

- **Repository**: https://github.com/bitrix24/templates-mcp
- **Production domain**: `prod.example.com`
- **Eval LLM**: DeepSeek (OpenAI-compatible API)
- **Production posture**: server is self-sufficient, GitHub Actions deploys on `v*` tag, `nginx-proxy` + `acme-companion` are already running on the host and serve the `proxy-net` network

## Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22+ | LTS, native `fetch`, ESM. CI / Docker / `package.json#engines` all align on 22. |
| Language | TypeScript 6.x (strict) | Type safety, IDE support |
| Framework | Nuxt 4.x (Nitro) | Base for `@nuxtjs/mcp-toolkit`, h3 as HTTP layer, auto-imports |
| MCP toolkit | `@nuxtjs/mcp-toolkit` ^0.17 | File-based discovery, Inspector, Evalite, Agent Skills, Code Mode |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.29 | Pulled in by the toolkit, current transport |
| Bitrix24 client | `@bitrix24/b24jssdk-nuxt` | Official Nuxt wrapper around `@bitrix24/b24jssdk` |
| UI components | `@bitrix24/b24ui-nuxt` | Vue component system Bitrix24 uses internally (Reka UI + Tailwind + Tailwind Variants). Powers the landing page and any future client-facing surface (OAuth setup, admin panels). |
| Icons | `@bitrix24/b24icons-vue` | Tree-shakeable icon set, subpath imports (`/social`, `/solid`, `/outline`, …) |
| CSS engine | Tailwind CSS 4 | Required by `@bitrix24/b24ui-nuxt`. Use semantic tokens (`bg-elevated`, `text-description`, `air-primary`, `air-secondary-no-accent`) — never raw palette like `text-gray-500`. |
| Validation | Zod | Used by toolkit for input schemas |
| Package manager | pnpm 11.x (pinned via `packageManager`) | Idiomatic for Nuxt, fast, disk-efficient. The versions in this table track `package.json` — bump them together when Renovate lands a major. |
| Tests | Vitest + Evalite + `@ai-sdk/mcp` | Unit + AI-evaluation, as recommended by the toolkit |
| Eval LLM | DeepSeek (`deepseek-chat`) | OpenAI-compatible API, cheap, budget approved |
| Lint | ESLint (Nuxt config, flat) | Nuxt ecosystem standard; formatting is delegated to `.editorconfig` |
| Containerization | Docker multi-stage | Reproducible builds, Nitro `node-server` preset |
| Reverse proxy | `nginxproxy/nginx-proxy` + `acme-companion` | Already deployed, auto-HTTPS via env |
| Dependency updates | Renovate Bot | Automated PRs, grouping, patch auto-merge |
| CI/CD | GitHub Actions | Free for public repos, tests + build + deploy |
| License | MIT | Per requirement |

## Repository layout

```
bx24-template-mcp/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                       # lint + typecheck + tests on every PR
│   │   └── deploy.yml                   # build & publish image on v* tag
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md
│       ├── feature_request.md
│       └── agent_feedback.md            # template for feedback from AI agents
├── renovate.json                        # Renovate Bot configuration
├── server/
│   ├── mcp/
│   │   ├── tools/                       # file-based discovery
│   │   │   ├── tasks/                    # 27 tools: core CRUD shown +
│   │   │   │   ├── create-task.ts        #   lifecycle verbs, checklist, results,
│   │   │   │   ├── list-tasks.ts         #   elapsed-time, dependencies
│   │   │   │   ├── update-task.ts
│   │   │   │   └── add-task-comment.ts   # … + 23 more
│   │   │   ├── users/
│   │   │   │   ├── current-user.ts
│   │   │   │   └── find-user.ts
│   │   │   └── meta/
│   │   │       └── submit-feedback.ts   # meta MCP tool for agent feedback
│   │   ├── resources/
│   │   │   └── pipelines.ts             # Phase 2
│   │   ├── prompts/
│   │   │   └── weekly-report.ts         # Phase 2
│   │   └── middleware/
│   │       └── auth.ts                  # Bearer token check
│   ├── utils/
│   │   ├── bitrix24.ts                  # singleton wrapper over b24jssdk
│   │   ├── errors.ts                    # Bitrix24 → MCP error mapping
│   │   └── github-feedback.ts           # GitHub API client for issue creation
│   ├── plugins/
│   │   └── bitrix24.server.ts
│   └── api/
│       └── health.get.ts
├── tests/
│   ├── unit/
│   │   ├── bitrix24.test.ts
│   │   ├── github-feedback.test.ts
│   │   └── tools/
│   │       ├── create-task.test.ts
│   │       └── submit-feedback.test.ts
│   ├── integration/
│   │   └── bitrix24.test.ts
│   └── evals/
│       └── tool-selection.eval.ts
├── skills/
│   └── manage-bx24-template-mcp/
│       ├── SKILL.md
│       ├── adding-tools.md
│       ├── testing.md
│       ├── troubleshooting.md
│       ├── deployment.md
│       ├── contributing.md
│       └── feedback.md                  # when and how an AI should send feedback
├── docs/                                # shipped: README, AGENT, ARCHITECTURE,
│   ├── README.md                        #   DEPLOYMENT, EVALS, FEEDBACK, MANUAL-TEST-PHRASES,
│   ├── AGENT.md                         #   REVERSE-PROXY, RUNBOOK, SECURITY, SECURITY-AUDIT.
│   ├── ARCHITECTURE.md                  # the rest below are planned stubs.
│   ├── DEPLOYMENT.md
│   ├── EVALS.md
│   ├── FEEDBACK.md
│   ├── MANUAL-TEST-PHRASES.md
│   ├── REVERSE-PROXY.md
│   ├── RUNBOOK.md
│   ├── SECURITY.md
│   ├── SECURITY-AUDIT.md
│   ├── ADDING-TOOLS.md
│   └── TESTING.md                       # planned
├── CONTRIBUTING.md
├── commitlint.config.js
├── nuxt.config.ts
├── tsconfig.json
├── vitest.config.ts
├── evalite.config.ts
├── package.json
├── pnpm-lock.yaml
├── .env.example
├── .gitignore
├── .dockerignore
├── .editorconfig
├── eslint.config.mjs
├── Dockerfile
├── docker-compose.yml
├── docker-compose.example.yml
├── LICENSE
└── README.md
```

## Agent skills

Agent-facing guidance lives under `skills/`. Primary entry point is [`skills/manage-bx24-template-mcp/SKILL.md`](./skills/manage-bx24-template-mcp/SKILL.md) — ground rules, when-to-do-X recipes, the UI / frontend section that points at b24ui's upstream [`llms.txt`](https://bitrix24.github.io/b24ui/llms.txt) and [skill](https://github.com/bitrix24/b24ui/tree/main/skills/b24-ui-nuxt). Skills are exposed to connected AI clients at runtime via [`@nuxtjs/mcp-toolkit`'s Agent Skills feature](https://mcp-toolkit.nuxt.dev/getting-started/agent-skills).

## Functional requirements

### MVP (Phase 1)

- Bitrix24 auth via **incoming webhook** (env: `NUXT_BITRIX24_WEBHOOK_URL`). MVP uses test portal.
- MCP server on Nitro over h3, exposed at `/mcp` (Streamable HTTP).
- Bearer auth via middleware (env: `NUXT_MCP_AUTH_TOKEN`).
- 5 base tools:
  1. `b24_task_create`
  2. `b24_task_list`
  3. `b24_task_update`
  4. `b24_task_comment_add`
  5. `b24_user_me`
- **Meta-tool `bx24mcp_submit_feedback`** — lets the AI agent submit feedback (positive/issue/suggestion). Each call creates a GitHub issue in `bitrix24/templates-mcp` with label `agent-feedback` (see "Agent Feedback" section).
- Inspector in Nuxt DevTools for tool debugging during development.
- Structured logging via the SDK's own `Logger` system (`@bitrix24/b24jssdk`'s `Logger` + `ConsoleHandler`), wired into `useBitrix24()` via `client.setLogger(useLogger())` so SDK retry / rate-limit / 503 events flow through the same channel as app logs. See `server/utils/logger.ts`.
- `/api/health` endpoint, no auth.

### Phase 2 (starts immediately after MVP, no waiting for feedback)

Tooling depth on tasks (concrete gap analysis lives in [`docs/MANUAL-TEST-PHRASES.md`](./docs/MANUAL-TEST-PHRASES.md) — phrase pack for verifying each tool against a real LLM):

- **Task lifecycle**: `start`, `pause`, `complete`, `approve`, `disapprove`, `defer`, `renew` — 7 thin v3 wrappers around `tasks.task.*` REST methods. ✅ **Shipped in PR #5** (also added `b24_task_rate` for the `MARK` field). Follow-ups for the full lifecycle (`accept` / `decline` / `delegate`) tracked in issue #8; bulk operations + rate-limit in #7.
- **Checklists**: `add_checklist_item`, `list_checklist_items`, `complete_checklist_item`, `renew_checklist_item`, `delete_checklist_item` — flat tree with `PARENT_ID` nesting, v2 namespace `task.checklistitem.*` (no v3 equivalent). ✅ **Shipped in PR #17** (includes single-RTT v2 batching via the `batchV2` helper and `confirmDeleteHeading` safety gate on heading deletion).
- **Comments — read**: `list_task_comments` over the new `tasks.task.chat.message.list`. Default filter strips service messages ("user X changed Y"). Also migrate the existing write tool from the deprecated `task.commentitem.add` to `tasks.task.chat.message.send`.
- **Subtasks**: extend `b24_task_create` schema with optional `parentId`. No new tool; `b24_task_list` already supports `PARENT_ID` filter via the generic filter object.
- **Time tracking**: `b24_task_elapsed_time_add`, `b24_task_elapsed_time_list`, `b24_task_elapsed_time_update`, `b24_task_elapsed_time_delete` over `task.elapseditem.*` (full CRUD — operators correct mis-clicked durations and clean up duplicate entries; PR-B).
- **Task dependencies**: `b24_task_dependency_add`, `b24_task_dependency_remove` over `tasks.task.dependence.*`. No read-back tool — Bitrix24 deprecated `task.item.getdependson` server-side with no v3 replacement (issue #33 smoke confirmed the endpoint no longer returns predecessors). Operators inspect existing links via the Bitrix24 UI until upstream ships a v3 endpoint or `tasks.task.get` exposes a `dependsOn` select field.

Infrastructure:

- **MCP resources** for static dictionaries (pipelines, stages, users) with TTL cache
- **MCP prompts** for typical scenarios
- **Client-side rate limiting** on Bitrix24 (2 req/sec, queue) — ✅ **provided by the SDK out of the box**. `@bitrix24/b24jssdk` 1.1+ ships `RestrictionManager` (leaky-bucket, default burst 50 / drain 2 req/sec, adaptive delay on `QUERY_LIMIT_EXCEEDED`, retry × 3 with backoff), initialised in `B24Hook`'s constructor via `ParamsFactory.getDefault()`. No project-side wrapper. Configurable per-tariff (`getEnterprise`, `getBatchProcessing`, `getRealtime`). Issue #7's bulk input on the 8 mutation tools shipped on top of this.
  - **Temporary local fix awaiting an SDK update** (issue #127, upstream [`bitrix24/b24jssdk#46`](https://github.com/bitrix24/b24jssdk/issues/46)): the `RestrictionManager` retries the permanent tasks rejection `1048582` ("action not available", returned on invalid lifecycle transitions like pausing an already-paused task) 3× before failing, instead of failing fast. As a stopgap, `server/utils/bitrix24.ts` registers `1048582` as a `hardErrorCode` so it is treated as non-retryable. **Once the SDK ships the upstream fix (#46), remove this local override** and rely on the SDK's built-in classification.

### Bitrix24 surface expansion (post-release — incremental, via the new-tool process)

**Out of scope until after the `v0.1.0` pilot tag.** The pre-release roadmap intentionally stops at the tasks domain — see resolved question #7 below. Once `v0.1.0` is in production and the pilot is generating signal, the toolset grows entity by entity rather than as one big committed block. Every addition follows [`docs/ADDING-TOOLS.md`](./docs/ADDING-TOOLS.md) (mirror for agents: [`skills/manage-bx24-template-mcp/adding-tools.md`](./skills/manage-bx24-template-mcp/adding-tools.md)) — one tool per PR with Zod schema, unit tests, eval cases, and a description tightened against the persona walk.

First expansion zone is CRM:

- **Deals**: create, list, move through stages
- **Contacts**: create, list, search by phone/email
- Further CRM entities (companies, leads, invoices, …) when the pilot asks for them

After CRM, the same process covers whatever Bitrix24 surface area `bx24mcp_submit_feedback` signal points at — no fixed delivery order, demand-driven only.

### Phase 3

- OAuth 2.0 via `B24OAuth` instead of webhook
- Multi-tenant (several portals per instance)
- Batch operations via REST `batch` method
- Code Mode (`experimental_codeMode` from toolkit)

## Non-functional requirements

- **License**: MIT
- **Documentation**: English, lives in `docs/` and `skills/`
- **Tests**: mandatory for each tool. Three layers:
  - **unit** — mock Bitrix24 client, validate schema and handler
  - **integration** — real test portal optional (`NUXT_BITRIX24_TEST_WEBHOOK_URL`)
  - **evals** — Evalite + DeepSeek, tool-selection on natural language
- **Transparency**: structured logs, request IDs, no hidden state
- **Extensibility**: file-based discovery
- **Secrets**: never committed, locally from `.env`, in prod from GitHub Actions secrets

## Agent Feedback — built-in feedback channel

Idea: every AI agent that uses this MCP must have a way to report good or bad experience — and that feedback must land in the repository's issue tracker, not get lost in logs.

### Why it matters

- Structured stream of suggestions from real AI agents in production, not just humans
- Track patterns: which tools are unclear, which descriptions need work, which combinations break
- Quickly retrain agents via prompt engineering because concrete cases are visible

### How it works

The MCP server has a dedicated tool — `bx24mcp_submit_feedback`. This is **not** a Bitrix24 tool, it's a meta-tool of the MCP itself. The AI agent calls it on its own when it wants to leave feedback.

```typescript
// server/mcp/tools/meta/submit-feedback.ts
import { z } from 'zod';
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server';
import { createGithubIssue } from '~/server/utils/github-feedback';

export default defineMcpTool({
  name: 'bx24mcp_submit_feedback',
  description: 'Submit feedback about the bx24-template-mcp server. Use this when you want to report a problem, suggest an improvement, or share a positive observation about your experience using this MCP. Each call creates a GitHub issue.',
  inputSchema: {
    kind: z.enum(['positive', 'issue', 'suggestion']).describe('Type of feedback'),
    summary: z.string().min(5).max(200).describe('Short summary, one line'),
    details: z.string().min(10).describe('Full details: what happened, what was expected, why it matters'),
    relatedTool: z.string().optional().describe('Name of the related MCP tool, if applicable (e.g. "b24_task_create")'),
    severity: z.enum(['low', 'medium', 'high']).optional().describe('How urgent this is, optional'),
  },
  handler: async ({ kind, summary, details, relatedTool, severity }) => {
    const issueUrl = await createGithubIssue({
      title: `[agent-feedback/${kind}] ${summary}`,
      body: buildIssueBody({ kind, details, relatedTool, severity }),
      labels: ['agent-feedback', `feedback:${kind}`, ...(relatedTool ? [`tool:${relatedTool}`] : [])],
    });
    return `Feedback submitted: ${issueUrl}`;
  },
});
```

### GitHub integration (`server/utils/github-feedback.ts`)

Thin client over the GitHub REST API (via `@octokit/rest` or `fetch`). Uses a Personal Access Token from env `NUXT_GITHUB_FEEDBACK_TOKEN`. The token must have `repo:public_repo` and `issues:write` on `bitrix24/templates-mcp`.

Cache the token on startup, reuse. On issue-creation failure — log it, but return a clean response to the agent so it doesn't loop on retries.

### Issue template (`.github/ISSUE_TEMPLATE/agent_feedback.md`)

Used as a reference for agent feedback — real issues are created programmatically, but the template documents the expected structure and helps maintainers triage quickly.

```markdown
---
name: Agent feedback
about: Feedback submitted by an AI agent via bx24mcp_submit_feedback
labels: agent-feedback
---

**Kind**: positive | issue | suggestion
**Related tool**: <name or n/a>
**Severity**: low | medium | high | n/a

## Summary

<short summary>

## Details

<full details from the agent>

## Reproduction context (if applicable)

<conversation excerpt, parameters used, expected vs actual>

---
_Submitted programmatically by `bx24mcp_submit_feedback`_
```

### Agent prompts

Concrete instructions for "when and how the agent should call `bx24mcp_submit_feedback`" will be refined later — here we only fix that the **mechanism exists** on the MCP side. Once finalised, prompts will live in `skills/manage-bx24-template-mcp/feedback.md` and `docs/FEEDBACK.md`.

Placeholder for `feedback.md`:

```markdown
# Agent Feedback Guide

> **Status**: prompt details to be finalized. This is a placeholder describing the available mechanism.

This MCP exposes a `bx24mcp_submit_feedback` tool so AI agents can report their experience. Concrete guidance on **when** and **how** an agent should use it (positive cases, error patterns, severity thresholds, suggested wording) will be added here in a follow-up PR.

For now, agents may use this tool whenever they notice:

- A tool description that was ambiguous or led to a wrong call
- An unexpected error or behavior from a Bitrix24 operation
- A missing capability that would be valuable
- A positive pattern worth keeping (rarer, but useful as a signal)

Each submission creates a GitHub issue in `bitrix24/templates-mcp` with the `agent-feedback` label.
```

### Feedback security

- GitHub token is isolated in a single file (`server/utils/github-feedback.ts`)
- Rate limit on the MCP server: max 5 issues/hour per MCP token, to prevent flooding (expandable if needed)
- Feedback content is sanitised: truncated to 10000 chars, Markdown control chars escaped
- In eval tests `submit-feedback` is mocked and does not create real issues

## Renovate Bot — automated dependency updates

`renovate.json` lives at the repo root. Renovate runs as a GitHub App (free for public repos), opens PRs for updates, groups by rules.

### `renovate.json`

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "config:recommended",
    ":semanticCommits",
    ":semanticCommitTypeAll(chore)",
    ":dependencyDashboard"
  ],
  "timezone": "Europe/Minsk",
  "schedule": ["after 2am and before 7am every weekday"],
  "labels": ["dependencies"],
  "prConcurrentLimit": 5,
  "prHourlyLimit": 2,
  "rangeStrategy": "bump",
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": ["before 6am on monday"]
  },
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "pin", "digest"],
      "automerge": true,
      "automergeType": "pr",
      "platformAutomerge": true
    },
    {
      "matchUpdateTypes": ["minor"],
      "matchCurrentVersion": "!/^0/",
      "automerge": false
    },
    {
      "matchPackageNames": ["@bitrix24/b24jssdk", "@bitrix24/b24jssdk-nuxt"],
      "groupName": "bitrix24 sdk",
      "automerge": false,
      "reviewers": ["IgorShevchik"]
    },
    {
      "matchPackageNames": ["@nuxtjs/mcp-toolkit", "@modelcontextprotocol/sdk"],
      "groupName": "mcp stack",
      "automerge": false,
      "reviewers": ["IgorShevchik"]
    },
    {
      "matchPackagePatterns": ["^@types/"],
      "groupName": "types",
      "automerge": true
    },
    {
      "matchPackagePatterns": ["eslint"],
      "groupName": "linters",
      "automerge": true
    },
    {
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["dependencies", "needs-review"]
    }
  ],
  "vulnerabilityAlerts": {
    "enabled": true,
    "labels": ["security"],
    "automerge": false
  }
}
```

### Policy

- **Patch and digest** — auto-merge if CI is green (lint, typecheck, unit, eval)
- **Minor for stable (1.x+) packages** — PR opened, manual review required
- **Minor for 0.x packages** — NOT auto-merged (pre-1.0 minor == breaking in semver)
- **Major** — always manual review + `needs-review` label
- **`@bitrix24/b24jssdk*` and `mcp stack`** — critical path, always manual review, maintainer notified
- **Types and linters** — grouped auto-merge
- **Vulnerabilities** — separate workflow, `security` label, no auto-merge (eyes-on)
- **Lock file maintenance** — weekly on Mondays, keeps lockfile clean
- **Schedule**: weekday nights only (Europe/Minsk), no working-hour noise
- **Limits**: max 5 concurrent PRs and 2 new per hour

### Onboarding

1. Install Renovate GitHub App on the repo (https://github.com/apps/renovate)
2. Renovate opens the initial onboarding PR
3. Merging the onboarding PR activates the config

Detail: Renovate creates a "Dependency Dashboard" issue summarising every pending update.

## Production server — self-sufficiency

The server is configured once, then runs unattended:

- **nginx-proxy + acme-companion** already run as a separate compose stack in `/opt/nginx-proxy/docker-compose.yml`. Containers use `restart: always` and survive reboot.
- **`proxy-net` network** exists as `external`, containers join via `networks: proxy-net`.
- **acme-companion** issues and renews TLS certs for any container that sets `LETSENCRYPT_HOST`.
- **MCP service** uses `restart: always`, starts with Docker, survives reboot.
- **Deployment**: GitHub Actions on `v*` tag builds and pushes the image to GHCR. The operator deploys via Watchtower (automatic) or `make redeploy` on the host (manual). CI has no SSH access to production.
- **Monitoring**: external UptimeRobot/Healthchecks.io pings `/api/health` once a minute (optional, not in MVP).
- **Logs**: Docker JSON driver with rotation; long-term retention (Loki/Graylog) is out of scope.

No host-level cron or systemd units — everything is in Docker.

## Contributing and Pull Requests

Section in `CONTRIBUTING.md`, mirrored in `skills/manage-bx24-template-mcp/contributing.md` for AI agents.

### Conventional Commits

Prefixes: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `ci`.
Optional scopes: `tools`, `client`, `auth`, `deploy`, `evals`, `skill`, `feedback`, `deps`.

Examples:

```
feat(tools): add list-task-comments
fix(client): handle 429 from Bitrix24 with exponential backoff
docs(adding-tools): clarify Zod describe step
chore(deps): bump @nuxtjs/mcp-toolkit to 0.15.3
ci: run evals only when DEEPSEEK_API_KEY secret is set
feat(feedback): persist tool name in issue title
```

`commitlint` enforces this in CI. Invalid messages are rejected.

### Pull Requests

- PR template is mandatory — `.github/PULL_REQUEST_TEMPLATE.md`, every section filled in
- PR title must follow Conventional Commits (Squash and Merge)
- Multiple commits per PR are fine, no rebase/force-push
- Before opening:
  - `pnpm lint` green
  - `pnpm typecheck` green (`nuxt typecheck`)
  - `pnpm test` green (unit + evals when `DEEPSEEK_API_KEY` is set)
- Don't mix unrelated changes
- Link to issue (`Closes #N` / `Refs #N`)
- Don't touch tracking labels in the template

### PR template

```markdown
<!-- PR title MUST follow Conventional Commits — squashed as commit message. -->

## Summary

<!-- 1–3 sentences -->

## Type of change

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] chore
- [ ] test
- [ ] refactor
- [ ] ci

## Linked issue

<!-- Closes #N / Refs #N -->

## Checklist

- [ ] PR title follows Conventional Commits
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] New/changed code has tests
- [ ] Public-facing changes reflected in `docs/` and `skills/`
- [ ] No unrelated changes
- [ ] No secrets in code, tests, or CI logs

## Screenshots / logs

## Notes for reviewers

<!-- /track -->
```

### CI on PRs (`.github/workflows/ci.yml`)

1. `pnpm install --frozen-lockfile`
2. `commitlint` (PR title + all commits)
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test` (unit; evals when `DEEPSEEK_API_KEY` is present)
6. Integration tests — when `NUXT_BITRIX24_TEST_WEBHOOK_URL` is present

Branch protection on `main` — merge only on green CI.

## Environment variables (`.env.example`)

```bash
# Bitrix24
NUXT_BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/your-user-id/your-webhook-code/

# MCP server
NUXT_MCP_AUTH_TOKEN=generate_via_openssl_rand_hex_32

# GitHub feedback
NUXT_GITHUB_FEEDBACK_TOKEN=ghp_xxx
NUXT_GITHUB_FEEDBACK_REPO=bitrix24/templates-mcp

# Eval LLM (optional, tests only)
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com

# Application
NODE_ENV=production
NUXT_LOG_LEVEL=info
NITRO_PORT=3000

# nginx-proxy + acme-companion
VIRTUAL_HOST=prod.example.com
VIRTUAL_PORT=3000
LETSENCRYPT_HOST=prod.example.com
```

## Nuxt config (`nuxt.config.ts`)

```typescript
export default defineNuxtConfig({
  modules: [
    '@nuxtjs/mcp-toolkit',
    '@bitrix24/b24jssdk-nuxt',
  ],
  mcp: {
    endpoint: '/mcp',
    name: 'bx24-template-mcp',
    version: '1.0.0',
  },
  runtimeConfig: {
    bitrix24WebhookUrl: '',
    mcpAuthToken: '',
    githubFeedbackToken: '',
    githubFeedbackRepo: 'bitrix24/templates-mcp',
    logLevel: 'info',
  },
  nitro: {
    preset: 'node-server',
  },
});
```

## Bitrix24 client (`server/utils/bitrix24.ts`)

```typescript
import { B24Hook } from '@bitrix24/b24jssdk'
import { useLogger } from '~/server/utils/logger'

let client: B24Hook | null = null

export function useBitrix24(): B24Hook {
  if (client) return client

  const { bitrix24WebhookUrl } = useRuntimeConfig()
  if (!bitrix24WebhookUrl) {
    throw new Error('NUXT_BITRIX24_WEBHOOK_URL is not configured')
  }

  // SDK 1.1+ exposes a static factory that parses portal host / user id /
  // secret out of the full webhook URL. The raw constructor (`new B24Hook(url)`)
  // was removed in SDK 1.1.
  try {
    client = B24Hook.fromWebhookUrl(bitrix24WebhookUrl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `NUXT_BITRIX24_WEBHOOK_URL is not a valid Bitrix24 webhook URL: ${reason}`,
    )
  }

  // Wire the SDK's internal events (retry, rate-limit, errors) into our
  // structured logger. One sink for app + SDK events.
  client.setLogger(useLogger())
  return client
}
```

Tool handlers do not call `client.actions.*.make` directly — they go through
`callV3<T>` / `callV2<T>` / `batchV3<T>` from `server/utils/sdk-helpers.ts`,
which own the `isSuccess` / `getErrorMessages` / transport-error funnel
once for the whole project. The deprecated `b24.callMethod` is forbidden
(removed in SDK 2.0).

In Phase 3, `useBitrix24OAuth()` joins it.

## Tests

**Eval tests with DeepSeek** (`tests/evals/tool-selection.eval.ts`):

```typescript
import { evalite } from 'evalite';
import { toolCallAccuracy } from 'evalite/scorers';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const deepseek = createOpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

evalite('Bitrix24 tool selection', {
  data: async () => [
    {
      input: 'Create task "Approve contract" with deadline Friday for user 5',
      expected: [{ toolName: 'b24_task_create', input: { title: 'Approve contract', responsibleId: 5 } }],
    },
    {
      input: 'Show my overdue tasks',
      expected: [{ toolName: 'b24_task_list', input: { mine: true, status: 'overdue' } }],
    },
  ],
  task: async (input) => {
    const mcp = await createMCPClient({
      transport: {
        type: 'http',
        url: process.env.MCP_URL!,
        headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` },
      },
    });
    try {
      const result = await generateText({
        model: deepseek('deepseek-chat'),
        prompt: input,
        tools: await mcp.tools(),
      });
      return result.toolCalls ?? [];
    } finally {
      await mcp.close();
    }
  },
  scorers: [({ output, expected }) => toolCallAccuracy({ actualCalls: output, expectedCalls: expected })],
});
```

Evalite UI at `http://localhost:3006`.

## Docker

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.output ./.output
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", ".output/server/index.mjs"]
```

## `docker-compose.yml`

```yaml
name: ${COMPOSE_PROJECT_NAME:-bx24-mcp}
services:
  bx24-template-mcp:
    image: ghcr.io/bitrix24/templates-mcp:latest
    container_name: ${COMPOSE_PROJECT_NAME:-bx24-mcp}-app
    restart: always
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
    environment:
      NUXT_BITRIX24_WEBHOOK_URL: ${NUXT_BITRIX24_WEBHOOK_URL}
      NUXT_MCP_AUTH_TOKEN: ${NUXT_MCP_AUTH_TOKEN}
      NUXT_GITHUB_FEEDBACK_TOKEN: ${NUXT_GITHUB_FEEDBACK_TOKEN}
      NUXT_GITHUB_FEEDBACK_REPO: ${NUXT_GITHUB_FEEDBACK_REPO}
      NUXT_LOG_LEVEL: ${NUXT_LOG_LEVEL}
      NITRO_PORT: ${NITRO_PORT}
      NODE_ENV: ${NODE_ENV}
      VIRTUAL_HOST: ${VIRTUAL_HOST}
      VIRTUAL_PORT: ${VIRTUAL_PORT}
      LETSENCRYPT_HOST: ${LETSENCRYPT_HOST}
      LETSENCRYPT_EMAIL: ${LETSENCRYPT_EMAIL}
    networks:
      - proxy-net
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  proxy-net:
    external: true
```

## Build & publish via GitHub Actions

`.github/workflows/deploy.yml`, triggered by `v*` tag push:

1. pnpm + Node 22
2. `pnpm install --frozen-lockfile`
3. `pnpm lint && pnpm typecheck && pnpm test:unit`
4. Docker image build (multi-platform buildx)
5. Push to `ghcr.io/bitrix24/templates-mcp:VERSION` and `:latest`
6. Build `.dxt` bundle and attach to GitHub Release

CI does **not** SSH into production. The operator pulls the new image via Watchtower or `make redeploy`.

Secrets needed in GitHub Actions:

- `NUXT_GITHUB_FEEDBACK_TOKEN` (passed to the container on the server)
- `NUXT_BITRIX24_TEST_WEBHOOK_URL` (optional, for integration tests)
- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (eval)

## Wiring up Claude

1. Claude.ai → Settings → Connectors → Add custom connector
2. Name: `Bitrix24 (b24-mcp)`
3. URL: `https://prod.example.com/mcp`
4. Advanced → Custom header: `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>`
5. Save, enable in chat, verify with "Show me my Bitrix24 current user".

---

## Documentation

All docs are in English. Two trees:

- `docs/` — for humans (maintainers, contributors, operators)
- `skills/` — for AI agents using the MCP or modifying the codebase

The documents below are not optional. Each one has a clear audience, a fixed scope, and an outline of what it must contain. If a document grows past its scope, split it — do not blur boundaries.

### Documentation map

| File | Audience | Scope | What it covers |
|---|---|---|---|
| `README.md` (root) | first-time visitor | elevator pitch | What this is, why, quick start, links to deeper docs |
| `CONTRIBUTING.md` (root) | contributor | how to land code | commits, PRs, checklist, branch flow |
| `LICENSE` (root) | legal | MIT | full license text |
| `docs/README.md` | reader of `docs/` | index | one-line summary per file, recommended reading order |
| `docs/ARCHITECTURE.md` | maintainer | system design | layers, data flow, key decisions, ADR-style trade-offs |
| `docs/ADDING-TOOLS.md` | contributor | adding a new MCP tool | step-by-step, template, naming, tests, eval cases |
| `docs/DEPLOYMENT.md` | operator | shipping to prod | tags, GH Actions, nginx-proxy, rollback |
| `docs/RUNBOOK.md` | on-call | "it's broken at 3am" | symptoms → diagnosis → fix, common incidents |
| `docs/TESTING.md` | contributor | running tests | unit, integration, evals, fixtures, what to mock |
| `docs/SECURITY.md` | maintainer / reviewer | threat model | auth, secrets, supply chain, reporting vulns |
| `docs/FEEDBACK.md` | maintainer | agent-feedback mechanism | tool contract, GitHub flow, rate limit, triage |
| `docs/AGENT.md` | AI agent | pointer | one-line redirect to `skills/manage-bx24-template-mcp/SKILL.md` |
| `skills/manage-bx24-template-mcp/SKILL.md` | AI agent | entry point | rules, do/don'ts, links to sub-skills |
| `skills/manage-bx24-template-mcp/adding-tools.md` | AI agent | adding a tool | concrete template, code blocks |
| `skills/manage-bx24-template-mcp/testing.md` | AI agent | running tests | minimal commands |
| `skills/manage-bx24-template-mcp/troubleshooting.md` | AI agent | common issues | symptoms and fixes |
| `skills/manage-bx24-template-mcp/deployment.md` | AI agent | deployment flow | what triggers deploy, what to check |
| `skills/manage-bx24-template-mcp/contributing.md` | AI agent | PR rules | mirror of `CONTRIBUTING.md` in agent-friendly form |
| `skills/manage-bx24-template-mcp/feedback.md` | AI agent | when to call `bx24mcp_submit_feedback` | prompts, examples, thresholds |

Only one planned doc below remains unwritten; its outline is kept. Outlines for the
now-authored docs have been removed — their scope lives in the table above.

### `docs/TESTING.md` — outline

How to run each test layer locally and what each one covers.

Sections:

1. **Three layers** — table: layer → command → when to run → what it validates
2. **Unit tests** — `pnpm test:unit`, what to mock (`useBitrix24`, GitHub client), no network
3. **Integration tests** — `pnpm test:integration`, requires `NUXT_BITRIX24_TEST_WEBHOOK_URL`, creates and tears down real Bitrix24 entities
4. **Eval tests** — `pnpm test:evals`, requires `DEEPSEEK_API_KEY`, runs against a live MCP instance (local or staging), how to read Evalite UI
5. **Coverage policy** — every tool needs a unit test, eval optional but encouraged
6. **Fixtures** — where they live (`tests/fixtures/`), how to add one
7. **CI behavior** — what runs in PRs, what runs nightly, what runs on tag
8. **Test portal hygiene** — rules: clean up created entities, prefer prefixes like `[test]`

### Documentation conventions

- Headings: ATX style (`#`, `##`), sentence case
- Code fences: language-tagged
- Links: relative within the repo, absolute for external
- Diagrams: prefer ASCII; if a real image is needed, store under `docs/assets/` and reference relatively
- Length: every doc above must fit in a single screen of attention. Split when a doc passes ~400 lines.
- Voice: imperative for instructions ("Run `pnpm test`"), declarative for descriptions ("The MCP layer discovers tools from `server/mcp/tools/`")
- No marketing fluff. No emoji unless the user explicitly asks.
- Examples are runnable. Snippets that won't run as shown are marked `# pseudo-code`.
- Every doc carries a `Last reviewed: YYYY-MM-DD` line at the top once we ship MVP. Stale (> 6 months) docs become a backlog item.

### How docs are kept current

- Any PR that changes behavior MUST touch the relevant doc, or include a justification in the PR description
- The PR template's checklist enforces this ("Public-facing changes reflected in `docs/` and `skills/`")
- Renovate PRs that change a major dependency must mention doc impact
- `RUNBOOK.md` is updated after every real incident — postmortem hook
- Doc tone for the AI-agent tree: short, imperative, copy-paste-friendly. For the human tree: connect-the-dots, explain trade-offs.

### How to write a new doc

1. Pick the audience first — human or agent. Drop into the right tree.
2. Find the slot in the documentation map above. If no slot fits, add one (PR with the table update).
3. Start with the outline (sections in this brief), fill in.
4. Cross-link aggressively. Repeat key facts only when an agent doc needs to stand alone.
5. PR: `docs(<area>): add <name>`.

---

## Roadmap summary

| Phase | Scope | Definition of done |
|---|---|---|
| MVP | 5 base tools + `bx24mcp_submit_feedback`, webhook auth, HTTP transport, Inspector, Docker, nginx-proxy, GH Actions, Renovate, docs, tests | Claude.ai creates/reads tasks in prod; agent can submit feedback as an issue; Renovate is active |
| Phase 2 | Task comments and checklists, rate limiting, resources, prompts, caching. Starts **immediately** after MVP | Infrastructure ready for entity expansion, error rate < 1% over 100 calls |
| Pilot release (`v0.1.0`) | Cut the tag, run on the production portal, collect agent feedback. **Scope locked to the tasks domain** — no new Bitrix24 surfaces between here and the tag | Tag pushed; CI deploy green; `bx24mcp_submit_feedback` issues start flowing |
| Phase 3 | OAuth, multi-tenant, batch, Code Mode | Multiple users connect their own portals, LLM orchestrates via JS code |
| Bitrix24 surface expansion | CRM first (Deals, Contacts, …), then whatever the pilot signal asks for. One tool per PR via [`docs/ADDING-TOOLS.md`](./docs/ADDING-TOOLS.md) | All major Bitrix24 entities reachable through tools shipped via the new-tool process |

## Resolved open questions

1. **Repository**: https://github.com/bitrix24/templates-mcp
2. **Production domain**: `prod.example.com`
3. **Test Bitrix24 portal**: webhook → `NUXT_BITRIX24_TEST_WEBHOOK_URL`
4. **Phase 2 starts immediately** after MVP, no waiting for feedback
5. **Eval tests on DeepSeek** (budget approved), OpenAI-compatible client
6. **`@nuxtjs/mcp-toolkit`** is the foundation — 0.15.x stability accepted as a deliberate risk
7. **Release before expansion** — the pre-release scope is **locked to the tasks domain**. CRM and any broader Bitrix24 surface area land **after** the `v0.1.0` pilot tag, one tool per PR, demand-driven by `bx24mcp_submit_feedback`. The pre-release roadmap stops at tasks; the `Pilot release` milestone row above is the cut line.

---

This brief is enough for an AI agent to scaffold the project from zero to a working MVP. Prompts for `bx24mcp_submit_feedback` will land in a follow-up PR — for now only the mechanism is fixed.
