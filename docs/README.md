# Documentation

Welcome. Pick the door for your role.

## Contributor

Start here if you are about to change code.

1. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — commits, PR rules, CI gates.
2. [`../skills/manage-bx24-template-mcp/adding-tools.md`](../skills/manage-bx24-template-mcp/adding-tools.md) — how to add a new MCP tool (modern template: `callV3` / `callV2` / `batchV3` helpers, error funnel, unit-test skeleton, persona walk).
3. [`EVALS.md`](./EVALS.md) — automated tool-selection eval (Evalite + DeepSeek); how to run, how to add cases.
4. [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — system design and roadmap, source of truth for everything that hasn't earned its own doc yet.

## Operator

Start here if you are running the service.

1. [`FEEDBACK.md`](./FEEDBACK.md) — agent-feedback channel (`bx24mcp_submit_feedback`) and its GitHub integration.
2. [`MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md) — natural-language test pack for verifying tool descriptions and LLM behaviour against a real portal.

## AI agent

Start here if you are an AI assistant working with this MCP.

1. [`AGENT.md`](./AGENT.md) — short pointer to the skill set.
2. [`../skills/manage-bx24-template-mcp/SKILL.md`](../skills/manage-bx24-template-mcp/SKILL.md) — ground rules, persona walk, scope discipline.
3. [`../skills/manage-bx24-template-mcp/adding-tools.md`](../skills/manage-bx24-template-mcp/adding-tools.md) — concrete template for writing new tools.
4. [`../skills/manage-bx24-template-mcp/feedback.md`](../skills/manage-bx24-template-mcp/feedback.md) — when and how to call `bx24mcp_submit_feedback`.

## Not yet authored

The following operator / contributor docs are referenced in `PROJECT-BRIEF.md` but not yet written. **Don't improvise local stubs** — open a GitHub issue and link the work, so the doc lands once authoritatively rather than drifting in parallel:

- `DEPLOYMENT.md` — release process, nginx-proxy + acme-companion, secrets management
- `RUNBOOK.md` — on-call playbook for prod incidents
- `SECURITY.md` — threat model, secret rotation, sanitisation rationale
- `TESTING.md` — running unit / integration / eval layers locally
- `TROUBLESHOOTING.md` — known issues and recovery procedures
- `ARCHITECTURE.md` — system design (today this lives inside `PROJECT-BRIEF.md`; eventual split when the brief gets trimmed)
