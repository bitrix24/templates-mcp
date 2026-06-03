# Makefile for bx24-template-mcp.
#
# Local development:   make dev
# First-time server:   make init-network && make server-up
# Deploy application:  make up
# Verify deployment:   make verify URL=https://mcp.example.com
#
# NOTE: make build requires a local clone of the repo (needs Dockerfile).
# Operators who deploy from a pre-built GHCR image only need docker-compose.yml
# and .env — they can skip build and use `make up` (pull on first run) or
# `make redeploy` after a new release tag.

.PHONY: dev build test lint typecheck \
        init-network server-up server-down \
        up down pull redeploy logs ps \
        watchtower-up watchtower-down watchtower-stop watchtower-start \
        build-dxt verify verify-local bootstrap-check clean

WATCHTOWER_COMPOSE := docker-compose.watchtower.yml

# Locate verify-deployment.sh whether the Makefile lives inside the repo
# (scripts/) or in a separate deploy directory next to a cloned src/ tree
# (src/scripts/).
VERIFY_SCRIPT := $(firstword $(wildcard scripts/verify-deployment.sh src/scripts/verify-deployment.sh))

# ─── Local development ────────────────────────────────────────────────────────

# Start Nuxt dev server with hot-reload.
dev:
	pnpm dev

# Run unit tests.
test:
	pnpm test

# Run ESLint.
lint:
	pnpm lint

# Run TypeScript type-checker.
typecheck:
	pnpm typecheck

# Build the DXT bundle for Claude Desktop (output: dist/bx24-template-mcp.dxt).
build-dxt:
	pnpm build:dxt

# ─── Host bootstrap (run once on a fresh server) ─────────────────────────────

# Create the shared Docker network that connects the proxy and the app.
init-network:
	docker network create proxy-net 2>/dev/null || true

# Start nginx-proxy + acme-companion (TLS terminator).
# Skip if nginx-proxy is already running on the host — see docker-compose.server.yml.
# Requires init-network to have run first.
server-up:
	docker compose -f docker-compose.server.yml up -d

# Stop nginx-proxy + acme-companion.
server-down:
	docker compose -f docker-compose.server.yml down

# ─── Application lifecycle ────────────────────────────────────────────────────

# Build the application image from local source (requires Dockerfile in repo).
build:
	docker compose build

# Start the application.
up:
	docker compose up -d

# Stop the application.
down:
	docker compose down

# Pull the latest image from the registry (ghcr.io, requires a published release).
pull:
	docker compose pull

# Pull the latest image and restart the container.
# Use after `git tag v… && git push origin v…` triggers CI and the new image lands.
# `--wait` gates on the container HEALTHCHECK: a crash-looping new image makes
# this command fail loudly instead of silently replacing a healthy one.
# (Watchtower's auto-update has no equivalent gate — see docs/RUNBOOK.md.)
redeploy:
	docker compose pull
	docker compose up -d --wait --wait-timeout 90
	docker image prune -f

# Follow application logs.
logs:
	docker compose logs -f

# List running containers with status.
ps:
	docker compose ps

# ─── Watchtower (opt-in auto-deploy) ─────────────────────────────────────────

# Start application + Watchtower (auto-update overlay).
# Watchtower checks GHCR nightly at 03:00 UTC and restarts the app when a new
# image is available. See docker-compose.watchtower.yml for configuration.
watchtower-up:
	docker compose -f docker-compose.yml -f $(WATCHTOWER_COMPOSE) up -d

# Stop application + Watchtower.
watchtower-down:
	docker compose -f docker-compose.yml -f $(WATCHTOWER_COMPOSE) down

# Pause Watchtower during a manual rollback (stays down until watchtower-start).
# See docs/DEPLOYMENT.md "Manual rollback → Watchtower path".
watchtower-stop:
	docker compose -f docker-compose.yml -f $(WATCHTOWER_COMPOSE) stop watchtower

# Resume Watchtower after the rollback is verified stable.
watchtower-start:
	docker compose -f docker-compose.yml -f $(WATCHTOWER_COMPOSE) start watchtower

# ─── Bootstrap check ─────────────────────────────────────────────────────────

# Verify that the deploy directory contains all required files.
# Run after first-time bootstrap (or git sparse-checkout) to confirm the setup
# is complete before proceeding to `make redeploy`.
bootstrap-check:
	@test -f docker-compose.yml || { echo "ERROR: docker-compose.yml not found — run scripts/bootstrap.sh (see docs/DEPLOYMENT.md)"; exit 1; }
	@test -n "$(VERIFY_SCRIPT)" && test -x "$(VERIFY_SCRIPT)" || { echo "ERROR: verify-deployment.sh not found or not executable in scripts/ (or src/scripts/) — run: chmod +x scripts/verify-deployment.sh"; exit 1; }
	@test -f .env || { echo "ERROR: .env not found — copy from .env.example and fill in values"; exit 1; }
	@echo "Bootstrap check passed."

# ─── Smoke test ───────────────────────────────────────────────────────────────

# Run the deployment smoke test against a live server.
# Usage:
#   make verify URL=https://mcp.example.com
#   make verify URL=http://localhost:3000
# Token is read from $NUXT_MCP_AUTH_TOKEN in the environment, or from .env if
# the variable is not already set. Shell-export semantics: values already in
# the environment take precedence over .env, so `NUXT_MCP_AUTH_TOKEN=x make
# verify URL=…` still works as expected.
verify:
	@[ -n "$(URL)" ] || (echo "Usage: make verify URL=https://mcp.example.com" && exit 1)
	@[ -n "$(VERIFY_SCRIPT)" ] || (echo "Error: verify-deployment.sh not found in scripts/ or src/scripts/" && exit 1)
	@set -a; [ -f .env ] && . ./.env; set +a; \
	  bash "$(VERIFY_SCRIPT)" --url "$(URL)"

# Run the smoke test directly on the server, bypassing DNS/NAT.
# Useful when the host cannot reach its own public IP (hairpin NAT) —
# a common firewall/routing setup where curl from the server itself times
# out on the public domain even though the service is fully functional.
# Resolves the domain to 127.0.0.1 so curl connects locally; TLS is still
# verified against the real certificate — no --insecure needed.
# Usage:
#   make verify-local URL=https://mcp.example.com
verify-local:
	@[ -n "$(URL)" ] || (echo "Usage: make verify-local URL=https://mcp.example.com" && exit 1)
	@[ -n "$(VERIFY_SCRIPT)" ] || (echo "Error: verify-deployment.sh not found in scripts/ or src/scripts/" && exit 1)
	@set -a; [ -f .env ] && . ./.env; set +a; \
	  HOST=$$(printf '%s' "$(URL)" | sed 's|^https://||;s|^http://||;s|/.*||;s|:.*||'); \
	  bash "$(VERIFY_SCRIPT)" --url "$(URL)" --resolve "$$HOST:127.0.0.1"

# ─── Cleanup ─────────────────────────────────────────────────────────────────

# Remove stopped containers, dangling images and build cache.
# WARNING: also removes unused Docker networks — including proxy-net if no
# container is currently attached. Run `make init-network` afterwards if needed.
# Does NOT touch named volumes or running containers.
clean:
	docker system prune -f
