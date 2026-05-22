# Deployment

How this MCP server ships to production: a Docker image built and pushed by GitHub Actions on a `v*` tag, then pulled onto a single Linux host where it runs under `docker compose` behind a reverse proxy that terminates TLS. There is no PaaS / serverless path — the server is a long-lived Nitro process that keeps the Bitrix24 `RestrictionManager` state warm, so it wants a real container, not a function.

The shipped [`docker-compose.yml`](../docker-compose.yml) assumes an `nginx-proxy` + `acme-companion` stack on a shared `proxy-net` network. For other TLS terminators (Caddy / Traefik / plain nginx + certbot) see [`REVERSE-PROXY.md`](./REVERSE-PROXY.md).

> This doc is the **operator how-to**. The design rationale lives in [`PROJECT-BRIEF.md` § Production server — self-sufficiency](../PROJECT-BRIEF.md#production-server--self-sufficiency); incident response lives in [`RUNBOOK.md`](./RUNBOOK.md); secret/threat detail in [`SECURITY.md`](./SECURITY.md). Everything below describes what the repo's [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), and [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) actually do — keep them and this doc in sync when any of them change.

## At a glance

```
push a v* tag
        │
        ▼
GitHub Actions (deploy.yml)
  test    — lint + typecheck + unit tests
        ├─────────────┬───────────────┐
        ▼             ▼                │
  build           dxt                 │   build ∥ dxt run in parallel
  buildx → push   bundle .dxt →       │   (both need `test`)
  ghcr.io/…       attach to Release   │
        │                             │
        ▼                             │
  deploy  — SSH to prod: docker compose pull && up -d   (needs `build`)
  health  — curl https://<PROD_HOST>/api/health (10 tries, 5s timeout, 3s apart)
  rollback— on health failure, re-pin the previous image digest
```

> ⚠️ **Pushing a `v*` tag triggers an immediate production deploy.** There is no "build now, ship later" gate — the tag IS the release. Before tagging, make sure the deploy secrets/variables (below) are configured and you are ready for prod to change. If they are *not* configured the build still runs, but the deploy step fails at the SSH stage (no silent half-deploy). To add a manual approval gate, set required reviewers on the `production` Environment (Settings → Environments).

### Cutting a release

```bash
# 1. Bump the version in package.json only — nuxt.config.ts reads it
#    dynamically (mcp.version = the package.json "version"), so there is
#    nothing else to edit.
#    edit package.json "version"
git commit -am "chore(release): v0.1.0"
git push

# 2. Tag and push — this is what triggers the deploy
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Use an annotated (`-a`) `vMAJOR.MINOR.PATCH` (or `-alpha.N` / `-beta.N`) tag matching the bumped `package.json` version. A lightweight tag also fires the `v*` trigger, but annotated tags carry an author/date/message and are what `git describe` and the GitHub release UI expect.

**Re-deploying an existing release**: `workflow_dispatch` (Actions → Deploy → Run workflow) takes a `ref` input and re-runs the pipeline. ⚠️ Image *tagging* follows the `metadata-action` rules, which emit the semver tags (`0.1.0`, `0.1`) and `:latest` **only** when the triggering ref is a `v*` **tag**. Dispatching against a branch or bare SHA produces neither `:latest` nor the semver tags, so the deploy step's `docker compose pull` of `:latest` would pull a **stale** image. Always dispatch against a `v*` tag, never a branch/SHA — or override `BX24_IMAGE` to the exact digest/tag you intend.

## The image

- Built from the multi-stage [`Dockerfile`](../Dockerfile): a `node:22-alpine` builder runs `pnpm build`; the runtime stage copies only `.output` and runs `node .output/server/index.mjs` as the non-root `node` user.
- Published to **GitHub Container Registry**: `ghcr.io/bitrix24/templates-mcp`.
- Tags applied on a `v*` release (via `docker/metadata-action`): the semver `{{version}}` **without** the `v` prefix (e.g. `0.1.0`), `{{major}}.{{minor}}` (e.g. `0.1`), the raw tag ref **with** the prefix (e.g. `v0.1.0`), and `latest`. Note the prefix difference — for a manual rollback pin (below) use the no-prefix semver form `:0.1.0` or the digest, not the `v`-prefixed ref unless you mean it.
- The container `EXPOSE`s `3000` and ships a `HEALTHCHECK` (`wget -qO- http://localhost:3000/api/health`, `--interval=30s --timeout=5s --retries=3`). `docker-compose.yml` declares an equivalent compose-level healthcheck.
- The `dxt` job bundles the same tool catalogue as a Claude-Desktop `.dxt` and attaches it to the GitHub Release (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`../mcp-stdio/README.md`](../mcp-stdio/README.md)). It does not gate the deploy.

## Prerequisites — once per host

The deploy job SSHes into one host and runs `docker compose` there. Set the host up **once**:

- [ ] **Docker Engine ≥ 24 + Compose v2**; the SSH user can run `docker` (in the `docker` group).
- [ ] **A reverse proxy + TLS** — either the `nginx-proxy` + `acme-companion` stack on the shared `proxy-net` network (matches the default [`docker-compose.yml`](../docker-compose.yml)), or an alternative from [`REVERSE-PROXY.md`](./REVERSE-PROXY.md). nginx-proxy owns ports 80/443, watches for containers that declare `VIRTUAL_HOST`, and `acme-companion` issues/renews Let's Encrypt certs for any container that sets `LETSENCRYPT_HOST`.
- [ ] **An external Docker network `proxy-net`**, joined by both the proxy stack and this service (`docker network create proxy-net`).
- [ ] **DNS**: an `A`/`AAAA` record for your `VIRTUAL_HOST` / `LETSENCRYPT_HOST` pointing at the host, so acme-companion can complete the HTTP-01 challenge. Replace the `prod.example.com` placeholder used throughout with your real FQDN.
- [ ] **A Bitrix24 incoming webhook URL** bound to a dedicated service user (see the README quick start).
- [ ] **`NUXT_MCP_AUTH_TOKEN`** generated (`openssl rand -hex 32`).

`restart: always` on the service (and on the proxy stack) means everything comes back after a reboot — no host-level cron or systemd units.

## First-time bootstrap on the host

```bash
sudo mkdir -p /opt/bx24-template-mcp && sudo chown "$USER":"$USER" /opt/bx24-template-mcp
cd /opt/bx24-template-mcp

# Pull the shipped compose (it pulls the GHCR image; it does NOT build).
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/docker-compose.yml

# Create .env from the template, then fill in the values (see Environment below).
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/.env.example
mv .env.example .env && chmod 600 .env
${EDITOR:-vi} .env

# Default compose requires the shared proxy-net network.
docker network create proxy-net 2>/dev/null || true

# Authenticate to GHCR only if the image is private — public images need no login.
# echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-user> --password-stdin
```

The `.env` lives only on the host (mode `0600`, owned by the deploy user) and is never read or written by CI.

## GitHub configuration

The `deploy` job reads these from **Settings → Secrets and variables → Actions**:

| Kind | Name | Purpose |
|---|---|---|
| Secret | `SSH_HOST` | Production host address. |
| Secret | `SSH_USER` | SSH user (must be able to run `docker`). |
| Secret | `SSH_KEY` | Private key for that user. |
| Secret | `SSH_PORT` | Optional. Read as `secrets.SSH_PORT \|\| 22`, so leaving it unset defaults to `22` — don't create an empty secret, just omit it. (Moving this to a Variable is tracked in [#90](https://github.com/bitrix24/templates-mcp/issues/90).) |
| Variable | `PROD_HOST` | Public hostname for the post-deploy health check (`https://<PROD_HOST>/api/health`) and the environment URL. |
| Variable | `DEPLOY_PATH` | Optional; deploy directory on the host. Defaults to `/opt/bx24-template-mcp`. |

`GITHUB_TOKEN` (auto-provided) pushes the image to GHCR — no extra secret, but the repo's package settings must allow Actions to write packages. The workflow runs least-privilege (`contents: read` + `packages: read`), elevating per-job only where needed (`build` → `packages: write`, `dxt` → `contents: write`).

> ⚠️ **Hardening — host-key verification (open gap)**: the deploy uses `appleboy/ssh-action`, which does **not** verify the production host's SSH fingerprint by default. The runner trusts whatever host answers on `SSH_HOST` — so anyone able to redirect that address (DNS spoofing, BGP hijack, a cloud-network MITM) can capture `SSH_KEY` and gain shell + Docker-daemon access to production. Docker-daemon access is effectively root: the `.env` secrets, every running container, and the host filesystem are all reachable. **Not recommended for production without pinning.** Close it by setting the action's `fingerprint` input in `deploy.yml`, e.g.:
>
> ```yaml
>     with:
>       host: ${{ secrets.SSH_HOST }}
>       fingerprint: ${{ secrets.SSH_FINGERPRINT }}   # ssh-keyscan -p <port> <host>
> ```
>
> Tracked in [#89](https://github.com/bitrix24/templates-mcp/issues/89); it should land before the host serves real traffic.

## Environment variables

Set these in the `.env` file in the deploy directory (consumed by [`docker-compose.yml`](../docker-compose.yml)). Start from [`.env.example`](../.env.example).

| Variable | Required | Notes |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | ✅ | Inbound webhook URL of your portal. Bind it to a dedicated service user, not a person. |
| `NUXT_MCP_AUTH_TOKEN` | ✅ | Bearer token MCP clients must present on `/mcp`. Generate with `openssl rand -hex 32`. |
| `NUXT_GITHUB_FEEDBACK_TOKEN` | ⬜ | Enables `bx24mcp_submit_feedback`. Fine-grained PAT with Issues: read/write. `.env.example` ships a `github_pat_xxx` **placeholder** — clear it or replace it; a copied placeholder is an invalid token, not "disabled". |
| `NUXT_GITHUB_FEEDBACK_REPO` | ⬜ | `owner/name` for feedback issues. Defaults to `bitrix24/templates-mcp`. |
| `NUXT_LOG_LEVEL` | ⬜ | `info` (default) / `debug` / `warning` / `error`. |
| `NUXT_AUDIT_DIR` | ⬜ | Directory for the OAuth/Bearer audit JSONL log. Defaults to `/data/audit/`. Only written by the OAuth flow (Phase 3) — a webhook-only deploy leaves it unused. See [Monitoring & logs](#monitoring--logs). |
| `NITRO_PORT` | ✅ | Container listen port. Keep `3000` unless you also change `VIRTUAL_PORT` and the Dockerfile `EXPOSE`/`HEALTHCHECK`. Present in `.env.example`. |
| `NODE_ENV` | ✅ † | `production`. |
| `VIRTUAL_HOST` | ✅ | Hostname nginx-proxy routes to this container (e.g. `mcp.example.com`). |
| `VIRTUAL_PORT` | ✅ | Container port nginx-proxy forwards to — must equal `NITRO_PORT` (`3000`). |
| `LETSENCRYPT_HOST` | ✅ | Hostname acme-companion requests a cert for; normally the same as `VIRTUAL_HOST`. |
| `LETSENCRYPT_EMAIL` | ✅ | Contact email for Let's Encrypt. |

† **`NODE_ENV` is special — add it to the host `.env` by hand.** The production `docker-compose.yml` forwards it unconditionally (`NODE_ENV: ${NODE_ENV}`, **no** `:-production` default), so an unset value passes an **empty** string that overrides the image's baked-in `ENV NODE_ENV=production`. `.env.example` deliberately **omits** `NODE_ENV` — that line would break the Nuxt dev/test toolchain, which loads the repo-root `.env` via Vite and rejects `NODE_ENV=production` — so a copied `.env` has no value to forward. Add `NODE_ENV=production` to the host deploy `.env` yourself. That host file is read by *docker compose* for `${VAR}` interpolation and injected into the container as a real env var, so the dev-toolchain caveat does not apply to it. (The local-run `docker-compose.example.yml` instead uses `${NODE_ENV:-production}`, so it is safe without the variable.) `NITRO_PORT` has the same no-default forwarding in prod but is already in `.env.example`.

> **Secrets management**: the `.env` lives only on the host, never in the repo; the image carries no secrets and reads everything from the environment at runtime. Rotating `NUXT_MCP_AUTH_TOKEN` is **not zero-downtime** — editing `.env` and running `docker compose up -d` restarts the container and severs all current MCP clients at once (no dual-accept window), so plan a short maintenance window and re-issue the new token. Rotate `NUXT_GITHUB_FEEDBACK_TOKEN` the same way. Per-secret rotation detail lives in [`SECURITY.md`](./SECURITY.md) and [`FEEDBACK.md`](./FEEDBACK.md).

## What the deploy job does on the host

From [`deploy.yml`](../.github/workflows/deploy.yml), after the image is pushed:

```bash
cd "$DEPLOY_PATH"                      # default /opt/bx24-template-mcp
# Record the running image's repo digest for rollback. Two steps: the
# container exposes only its image ID (.Image), and only the image's own
# inspect carries .RepoDigests. Overwrite (not append) so we keep the
# last-known-good ref. On the very first deploy there is no container, so
# this resolves to an empty `previous=`.
CURRENT_DIGEST=""
IMAGE_ID=$(docker container inspect --format='{{.Image}}' bx24-template-mcp 2>/dev/null || true)
if [ -n "$IMAGE_ID" ]; then
  CURRENT_DIGEST=$(docker image inspect --format='{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$IMAGE_ID" 2>/dev/null || true)
fi
echo "previous=$CURRENT_DIGEST" > rollback.env
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f
```

Then it polls `https://<PROD_HOST>/api/health` up to 10 times (5s timeout each, 3s apart — worst case ~80s before declaring failure). If the service never returns 200, the **rollback** step distinguishes two cases: a **missing** `rollback.env` → "rollback.env missing — manual rollback required"; a present file with an **empty** `previous=` → "No previous image recorded — manual rollback required". Otherwise it pulls the recorded digest and re-pins it:

```bash
BX24_IMAGE="$PREV" docker compose up -d --remove-orphans
```

`docker-compose.yml` defaults its `image:` to `${BX24_IMAGE:-ghcr.io/bitrix24/templates-mcp:latest}`, so exporting `BX24_IMAGE` pins a specific digest without editing any file on disk.

## Manual rollback

If you need to roll back outside the automated flow, pin a known-good tag or digest. **Use only a literal tag or digest — never a value read from an untrusted source (a tampered `rollback.env`, env, or log output); it is passed to the shell.**

```bash
cd "$DEPLOY_PATH"
BX24_IMAGE="ghcr.io/bitrix24/templates-mcp:0.1.0" docker compose up -d --remove-orphans
curl -fsS https://<PROD_HOST>/api/health
```

`BX24_IMAGE` must be a valid image reference — a digest (`ghcr.io/bitrix24/templates-mcp@sha256:…`) or a `name:tag`. To make the pin permanent, set `BX24_IMAGE=…` in `.env` (otherwise the next `v*` deploy pulls `:latest` again). See [`RUNBOOK.md`](./RUNBOOK.md) for the full incident flow.

## Running a production-like container locally

To smoke-test the production image build without the proxy stack, use [`docker-compose.example.yml`](../docker-compose.example.yml) — it **builds** from the local `Dockerfile` and binds host port 3000 directly (no nginx-proxy, no TLS):

```bash
cp .env.example .env          # set NUXT_BITRIX24_WEBHOOK_URL + NUXT_MCP_AUTH_TOKEN
docker compose -f docker-compose.example.yml up --build
curl http://localhost:3000/api/health
```

No `NODE_ENV` export is needed here — `docker-compose.example.yml` defaults it (`${NODE_ENV:-production}`), unlike the production `docker-compose.yml` (see the env table † note). This verifies the image, not production serving — the real `docker-compose.yml` expects the external `proxy-net` network and nginx-proxy in front of it.

## Monitoring & logs

- **Health**: `/api/health` is unauthenticated and returns `{ status, service, timestamp }`. Point an external monitor (UptimeRobot / Healthchecks.io) at `https://<PROD_HOST>/api/health` for liveness alerting.
- **Logs**: container logs go to Docker's JSON driver (`docker compose logs -f`). Configure rotation at the daemon level. Long-term aggregation (Loki / Graylog) is out of scope for the template.
- **Audit log**: the OAuth/Bearer audit trail (`server/utils/audit-log.ts`) appends JSONL to `/data/audit/` (override with `NUXT_AUDIT_DIR`), creating the directory `0750` and files `0640`. Those modes are applied **only on creation** — if the directory already exists with broader permissions (e.g. after a redeploy or a manually-created mount), re-assert them: `chmod 0750 /data/audit && find /data/audit -name '*.jsonl' -exec chmod 0640 {} +`. **Files grow forever — operators MUST configure rotation/retention** (`logrotate` or `find -mtime`). Records carry `ip`/`ua` (GDPR personal data); cap retention at ~90 days (max 12 months absent a legal hold). Currently exercised only by the OAuth flow (Phase 3); a webhook-only Phase-1 deploy writes nothing here yet. See [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md).
- **Resources**: the compose service caps at 0.5 CPU / 512 MB — raise these in `docker-compose.yml` if your tool volume needs more.

## See also

- [`RUNBOOK.md`](./RUNBOOK.md) — what to do when the deploy or runtime breaks.
- [`REVERSE-PROXY.md`](./REVERSE-PROXY.md) — pick your TLS terminator.
- [`SECURITY.md`](./SECURITY.md) — threat model, secret rotation, disclosure.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — one tool catalogue, three transports (Remote HTTP, Local HTTP, DXT stdio).
- [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — "Production server — self-sufficiency" (the design rationale this doc operationalises).
- [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) — credential-handling audits (webhook URL redaction, supply-chain).
