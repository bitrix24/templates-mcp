# Security policy

`Last reviewed: 2026-06-14`

Policy and process. The dependency-level audit (what the SDK logs, what the redactor catches) lives in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).

## Reporting a vulnerability

- **Do not** open a public GitHub issue for security reports.
- Use **GitHub Security Advisories** for this repository: <https://github.com/bitrix24/templates-mcp/security/advisories/new>. The form is private to the reporter and the maintainers, lets us iterate on a fix in a private fork, and pins a CVE on publication. Include reproduction steps, affected version, and the impact you observed.
- Acknowledgement within **~5 business days** (best-effort, pre-release; no formal SLA until GA). Fix timeline depends on severity.

## Supported versions

While the project is pre-release, only the latest tag receives fixes. Once a `v0.x` line stabilises, this section will list the supported range.

## Threat model — what's in scope

- **Webhook URL secret leak.** The webhook URL contains a per-user secret. Logger redaction is the primary control — see `server/utils/logger-redactor.ts` and the audit pass in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md). Any dependency bump that touches the SDK or its logger surface MUST re-run the audit. Redaction is **URL-shaped only**: if a Bitrix24 REST endpoint ever returns a credential as a JSON value (e.g. `{ token: "…" }`) and that body lands in `getLogger().info('post/response', …)`, the redactor will not catch it. No known REST method does this today; tracked as a known limitation in [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).
- **Bearer token leak (HTTP modes).** With `NUXT_BITRIX24_OAUTH_ENABLED=false` (the default), `NUXT_MCP_AUTH_TOKEN` is the only thing between a public `/mcp` and tool execution against your portal. It's compared with `crypto.timingSafeEqual`. Rotation procedure below.
- **OAuth multi-tenant (opt-in).** When `NUXT_BITRIX24_OAUTH_ENABLED=true`, `/mcp` accepts per-user OAuth Bearers instead and `NUXT_MCP_AUTH_TOKEN` is **bypassed** there — each user acts under their own Bitrix24 identity. The controls: Bearers are stored as sha256 hashes (never plaintext) in a SQLite store on a persistent volume; revocation is immediate; every 401 carries a `WWW-Authenticate` errorCode; the operator `/api/oauth/_health` endpoint is gated by a *separate* `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` (privilege separation — the agent's token must never read fleet counts). The design, threat model, and event taxonomy live in [`OAUTH-DESIGN.md`](./OAUTH-DESIGN.md); the operator guide + migration warning in [`DEPLOYMENT.md` → OAuth 2.0 multi-tenant](./DEPLOYMENT.md#oauth-20-multi-tenant-opt-in). **Migration hazard:** flipping the flag on without first migrating clients to per-user Bearers 401s every connected client (no dual-accept window). **Upstream-trust defence (issue #220):** the `domain`, `client_endpoint`, and `server_endpoint` fields Bitrix24 returns at token exchange and refresh are NOT trusted verbatim — they are validated against an allow-list and the previously-authorised portal (`server/utils/portal-validation.ts`). A divergent `domain` is refused (`502 EXCHANGE-DOMAIN-MISMATCH` on `/callback`; `domain-mismatch` throw on refresh) rather than silently persisted; a divergent endpoint URL is replaced with the safe canonical form and logged as `oauth.endpoint.reject`. This blunts an upstream compromise of `oauth.bitrix24.tech` (DNS/BGP poisoning) that would otherwise redirect a tenant's REST calls to an attacker host. Every `B24OAuth` instance also gets the URL-redacting logger, same as the webhook client. **HTTP-surface hardening (issue #221):** the `/api/oauth/callback` HTML pages (including the one that displays the freshly-minted Bearer) carry `X-Frame-Options: DENY` + a strict `default-src 'none'; frame-ancestors 'none'` CSP **on every response — success, HTML exchange-error pages, and the early JSON-deny throws alike** — so a same-site frame (subdomain takeover, sibling-app XSS) cannot read the token off the page on any path; both `/api/oauth/install` and `/api/oauth/callback` are rate-limited per source IP via [`server/middleware/oauth-rate-limit.ts`](../server/middleware/oauth-rate-limit.ts) (install: 10/min for the `oauth_state`-flood vector; callback: 30/min for the junk-`state` SQLite-DELETE vector — both flag-gated, raw socket IP, surfacing `errorCode: RATE-LIMITED` per [§11 of `OAUTH-DESIGN.md`](./OAUTH-DESIGN.md#11-observability--logging)); the raw `?portal=` value is stripped of C0/C1/DEL controls, Unicode bidi overrides (U+202A-U+202E, U+2066-U+2069), and zero-widths/BOM (Trojan Source defence against the operator's log viewer) then length-capped before it reaches the structured log; and the `bx24mcp_submit_feedback` quota is keyed per tenant under OAuth so one tenant cannot starve another's window. **Operator-UX follow-up (#232):** `/api/oauth/install` renders a JS-free landing form to browsers (`Accept: text/html`) when `?portal=` is absent, so non-technical operators don't have to hand-craft a query string; the install page tightens `form-action` to the exact install path (`form-action /api/oauth/install`, NOT `'self'` — minimum privilege, browsers honour CSP-L2 path-level form-action), and the callback page omits the directive entirely (no `<form>`). The shared helper `server/utils/oauth-html.ts` is the single source of truth for both — no scripts, no inline styles, no external assets are permitted on either route. CLI callers without `text/html` keep the unchanged JSON `400 PORTAL-FORMAT` contract (body + status); the rate-limit middleware skips landing-form renders (no `?portal=`) so a browser F5 cannot self-429 the operator off the page they're using.
- **Prompt injection via tool input.** Defensive hardening for LLM-controlled keys lives in `server/utils/v3-filter.ts` and `wire-coerce.ts`; commit history references it as "defensive hardening for toV3Filter / pick against LLM-controlled keys" (PR #41). Re-audit if a new tool builds Bitrix24 REST filters from agent input.
- **Tool delete operations.** Every delete tool gates on `confirmDelete: true` (Ground Rule #9 in `skills/manage-bx24-template-mcp/SKILL.md`). Cascade-destructive deletes layer a second confirm (Rule #10).
- **DXT bundle.** Webhook lives in OS keychain via Claude Desktop's `user_config` (`sensitive: true`). Unpacked bundle lives on disk as plain files — protect with full-disk encryption if the threat model includes physical access.

## Out of scope (today)

- Horizontally-scaled (multi-replica) OAuth. The OAuth token cache + refresh state are process-local, so the multi-tenant flow is supported on a **single instance** only; a shared token store for 2+ replicas behind a load balancer is a known limitation (see [`OAUTH-DESIGN.md`](./OAUTH-DESIGN.md) §5 / §12). Single-instance multi-tenant OAuth itself **is** in scope and shipped — see the threat-model entry above.
- DoS mitigation beyond Docker resource limits — **except** the per-IP rate limits on `/api/oauth/install` (10/min, against the `oauth_state`-flood vector) and `/api/oauth/callback` (30/min, against the junk-`state` SQLite-DELETE vector) from issue #221, both surfacing errorCode `RATE-LIMITED` per [§11 of `OAUTH-DESIGN.md`](./OAUTH-DESIGN.md#11-observability--logging). General load-shedding / L7 DDoS protection is still the reverse proxy's job.
- Audit log of tool invocations. *Planned (pre-GA): retention policy / log shipping when this lands.*

## Secret rotation

| Secret | Where it lives | Rotation procedure |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | Host `.env` (production); `.env` on laptop (local HTTP); OS keychain (DXT) | Revoke webhook in Bitrix24 portal → create new → update store → `docker compose up -d` (production) or restart client (DXT). The old URL fails closed (401/403). |
| `NUXT_MCP_AUTH_TOKEN` | Host `.env` (production); `.env` on laptop (local HTTP); not used for DXT | Generate new (`openssl rand -hex 32`), update `.env`, `docker compose up -d`, update every connected client header. No revocation list — old token is dead the instant the new one is loaded. |
| GitHub feedback PAT [^pat] | Host `.env` / laptop `.env` / DXT user_config | Revoke PAT on GitHub → create new → update store → restart service. |
| `NUXT_BITRIX24_OAUTH_CLIENT_SECRET` (OAuth on) | Host `.env` | Rotate the secret on the Bitrix24 Marketplace application → update `.env` → `docker compose up -d`. Existing minted Bearers keep working (they don't carry the client secret); only the authorize/refresh exchange uses it. |
| `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` (OAuth on) | Host `.env` | Generate new (`openssl rand -hex 32`), update `.env`, `docker compose up -d`. Gates `/api/oauth/_health` only — rotating it does not affect user Bearers or `/mcp`. |

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
- **Workflow static analysis (`actionlint` + `zizmor`) — BOTH ENFORCING** (issues #178, #179). Two complementary CI jobs block the build on any finding in `.github/workflows/**`. `zizmor` owns *security* (template injection, artifact/cache poisoning, dangerous triggers, excessive permissions, credential persistence); `actionlint` owns *correctness* (YAML schema, `${{ }}` expression validity, deprecated/mutable `uses:` refs, shellcheck on embedded `run:` blocks). `zizmor` runs a **pinned** binary (`version: 1.25.2`) in **offline** mode so the gate is reproducible against a local `zizmor --offline .github/workflows/` and isn't perturbed by live advisory-DB changes; accepted findings are annotated inline with `# zizmor: ignore[<audit>]` + a justification (see `deploy.yml`). `actionlint` is likewise pinned (`1.6.24`, SHA-256-verified download). Bump either deliberately and re-triage. The custom single-line expression-injection regex guard that backstopped these during the rollout was removed in #179 once both flipped to blocking — it had become a strict subset of what they enforce.
- *Planned (pre-GA): a secret-scanning hook (e.g. `gitleaks`) in pre-commit and CI. Today the only line of defence is reviewer eyes.*
