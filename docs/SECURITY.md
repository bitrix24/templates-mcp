# Security policy

> **Status: DRAFT — operational placeholders (`TODO(team)`) pending.** The technical content is accurate against the code at the time of writing; team-specific values (response windows, on-call schedule) are still being finalised.

Policy and process. The dependency-level audit (what the SDK logs, what the redactor catches) lives in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).

## Reporting a vulnerability

- **Do not** open a public GitHub issue for security reports.
- Use **GitHub Security Advisories** for this repository: <https://github.com/bitrix24/templates-mcp/security/advisories/new>. The form is private to the reporter and the maintainers, lets us iterate on a fix in a private fork, and pins a CVE on publication. Include reproduction steps, affected version, and the impact you observed.
- Acknowledgement within *(TODO(team): response window)*. Fix timeline depends on severity.

## Supported versions

While the project is pre-release, only the latest tag receives fixes. Once a `v0.x` line stabilises, this section will list the supported range.

## Threat model — what's in scope

- **Webhook URL secret leak.** The webhook URL contains a per-user secret. Logger redaction is the primary control — see `server/utils/logger-redactor.ts` and the audit pass in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md). Any dependency bump that touches the SDK or its logger surface MUST re-run the audit. Redaction is **URL-shaped only**: if a Bitrix24 REST endpoint ever returns a credential as a JSON value (e.g. `{ token: "…" }`) and that body lands in `getLogger().info('post/response', …)`, the redactor will not catch it. No known REST method does this today; tracked as a known limitation in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).
- **Bearer token leak (HTTP modes).** `NUXT_MCP_AUTH_TOKEN` is the only thing between a public `/mcp` and tool execution against your portal. It's compared with `crypto.timingSafeEqual`. Rotation procedure below.
- **Prompt injection via tool input.** Defensive hardening for LLM-controlled keys lives in `server/utils/v3-filter.ts` and `wire-coerce.ts`; commit history references it as "defensive hardening for toV3Filter / pick against LLM-controlled keys" (PR #41). Re-audit if a new tool builds Bitrix24 REST filters from agent input.
- **Tool delete operations.** Every delete tool gates on `confirmDelete: true` (Ground Rule #9 in `skills/manage-bx24-template-mcp/SKILL.md`). Cascade-destructive deletes layer a second confirm (Rule #10).
- **DXT bundle.** Webhook lives in OS keychain via Claude Desktop's `user_config` (`sensitive: true`). Unpacked bundle lives on disk as plain files — protect with full-disk encryption if the threat model includes physical access.

## Out of scope (today)

- Multi-tenant deployment. The Bearer model is single-tenant; a multi-tenant variant needs per-tenant scoping and is not on the roadmap.
- DoS mitigation beyond Docker resource limits.
- Audit log of tool invocations. *(TODO(team): retention policy / log shipping if/when this lands.)*

## Secret rotation

| Secret | Where it lives | Rotation procedure |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | Host `.env` (production); `.env` on laptop (local HTTP); OS keychain (DXT) | Revoke webhook in Bitrix24 portal → create new → update store → `docker compose up -d` (production) or restart client (DXT). The old URL fails closed (401/403). |
| `NUXT_MCP_AUTH_TOKEN` | Host `.env` (production); `.env` on laptop (local HTTP); not used for DXT | Generate new (`openssl rand -hex 32`), update `.env`, `docker compose up -d`, update every connected client header. No revocation list — old token is dead the instant the new one is loaded. |
| GitHub feedback PAT [^pat] | Host `.env` / laptop `.env` / DXT user_config | Revoke PAT on GitHub → create new → update store → restart service. |
| `SSH_KEY` (GitHub Actions secret) | GitHub repo secrets | Generate new key pair, add public half to deploy user's `authorized_keys`, replace `SSH_KEY` secret value, remove old public key. |

[^pat]: Env var name differs by transport: HTTP modes read `NUXT_GITHUB_FEEDBACK_TOKEN` (Nuxt runtime-config prefix); the DXT bundle reads `GITHUB_FEEDBACK_TOKEN` (no `NUXT_` prefix — projected directly in `mcp-stdio/nuxt-shims.ts`).

## Dependency policy

- Renovate is configured (`renovate.json`); PRs land continuously.
- *(TODO(team): merge cadence — weekly batch vs. immediate per-PR.)*
- Major bumps to `@bitrix24/b24jssdk`, `@modelcontextprotocol/sdk`, `zod`, or `@nuxtjs/mcp-toolkit` MUST trigger:
  - Re-run of the SDK-logger audit in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).
  - Manual smoke of all three transports (Remote HTTP, Local HTTP, DXT) — see [`MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md).
- The DXT bundle pins zod via a workaround (`mcp-stdio/nuxt-shims.ts` forces init). zod major bumps require revalidating that workaround.

## Pre-commit & CI scans

- `commitlint` runs on every commit message (conventional commits).
- ESLint enforces no direct `actions.*` calls; only `callV2/callV3/batchV2/batchV3` from `server/utils/sdk-helpers.ts`.
- *(TODO(team): add a secret-scanning hook (e.g. `gitleaks`) to pre-commit and to CI; today the only line of defence is reviewer eyes.)*
