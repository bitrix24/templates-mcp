# bx24-template-mcp

[![CI](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml)
[![Deploy](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bitrix24 JS](https://img.shields.io/badge/Made%20with-Bitrix24%20JS-2fc6f6?logo=bitrix24&labelColor=020420)](https://bitrix24.github.io/b24jssdk/)

A Model Context Protocol (MCP) server that gives AI assistants (Claude and equivalents) access to Bitrix24 — tasks, deals, contacts, and more — through a single Bearer-protected `/mcp` endpoint.

> **Status**: pre-release, Phase 2 in progress. MVP shipped (PRs #1–#4); task lifecycle + rating shipped (PR #5). Roadmap and contract live in [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md). This README will be rewritten for end-users on the first `v0.1.0` tag.

## Why

Off-the-shelf Bitrix24 MCP servers are either toy demos or vendor-locked. This project ships a production-grade Nuxt + Nitro server with:

- File-based tool discovery via [`@nuxtjs/mcp-toolkit`](https://github.com/nuxt-modules/mcp-toolkit).
- Official [`@bitrix24/b24jssdk-nuxt`](https://www.npmjs.com/package/@bitrix24/b24jssdk-nuxt) under the hood — no hand-rolled HTTP.
- Bearer auth on `/mcp`, plus a built-in `bx24mcp_submit_feedback` meta-tool so AI agents can file structured GitHub issues against this repo when something is unclear.
- Docker behind `nginx-proxy` + `acme-companion` for hands-off TLS.
- Renovate for automated dependency updates.
- Three test layers: unit, integration (real test portal), and Evalite + DeepSeek for tool-selection evals.

## Quick start (local)

```bash
git clone https://github.com/bitrix24/templates-mcp.git
cd templates-mcp
cp .env.example .env
# edit .env: set NUXT_BITRIX24_WEBHOOK_URL and NUXT_MCP_AUTH_TOKEN
pnpm install
pnpm dev
```

Verify the health endpoint:

```bash
curl http://localhost:3000/api/health
```

Open Nuxt DevTools in the browser to reach the MCP Inspector for interactive tool debugging.

## Available tools

| Tool | What it does |
|---|---|
| `bitrix24_current_user` | Returns the Bitrix24 user that owns the configured webhook. Useful as a connectivity check. |
| `bitrix24_find_user` | Find users by name / surname / position / department, or free-text. **Call this before any tool that takes a userId** — operators speak in names, not numeric ids. |
| `bitrix24_create_task` | Create a task — title, responsibleId required; description / deadline / groupId / priority / accomplices / auditors optional. |
| `bitrix24_list_tasks` | List tasks with filter (`{ RESPONSIBLE_ID, STATUS, "!STATUS", ">=DEADLINE", … }`), order, select, and pagination (page size fixed at 50). |
| `bitrix24_update_task` | Update an existing task by id with a partial UPPERCASE-keyed `fields` object. |
| `bitrix24_add_task_comment` | Append a comment to a task (BBCode-friendly). |
| `bitrix24_start_task` | Move a task to In progress (3). |
| `bitrix24_pause_task` | Move an In-progress task back to Pending (2). |
| `bitrix24_complete_task` | Mark a task as completed (5), or Supposedly completed (4) when task control is on. |
| `bitrix24_approve_task` | Creator approves a Supposedly-completed task → Completed (5). |
| `bitrix24_disapprove_task` | Creator rejects a Supposedly-completed task → Pending (2) for rework. |
| `bitrix24_defer_task` | Move a task to Deferred (6) — postponed but not closed. |
| `bitrix24_renew_task` | Reopen a Completed or Deferred task → Pending (2). |
| `bitrix24_rate_task` | Set or clear the task rating (positive / negative / none — Bitrix24 `MARK` field). |
| `bitrix24_add_checklist_item` | Add an item to a task checklist. Omit `parentId` (or pass 0) to start a new checklist — the `title` becomes the heading. |
| `bitrix24_list_checklist_items` | List every checklist item on a task as a flat tree (`parentId: 0` = checklist heading). |
| `bitrix24_complete_checklist_item` | Check off a checklist item. |
| `bitrix24_renew_checklist_item` | Un-check a previously completed checklist item. |
| `bitrix24_delete_checklist_item` | Delete a checklist item. Heading deletion (parentId 0) wipes the whole checklist and is refused without `confirmDeleteHeading: true`. |
| `bx24mcp_submit_feedback` | Meta-tool: lets the AI agent file a GitHub issue against this repository with structured feedback. See [`docs/FEEDBACK.md`](./docs/FEEDBACK.md). |

19 Bitrix24 + 1 meta = **20 tools total**.

The 8 task-mutation tools above (`start_task` / `pause_task` / `complete_task` / `approve_task` / `disapprove_task` / `defer_task` / `renew_task` / `rate_task`) plus the 3 checklist actions (`complete_checklist_item` / `renew_checklist_item` / `delete_checklist_item`) accept either a single id **or** an array for batch mode (up to 50; pass `force: true` to override). Batches go through one HTTP round-trip — `actions.v3.batch.make` for the lifecycle tools, `actions.v2.batch.make` for the checklist actions. `add_checklist_item` and `list_checklist_items` are single-call only by design. Rate limiting, retry, and adaptive back-pressure are provided by the [`@bitrix24/b24jssdk`](https://www.npmjs.com/package/@bitrix24/b24jssdk) `RestrictionManager` — initialised with `ParamsFactory.getDefault()` (standard tariff: burst 50, drain 2 req/sec, 3 retries on transient errors). Override at runtime via `client.setRestrictionManagerParams(ParamsFactory.getEnterprise())` etc.

## Connecting Claude

1. Claude.ai → Settings → Connectors → Add custom connector.
2. Name: `Bitrix24 (b24-mcp)`.
3. URL: `https://prod.example.com/mcp`.
4. Advanced → Custom header: `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>`.
5. Save, enable in chat, ask "Show me my Bitrix24 current user".

## Repository layout

```
.
├── server/
│   ├── api/health.get.ts        # public health endpoint
│   ├── middleware/mcp-auth.ts   # Bearer auth on /mcp
│   ├── mcp/tools/               # file-based MCP tool discovery
│   └── utils/                   # Bitrix24 client singleton, error mapping
├── tests/unit/                  # Vitest unit tests
├── docs/                        # human docs
├── skills/manage-bx24-template-mcp/  # agent skill set
├── .github/                     # workflows, issue/PR templates
├── Dockerfile
├── docker-compose.yml           # production (nginx-proxy + acme-companion)
├── docker-compose.example.yml   # local (host port 3000)
├── renovate.json
└── PROJECT-BRIEF.md
```

## Documentation

- [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md) — full specification, source of truth.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — commits, PRs, CI gates.
- [`docs/`](./docs/) — architecture, deployment, runbook, testing, security, feedback (stubs land alongside MVP).
- [`skills/manage-bx24-template-mcp/SKILL.md`](./skills/manage-bx24-template-mcp/SKILL.md) — entry point for AI agents.

## License

MIT — see [`LICENSE`](./LICENSE).
