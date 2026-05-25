#!/usr/bin/env bash
# Operator-runnable smoke check for a freshly stood-up bx24-template-mcp
# HTTP deployment. Mirrors the contract the CI `docker-smoke` job pins on
# every PR, so a green run here means the deployed bundle matches what
# CI signed off on.
#
# What this checks
# ----------------
#   1. /api/health returns 200 with {"status":"ok",...}
#   2. /mcp without an Authorization header returns 401
#   3. /mcp with a wrong Bearer returns 401
#   4. /mcp with the configured Bearer is NOT rejected at auth
#      (anything other than 401 / 403 / 503 — the toolkit may still answer
#      405 to a bare GET; auth passing through is what we care about)
#
# What this DOES NOT check
# ------------------------
#   * No Bitrix24 REST call is made. Safe to run against production.
#   * No MCP JSON-RPC handshake. For a live tool call after this passes,
#     see docs/MANUAL-TEST-PHRASES.md.
#
# Exit codes
# ----------
#   0   all assertions passed
#   1   one or more assertions failed
#   64  CLI usage error

set -euo pipefail

URL=""
TOKEN=""
TIMEOUT="10"
HEALTH_RETRIES="20"
HEALTH_INTERVAL="3"
USE_COLOR="auto"

usage() {
  cat >&2 <<EOF
Usage: $0 --url <BASE_URL> --token <NUXT_MCP_AUTH_TOKEN> [options]

Required:
  --url URL              Base URL of the deployed server.
                           Local docker-compose-example:  http://localhost:3000
                           Production behind nginx-proxy: https://prod.example.com
  --token TOKEN          The Bearer value of NUXT_MCP_AUTH_TOKEN as configured
                         on the host. Used to assert that auth passes for the
                         right token. NEVER passes this back over stdout.

Options:
  --timeout SECS         Per-request curl timeout. Default: ${TIMEOUT}.
  --health-retries N     How many /api/health attempts before bailing.
                         Default: ${HEALTH_RETRIES} (≈ retries × interval seconds).
  --health-interval SECS Sleep between health attempts. Default: ${HEALTH_INTERVAL}.
  --no-color             Disable ANSI output (auto-disabled when stdout is not a TTY).
  -h, --help             Show this help.

Example:
  ./scripts/verify-deployment.sh \\
    --url https://prod.example.com \\
    --token "\$NUXT_MCP_AUTH_TOKEN"
EOF
  exit 64
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)             URL="${2:?--url requires a value}"; shift 2 ;;
    --token)           TOKEN="${2:?--token requires a value}"; shift 2 ;;
    --timeout)         TIMEOUT="${2:?--timeout requires a value}"; shift 2 ;;
    --health-retries)  HEALTH_RETRIES="${2:?--health-retries requires a value}"; shift 2 ;;
    --health-interval) HEALTH_INTERVAL="${2:?--health-interval requires a value}"; shift 2 ;;
    --no-color)        USE_COLOR="no"; shift ;;
    -h|--help)         usage ;;
    *)                 echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$URL" ]   || { echo "Missing --url"   >&2; usage; }
[ -n "$TOKEN" ] || { echo "Missing --token" >&2; usage; }

# Strip a single trailing slash so the route concatenation stays sane.
URL="${URL%/}"

# Colour handling — opt-out via --no-color, auto-off when not a TTY.
if [ "$USE_COLOR" = "auto" ] && [ -t 1 ]; then USE_COLOR="yes"; fi
if [ "$USE_COLOR" = "yes" ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

pass() { printf "%s  ✓%s  %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "%s  ✗%s  %s\n" "$RED"   "$RESET" "$1" >&2; FAILED=$((FAILED + 1)); }
info() { printf "%s•%s %s\n"      "$DIM"   "$RESET" "$1"; }

FAILED=0

# Single curl wrapper — emits just the HTTP status code, never the body.
# Bodies could leak version info or the MCP toolkit's tool catalogue; we
# only ever assert on the status here.
status_of() {
  # Args: METHOD URL [extra curl args...]
  local method="$1" target="$2"
  shift 2
  curl -ksS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" -X "$method" "$target" "$@"
}

info "Target: $URL  (timeout ${TIMEOUT}s, health retries ${HEALTH_RETRIES}×${HEALTH_INTERVAL}s)"
info "Token : ${#TOKEN}-char value (not echoed)"
echo

# ─── 1. /api/health ────────────────────────────────────────────────────────
info "Waiting for /api/health to become healthy"
HEALTH_OK="no"
for i in $(seq 1 "$HEALTH_RETRIES"); do
  if STATUS=$(status_of GET "$URL/api/health"); then
    if [ "$STATUS" = "200" ]; then HEALTH_OK="yes"; break; fi
  fi
  printf "%s    attempt %d/%d: status=%s%s\n" "$DIM" "$i" "$HEALTH_RETRIES" "${STATUS:-error}" "$RESET"
  sleep "$HEALTH_INTERVAL"
done

if [ "$HEALTH_OK" = "yes" ]; then
  pass "/api/health → 200 (after $i attempt(s))"
else
  fail "/api/health never returned 200 after $HEALTH_RETRIES attempts — bailing on remaining checks"
  echo
  printf "%s  Hint: the server may still be booting (cold pnpm build, slow disk), the\n" "$YELLOW"
  printf "  TLS/reverse-proxy may not be forwarding /api/health, or the container\n"
  printf "  is in a crash loop. Check 'docker compose logs -f' on the host.%s\n" "$RESET"
  exit 1
fi

# Body shape — best-effort, doesn't gate the run if it works under TLS.
BODY=$(curl -ksS --max-time "$TIMEOUT" "$URL/api/health" || true)
if printf '%s' "$BODY" | grep -q '"status":"ok"'; then
  pass '/api/health body contains "status":"ok"'
else
  fail "/api/health body did not contain '\"status\":\"ok\"' — got: $BODY"
fi

# ─── 2. /mcp without Authorization → 401 ───────────────────────────────────
STATUS=$(status_of GET "$URL/mcp")
case "$STATUS" in
  401) pass "/mcp without Authorization → 401 (auth middleware engaged)" ;;
  503) fail "/mcp returned 503 — NUXT_MCP_AUTH_TOKEN is unset or still 'replace-with-secure-token'; the host is not actually configured" ;;
  *)   fail "/mcp without Authorization → expected 401, got $STATUS (auth middleware may be missing or the route is not behind it)" ;;
esac

# ─── 3. /mcp with a wrong Bearer → 401 ─────────────────────────────────────
STATUS=$(status_of GET "$URL/mcp" -H "Authorization: Bearer not-the-token")
case "$STATUS" in
  401) pass "/mcp with wrong Bearer → 401" ;;
  *)   fail "/mcp with wrong Bearer → expected 401, got $STATUS" ;;
esac

# ─── 4. /mcp with the configured Bearer → NOT 401 / 403 / 503 ──────────────
# A bare GET to /mcp with a valid token may legitimately produce 200, 202,
# 405, etc. depending on what the MCP toolkit's handler returns to a non-
# JSON-RPC method. What matters here is that auth passed — i.e. NOT 401 / 403,
# and NOT 503 (which would mean the token equals the placeholder).
STATUS=$(status_of GET "$URL/mcp" -H "Authorization: Bearer $TOKEN")
case "$STATUS" in
  401|403) fail "/mcp with the configured Bearer → $STATUS (token mismatch — check the value on the host)" ;;
  503)     fail "/mcp with the configured Bearer → 503 (the host is treating the token as the placeholder — re-check NUXT_MCP_AUTH_TOKEN)" ;;
  000)     fail "/mcp with the configured Bearer → curl could not connect (TLS handshake / DNS / firewall)" ;;
  *)       pass "/mcp with the configured Bearer → $STATUS (auth passed)" ;;
esac

echo
if [ "$FAILED" -eq 0 ]; then
  printf "%sAll checks passed.%s\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s%d check(s) failed.%s\n" "$RED" "$FAILED" "$RESET" >&2
  exit 1
fi
