# Deployment

How this MCP server ships to production: a Docker image built and pushed by GitHub Actions on a `v*` tag, then pulled onto a single Linux host where it runs under `docker compose` behind a reverse proxy that terminates TLS. There is no PaaS / serverless path — the server is a long-lived Nitro process that keeps the Bitrix24 `RestrictionManager` state warm, so it wants a real container, not a function.

The shipped [`docker-compose.yml`](../docker-compose.yml) assumes an `nginx-proxy` + `acme-companion` stack on a shared `proxy-net` network. For other TLS terminators (Caddy / Traefik / plain nginx + certbot) see [`REVERSE-PROXY.md`](./REVERSE-PROXY.md).

> This doc is the **operator how-to**. The design rationale lives in [`PROJECT-BRIEF.md` § Production server — self-sufficiency](../PROJECT-BRIEF.md#production-server--self-sufficiency); incident response lives in [`RUNBOOK.md`](./RUNBOOK.md); secret/threat detail in [`SECURITY.md`](./SECURITY.md). Everything below describes what the repo's [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), and [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) actually do — keep them and this doc in sync when any of them change.

## Quick deploy (3 steps)

Already have the host set up? This is all you need:

```bash
# 1. On your host — pull the new image and restart the container
cd /opt/bx24-template-mcp
# If Watchtower is running, stop it first so it doesn't race you:
#   make watchtower-stop
make redeploy          # = pull + up -d --wait (blocks until the container is healthy)

# 2. Verify it's healthy
make verify-local URL=https://your-domain.com

# 3. Done — check logs if something looks off
make logs
```

That's the normal upgrade path. See [Manual rollback](#manual-rollback) if you need to revert.

## At a glance

```
push a v* tag
        │
        ▼
GitHub Actions (deploy.yml → "Build & publish")
  test         — lint + typecheck + unit tests
        │
        ▼
  build        — buildx → push image to ghcr.io/…
        │
        ▼
  dxt-build    — bundle .dxt, upload as a workflow artifact
        │
        ▼  (only on a v* tag)
  dxt-release  — attach the .dxt artifact to the GitHub Release
```

CI builds and pushes the image to GHCR. **CI does not SSH into your server.** Pulling the image to production is the operator's responsibility — via Watchtower (detects updates; applies them only if you opt into auto-apply) or `make redeploy` (manual). No SSH secrets are needed in GitHub Actions.

### Option A — Watchtower (update detection; monitor-only by default)

[`docker-compose.watchtower.yml`](../docker-compose.watchtower.yml) is a Compose overlay. Run `make watchtower-up` instead of `make up` to start the app with Watchtower alongside it. Watchtower watches only the app container (via label). It ships **monitor-only by default** (`WATCHTOWER_MONITOR_ONLY: "true"`): it detects that a newer `:latest` exists and notifies you, but does **not** restart the container — you promote the update with the health-gated `make redeploy` (Option B), by hand or from a cron / systemd timer.

> ⚠️ **No native health gate or rollback.** This is why monitor-only is the default: if Watchtower auto-applied a crash-looping `:latest`, it would keep it running until you noticed. In monitor-only mode set `WATCHTOWER_NOTIFICATION_URL` so detections actually reach you — nothing is applied automatically. If you instead opt into unattended **auto-apply** (remove `WATCHTOWER_MONITOR_ONLY`), pair it with that notification URL **and** an external monitor (UptimeRobot / Healthchecks.io) on `/api/health` to catch a bad release fast.

> ⚠️ **Pushing a `v*` tag publishes a new image.** Watchtower detects it at the next nightly check (03:00 UTC); in auto-apply mode it would also restart onto it. Before tagging, make sure the server's `.env` is complete and the container is healthy.

### Option B — Manual redeploy

SSH into the host and run `make redeploy` (or `docker compose pull && docker compose up -d`) whenever you want to deploy a new image. No special CI secrets needed — just your normal SSH access to the host.

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

**Re-deploying an existing release**: `workflow_dispatch` (Actions → **Build & publish** → Run workflow) takes a `ref` input and re-runs the pipeline. ⚠️ Image *tagging* follows the `metadata-action` rules: the semver tags (`0.1.0`, `0.1`) and `:latest` are emitted **only** when the triggering ref is a `v*` **tag**. A dispatch against a branch or bare SHA publishes just a `sha-<short>` tag (never `:latest`/semver), so Watchtower — which tracks `:latest` — won't pick it up, and a `make redeploy` pulling `:latest` would get a **stale** image. To deploy a dispatched build, pull that exact `sha-<short>` tag (or set `BX24_IMAGE` to it). For a normal release, dispatch against a `v*` tag.

## The image

- Built from the multi-stage [`Dockerfile`](../Dockerfile): a `node:22-alpine` builder runs `pnpm build`; the runtime stage copies only `.output` and runs `node .output/server/index.mjs` as the non-root `node` user.
- Published to **GitHub Container Registry**: `ghcr.io/bitrix24/templates-mcp`.
- Tags applied on a `v*` release (via `docker/metadata-action`): the semver `{{version}}` **without** the `v` prefix (e.g. `0.1.0`), `{{major}}.{{minor}}` (e.g. `0.1`), the raw tag ref **with** the prefix (e.g. `v0.1.0`), and `latest`. Note the prefix difference — for a manual rollback pin (below) use the no-prefix semver form `:0.1.0` or the digest, not the `v`-prefixed ref unless you mean it.
- The container `EXPOSE`s `3000` and ships a `HEALTHCHECK` (`wget -qO- http://localhost:3000/api/health`, `--interval=30s --timeout=5s --retries=3`). `docker-compose.yml` declares an equivalent compose-level healthcheck.
- The `dxt-build` job bundles the same tool catalogue as a Claude-Desktop `.dxt` and uploads it as a workflow artifact; `dxt-release` attaches that artifact to the GitHub Release (only on `v*` tags) — see [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`../mcp-stdio/README.md`](../mcp-stdio/README.md). Neither gates the image build.

## Prerequisites — once per host

Set the host up **once**:

- [ ] **Docker Engine ≥ 24 + Compose v2**; the operator's account can run `docker` (in the `docker` group).
- [ ] **`jq`** — required for the JSON-RPC assertion in the smoke test (`make verify-local`). Without it the last two checks are skipped. Install once: `sudo apt install -y jq` (Debian/Ubuntu) or `brew install jq` (macOS).
- [ ] **A reverse proxy + TLS** — either the `nginx-proxy` + `acme-companion` stack on the shared `proxy-net` network (matches the default [`docker-compose.yml`](../docker-compose.yml)), or an alternative from [`REVERSE-PROXY.md`](./REVERSE-PROXY.md). nginx-proxy owns ports 80/443, watches for containers that declare `VIRTUAL_HOST`, and `acme-companion` issues/renews Let's Encrypt certs for any container that sets `LETSENCRYPT_HOST`.
- [ ] **An external Docker network `proxy-net`**, joined by both the proxy stack and this service (`docker network create proxy-net`).
- [ ] **DNS**: an `A`/`AAAA` record for your `VIRTUAL_HOST` / `LETSENCRYPT_HOST` pointing at the host, so acme-companion can complete the HTTP-01 challenge. Replace the `prod.example.com` placeholder used throughout with your real FQDN.
- [ ] **A Bitrix24 incoming webhook URL** bound to a dedicated service user (see the README quick start).
- [ ] **`NUXT_MCP_AUTH_TOKEN`** generated (`openssl rand -hex 32`).
- [ ] **`NODE_ENV=production`** added to the host `.env` (not the repo `.env`) — see the note in `.env.example`. Without it docker compose prints a warning on every command. One-liner: `echo "NODE_ENV=production" >> .env`.

`restart: always` on the service (and on the proxy stack) means everything comes back after a reboot — no host-level cron or systemd units.

## Makefile quick-reference

The repo ships a `Makefile` that wraps the most common operations so you don't have to memorise compose flags.

| Goal | Command |
|---|---|
| Local dev server | `make dev` |
| Unit tests / lint / typecheck | `make test` / `make lint` / `make typecheck` |
| Build DXT bundle for Claude Desktop | `make build-dxt` |
| Create `proxy-net` network (once) | `make init-network` |
| Start nginx-proxy + acme-companion (once, skip if already running) | `make server-up` |
| Stop nginx-proxy + acme-companion | `make server-down` |
| Build image from local source (requires repo clone with Dockerfile) | `make build` |
| Start application only | `make up` |
| Start application + Watchtower (auto-update overlay) | `make watchtower-up` |
| Stop application + Watchtower | `make watchtower-down` |
| Stop application only | `make down` |
| Pull latest image from GHCR (requires published release) | `make pull` |
| Pull latest image + restart | `make redeploy` |
| Show container status | `make ps` |
| Follow logs | `make logs` |
| Pause Watchtower during manual rollback | `make watchtower-stop` |
| Resume Watchtower after rollback | `make watchtower-start` |
| Smoke-test from external machine | `make verify URL=https://mcp.example.com` |
| Smoke-test directly on the server (hairpin NAT) | `make verify-local URL=https://mcp.example.com` |
| Remove stopped containers, dangling images, build cache ⚠️ also removes unused networks | `make clean` |

The reverse-proxy stack is defined in [`docker-compose.server.yml`](../docker-compose.server.yml). It runs `nginx-proxy` + `acme-companion` on the shared `proxy-net` network and handles TLS for any container that declares `VIRTUAL_HOST` / `LETSENCRYPT_HOST`. Start it once with `make server-up`; it survives host reboots via `restart: always`.

> **If nginx-proxy is already running on your host** (a common setup when you host multiple services), skip `make server-up` — running it twice causes a port 80/443 conflict. Check with `docker ps | grep nginx-proxy` before running.

## First-time bootstrap on the host

```bash
sudo mkdir -p /opt/bx24-template-mcp && sudo chown "$USER":"$USER" /opt/bx24-template-mcp
cd /opt/bx24-template-mcp

# Install jq — needed for the JSON-RPC assertions in the smoke test.
sudo apt install -y jq     # Debian / Ubuntu

# Pull the shipped compose (it pulls the GHCR image; it does NOT build).
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/docker-compose.yml

# Create .env from the template, then fill in the values (see Environment below).
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/.env.example
mv .env.example .env && chmod 600 .env
${EDITOR:-vi} .env

# Add NODE_ENV for production — docker compose needs it, see .env.example for why
# this goes in the HOST .env only (not the repo root .env).
echo "NODE_ENV=production" >> .env

# Default compose requires the shared proxy-net network.
docker network create proxy-net 2>/dev/null || true

# Authenticate to GHCR only if the image is private — public images need no login.
# echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-user> --password-stdin
```

The `.env` lives only on the host (mode `0600`, owned by the deploy user) and is never read or written by CI.

## GitHub configuration

Only `GITHUB_TOKEN` is needed — it is auto-provided and used by the `build` job to push the image to GHCR. No SSH secrets. Make sure the repo's package settings allow Actions to write packages (**Settings → Actions → General → Workflow permissions → Read and write**).

The workflow runs least-privilege (`contents: read`), elevating per-job only where needed (`build` → `packages: write`, `dxt-release` → `contents: write`, granted only on `v*` tag runs).

### Bring-your-own CD (forks / self-hosted)

If you fork this repo and want CI to deploy automatically, you have two options:

1. **Watchtower**: the `build` job already pushes to GHCR on every `v*` tag. Add the Watchtower overlay on your host — no workflow changes needed.
2. **Custom deploy step**: add a job to `deploy.yml` that SSHes in or calls a webhook after `build` succeeds. Keep secrets in GitHub Actions secrets; bind them through `env:` rather than interpolating `${{ secrets.* }}` directly into `run:` blocks (expression-injection risk — see CI authoring rule in `CONTRIBUTING.md`).

## Environment variables

Set these in the `.env` file in the deploy directory (consumed by [`docker-compose.yml`](../docker-compose.yml)). Start from [`.env.example`](../.env.example).

| Variable | Required | Notes |
|---|---|---|
| `NUXT_BITRIX24_WEBHOOK_URL` | ✅ | Inbound webhook URL of your portal. Bind it to a dedicated service user, not a person. |
| `NUXT_MCP_AUTH_TOKEN` | ✅ | Bearer token MCP clients must present on `/mcp`. Generate with `openssl rand -hex 32`. `.env.example` ships the `replace-with-secure-token` **placeholder** — leaving it unchanged makes `/mcp` return **503** (treated as "not configured"), never a working endpoint. |
| `NUXT_GITHUB_FEEDBACK_TOKEN` | ⬜ | Enables `bx24mcp_submit_feedback`. Fine-grained PAT with Issues: read/write. `.env.example` ships a `github_pat_xxx` **placeholder** — clear it or replace it; a copied placeholder is an invalid token, not "disabled". |
| `NUXT_GITHUB_FEEDBACK_REPO` | ⬜ | `owner/name` for feedback issues. Defaults to `bitrix24/templates-mcp`. |
| `NUXT_LOG_LEVEL` | ⬜ | `info` (default) / `debug` / `notice` / `warning` (alias `warn`) / `error` / `critical` / `alert` / `emergency`. Unset → `DEBUG` in dev, `INFO` otherwise. **An unrecognised non-empty value (typo like `debgu`, `infoo`) prints a one-line warning to `stderr` at startup** naming the variable, the value (capped at 32 chars and webhook-secret-redacted), the active `NODE_ENV`, and the level actually used — then falls back to the default. Empty / whitespace values stay silent. |
| `NUXT_AUDIT_DIR` | ⬜ | Directory for the OAuth/Bearer audit JSONL log. Defaults to `/data/audit/`. Only written by the OAuth flow (Phase 3) — a webhook-only deploy leaves it unused. See [Monitoring & logs](#monitoring--logs). |
| `NITRO_PORT` | ✅ | Container listen port. Keep `3000` unless you also change `VIRTUAL_PORT` and the Dockerfile `EXPOSE`/`HEALTHCHECK`. Present in `.env.example`. |
| `NODE_ENV` | ✅ † | `production`. |
| `VIRTUAL_HOST` | ✅ | Hostname nginx-proxy routes to this container (e.g. `mcp.example.com`). |
| `VIRTUAL_PORT` | ✅ | Container port nginx-proxy forwards to — must equal `NITRO_PORT` (`3000`). |
| `LETSENCRYPT_HOST` | ✅ | Hostname acme-companion requests a cert for; normally the same as `VIRTUAL_HOST`. |
| `LETSENCRYPT_EMAIL` | ✅ | Contact email for Let's Encrypt. |

† **`NODE_ENV` is special — add it to the host `.env` by hand.** The production `docker-compose.yml` forwards it unconditionally (`NODE_ENV: ${NODE_ENV}`, **no** `:-production` default), so an unset value passes an **empty** string that overrides the image's baked-in `ENV NODE_ENV=production`. `.env.example` deliberately **omits** `NODE_ENV` — that line would break the Nuxt dev/test toolchain, which loads the repo-root `.env` via Vite and rejects `NODE_ENV=production` — so a copied `.env` has no value to forward. Add `NODE_ENV=production` to the host deploy `.env` yourself. That host file is read by *docker compose* for `${VAR}` interpolation and injected into the container as a real env var, so the dev-toolchain caveat does not apply to it. (The local-run `docker-compose.example.yml` instead uses `${NODE_ENV:-production}`, so it is safe without the variable.) `NITRO_PORT` has the same no-default forwarding in prod but is already in `.env.example`.

> **Secrets management**: the `.env` lives only on the host, never in the repo; the image carries no secrets and reads everything from the environment at runtime. Rotating `NUXT_MCP_AUTH_TOKEN` is **not zero-downtime** — editing `.env` and running `docker compose up -d` restarts the container and severs all current MCP clients at once (no dual-accept window), so plan a short maintenance window and re-issue the new token. Rotate `NUXT_GITHUB_FEEDBACK_TOKEN` the same way. Per-secret rotation detail lives in [`SECURITY.md`](./SECURITY.md) and [`FEEDBACK.md`](./FEEDBACK.md).

## Manual rollback

### With Watchtower

Watchtower always converges on the latest pushed image. To roll back:

1. **Stop Watchtower** so it doesn't re-update while you roll back:
   ```bash
   make watchtower-stop
   ```
2. **Pin the old version** in `.env`:
   ```bash
   # Use the semver tag (no 'v' prefix) or the full digest
   echo 'BX24_IMAGE=ghcr.io/bitrix24/templates-mcp:0.1.0' >> .env
   ```
3. **Restart the app** with the pinned image:
   ```bash
   make up
   ```
4. Verify: `make verify-local URL=https://your-domain.com`
5. When stable, remove `BX24_IMAGE` from `.env` and resume Watchtower:
   ```bash
   make watchtower-start
   ```

Available image tags are published on the [GHCR page](https://github.com/bitrix24/templates-mcp/pkgs/container/templates-mcp) — copy the digest or tag from there. For a version tag, CI publishes both `v0.1.0` and `0.1.0` (no-prefix semver) — either works in `BX24_IMAGE`.

### Without Watchtower (manual redeploy)

Pin a known-good tag or digest. **Use only a literal tag or digest — never a value read from an untrusted source (log output, env dump); it is passed to the shell.**

```bash
cd /opt/bx24-template-mcp
BX24_IMAGE="ghcr.io/bitrix24/templates-mcp:0.1.0" docker compose up -d --remove-orphans
curl -fsS https://<your-domain>/api/health
```

`BX24_IMAGE` must be a valid image reference — a digest (`ghcr.io/bitrix24/templates-mcp@sha256:…`) or a `name:tag`. To make the pin permanent, set `BX24_IMAGE=…` in `.env` (otherwise the next `make redeploy` pulls `:latest`). See [`RUNBOOK.md`](./RUNBOOK.md) for the full incident flow.

## Running a production-like container locally

To smoke-test the production image build without the proxy stack, use [`docker-compose.example.yml`](../docker-compose.example.yml) — it **builds** from the local `Dockerfile` and binds host port 3000 directly (no nginx-proxy, no TLS):

```bash
cp .env.example .env          # set NUXT_BITRIX24_WEBHOOK_URL + NUXT_MCP_AUTH_TOKEN
docker compose -f docker-compose.example.yml up --build
curl http://localhost:3000/api/health
```

No `NODE_ENV` export is needed here — `docker-compose.example.yml` defaults it (`${NODE_ENV:-production}`), unlike the production `docker-compose.yml` (see the env table † note). This verifies the image, not production serving — the real `docker-compose.yml` expects the external `proxy-net` network and nginx-proxy in front of it.

## Verifying your deployment

Once the container is up — locally via `docker-compose.example.yml` or in production behind nginx-proxy — run the bundled smoke check. It exercises the same contract the CI `docker-smoke` job pins on every PR, so a green run on the host means the deployed bundle matches what CI signed off on. Recommended invocation passes the token via the environment so it does not appear in `/proc/<pid>/cmdline` (visible to other local users on shared hosts):

```bash
NUXT_MCP_AUTH_TOKEN="$(pass show bx24-mcp-token)" \
  ./scripts/verify-deployment.sh --url https://prod.example.com
```

`--token <value>` and `--token-stdin` are also accepted — see `./scripts/verify-deployment.sh --help` for retry / timeout / TLS knobs (`--health-retries`, `--health-interval`, `--timeout`, `--insecure` for self-signed staging hosts, `--no-color`).

What it asserts:

- `/api/health` returns `200 {"status":"ok",...}` — strict `.status == "ok"` predicate via `jq` when available, substring match as a BusyBox-friendly fallback. Retries until ready (default ≈ 60s; raise with `--health-retries`).
- `/mcp` **without** an `Authorization` header → `401`.
- `/mcp` with a **wrong**, length-matched Bearer → `401` (length-matching forces the call past the byte-length short-circuit in `server/middleware/mcp-auth.ts` so the timing-safe content comparator is the path actually exercised).
- `/mcp` with the **configured** Bearer → anything other than `401` / `403` / `503` (the MCP toolkit may answer `200` / `202` / `405` to a bare GET; what matters is that auth passed).
- **JSON-RPC `initialize` round-trip** → `POST /mcp` with a real `initialize` payload and `Accept: application/json, text/event-stream`; the response must be a valid JSON-RPC envelope (`jsonrpc: "2.0"`, matching `id`, `result.protocolVersion` populated), `result.serverInfo.name === "bx24-template-mcp"`, and `result.capabilities.tools` advertised. A follow-up `tools/list` must include `b24_user_me` in the catalogue.
  - *Why it's here*: this pins the `@nuxtjs/mcp-toolkit` dispatcher. A middleware refactor whose error lands in Nitro's uncaught-error handler (becoming a `500` instead of a JSON-RPC error envelope) ships green under the four checks above but fails here.
  - *Stateless mode*: the follow-up `tools/list` carries no `Mcp-Session-Id` — `@nuxtjs/mcp-toolkit`'s node provider defaults to **stateless mode**, so each `/mcp` request is independently authenticated and the SDK neither issues nor requires a session header.
  - *Requires `jq`*: if `jq` is not on PATH this assertion is **skipped** with a notice (the JSON-RPC predicates are too brittle without real parsing).

**Running the check from the server itself (hairpin NAT).** Many VPS and dedicated-server setups use a firewall or NAT configuration where the host cannot reach its own public IP — `curl https://mcp.example.com` from the box times out even though the service is perfectly healthy. Use `make verify-local` instead of `make verify`: it passes `--resolve mcp.example.com:127.0.0.1` to curl so the connection goes through the loopback interface while TLS is still verified against the real certificate (no `--insecure` needed). You can also run it directly:

```bash
bash scripts/verify-deployment.sh --url https://mcp.example.com \
  --resolve mcp.example.com:127.0.0.1
```

What it does **not** do:

- It makes **no Bitrix24 REST call** — safe to run against production. For a live tool call after this passes, use the canonical operator prompts in [`docs/MANUAL-TEST-PHRASES.md`](./MANUAL-TEST-PHRASES.md) through an MCP client (Claude Desktop via `mcp-remote`, MCP Inspector, etc.).
- It does **not** verify the reverse-proxy config end-to-end beyond "TLS terminates and `/api/health` / `/mcp` reach the container". Header forwarding (`X-Forwarded-*`), `proxy_read_timeout` for long MCP responses, and TLS cert chain depth are out of scope here — see [`REVERSE-PROXY.md`](./REVERSE-PROXY.md). (TLS verification itself **is** on by default — a broken cert chain fails the run with a curl error; pass `--insecure` only for self-signed staging.)
- It does **not** check that the container runs as a non-root user. That assertion lives in the CI `docker-smoke` job (via `docker exec ... id -u`) and is intentionally not duplicated in the operator script, which avoids `docker exec` so it can run against a remote URL the operator does not have shell access to.

Failure behaviour: the `/api/health` step **bails early** if it can't reach `200` within the retry budget — and prints a layered hint (`502/503/504` = proxy reaches an unhealthy upstream, `000` = TLS handshake / DNS / firewall, other = cold boot / crash loop). All later assertions (three Bearer-auth checks + the JSON-RPC `initialize` + `tools/list` round-trip) **accumulate failures** instead of bailing, so a single run surfaces every regression at once with inline `✗` lines. The script exits non-zero when any assertion failed. The most common production miss is `/mcp → 503`, which means `NUXT_MCP_AUTH_TOKEN` is unset or still the `replace-with-secure-token` placeholder — that 503 is by design (see [`server/middleware/mcp-auth.ts`](../server/middleware/mcp-auth.ts)).

## Monitoring & logs

- **Health**: `/api/health` is unauthenticated and returns `{ status, timestamp }` (no `service` or version field — kept minimal so the probe is not a fingerprinting surface). Point an external monitor (UptimeRobot / Healthchecks.io) at `https://<your-domain>/api/health` for liveness alerting; key your checks on `status: "ok"`, not on a service-name field.
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
