# Deployment

How this MCP server ships to production: a Docker image built and pushed by GitHub Actions on a `v*` tag, then pulled onto a single host where it runs behind a shared `nginx-proxy` + `acme-companion` stack that terminates TLS. There is no PaaS / serverless path — the server is a long-lived Nitro process that keeps the Bitrix24 `RestrictionManager` state warm, so it wants a real container, not a function.

Everything below describes what the repo's [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), and [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) actually do — keep them and this doc in sync when any of them change.

> This doc is the **operator how-to**; the design rationale lives in [`PROJECT-BRIEF.md` § Production server — self-sufficiency](../PROJECT-BRIEF.md#production-server--self-sufficiency). If the two ever diverge, treat this doc as authoritative for *how to operate* and fix the brief.

## At a glance

```
push a v* tag
        │
        ▼
GitHub Actions (deploy.yml)
  1. Verify   — lint + typecheck + unit tests
  2. Build    — docker buildx → push to ghcr.io/bitrix24/templates-mcp
  3. Deploy   — SSH to prod host: docker compose pull && up -d
  4. Health   — curl https://<PROD_HOST>/api/health (10 tries)
  5. Rollback — on health failure, re-pin the previous image digest
```

> ⚠️ **Pushing a `v*` tag triggers an immediate production deploy.** There is no "build now, ship later" gate — the tag IS the release. Before tagging: make sure the deploy secrets/variables (below) are configured and you are ready for prod to change. If they are *not* configured the pipeline build still runs but the deploy step fails at the SSH stage (no silent half-deploy).

### Cutting a release

```bash
# 1. Bump the version (keep package.json + nuxt.config.ts mcp.version in step)
#    edit package.json "version" and nuxt.config.ts mcp.version
git commit -am "chore(release): v0.1.0"
git push

# 2. Tag and push — this is what triggers the deploy
git tag v0.1.0
git push origin v0.1.0
```

Use an annotated `vMAJOR.MINOR.PATCH` (or `-alpha.N` / `-beta.N`) tag matching the bumped `package.json` version.

**Re-deploying an existing release**: `workflow_dispatch` (Actions → Deploy → Run workflow) takes a `ref` input and re-runs verify+build+deploy. ⚠️ Image *tagging* still follows the `metadata-action` rules, which only emit the `:latest` tag (and the semver tags) when the triggering ref is a `v*` **tag** — running a dispatch against a branch or bare SHA will not refresh `:latest`, and the deploy step's `docker compose pull` of `:latest` would then pull a **stale** image. Always dispatch against a `v*` tag, never a branch/SHA, unless you also override `BX24_IMAGE` to the exact image you intend.

## The image

- Built from the multi-stage [`Dockerfile`](../Dockerfile): `node:22-alpine` builder runs `pnpm build`, the runtime stage copies only `.output` and runs `node .output/server/index.mjs` as the non-root `node` user.
- Published to **GitHub Container Registry**: `ghcr.io/bitrix24/templates-mcp`.
- Tags applied on a `v*` release (via `docker/metadata-action`): the semver `{{version}}` **without** the `v` prefix (e.g. `0.1.0`), `{{major}}.{{minor}}` (e.g. `0.1`), the raw tag ref **with** the prefix (e.g. `v0.1.0`), and `latest`. Note the prefix difference — for a manual rollback pin (below) use the no-prefix semver form `:0.1.0` or the digest, not the `v`-prefixed ref unless you mean it.
- The container `EXPOSE`s `3000` and ships a `HEALTHCHECK` (`/api/health`, `--interval=30s --timeout=5s --retries=3`). `docker-compose.yml` declares an equivalent compose-level healthcheck with the same parameters.

## Prerequisites on the production host

The deploy job SSHes into one host and runs `docker compose` there. That host needs to be set up **once**:

1. **Docker Engine + Compose v2** installed; the SSH user can run `docker` (in the `docker` group).
2. **A shared `nginx-proxy` + `acme-companion` stack** running separately (the brief assumes `/opt/nginx-proxy/docker-compose.yml`). It owns ports 80/443, watches for containers that declare `VIRTUAL_HOST`, and `acme-companion` issues/renews Let's Encrypt certs for any container that sets `LETSENCRYPT_HOST`.
3. **An external Docker network named `proxy-net`**, which both the proxy stack and this service join:
   ```bash
   docker network create proxy-net   # once, if it doesn't exist
   ```
4. **A deploy directory** (default `/opt/bx24-template-mcp`, override with the `DEPLOY_PATH` repo variable) containing:
   - [`docker-compose.yml`](../docker-compose.yml) from this repo (copy it there; it pulls the GHCR image, it does **not** build).
   - A `.env` file with the production values (see [Environment](#environment-variables) below).
5. **DNS**: an `A`/`AAAA` record for your `VIRTUAL_HOST` / `LETSENCRYPT_HOST` pointing at the host, so acme-companion can complete the HTTP-01 challenge.

`restart: always` on the service (and on the proxy stack) means everything comes back after a reboot — no host-level cron or systemd units.

## GitHub configuration

The `deploy` job reads these from the repo's **Settings → Secrets and variables → Actions**:

| Kind | Name | Purpose |
|---|---|---|
| Secret | `SSH_HOST` | Production host address. |
| Secret | `SSH_USER` | SSH user (must be able to run `docker`). |
| Secret | `SSH_KEY` | Private key for that user. |
| Secret | `SSH_PORT` | Optional. Read as `secrets.SSH_PORT \|\| 22`, so leaving the secret unset defaults to `22` — don't create an empty secret, just omit it. |
| Variable | `PROD_HOST` | Public hostname for the post-deploy health check (`https://<PROD_HOST>/api/health`) and the environment URL. |
| Variable | `DEPLOY_PATH` | Optional; deploy directory on the host. Defaults to `/opt/bx24-template-mcp`. |

`GITHUB_TOKEN` (auto-provided) is used to push the image to GHCR — no extra secret needed, but the repo's package settings must allow Actions to write packages.

> **Hardening — host-key verification**: the deploy uses `appleboy/ssh-action`, which does **not** verify the production host's SSH fingerprint by default. That leaves a (small, CI-only) MITM window on the runner → host channel. For a hardened setup, pin the host key via the action's `fingerprint` input in `deploy.yml` (a separate change — tracked as an infra issue). Until then, the runner trusts whatever host answers on `SSH_HOST`.

## Environment variables

Set these in the `.env` file in the deploy directory (consumed by [`docker-compose.yml`](../docker-compose.yml)). Start from [`.env.example`](../.env.example).

| Variable | Required | Notes |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | ✅ | Inbound webhook URL of your portal. See the README "How to create a Bitrix24 webhook". Bind it to a dedicated service user, not a person. |
| `NUXT_MCP_AUTH_TOKEN` | ✅ | Bearer token MCP clients must present on `/mcp`. Generate with `openssl rand -hex 32`. |
| `NUXT_GITHUB_FEEDBACK_TOKEN` | ⬜ | Enables `bx24mcp_submit_feedback`. Fine-grained PAT with Issues: read/write. Leave empty to disable the meta-tool. |
| `NUXT_GITHUB_FEEDBACK_REPO` | ⬜ | `owner/name` for feedback issues. Defaults to `bitrix24/templates-mcp`. |
| `NUXT_LOG_LEVEL` | ⬜ | `info` (default) / `debug` / `warning` / `error`. |
| `NITRO_PORT` | ✅ † | Container listen port. Keep `3000` unless you also change `VIRTUAL_PORT` and the Dockerfile `EXPOSE`/`HEALTHCHECK`. |
| `NODE_ENV` | ✅ † | `production`. |
| `VIRTUAL_HOST` | ✅ | Hostname nginx-proxy routes to this container (e.g. `mcp.example.com`). |
| `VIRTUAL_PORT` | ✅ | Container port nginx-proxy forwards to — must equal `NITRO_PORT` (`3000`). |
| `LETSENCRYPT_HOST` | ✅ | Hostname acme-companion requests a cert for; normally the same as `VIRTUAL_HOST`. |
| `LETSENCRYPT_EMAIL` | ✅ | Contact email for Let's Encrypt. |

† `NITRO_PORT` and `NODE_ENV` have image-level defaults baked into the [`Dockerfile`](../Dockerfile) (`ENV NITRO_PORT=3000`, `ENV NODE_ENV=production`), but `docker-compose.yml` forwards them unconditionally (`NITRO_PORT: ${NITRO_PORT}`, not `${NITRO_PORT:-3000}`) — so leaving them out of `.env` passes an **empty** value that overrides the image default. Keep both in `.env` ([`.env.example`](../.env.example) already sets them).

> **Secrets management**: the `.env` lives only on the host, never in the repo. The image carries no secrets — it reads everything from the environment at runtime. Rotating `NUXT_MCP_AUTH_TOKEN` is **not zero-downtime**: editing `.env` and running `docker compose up -d` restarts the container and severs all current MCP clients at once (there is no dual-accept window), so plan a short maintenance window and re-issue the new token to the clients that should keep access. Rotate `NUXT_GITHUB_FEEDBACK_TOKEN` the same way (see [`FEEDBACK.md`](./FEEDBACK.md)).

## What the deploy job does on the host

From [`deploy.yml`](../.github/workflows/deploy.yml), after the image is pushed:

```bash
cd "$DEPLOY_PATH"                      # default /opt/bx24-template-mcp
# record the currently-running image digest for rollback (guarded: on the very
# first deploy there is no running container, so this resolves to empty)
IMAGE_ID=$(docker container inspect --format='{{.Image}}' bx24-template-mcp 2>/dev/null || true)
# → writes `previous=<digest>` (or `previous=` on first deploy) to rollback.env
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f
```

On the **first** deploy `rollback.env` holds an empty `previous=` — that's expected; the rollback step below detects it and exits with "No previous image recorded — manual rollback required" instead of pinning garbage.

Then it polls `https://<PROD_HOST>/api/health` up to 10 times (3s apart). If the service never returns 200, the **rollback** step reads `previous=` from `rollback.env`, pulls that digest, and re-pins it:

```bash
BX24_IMAGE="$PREV" docker compose up -d --remove-orphans
```

`docker-compose.yml` defaults its `image:` to `${BX24_IMAGE:-ghcr.io/bitrix24/templates-mcp:latest}`, so exporting `BX24_IMAGE` pins a specific digest without editing any file on disk.

## Manual rollback

If you need to roll back outside the automated flow:

```bash
cd "$DEPLOY_PATH"
# pin a known-good tag or digest:
BX24_IMAGE="ghcr.io/bitrix24/templates-mcp:0.1.0" docker compose up -d --remove-orphans
# verify
curl -fsS https://<PROD_HOST>/api/health
```

`BX24_IMAGE` must be a valid image reference — a digest (`ghcr.io/bitrix24/templates-mcp@sha256:…`) or a `name:tag`. Never interpolate an untrusted string into it; it's passed to the shell. To make the pin permanent, set `BX24_IMAGE=…` in `.env` (otherwise the next `v*` deploy pulls `:latest` again).

## Running a production-like container locally

To smoke-test the production image build without the proxy stack, use [`docker-compose.example.yml`](../docker-compose.example.yml) — it **builds** from the local `Dockerfile` and binds host port 3000 directly (no nginx-proxy, no TLS):

```bash
cp .env.example .env          # set at least NUXT_BITRIX24_WEBHOOK_URL + NUXT_MCP_AUTH_TOKEN
docker compose -f docker-compose.example.yml up --build
curl http://localhost:3000/api/health
```

This is for verifying the image, not for serving production traffic — the real `docker-compose.yml` expects the external `proxy-net` network and the nginx-proxy stack in front of it.

## Monitoring & logs

- **Health**: `/api/health` is unauthenticated and returns `{ status, service, timestamp }`. Point an external monitor (UptimeRobot / Healthchecks.io) at `https://<PROD_HOST>/api/health` for liveness alerting.
- **Logs**: container logs go to Docker's JSON driver (`docker compose logs -f`). Configure rotation at the daemon level. Long-term aggregation (Loki / Graylog) is out of scope for the template.
- **Resources**: the compose service caps at 0.5 CPU / 512 MB — raise these in `docker-compose.yml` if your tool volume needs more.

## Related

- [`../PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) — "Production server — self-sufficiency" section (the design rationale this doc operationalises).
- [`FEEDBACK.md`](./FEEDBACK.md) — `NUXT_GITHUB_FEEDBACK_TOKEN` setup and rotation.
- [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md) — credential-handling audits (webhook URL redaction, supply-chain).
