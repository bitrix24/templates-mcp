# Documentation

Welcome. Pick the door for your role.

## Contributor

Start here if you are about to change code.

1. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — commits, PR rules, CI gates.
2. `ADDING-TOOLS.md` — how to add a new MCP tool *(lands with MVP)*.
3. `TESTING.md` — three test layers *(lands with MVP)*.
4. [`EVALS.md`](./EVALS.md) — automated tool-selection eval (Evalite + DeepSeek); how to run, how to add cases.
5. `ARCHITECTURE.md` — system design *(lands with MVP)*.

## Operator

Start here if you are running the service.

1. `DEPLOYMENT.md` — release process, nginx-proxy, secrets *(lands with MVP)*.
2. `RUNBOOK.md` — on-call playbook *(lands with MVP)*.
3. `SECURITY.md` — threat model, secret rotation *(lands with MVP)*.
4. [`FEEDBACK.md`](./FEEDBACK.md) — agent-feedback channel (`bx24mcp_submit_feedback`) and its GitHub integration.
5. [`MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md) — natural-language test pack for verifying tool descriptions and LLM behaviour against a real portal.

## AI agent

Start here if you are an AI assistant working with this MCP.

1. [`AGENT.md`](./AGENT.md) — short pointer to the skill set.
2. [`../skills/manage-bx24-template-mcp/SKILL.md`](../skills/manage-bx24-template-mcp/SKILL.md) — ground rules.
3. [`../skills/manage-bx24-template-mcp/feedback.md`](../skills/manage-bx24-template-mcp/feedback.md) — when and how to call `bx24mcp_submit_feedback`.

## Current state

This project is in MVP development. The files marked *(lands with MVP)* above are placeholders or partial stubs and will be filled in alongside the corresponding code. The contract for what each one contains is fixed in [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) under the "Documentation" section.
