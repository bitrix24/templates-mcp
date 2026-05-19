# Deployment

> **Status: DRAFT — operational placeholders (`TODO(team)`) pending.** The procedure and CI flow are accurate against the workflow at the time of writing; approval policy, FQDN, and a few similar values are still being finalised.

Production deploy procedure for `bitrix24/templates-mcp`. Stack: GHCR image + `docker compose` on a single Linux host, fronted by a reverse proxy you choose. CI runs in `.github/workflows/deploy.yml`.

For TLS terminator alternatives (Caddy / Traefik / plain nginx + certbot), see [`REVERSE-PROXY.md`](./REVERSE-PROXY.md). The default shipped `docker-compose.yml` assumes nginx-proxy + acme-companion on a shared `proxy-net` network.

## Prerequisites — once per host

- [ ] Linux host with Docker Engine ≥ 24 and the `docker compose` plugin.
- [ ] Deploy user with passwordless `docker` group membership and SSH key access.
- [ ] DNS `A`/`AAAA` for `prod.example.com` pointing at the host. *(TODO(team): replace `prod.example.com` with the real FQDN before the first `v0.1.0` tag.)*
- [ ] Reverse proxy + TLS — either the nginx-proxy + acme-companion stack on `proxy-net` (matches default compose), or an alternative from `REVERSE-PROXY.md` plus the `docker-compose.example.yml` base.
- [ ] Bitrix24 incoming webhook URL (Developer resources → Other → Inbound webhook).
- [ ] `NUXT_MCP_AUTH_TOKEN` generated and stored — see `.env.example` for the three recipes (openssl / PowerShell / Node).

## Prerequisites — GitHub-side

GitHub repository secrets (Settings → Secrets and variables → Actions):

- [ ] `SSH_HOST` — deploy host FQDN or IP.
- [ ] `SSH_USER` — deploy user.
- [ ] `SSH_KEY` — private key matching the deploy user's `~/.ssh/authorized_keys`.
- [ ] `SSH_PORT` — *(optional, defaults to 22)*.

Repository variables (Settings → Secrets and variables → Actions → Variables):

- [ ] `PROD_HOST` — `prod.example.com`, used in the `environment.url` shown on the run page.
- [ ] `DEPLOY_PATH` — *(optional, defaults to `/opt/bx24-template-mcp`)*.

The `production` Environment (Settings → Environments) is used for the deploy job. Add reviewers there if you want a manual approval gate. *(TODO(team): decide approval policy.)*

## First-time bootstrap on the host

```bash
sudo mkdir -p /opt/bx24-template-mcp && sudo chown deploy:deploy /opt/bx24-template-mcp
cd /opt/bx24-template-mcp

# Pull the shipped compose (or copy your own from REVERSE-PROXY.md).
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/docker-compose.yml

# Create .env from the template, fill in NUXT_BITRIX24_WEBHOOK_URL and NUXT_MCP_AUTH_TOKEN.
curl -sSLO https://raw.githubusercontent.com/bitrix24/templates-mcp/main/.env.example
mv .env.example .env && chmod 600 .env
vi .env

# Default compose requires the shared proxy-net network.
docker network create proxy-net 2>/dev/null || true

# Authenticate to GHCR (only if the image is private — public images need no login).
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-user> --password-stdin
```

The `.env` lives on the host. The CI pipeline never reads or writes it. Rotating secrets = edit `.env` and `docker compose up -d`. *(TODO(team): if you later move to GH Secrets → host `.env` materialisation, update this section and `RUNBOOK.md`.)*

## Releasing — push a tag

```bash
git tag v0.1.0 && git push origin v0.1.0
```

This triggers `.github/workflows/deploy.yml`:

1. **test** — `pnpm lint && pnpm typecheck && pnpm test:unit`.
2. **build** — Docker buildx → push `ghcr.io/bitrix24/templates-mcp:{0.1.0, 0.1, latest}`.
3. **dxt** — bundles `.dxt` and attaches it to the GitHub Release.
4. **deploy** — SSH to `SSH_HOST`, captures current image digest into `rollback.env`, `docker compose pull && up -d`, then probes `https://prod.example.com/api/health` up to ten times, sleeping 3 s between failed attempts (each curl has a 5 s timeout — worst-case ~80 s before declaring failure, typical success within the first attempt). On failure, re-pulls the previous digest via `BX24_IMAGE=<prev>` override and re-ups.

A manual deploy of any ref is available via Actions → Deploy → Run workflow → `ref`.

## Subsequent deploys

Push another `v*` tag. The pipeline is idempotent — no host-side changes between tags unless `docker-compose.yml` or `.env` shape changed.

## Manual fallback (CI is broken)

```bash
ssh deploy@prod.example.com
cd /opt/bx24-template-mcp
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f
curl -fsS https://prod.example.com/api/health
```

## Rollback to a specific image

```bash
ssh deploy@prod.example.com
cd /opt/bx24-template-mcp
BX24_IMAGE="ghcr.io/bitrix24/templates-mcp@sha256:<digest>" docker compose up -d --remove-orphans
```

`docker-compose.yml` reads `image: ${BX24_IMAGE:-…:latest}` — exporting the env var pins without editing files. The previous-known-good digest sits in `rollback.env` after the last successful deploy.

## See also

- [`RUNBOOK.md`](./RUNBOOK.md) — what to do when the deploy or runtime breaks.
- [`REVERSE-PROXY.md`](./REVERSE-PROXY.md) — pick your TLS terminator.
- [`SECURITY.md`](./SECURITY.md) — secret rotation, disclosure.
