# Makefile for bx24-template-mcp.
#
# Local development:   make dev
# First-time server:   make init-network && make server-up
# Deploy application:  make up
# Verify deployment:   make verify URL=https://mcp.example.com

.PHONY: dev build test lint typecheck \
        init-network server-up server-down \
        up down pull redeploy logs ps \
        build-dxt verify clean

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
# Requires init-network to have run first.
server-up:
	docker compose -f docker-compose.server.yml up -d

# Stop nginx-proxy + acme-companion.
server-down:
	docker compose -f docker-compose.server.yml down

# ─── Application lifecycle ────────────────────────────────────────────────────

# Build the application image from local source.
build:
	docker compose build

# Start the application (builds first if no image exists).
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
redeploy:
	docker compose pull
	docker compose up -d
	docker image prune -f

# Follow application logs.
logs:
	docker compose logs -f

# List running containers with status.
ps:
	docker compose ps

# ─── Smoke test ───────────────────────────────────────────────────────────────

# Run the deployment smoke test against a live server.
# Usage:
#   make verify URL=https://mcp.example.com
#   make verify URL=http://localhost:3000
# Token is read from $NUXT_MCP_AUTH_TOKEN in the environment.
verify:
	@[ -n "$(URL)" ] || (echo "Usage: make verify URL=https://mcp.example.com" && exit 1)
	bash scripts/verify-deployment.sh --url $(URL)

# ─── Cleanup ─────────────────────────────────────────────────────────────────

# Remove stopped containers, unused images and build cache.
# Does NOT touch running containers or named volumes.
clean:
	docker system prune -f
