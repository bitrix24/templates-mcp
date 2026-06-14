# Runbook

`Last reviewed: 2026-06-14`

> **Placeholders:** every literal `prod.example.com` below is your production host — substitute your own domain. Every `/opt/bx24-template-mcp` is your deploy directory (the default shown; wherever you cloned the compose stack). These are host-side values only — CI holds no `PROD_HOST` / `DEPLOY_PATH` variables.

Incident response for `bx24-template-mcp` in production. Pair with [`DEPLOYMENT.md`](./DEPLOYMENT.md) (how the system is set up) and [`SECURITY.md`](./SECURITY.md) (incidents that require disclosure).

## On-call basics

- **Service:** `bx24-template-mcp` Docker container on `prod.example.com`.
- **Healthcheck URL:** `https://prod.example.com/api/health` (and `http://localhost:3000/api/health` from the host).
- **Logs:** `docker logs --since=15m $(docker compose ps -q bx24-template-mcp)` on the host (the container name now resolves from `COMPOSE_PROJECT_NAME` — default `bx24-mcp-app` — so use the service-name lookup, not the raw container name; see [Container naming after #189](#container-naming-after-189) below). SDK logs are URL-redacted via `makeRedactingLogger`.
- **Compose dir:** `/opt/bx24-template-mcp` (or wherever you deployed the compose stack).
- **On-call:** pre-GA this is a single maintainer on a best-effort basis — no formal rotation, paging channel, or RTO yet.

## Alert → action

| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health` returns non-2xx for ≥3 minutes | Container crash-looped or stuck | `docker logs --tail=200 $(docker compose ps -q bx24-template-mcp)`; if recent deploy, [rollback](#rollback) |
| 503 "MCP endpoint is not available" on `/mcp` | `NUXT_MCP_AUTH_TOKEN` missing/empty in `.env` | Edit `/opt/bx24-template-mcp/.env`, `docker compose up -d` |
| 401 "Invalid bearer token" from clients that worked yesterday | Token rotated, or client config drift | Diff client header against `.env` value; if intentional rotation, update clients |
| GitHub Actions build job failed at "Build & push" | CI test fail, GHCR permission, or buildx error | Re-read job output; common: `pnpm test:unit` regression, GHCR rate limit |
| Bitrix24 calls failing with 401/403 | Webhook revoked or scope changed in the portal | Recreate webhook in portal; update `NUXT_BITRIX24_WEBHOOK_URL` in `.env`; `docker compose up -d` |
| Bitrix24 calls failing with `QUERY_LIMIT_EXCEEDED` / 503 | Rate limit on the portal side | No action needed — `RestrictionManager` retries with back-off. If sustained, lower client RPS or move to Enterprise tariff (see `server/utils/bitrix24.ts` notes). |
| `EXCHANGE-DOMAIN-MISMATCH` (502) on `/api/oauth/callback`, or `oauth.refresh.fail.transient` with `reason: domain-mismatch` (OAuth mode) | Bitrix24 returned a portal `domain` that failed the allow-list or didn't match the authorised portal — a legitimate portal rename, or (if `got` is a foreign portal) an upstream anomaly/attack on the OAuth endpoint. | Grep the log for `reason: domain-mismatch`, compare `expected` vs `got`. Real rename → have the user re-run `/api/oauth/install` for the new host. Unexpected `got` host → treat as a security incident (possible DNS/BGP poisoning of `oauth.bitrix24.tech`); the request was already refused (no tokens written), so investigate before re-enabling installs. |
| `oauth.endpoint.reject` (WARN) in logs (OAuth mode) | A refresh response carried a `client_endpoint`/`server_endpoint` URL that failed validation (wrong host, userinfo, or a port); the safe canonical URL was substituted automatically. | A single occurrence is benign. **Repeated** occurrences for one tenant indicate an upstream anomaly worth investigating (read `field`, `raw`, `expectedHost`). |
| `oauth.refresh.fail.tenant-deleted` (ERROR) in logs (OAuth mode) | A refresh fired for a tenant whose `oauth_tokens` row was deleted mid-flight — i.e. an operator/user uninstalled the app (or `deleteTenant` ran) between the SDK's expiry check and the refresh read. A benign race, **not** a revoked credential: the CASCADE already dropped this tenant's Bearers, no `markRefreshFailed` runs, and `lastRefreshFail` in `/api/oauth/_health` is deliberately NOT bumped. | A single occurrence right after an uninstall needs **no action**. If it repeats for the same tenant that is NOT being uninstalled, verify CASCADE integrity (`PRAGMA foreign_keys` must be ON — the token store enables it on connect) and check for a stuck cached `B24OAuth` instance (it is evicted on `deleteTenant`). |
| Clients report **429** on `/api/oauth/install` (OAuth mode) | Per-IP rate limit hit (10/min, issue #221). Behind the reference nginx-proxy all external traffic shares the proxy's socket IP, so the bucket is effectively global — a burst of real users authorising at once can collectively trip it. | Grep `oauth.install.deny.rate-limited` for the `ip`. A single user self-resolves by waiting ~60 s. If the IP is the proxy's and legitimate installs are being blocked at scale, add an nginx `limit_req` zone in front with a per-client rate (the limits compose), or raise `MAX_PER_WINDOW` in `server/middleware/oauth-rate-limit.ts`. |
| TLS cert expired / "first certificate" errors from clients | acme-companion stalled, or DNS changed | `docker logs nginx-proxy-acme`; restart the companion container. For Self-Hosted Bitrix24 with a private CA see `NODE_EXTRA_CA_CERTS` in `.env.example`. |
| `docker compose pull` hangs or fails | GHCR auth lost, or registry unreachable | `docker login ghcr.io` on the host; check egress to `ghcr.io:443` |
| Container reports `out of memory` | Compose limit `512M` exceeded (raised by Bitrix24 SDK retry storm or large batch) | Inspect `docker stats`; if legitimate, raise `deploy.resources.limits.memory` in `docker-compose.yml`. Otherwise dig into a leak. |

## Container naming after #189

The container name is now parameterised: `${COMPOSE_PROJECT_NAME:-bx24-mcp}-app`. With the default `COMPOSE_PROJECT_NAME=bx24-mcp` (from `.env.example`) the container is **`bx24-mcp-app`**. With `COMPOSE_PROJECT_NAME=bx24-mcp-staging` it becomes `bx24-mcp-staging-app`.

Don't hardcode the literal `bx24-template-mcp` in alerts, scripts, or shell aliases — that name is gone. Use one of:

```bash
# Compose-aware lookup (works regardless of COMPOSE_PROJECT_NAME):
docker logs --tail=200 $(docker compose ps -q bx24-template-mcp)
docker exec -it $(docker compose ps -q bx24-template-mcp) sh

# Direct name (only if you know your COMPOSE_PROJECT_NAME):
docker logs --tail=200 bx24-mcp-app                # default
docker logs --tail=200 bx24-mcp-staging-app        # staging

# Discover the name on the host:
docker compose ps --format json | jq -r '.[].Name'
```

`bx24-template-mcp` stays as the Compose **service name** (the key under `services:` in `docker-compose.yml`), so `docker compose ps bx24-template-mcp` and `docker compose logs bx24-template-mcp` keep working — those operate on the service, not the container.

## Rollback

CI does **not** auto-rollback — there is no SSH deploy step. **Neither does Watchtower by default:** it ships in **monitor-only** mode (`WATCHTOWER_MONITOR_ONLY: "true"` in `docker-compose.watchtower.yml`), so it detects that a newer `:latest` exists (≈03:00 UTC after a `v*` tag) and notifies you, but does **not** restart the container — you promote with `make redeploy`. Operators who opt into **auto-apply** (by removing `WATCHTOWER_MONITOR_ONLY`) get the historic "applied without a health check" behaviour back; pair that with an external `/api/health` monitor (UptimeRobot / Healthchecks.io) to catch a crash-looping `:latest`. After every release tag, watch `/api/health` for the first few minutes either way. Manual rollback:

```bash
# This is a manual operator step — CI does not SSH into production.
ssh deploy@prod.example.com
cd /opt/bx24-template-mcp
# Stop Watchtower first if running (so it doesn't re-update while you roll back):
make watchtower-stop   # or: docker compose stop watchtower
```

List available image versions:

```bash
docker image ls ghcr.io/bitrix24/templates-mcp --digests
# Pick a known-good digest or semver tag (no 'v' prefix), then PIN it in .env —
# an inline `BX24_IMAGE=… docker compose up -d` is undone the moment Watchtower
# (or the next `make redeploy`) re-pulls :latest, so persist it:
echo 'BX24_IMAGE=ghcr.io/bitrix24/templates-mcp@sha256:<digest>' >> .env
docker compose up -d --remove-orphans
curl -fsS https://prod.example.com/api/health
```

Once a fixed image ships forward, delete the `BX24_IMAGE` line from `.env` to resume tracking `:latest`, then resume Watchtower: `make watchtower-start`

## Investigating from logs

- Each log line is structured JSON-friendly text. SDK lines have `requestId` (UUIDv7, sortable) — grep by it to follow a single REST call.
- The webhook secret appears as `<REDACTED>` in every `method` URL. If you see a real secret in logs, that is a security incident — see [`SECURITY.md`](./SECURITY.md).
- Stderr is the only sink; `journalctl -u docker --since=10m` or `docker logs` are equivalent here.

## Escalation

- Pre-GA: single maintainer, best-effort — no formal paging path / escalation order yet.
- Security incident (credential disclosure suspected): follow [`SECURITY.md`](./SECURITY.md) **before** any public post-mortem.
- Bitrix24-portal-side issue (rate cap, auth, missing data): contact the portal admin (the account that owns the configured Bitrix24 webhook).
