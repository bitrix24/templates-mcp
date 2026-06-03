#!/usr/bin/env bash
# First-time deploy bootstrap for bx24-template-mcp.
#
# This is the single source of truth for *which* files an operator needs on a
# production host. The companion docs/DEPLOYMENT.md no longer lists them by
# hand — it just downloads and runs this script — so adding a new deploy file
# means editing the FILES array below and nothing else (closes issue #206).
#
# What it does
# ------------
#   1. Sparse-clones (or, on a re-run, updates) the pinned release tag into
#      DEPLOY_DIR, fetching only the deploy files — no source, tests or CI.
#   2. Makes verify-deployment.sh executable (a safety net; git already
#      preserves the executable bit from the repo index).
#   3. Scaffolds .env from .env.example (mode 0600) if it does not exist yet.
#   4. Runs `make bootstrap-check` to confirm the directory is complete.
#
# It does NOT fill in secrets or start the container — that stays an explicit,
# operator-driven step (edit .env, then `make redeploy`).
#
# Usage
# -----
#   TAG=v0.1.1 DEPLOY_DIR=/opt/bx24-template-mcp ./bootstrap.sh
#   ./bootstrap.sh v0.1.1 /opt/bx24-template-mcp     # positional, same effect
#
# Both inputs may come from the environment or from positional args; args win.
# Review this script before running it — it is fetched over the network.

set -euo pipefail

REPO_URL="https://github.com/bitrix24/templates-mcp.git"

# ─── The deploy file set — the ONE place this list lives ──────────────────────
# Add a new file here when the deployment grows one; nothing else to update.
FILES=(
  docker-compose.yml
  docker-compose.server.yml
  docker-compose.watchtower.yml
  Makefile
  scripts/verify-deployment.sh
  scripts/bootstrap.sh
  .env.example
)

# ─── Inputs (positional args override environment) ────────────────────────────
TAG="${1:-${TAG:-}}"
DEPLOY_DIR="${2:-${DEPLOY_DIR:-}}"

if [ -z "$TAG" ] || [ -z "$DEPLOY_DIR" ]; then
  echo "Usage: TAG=<vX.Y.Z> DEPLOY_DIR=<path> $0   (or: $0 <vX.Y.Z> <path>)" >&2
  echo "Pick a tag from: https://github.com/bitrix24/templates-mcp/releases" >&2
  exit 1
fi

# ─── 1. Fetch the deploy files (idempotent — safe to re-run) ──────────────────
if [ -d "$DEPLOY_DIR/.git" ]; then
  # Re-bootstrap / move to a new tag: update the existing sparse clone in place
  # instead of failing on a non-empty directory.
  echo "Existing clone found in $DEPLOY_DIR — updating to $TAG."
  git -C "$DEPLOY_DIR" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git -C "$DEPLOY_DIR" sparse-checkout set "${FILES[@]}"
  git -C "$DEPLOY_DIR" checkout --quiet "tags/$TAG"
else
  echo "Sparse-cloning $TAG into $DEPLOY_DIR."
  git clone --depth 1 --filter=blob:none --sparse \
    --branch "$TAG" "$REPO_URL" "$DEPLOY_DIR"
  git -C "$DEPLOY_DIR" sparse-checkout set "${FILES[@]}"
fi

cd "$DEPLOY_DIR"

# ─── 2. Executable bit (safety net — git preserves it from the index) ─────────
chmod +x scripts/verify-deployment.sh

# ─── 3. Scaffold .env (never overwrite an existing one) ───────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example (mode 0600) — fill in the real values."
else
  echo "Keeping existing .env."
fi

# ─── 4. Confirm the directory is complete ─────────────────────────────────────
make bootstrap-check

cat <<EOF

Bootstrap done. Next:
  1. Edit .env and set the real secrets:            \${EDITOR:-vi} .env
  2. Add NODE_ENV to the HOST .env (not the repo):  grep -qxF 'NODE_ENV=production' .env || echo 'NODE_ENV=production' >> .env
  3. Ensure the proxy network exists:               docker network create proxy-net 2>/dev/null || true
  4. Pull the image and start:                      make redeploy
  5. Smoke-test:                                     make verify-local URL=https://<your-domain>
EOF
