# Documentation

`Last reviewed: 2026-06-14`

Welcome. Pick the door for your role.

## Contributor

Start here if you are about to change code.

1. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — commits, PR rules, CI gates.
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 15-minute orientation: layers, decisions, hot spots.
3. [`ADDING-TOOLS.md`](./ADDING-TOOLS.md) — human walkthrough for adding a new MCP tool: mental model, where files go, the two registrations, anatomy of a real tool. Links to the agent skill for the full template (`callV2` / `callV3` / `batchV2` / `batchV3` helpers, error funnel, unit-test skeleton, persona walk).
4. [`EVALS.md`](./EVALS.md) — automated tool-selection eval (Evalite + DeepSeek); how to run, how to add cases.
5. [`OAUTH-DESIGN.md`](./OAUTH-DESIGN.md) — normative design doc for the OAuth 2.0 multi-tenant support (shipped, opt-in behind `NUXT_BITRIX24_OAUTH_ENABLED`): threat model, token-store contract, event taxonomy.
6. [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — system design and roadmap, source of truth for everything that hasn't earned its own doc yet.

> **Testing strategy** is not a separate doc — see `CONTRIBUTING.md` for the unit/integration split and CI gates, and `EVALS.md` for the LLM tool-selection layer.

## Operator

Start here if you are running the service.

1. [`DEPLOYMENT.md`](./DEPLOYMENT.md) — production deploy procedure, secrets bootstrap, rollback.
2. [`RUNBOOK.md`](./RUNBOOK.md) — incident response, alert → action table.
3. [`REVERSE-PROXY.md`](./REVERSE-PROXY.md) — pick your TLS terminator (nginx-proxy / Caddy / Traefik / plain nginx+certbot).
4. [`SECURITY.md`](./SECURITY.md) — disclosure, threat model, secret rotation.
5. [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) — dependency-level audit (SDK logger surface).
6. [`FEEDBACK.md`](./FEEDBACK.md) — agent-feedback channel (`bx24mcp_submit_feedback`) and its GitHub integration.
7. [`MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md) — natural-language test pack for verifying tool descriptions and LLM behaviour against a real portal.

## AI agent

Start here if you are an AI assistant working with this MCP.

1. [`AGENT.md`](./AGENT.md) — short pointer to the skill set.
2. [`../skills/manage-bx24-template-mcp/SKILL.md`](../skills/manage-bx24-template-mcp/SKILL.md) — ground rules, persona walk, scope discipline.
3. [`../skills/manage-bx24-template-mcp/adding-tools.md`](../skills/manage-bx24-template-mcp/adding-tools.md) — concrete template for writing new tools.
4. [`../skills/manage-bx24-template-mcp/feedback.md`](../skills/manage-bx24-template-mcp/feedback.md) — when and how to call `bx24mcp_submit_feedback`.
5. [`OAUTH-DESIGN.md`](./OAUTH-DESIGN.md) — read before changing tool dispatch or anything in `server/utils/bitrix24*.ts`.

## Not yet authored

- `TROUBLESHOOTING.md` — known issues and recovery procedures (the Alert→Action table in `RUNBOOK.md` covers the prod-incident slice; this one would be the dev/laptop slice).
