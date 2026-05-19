# bx24-template-mcp

[![CI](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml)
[![Deploy](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bitrix24 JS](https://img.shields.io/badge/Made%20with-Bitrix24%20JS-2fc6f6?logo=bitrix24&labelColor=020420)](https://bitrix24.github.io/b24jssdk/)

A starter template for building Model Context Protocol (MCP) servers on top of Bitrix24. Ships example tools for tasks and users behind a single Bearer-protected `/mcp` endpoint — plus the auth, throttling, logging, and test scaffolding you need to fork it and add your own.

> **Status**: stable template, pre-v1. Fork it and extend with your own tools. Roadmap and contract live in [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md). This README will be rewritten for end-users on the first `v0.1.0` tag.

## Why

Off-the-shelf Bitrix24 MCP servers are either toy demos or vendor-locked. This project ships a production-grade Nuxt + Nitro **template** with:

- File-based tool discovery via [`@nuxtjs/mcp-toolkit`](https://github.com/nuxt-modules/mcp-toolkit).
- Official [`@bitrix24/b24jssdk-nuxt`](https://www.npmjs.com/package/@bitrix24/b24jssdk-nuxt) under the hood — no hand-rolled HTTP.
- Bearer auth on `/mcp`, plus a built-in `bx24mcp_submit_feedback` meta-tool so AI agents can file structured GitHub issues against this repo when something is unclear.
- Docker behind `nginx-proxy` + `acme-companion` for hands-off TLS.
- Renovate for automated dependency updates.
- Three test layers: unit, integration (real test portal), and Evalite + DeepSeek for tool-selection evals.

## Quick start (local)

**Prerequisite — mint an incoming webhook in your Bitrix24 portal.** In the portal: *Developer resources → Other → Inbound webhook* (or "Applications → Developer resources" on some skins). Grant the scopes you plan to call (at minimum `user` + `task` for the current tool set), save, and copy the URL of the form `https://<your-portal>.bitrix24.com/rest/<user-id>/<webhook-code>/` — that is `NUXT_BITRIX24_WEBHOOK_URL`.

> **Create the webhook under a dedicated service user**, not a real employee's account. The webhook inherits the creator's permissions for every call, so binding it to a personal account ties the integration to that person's role, department visibility, and tenure — anyone who leaves the company or loses rights silently breaks the MCP. Grant the service user the **minimum rights the tool set actually needs** (admin only if you need cross-user task visibility and want to avoid "task not found" / `ACCESS_DENIED` surprises on entities a non-admin user happens not to see).
>
> This is a webhook-era trade-off only. When the template moves to **OAuth 2.0** in a future release, each end user logs in with their own Bitrix24 account and every REST call is executed under that user's identity and permissions — the service-user shortcut goes away, and access becomes per-user by design.

```bash
git clone https://github.com/bitrix24/templates-mcp.git
cd templates-mcp
cp .env.example .env
# edit .env: set NUXT_BITRIX24_WEBHOOK_URL (from the prerequisite above)
#            and NUXT_MCP_AUTH_TOKEN (generate via: openssl rand -hex 32)
corepack enable    # if pnpm is not installed
pnpm install
# If npmjs.com is unreachable from your network (e.g. some corporate or
# regional setups), point pnpm at a mirror first:
#   pnpm config set registry https://registry.npmmirror.com
pnpm dev
```

The official walkthrough for adding an inbound webhook lives at
[apidocs.bitrix24.com → How to add an inbound webhook](https://apidocs.bitrix24.com/api-reference/how-to-call-rest-api/how-to-add-inbound-webhook.html).

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
| `bitrix24_add_task_result` | Record a free-form RESULT (outcome text) on a task — separate from comments and from the task body. |
| `bitrix24_list_task_results` | List the results recorded on a task. Newest-first by default; pagination via limit/offset. |
| `bitrix24_update_task_result` | Rewrite the text of an existing result. Author-only: Bitrix24 returns `ACCESSDENIEDEXCEPTION` if any other operator (besides a portal admin) tries to edit. |
| `bitrix24_delete_task_result` | Delete a result by id. Author-only; the task itself is not affected. |
| `bx24mcp_submit_feedback` | Meta-tool: lets the AI agent file a GitHub issue against this repository with structured feedback. See [`docs/FEEDBACK.md`](./docs/FEEDBACK.md). |

23 Bitrix24 + 1 meta = **24 tools total**.

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

## Support

GitHub Issues only — open one at [bitrix24/templates-mcp/issues](https://github.com/bitrix24/templates-mcp/issues). There is no Discord, Slack, or Telegram channel for this template. The `bx24mcp_submit_feedback` meta-tool (see [`docs/FEEDBACK.md`](./docs/FEEDBACK.md)) lets the AI agent itself file structured issues directly from a Claude / Cursor / Windsurf session.

## License

MIT — see [`LICENSE`](./LICENSE).
