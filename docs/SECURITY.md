# Security policy

Policy and process. The dependency-level audit (what the SDK logs, what the redactor catches) lives in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).

## Reporting a vulnerability

- **Do not** open a public GitHub issue for security reports.
- Use **GitHub Security Advisories** for this repository: <https://github.com/bitrix24/templates-mcp/security/advisories/new>. The form is private to the reporter and the maintainers, lets us iterate on a fix in a private fork, and pins a CVE on publication. Include reproduction steps, affected version, and the impact you observed.
- Acknowledgement within **~5 business days** (best-effort, pre-release; no formal SLA until GA). Fix timeline depends on severity.

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
- Audit log of tool invocations. *Planned (pre-GA): retention policy / log shipping when this lands.*

## Secret rotation

| Secret | Where it lives | Rotation procedure |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | Host `.env` (production); `.env` on laptop (local HTTP); OS keychain (DXT) | Revoke webhook in Bitrix24 portal → create new → update store → `docker compose up -d` (production) or restart client (DXT). The old URL fails closed (401/403). |
| `NUXT_MCP_AUTH_TOKEN` | Host `.env` (production); `.env` on laptop (local HTTP); not used for DXT | Generate new (`openssl rand -hex 32`), update `.env`, `docker compose up -d`, update every connected client header. No revocation list — old token is dead the instant the new one is loaded. |
| GitHub feedback PAT [^pat] | Host `.env` / laptop `.env` / DXT user_config | Revoke PAT on GitHub → create new → update store → restart service. |

[^pat]: All transports use `NUXT_GITHUB_FEEDBACK_TOKEN` — HTTP modes read it via Nuxt runtime-config, and the DXT manifest injects that same name. `mcp-stdio/nuxt-shims.ts` resolves `NUXT_GITHUB_FEEDBACK_TOKEN ?? GITHUB_FEEDBACK_TOKEN`, keeping the un-prefixed `GITHUB_FEEDBACK_TOKEN` only as a back-compat fallback for older bundles.

## Dependency policy

- Renovate is configured (`renovate.json`); PRs open on the configured schedule (weekday 02:00–07:00 Europe/Minsk), with `vulnerabilityAlerts` raised out-of-schedule.
- **Image updates are split by file, not duplicated:** Dockerfile base images → Dependabot (`.github/dependabot.yml`); docker-compose infra images (digest-pinned `nginx-proxy` / `acme-companion` / `watchtower`) → Renovate's `docker-compose` manager. The full who-watches-what matrix and the step-by-step CVE response live in [Patching upstream CVEs in pinned images](#patching-upstream-cves-in-pinned-images).
- Merge cadence: Renovate auto-merges `patch` / `pin` / `digest` updates; `minor`, `major`, and all docker-compose infra-image bumps are held for review. PRs open in the weekday 02:00–07:00 (Europe/Minsk) window.
- Major bumps to `@bitrix24/b24jssdk`, `@modelcontextprotocol/sdk`, `zod`, or `@nuxtjs/mcp-toolkit` MUST trigger:
  - Re-run of the SDK-logger audit in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).
  - Manual smoke of all three transports (Remote HTTP, Local HTTP, DXT) — see [`MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md).
- The DXT bundle pins zod via a workaround (`mcp-stdio/nuxt-shims.ts` forces init). zod major bumps require revalidating that workaround.

## Patching upstream CVEs in pinned images

The reverse-proxy stack pins infra images by **SHA digest** — `nginx-proxy` and `acme-companion` in [`docker-compose.server.yml`](../docker-compose.server.yml), `watchtower` in [`docker-compose.watchtower.yml`](../docker-compose.watchtower.yml). A digest pin is immutable on purpose: `docker compose pull`, `make redeploy`, and Watchtower will **not** pull an upstream security fix on their own — the digest has to be bumped in git. So for every pinned image we own the patch cadence; it is not automatic.

### Who watches what

| Surface | Owner | Behaviour |
|---|---|---|
| npm dependencies | Renovate (`renovate.json`, `vulnerabilityAlerts: true`) | PRs on schedule (weekday 02:00–07:00 Europe/Minsk); security alerts out-of-schedule |
| GitHub Actions | Renovate (`helpers:pinGitHubActionDigests`) | SHA-pinned + `# vX.Y.Z` comment |
| Dockerfile base images | Dependabot (`.github/dependabot.yml`) | mutable-tag bumps, weekly |
| docker-compose infra images | Renovate `docker-compose` manager | tag **and** `@sha256` bumped together, all `docker-compose*.yml` |

> Dependabot's docker ecosystem only sees the canonical `docker-compose.yml`, not split names like `docker-compose.server.yml` ([dependabot-core#12134](https://github.com/dependabot/dependabot-core/issues/12134)) — that is why the Compose infra images are routed to Renovate. Don't re-enable Dependabot for compose; the two would race on the same image.
>
> Two `renovate.json` packageRules keep this clean: the app's own image (`docker-compose.yml`) is **excluded** from the docker-compose manager (it ships via CI `v*` tags), and infra-image bumps are **never auto-merged** — every nginx-proxy / acme-companion / watchtower change requires review.

### When a CVE drops in nginx (or any pinned image)

1. **Locate every copy.** Grep the repo for the image. The same nginx engine ships inside our `nginx-proxy` reverse proxy — this is plain upstream nginx, **not** the `bx-nginx` package from the Bitrix virtual machine (VMBitrix). A "bx-nginx" advisory does **not** apply to this project directly (we don't run VMBitrix; we talk to Bitrix24 over REST). The underlying nginx CVE, however, *does* apply to `nginx-proxy`. Keep these two layers separate when triaging.
2. **Check the real version, not the wrapper's.** Wrapper images (`nginx-proxy`, `acme-companion`) carry their own version number; find the *bundled* nginx — `docker exec nginx-proxy nginx -v`, or the wrapper's release notes — and compare *that* against the CVE's fixed version.
3. **Bump to a patched release and re-pin the digest.** Update the tag **and** the `@sha256:` digest — never leave the old digest behind (that would re-introduce the vulnerable image). Get the multi-arch manifest digest with `docker buildx imagetools inspect <ref>` (or `docker pull <ref>` → the `Digest:` line). Never hand-type or guess a digest.
4. **Roll it out.** The digest change in git is what makes `make redeploy` / `docker compose pull` actually fetch the fix on the host.
5. **Verify the patched version is live.** e.g. `docker exec nginx-proxy nginx -v` on the host must report the fixed version.

If Renovate has already opened the bump PR, prefer merging that — it computes the new digest for you. The manual steps above are the break-glass path when you can't wait for the next scheduled run.

## Pre-commit & CI scans

- `commitlint` runs on every commit message (conventional commits).
- ESLint enforces no direct `actions.*` calls; only `callV2/callV3/batchV2/batchV3` from `server/utils/sdk-helpers.ts`.
- *Planned (pre-GA): a secret-scanning hook (e.g. `gitleaks`) in pre-commit and CI. Today the only line of defence is reviewer eyes.*
