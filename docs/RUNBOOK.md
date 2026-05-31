# Runbook

> **Placeholders:** every literal `prod.example.com` below is your production host — substitute your own domain. Every `/opt/bx24-template-mcp` is your deploy directory (the default shown; wherever you cloned the compose stack). These are host-side values only — CI holds no `PROD_HOST` / `DEPLOY_PATH` variables.

Incident response for `bx24-template-mcp` in production. Pair with [`DEPLOYMENT.md`](./DEPLOYMENT.md) (how the system is set up) and [`SECURITY.md`](./SECURITY.md) (incidents that require disclosure).

## On-call basics

- **Service:** `bx24-template-mcp` Docker container on `prod.example.com`.
- **Healthcheck URL:** `https://prod.example.com/api/health` (and `http://localhost:3000/api/health` from the host).
- **Logs:** `docker logs --since=15m bx24-template-mcp` on the host. SDK logs are URL-redacted via `makeRedactingLogger`.
- **Compose dir:** `/opt/bx24-template-mcp` (or wherever you deployed the compose stack).
- **On-call:** pre-GA this is a single maintainer on a best-effort basis — no formal rotation, paging channel, or RTO yet.

## Alert → action

| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health` returns non-2xx for ≥3 minutes | Container crash-looped or stuck | `docker logs --tail=200 bx24-template-mcp`; if recent deploy, [rollback](#rollback) |
| 503 "MCP endpoint is not available" on `/mcp` | `NUXT_MCP_AUTH_TOKEN` missing/empty in `.env` | Edit `/opt/bx24-template-mcp/.env`, `docker compose up -d` |
| 401 "Invalid bearer token" from clients that worked yesterday | Token rotated, or client config drift | Diff client header against `.env` value; if intentional rotation, update clients |
| GitHub Actions build job failed at "Build & push" | CI test fail, GHCR permission, or buildx error | Re-read job output; common: `pnpm test:unit` regression, GHCR rate limit |
| Bitrix24 calls failing with 401/403 | Webhook revoked or scope changed in the portal | Recreate webhook in portal; update `NUXT_BITRIX24_WEBHOOK_URL` in `.env`; `docker compose up -d` |
| Bitrix24 calls failing with `QUERY_LIMIT_EXCEEDED` / 503 | Rate limit on the portal side | No action needed — `RestrictionManager` retries with back-off. If sustained, lower client RPS or move to Enterprise tariff (see `server/utils/bitrix24.ts` notes). |
| TLS cert expired / "first certificate" errors from clients | acme-companion stalled, or DNS changed | `docker logs nginx-proxy-acme`; restart the companion container. For Self-Hosted Bitrix24 with a private CA see `NODE_EXTRA_CA_CERTS` in `.env.example`. |
| `docker compose pull` hangs or fails | GHCR auth lost, or registry unreachable | `docker login ghcr.io` on the host; check egress to `ghcr.io:443` |
| Container reports `out of memory` | Compose limit `512M` exceeded (raised by Bitrix24 SDK retry storm or large batch) | Inspect `docker stats`; if legitimate, raise `deploy.resources.limits.memory` in `docker-compose.yml`. Otherwise dig into a leak. |

## Rollback

CI does **not** auto-rollback — there is no SSH deploy step. **Neither does Watchtower:** it applies a new `:latest` image (≈03:00 UTC after a `v*` tag) without a post-update health check, so a bad image keeps running until you act. After every release tag, watch `/api/health` for the first few minutes. Manual rollback:

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
