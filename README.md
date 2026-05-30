# bx24-template-mcp

[![CI](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/ci.yml)
[![Deploy](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml/badge.svg)](https://github.com/bitrix24/templates-mcp/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Nuxt](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bitrix24 JS](https://img.shields.io/badge/Made%20with-Bitrix24%20JS-2fc6f6?logo=bitrix24&labelColor=020420)](https://bitrix24.github.io/b24jssdk/)

A starter template for building Model Context Protocol (MCP) servers on top of Bitrix24. Ships example tools for tasks and users behind a single Bearer-protected `/mcp` endpoint over HTTP, or a `.dxt` bundle Claude Desktop installs in two clicks — plus the auth, throttling, logging, and test scaffolding you need to fork it and add your own.

> **What is Bitrix24?** An all-in-one CRM + task management + comms suite, ~12 million organisations. Strongest in Russia/CIS, Brazil/LatAm, Eastern Europe, and SMB segments globally. Competes with HubSpot/Pipedrive on the CRM side and Asana/Monday on tasks. This project gives AI assistants access to a Bitrix24 portal you already operate — it is **not** a Bitrix24 alternative.

> **Status**: stable template, currently at **v0.1.0-alpha.1** (see [`CHANGELOG.md`](./CHANGELOG.md)); Phase 2 in progress. **Pilot scope is tasks only** — CRM (deals / contacts / leads) is the planned post-pilot expansion, see [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md). Tasks (CRUD + lifecycle + checklists + results + elapsed time + dependencies) are shipped. Fork it and extend with your own tools. This README will be rewritten for end-users on the first non-alpha `v0.1.0` tag.

## Choose your path

| You are… | Use | Why |
|---|---|---|
| **A non-technical Bitrix24 operator** (HR, accountant, foreman) on a single workstation | **DXT bundle** → [Desktop Extension](#desktop-extension--claude-desktop-one-file-two-clicks) | One file, two clicks. No terminal, no port, no Bearer. Webhook stored in the OS keychain. Локализованный гайд: [`INSTALL.ru.md`](./mcp-stdio/INSTALL.ru.md) · em PT-BR: [`INSTALL.pt-BR.md`](./mcp-stdio/INSTALL.pt-BR.md). |
| **A developer** running an AI agent on your laptop (Claude Code / Cursor / Claude Desktop) | **Local HTTP** → [Local MCP](#local-mcp--your-own-machine-claude-desktop-cursor-claude-code-cline) | `pnpm start`, point the client at `localhost:3000`. No public domain. Stays inside your machine. |
| **A team / SaaS deploying for many users** | **Docker production** → [Remote MCP](#remote-mcp--production-server-claudeai-web) | Public URL with TLS, Bearer-protected `/mcp`, GHCR image, GitHub-Actions deploy + rollback. |

The three paths share **the same tool code** — same files in `server/mcp/tools/**`, same auth model, same logger redaction. Only the transport and packaging differ.

## Why

Off-the-shelf Bitrix24 MCP servers are either toy demos or vendor-locked. This project ships a production-grade Nuxt + Nitro **template** with:

- File-based tool discovery via [`@nuxtjs/mcp-toolkit`](https://github.com/nuxt-modules/mcp-toolkit).
- Official [`@bitrix24/b24jssdk-nuxt`](https://www.npmjs.com/package/@bitrix24/b24jssdk-nuxt) under the hood — no hand-rolled HTTP.
- Bearer auth on `/mcp`, plus a built-in `bx24mcp_submit_feedback` meta-tool so AI agents can file structured GitHub issues against this repo when something is unclear.
- **Three deployment shapes** in one repo: Docker behind a reverse proxy (nginx-proxy / Caddy / Traefik / plain certbot — see [`docs/REVERSE-PROXY.md`](./docs/REVERSE-PROXY.md)), local HTTP for solo dev/laptop use, and a stdio DXT bundle for Claude Desktop.
- Works with **Bitrix24 Cloud** (any TLD — `.com` / `.ru` / `.com.br` / `.es` / `.de` / …) **and Bitrix24 Self-Hosted** (on-premise). Private CA trust via `NODE_EXTRA_CA_CERTS`.
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
corepack enable    # provides pnpm — this repo pins pnpm v11 via packageManager, corepack installs it automatically
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
| `b24_user_me` | Returns the Bitrix24 user that owns the configured webhook. Useful as a connectivity check. |
| `b24_user_find` | Find users by name / surname / position / department, or free-text. **Call this before any tool that takes a userId** — operators speak in names, not numeric ids. |
| `b24_task_create` | Create a task — title, responsibleId required; description / deadline / groupId / priority / accomplices / auditors optional. |
| `b24_task_list` | List tasks with filter (`{ RESPONSIBLE_ID, STATUS, "!STATUS", ">=DEADLINE", … }`), order, select, and pagination (page size fixed at 50). |
| `b24_task_update` | Update an existing task by id with a partial UPPERCASE-keyed `fields` object. |
| `b24_task_comment_add` | Append a comment to a task (BBCode-friendly). |
| `b24_task_start` | Move a task to In progress (3). |
| `b24_task_pause` | Move an In-progress task back to Pending (2). |
| `b24_task_complete` | Mark a task as completed (5), or Supposedly completed (4) when task control is on. |
| `b24_task_approve` | Creator approves a Supposedly-completed task → Completed (5). |
| `b24_task_disapprove` | Creator rejects a Supposedly-completed task → Pending (2) for rework. |
| `b24_task_defer` | Move a task to Deferred (6) — postponed but not closed. |
| `b24_task_renew` | Reopen a Completed or Deferred task → Pending (2). |
| `b24_task_rate` | Set or clear the task rating (positive / negative / none — Bitrix24 `MARK` field). |
| `b24_task_checklist_item_add` | Add an item to a task checklist. Omit `parentId` (or pass 0) to start a new checklist — the `title` becomes the heading. |
| `b24_task_checklist_item_list` | List every checklist item on a task as a flat tree (`parentId: 0` = checklist heading). |
| `b24_task_checklist_item_complete` | Check off a checklist item. |
| `b24_task_checklist_item_renew` | Un-check a previously completed checklist item. |
| `b24_task_checklist_item_delete` | Delete a checklist item. Heading deletion (parentId 0) wipes the whole checklist and is refused without `confirmDeleteHeading: true`. |
| `b24_task_result_add` | Record a free-form RESULT (outcome text) on a task — separate from comments and from the task body. |
| `b24_task_result_list` | List the results recorded on a task. Newest-first by default; pagination via limit/offset. |
| `b24_task_result_update` | Rewrite the text of an existing result. Author-only: Bitrix24 returns `ACCESSDENIEDEXCEPTION` if any other operator (besides a portal admin) tries to edit. |
| `b24_task_result_delete` | Delete a result by id. Author-only; the task itself is not affected. |
| `b24_task_elapsed_time_add` | Log a manual elapsed-time entry on a task ("how long did this take"), separate from the auto stopwatch. `seconds` capped at 86400 (24h). |
| `b24_task_elapsed_time_list` | List elapsed-time entries (manual + stopwatch) on tasks. Filter by `taskId` or a custom camelCase filter; paginates at 50. |
| `b24_task_elapsed_time_update` | Correct an existing elapsed-time entry (duration / comment / attribution). Author-or-admin only. |
| `b24_task_elapsed_time_delete` | Delete elapsed-time entries. Requires `confirmDelete: true`. Author-or-admin only. |
| `b24_task_dependency_add` | Create a "previous task" dependency (`taskIdFrom` → `taskIdTo`) for Gantt-style scheduling. |
| `b24_task_dependency_remove` | Remove a "previous task" dependency. Requires `confirmDelete: true`. |
| `bx24mcp_submit_feedback` | Meta-tool: lets the AI agent file a GitHub issue against this repository with structured feedback. See [`docs/FEEDBACK.md`](./docs/FEEDBACK.md). |

29 Bitrix24 + 1 meta = **30 tools total**.

The 8 task-mutation tools above (`start_task` / `pause_task` / `complete_task` / `approve_task` / `disapprove_task` / `defer_task` / `renew_task` / `rate_task`) accept a single id **or** an array for batch mode (up to **25**; pass `force: true` to override) and go through one HTTP round-trip via the `batchV2` helper. The 3 checklist actions (`complete_checklist_item` / `renew_checklist_item` / `delete_checklist_item`) also accept single or batch (up to **50**; `force: true` to override) via `batchV2`. `delete_elapsed_time` and `remove_task_dependency` likewise take a single id or an array for batch deletion (up to **50**; `force: true` to override; each still gated by `confirmDelete: true`). `add_checklist_item` and `list_checklist_items` are single-call only by design. Rate limiting, retry, and adaptive back-pressure are provided by the [`@bitrix24/b24jssdk`](https://www.npmjs.com/package/@bitrix24/b24jssdk) `RestrictionManager` — initialised with `ParamsFactory.getDefault()` (standard tariff: burst 50, drain 2 req/sec, 3 retries on transient errors). Override at runtime via `client.setRestrictionManagerParams(ParamsFactory.getEnterprise())` etc.

## Connecting Claude

### Remote MCP — production server (Claude.ai web)

1. Claude.ai → Settings → Connectors → Add custom connector.
2. Name: `Bitrix24 (b24-mcp)`.
3. URL: `https://prod.example.com/mcp`.
4. Advanced → Custom header: `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>`.
5. Save, enable in chat, ask "Show me my Bitrix24 current user".

For production deployment, see [`docs/REVERSE-PROXY.md`](./docs/REVERSE-PROXY.md) — covers nginx-proxy (the default), Caddy, plain nginx + certbot, and Traefik. Pick whichever your hosting provider already runs.

### Local MCP — your own machine (Claude Desktop, Cursor, Claude Code, Cline, …)

No public domain or TLS required. Run the same Nuxt build on `localhost` and point any HTTP-MCP-capable AI client at it.

```bash
git clone https://github.com/bitrix24/templates-mcp.git
cd templates-mcp
cp .env.example .env
# In .env: set NUXT_BITRIX24_WEBHOOK_URL; generate NUXT_MCP_AUTH_TOKEN
#   Linux/macOS:  openssl rand -hex 32
#   Windows:      -join ((48..57)+(97..102) | Get-Random -Count 64 | %{[char]$_})
#   Any Node:     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm install
pnpm build
pnpm start
# → server listening on http://localhost:3000/mcp
```

Health check while it's up:

```bash
curl http://localhost:3000/api/health
```

Then add an MCP server entry to your client. The wire shape is identical everywhere — URL + `Authorization: Bearer <token>` header — only the config file location differs.

#### Claude Code (CLI agent — `claude mcp add`)

One-line registration, no JSON editing:

```bash
claude mcp add bx24 \
  --transport http \
  --url http://localhost:3000/mcp \
  --header "Authorization=Bearer <NUXT_MCP_AUTH_TOKEN>"
```

Confirm with `claude mcp list`. The server is now available in every Claude Code session — try `/mcp` inside the CLI to inspect tools.

#### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json` per project)

User-scoped at `~/.cursor/mcp.json` (macOS/Linux) / `%USERPROFILE%\.cursor\mcp.json` (Windows). For a project-scoped server, put the same file at `.cursor/mcp.json` in the repo root.

```json
{
  "mcpServers": {
    "bx24": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <NUXT_MCP_AUTH_TOKEN>" }
    }
  }
}
```

Cursor → Settings → MCP — reload to pick up the change.

#### Claude Desktop (`claude_desktop_config.json`)

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bx24": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <NUXT_MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

#### Cline / Continue / Zed / any other HTTP-MCP client

Same shape — URL `http://localhost:3000/mcp` + `Authorization: Bearer <NUXT_MCP_AUTH_TOKEN>`. Refer to the client's own MCP docs for the exact config file path.

Restart the client, ask *"Show me my Bitrix24 current user"* — you should see the operator behind the webhook.

#### Keeping it always-on

`pnpm start` is fine for one-off use. For a daemon:

- **systemd --user** (Linux): create `~/.config/systemd/user/bx24-mcp.service` with `ExecStart=/usr/bin/node /path/to/templates-mcp/.output/server/index.mjs`, then `systemctl --user enable --now bx24-mcp`.
- **launchd** (macOS): a plist in `~/Library/LaunchAgents/` pointing at the same node command, loaded via `launchctl load`.
- **pm2** (cross-platform, Node-native): `pm2 start .output/server/index.mjs --name bx24-mcp && pm2 save`.
- **NSSM** (Windows): wrap `node .output/server/index.mjs` as a Windows service.

### Desktop Extension — Claude Desktop, one file, two clicks

For users who **don't want to run a server or open a terminal at all** — accountants, HR ops, on-site staff — this project also builds as a [`.dxt`](https://www.anthropic.com/news/desktop-extensions) bundle: a single file Claude Desktop installs natively over **stdio**. The Bitrix24 webhook stays on the device, in Claude Desktop's OS-backed encrypted user-config (macOS Keychain / Windows DPAPI / Linux libsecret). No port, no Bearer token, no public URL.

```bash
pnpm install
pnpm build:dxt
# → dist/bx24-template-mcp.dxt
```

In Claude Desktop: *Settings → Extensions → Install from file → pick the `.dxt`*. Paste your Bitrix24 webhook URL when prompted. Done.

Pre-built `.dxt` files are attached to every [GitHub release](https://github.com/bitrix24/templates-mcp/releases). Localised install guides:

- 🇷🇺 [`mcp-stdio/INSTALL.ru.md`](./mcp-stdio/INSTALL.ru.md)
- 🇧🇷 [`mcp-stdio/INSTALL.pt-BR.md`](./mcp-stdio/INSTALL.pt-BR.md)

Build/runtime internals: [`mcp-stdio/README.md`](./mcp-stdio/README.md).

### Bitrix24 Self-Hosted (on-premise) and private CAs

All three transports support Self-Hosted Bitrix24 — the URL shape is the same (`https://<host>/rest/<user_id>/<secret>/`), the SDK doesn't enforce the `.bitrix24.*` TLD. If the on-prem portal uses a **self-signed cert or an internal CA**, point Node at the bundle:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/internal-ca-bundle.pem
```

- HTTP / Docker: set in `.env` (`docker-compose.example.yml` already wires it through; uncomment the `volumes:` line to mount the bundle).
- DXT: set in the shell **before launching Claude Desktop** so the variable is inherited by the spawned extension process. On Windows: `[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", "C:\certs\ca.pem", "User")`.

### Data residency, telemetry, LGPD / GDPR

- **No outbound calls to third parties.** The server makes exactly two kinds of HTTP requests: (a) to your Bitrix24 portal, (b) to the GitHub Issues API — and (b) **only** when the assistant invokes `bx24mcp_submit_feedback` AND you supplied a PAT. No analytics, no crash reporting, no LLM provider in the middle.
- **Webhook secret storage per transport:**
  - DXT — OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) via Claude Desktop's `user_config`.
  - Local HTTP — `.env` file on your filesystem; protect with normal file ACLs.
  - Docker production — environment variable passed to the container; the value lives in the host's `.env` (or your secrets manager).
- **Logger redaction.** The Bitrix24 SDK logs every outbound request URL, which contains the webhook secret. `server/utils/logger-redactor.ts` wraps the SDK logger so URL secrets render as `<REDACTED>` in every sink — `docker logs`, `journalctl`, Claude Desktop's extension log panel.
- **Log verbosity knob.** `NUXT_LOG_LEVEL` (or `LOG_LEVEL` in the DXT bundle / dry-run) controls the console level: `debug` / `info` / `notice` / `warning` (alias `warn`) / `error` / `critical` / `alert` / `emergency`. Unset → `DEBUG` under `nuxt dev`, `INFO` otherwise. A typo like `NUXT_LOG_LEVEL=debgu` prints a one-shot, redacted warning to `stderr` at startup naming the bad value and the level actually used, instead of silently falling back — see [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md#environment-variables) for the full table.
- **For GDPR/LGPD scrutiny:** the codebase has zero telemetry hooks. See [`docs/SECURITY-AUDIT.md`](./docs/SECURITY-AUDIT.md) for the formal audit.

### Time zones and deadlines

Bitrix24 stores `DEADLINE` and related datetime fields in **portal-local time**. The LLM sometimes hallucinates the timezone (`America/Sao_Paulo` vs `UTC` vs the operator's local) when parsing phrases like *"by tomorrow 6pm"*. If your portal's TZ differs from the operator's, **be explicit in the prompt** ("DEADLINE 2026-05-20T18:00:00+03:00"), or set the Bitrix24 user profile timezone to match what your team verbally assumes.

## Repository layout

```
.
├── server/
│   ├── api/health.get.ts        # public health endpoint
│   ├── middleware/mcp-auth.ts   # Bearer auth on /mcp
│   ├── mcp/tools/               # file-based MCP tool discovery
│   ├── plugins/                 # Nitro plugins (audit-log drain)
│   ├── types/                   # Bitrix24 REST response shapes
│   └── utils/                   # Bitrix24 client singleton, error mapping
├── mcp-stdio/                   # local-stdio DXT bundle (build:dxt)
│   ├── server.ts                # stdio entrypoint
│   ├── manifest.json            # DXT manifest (trilingual user_config)
│   ├── INSTALL.ru.md            # 🇷🇺 локализованный гайд
│   └── INSTALL.pt-BR.md         # 🇧🇷 guia localizado
├── tests/
│   ├── unit/                    # Vitest unit tests
│   ├── integration/             # live test-portal checks (opt-in via env)
│   └── evals/                   # Evalite + DeepSeek tool-selection evals
├── docs/
│   ├── REVERSE-PROXY.md         # Caddy / Traefik / nginx+certbot alternatives
│   └── …                        # architecture, security, runbook
├── skills/manage-bx24-template-mcp/  # agent skill set
├── .github/                     # workflows, issue/PR templates
├── Dockerfile
├── docker-compose.yml           # production (nginx-proxy + acme-companion)
├── docker-compose.example.yml   # single-host, bring-your-own-TLS
├── renovate.json
└── PROJECT-BRIEF.md
```

## Documentation

- [`PROJECT-BRIEF.md`](./PROJECT-BRIEF.md) — full specification, source of truth.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — commits, PRs, CI gates.
- [`docs/REVERSE-PROXY.md`](./docs/REVERSE-PROXY.md) — Caddy / Traefik / plain nginx+certbot snippets for production TLS.
- [`docs/`](./docs/) — architecture, deployment, runbook, testing, security, feedback (stubs land alongside MVP).
- [`mcp-stdio/INSTALL.ru.md`](./mcp-stdio/INSTALL.ru.md) · [`mcp-stdio/INSTALL.pt-BR.md`](./mcp-stdio/INSTALL.pt-BR.md) — localised DXT install guides.
- [`skills/manage-bx24-template-mcp/SKILL.md`](./skills/manage-bx24-template-mcp/SKILL.md) — entry point for AI agents.

## Support

GitHub Issues only — open one at [bitrix24/templates-mcp/issues](https://github.com/bitrix24/templates-mcp/issues). There is no Discord, Slack, or Telegram channel for this template. The `bx24mcp_submit_feedback` meta-tool (see [`docs/FEEDBACK.md`](./docs/FEEDBACK.md)) lets the AI agent itself file structured issues directly from a Claude / Cursor / Windsurf session.

## License

MIT — see [`LICENSE`](./LICENSE).
