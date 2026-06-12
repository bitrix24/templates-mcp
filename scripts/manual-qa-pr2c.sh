#!/usr/bin/env bash
# scripts/manual-qa-pr2c.sh — manual QA for PR-2c (OAuth install/callback/health surface)
#
# Goal: prove the new OAuth surface gates correctly under BOTH configurations
# without needing a real Bitrix24 portal:
#
#   - Scenario A — `NUXT_BITRIX24_OAUTH_ENABLED=false` (production default):
#                  every OAuth endpoint refuses with 503 FLAG-OFF; the existing
#                  webhook flow stays intact (/api/health = 200).
#   - Scenario B — `NUXT_BITRIX24_OAUTH_ENABLED=true` + dummy CLIENT_ID +
#                  REDIRECT_URL: install / callback / _health gates work as
#                  documented in OAUTH-DESIGN.md §11; happy-path install
#                  produces a 302 redirect + CSRF cookie.
#
# Usage:
#   1. Boot the app locally (e.g. `pnpm dev` OR `docker compose up`).
#   2. (Optional) set MCP_BASE to the server URL — default http://localhost:3000.
#   3. ./scripts/manual-qa-pr2c.sh
#
# The script auto-detects which scenario the running server is in by hitting
# /api/oauth/install and looking at the response. The base URL comes from
# the first positional argument, falling back to $MCP_BASE, falling back to
# http://localhost:3000:
#   ./scripts/manual-qa-pr2c.sh http://localhost:3002

set -uo pipefail
BASE="${1:-${MCP_BASE:-http://localhost:3000}}"
PASS=0
FAIL=0

green() { printf "\033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS + 1)); }
red()   { printf "\033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }

# Probe one endpoint and report whether it matches the expected status.
# Usage: assert_status <name> <expected> <url>
assert_status() {
  local name=$1
  local expected=$2
  local url=$3
  local actual
  actual=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$actual" = "$expected" ]; then
    green "$name → $expected"
  else
    red "$name → expected $expected, got $actual ($url)"
  fi
}

# Probe and check that the response body contains a specific errorCode.
# Usage: assert_error_code <name> <expected_code> <url>
#
# The body is whitespace-stripped before matching: a production Nitro
# build pretty-prints the error JSON (`"errorCode": "X"` with a space and
# newlines), while dev serves it compact — the CI run of issue #224
# caught exactly this drift, so match both shapes.
assert_error_code() {
  local name=$1
  local expected_code=$2
  local url=$3
  local body
  body=$(curl -s "$url" 2>/dev/null || echo "")
  if echo "$body" | tr -d ' \n\t' | grep -q "\"errorCode\":\"$expected_code\""; then
    green "$name → errorCode=$expected_code"
  else
    red "$name → expected errorCode=$expected_code, body was: $(echo "$body" | head -c 200)"
  fi
}

echo "=== PR-2c manual QA against $BASE ==="
echo

# Detect scenario by probing /api/oauth/install with no params.
# - Scenario A (flag off): 503 with errorCode FLAG-OFF
# - Scenario B (flag on, configured): 400 with errorCode PORTAL-FORMAT (no portal arg)
# - Scenario C (flag on, NOT configured): 503 with errorCode NOT-CONFIGURED
probe=$(curl -s "$BASE/api/oauth/install" 2>/dev/null || echo "")
# Strip whitespace before the glob match: production Nitro pretty-prints
# the error JSON (`"errorCode": "X"` + newlines) while dev serves it
# compact. Without this the detection silently falls through to the
# "could not detect" branch on a production boot (caught by the #224 CI
# run). The raw $probe is kept for the human-readable error message below.
probe_compact=$(echo "$probe" | tr -d ' \n\t')
case "$probe_compact" in
  *'"errorCode":"FLAG-OFF"'*)
    echo "Detected: Scenario A — NUXT_BITRIX24_OAUTH_ENABLED=false (default)"
    echo
    echo "--- Webhook flow unchanged ---"
    assert_status "GET /api/health" 200 "$BASE/api/health"

    echo
    echo "--- OAuth endpoints refuse with FLAG-OFF ---"
    assert_error_code "/api/oauth/install (any portal)" "FLAG-OFF" \
      "$BASE/api/oauth/install?portal=acme.bitrix24.com"
    assert_error_code "/api/oauth/callback (any params)" "FLAG-OFF" \
      "$BASE/api/oauth/callback?code=x&state=y"
    assert_error_code "/api/oauth/_health" "FLAG-OFF" "$BASE/api/oauth/_health"
    ;;

  *'"errorCode":"NOT-CONFIGURED"'*)
    echo "Detected: Scenario C — flag ON but CLIENT_ID/REDIRECT_URL missing"
    echo
    assert_error_code "/api/oauth/install (any portal, no config)" "NOT-CONFIGURED" \
      "$BASE/api/oauth/install?portal=acme.bitrix24.com"
    echo "  → Fix: set NUXT_BITRIX24_OAUTH_CLIENT_ID and _REDIRECT_URL."
    ;;

  *'"errorCode":"PORTAL-FORMAT"'*)
    echo "Detected: Scenario B — NUXT_BITRIX24_OAUTH_ENABLED=true, configured"
    echo

    echo "--- Portal allow-list rejection ---"
    assert_error_code "install with evil.example.com" "PORTAL-FORMAT" \
      "$BASE/api/oauth/install?portal=evil.example.com"
    assert_error_code "install with unlisted TLD (.us)" "PORTAL-FORMAT" \
      "$BASE/api/oauth/install?portal=acme.bitrix24.us"
    assert_error_code "install with no portal" "PORTAL-FORMAT" \
      "$BASE/api/oauth/install"

    echo
    echo "--- Happy-path install (302 + CSRF cookie) ---"
    # Capture the redirect Location + cookie attributes. GET with -D -
    # (NOT curl -sI): a production Nitro build does not match HEAD
    # requests onto `.get.ts` route handlers — HEAD falls through to the
    # landing renderer and answers 200, silently breaking the assertion
    # (caught by the #224 CI run; dev servers route HEAD fine, which is
    # why this passed local QA).
    install_response=$(curl -s -D - -o /dev/null "$BASE/api/oauth/install?portal=acme.bitrix24.com" 2>/dev/null || echo "")
    install_status=$(echo "$install_response" | head -1 | awk '{print $2}')
    if [ "$install_status" = "302" ]; then
      green "install with acme.bitrix24.com → 302"
    else
      red "install with acme.bitrix24.com → expected 302, got $install_status"
    fi
    if echo "$install_response" | grep -i "^location:" | grep -q "acme.bitrix24.com/oauth/authorize/"; then
      green "  Location → https://acme.bitrix24.com/oauth/authorize/..."
    else
      red "  Location header missing or wrong"
    fi
    if echo "$install_response" | grep -i "^set-cookie:" | grep -q "bx24_oauth_csrf="; then
      green "  Set-Cookie: bx24_oauth_csrf=... set"
    else
      red "  Set-Cookie bx24_oauth_csrf missing"
    fi
    if echo "$install_response" | grep -i "^set-cookie:" | grep -iq "httponly"; then
      green "  Cookie HttpOnly"
    else
      red "  Cookie HttpOnly attribute missing"
    fi
    if echo "$install_response" | grep -i "^set-cookie:" | grep -iq "samesite=lax"; then
      green "  Cookie SameSite=Lax"
    else
      red "  Cookie SameSite=Lax attribute missing"
    fi

    echo
    echo "--- Callback gates ---"
    assert_error_code "callback with no code" "PARAMS-MISSING" \
      "$BASE/api/oauth/callback?state=somestate"
    assert_error_code "callback with no state" "PARAMS-MISSING" \
      "$BASE/api/oauth/callback?code=somecode"
    assert_error_code "callback with unknown state" "STATE-MISSING" \
      "$BASE/api/oauth/callback?code=x&state=00000000000000000000000000000000"

    echo
    echo "--- /mcp Bearer auth (PR #217 — the last wire) ---"
    # /mcp with no Bearer must return 401 BEARER-UNKNOWN with a
    # WWW-Authenticate header carrying the §11 errorCode.
    mcp_headers=$(curl -s -D - -o /dev/null "$BASE/mcp" 2>/dev/null || echo "")
    mcp_status=$(echo "$mcp_headers" | head -1 | awk '{print $2}')
    if [ "$mcp_status" = "401" ]; then
      green "/mcp without Bearer -> 401"
    else
      red "/mcp without Bearer -> expected 401, got $mcp_status"
    fi
    if echo "$mcp_headers" | grep -iq 'www-authenticate.*BEARER-UNKNOWN'; then
      green "  WWW-Authenticate carries errorCode=BEARER-UNKNOWN"
    else
      red "  WWW-Authenticate missing or wrong errorCode"
    fi

    # /mcp with a RANDOM Bearer that was never minted must also return 401
    # BEARER-UNKNOWN (issue #224 — proves the toolkit-middleware path in
    # `server/mcp/index.ts` actually runs the sha256 lookup against
    # `mcp_tokens` rather than just matching the legacy shared token).
    random_bearer="ci$(date +%s)deadbeef0000000000000000000000000000000000000000000000000000"
    mcp_random_headers=$(curl -s -D - -o /dev/null \
      -H "Authorization: Bearer $random_bearer" "$BASE/mcp" 2>/dev/null || echo "")
    mcp_random_status=$(echo "$mcp_random_headers" | head -1 | awk '{print $2}')
    if [ "$mcp_random_status" = "401" ]; then
      green "/mcp with random unminted Bearer -> 401"
    else
      red "/mcp with random unminted Bearer -> expected 401, got $mcp_random_status"
    fi
    if echo "$mcp_random_headers" | grep -iq 'www-authenticate.*BEARER-UNKNOWN'; then
      green "  WWW-Authenticate (random Bearer) carries errorCode=BEARER-UNKNOWN"
    else
      red "  WWW-Authenticate (random Bearer) missing or wrong errorCode"
    fi

    echo
    echo "--- /api/oauth/_health gates ---"
    # _health from localhost = 200 if no admin token; 401 ADMIN-TOKEN-MISSING if token set;
    # 503 NOT-CONFIGURED if non-localhost without an admin token (fails-closed).
    health_status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/oauth/_health" 2>/dev/null)
    health_body=$(curl -s "$BASE/api/oauth/_health" 2>/dev/null || echo "")
    case "$health_status" in
      200)
        if echo "$health_body" | grep -q "\"enabled\":true"; then
          green "_health (no admin token, localhost) → 200 + enabled=true"
        else
          red "_health 200 but body shape unexpected: $health_body"
        fi
        ;;
      503)
        # Non-localhost request without an admin token: fails-closed.
        # Exactly what we want when the probe runs through a published
        # docker port (the source IP inside the container is the docker
        # bridge, not 127.0.0.1).
        if echo "$health_body" | grep -q "NOT-CONFIGURED"; then
          green "_health (non-localhost, no admin token) → 503 NOT-CONFIGURED (fails-closed)"
        else
          red "_health 503 but body unexpected: $health_body"
        fi
        ;;
      401)
        if echo "$health_body" | grep -q "ADMIN-TOKEN"; then
          green "_health (admin token configured) → 401 ADMIN-TOKEN-MISSING"
        else
          red "_health 401 but body unexpected: $health_body"
        fi
        ;;
      *)
        red "_health → unexpected status $health_status (body: $health_body)"
        ;;
    esac
    ;;

  *)
    red "Could not detect scenario — /api/oauth/install returned: $(echo "$probe" | head -c 200)"
    echo "Is the server running on $BASE?"
    exit 2
    ;;
esac

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -eq 0 ]; then exit 0; else exit 1; fi
