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
# /api/oauth/install and looking at the response. No env vars required.

set -uo pipefail
BASE="${MCP_BASE:-http://localhost:3000}"
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
assert_error_code() {
  local name=$1
  local expected_code=$2
  local url=$3
  local body
  body=$(curl -s "$url" 2>/dev/null || echo "")
  if echo "$body" | grep -q "\"errorCode\":\"$expected_code\""; then
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
case "$probe" in
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
    # Capture the redirect Location + cookie attributes.
    install_response=$(curl -sI "$BASE/api/oauth/install?portal=acme.bitrix24.com" 2>/dev/null || echo "")
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
    echo "--- /api/oauth/_health gates ---"
    # _health from localhost = 200 if no admin token; 401 ADMIN-TOKEN-MISSING if token set.
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
