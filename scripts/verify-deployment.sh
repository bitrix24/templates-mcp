#!/usr/bin/env bash
# Operator-runnable smoke check for a freshly stood-up bx24-template-mcp
# HTTP deployment. Mirrors the contract the CI `docker-smoke` job pins on
# every PR, so a green run here means the deployed bundle matches what
# CI signed off on.
#
# What this checks
# ----------------
#   1. /api/health returns 200 with {"status":"ok",...} (uses `jq -e` if
#      available; falls back to a literal substring match otherwise).
#   2. /mcp without an Authorization header returns 401.
#   3. /mcp with a wrong Bearer returns 401. The wrong-Bearer value is
#      built to match the configured token's length so a regression that
#      compares only a length-prefix would still surface.
#   4. /mcp with the configured Bearer is NOT rejected at auth (anything
#      other than 401 / 403 / 503 — the toolkit may answer 200 / 202 / 405
#      to a bare GET; auth passing through is what we care about).
#   5. JSON-RPC `initialize` + `tools/list` round-trip on /mcp:
#      pins serverInfo.name, `capabilities.tools` advertisement and the
#      presence of a stable canary tool (`b24_user_me`) in the catalogue.
#      Requires `jq` — skipped with a notice otherwise.
#
# What this DOES NOT check
# ------------------------
#   * No Bitrix24 REST call is made. Safe to run against production.
#   * No live tool invocation. For a real Bitrix24 call after this passes,
#     see docs/MANUAL-TEST-PHRASES.md.
#   * Reverse-proxy header forwarding (X-Forwarded-*), `proxy_read_timeout`
#     for long MCP responses, and TLS chain depth — see REVERSE-PROXY.md.
#
# TLS verification
# ----------------
# Verification is ON by default. A broken cert chain (expired Let's Encrypt,
# missing intermediate, hostname mismatch) WILL fail the run with a clear
# curl error — exactly what an operator wants on production. Pass
# `--insecure` to skip verification for self-signed staging hosts; this
# is opt-in so the script can never silently leak the Bearer over a MITM'd
# connection on a production target.
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
INSECURE="no"
RESOLVE=""

# Pulled from env so an operator can avoid putting the token on the command
# line (visible via `/proc/<pid>/cmdline` / `ps` to other local users for
# the script's runtime). Either `--token <value>`, `--token-stdin`, or
# `NUXT_MCP_AUTH_TOKEN=… ./verify-deployment.sh …` works.
ENV_TOKEN="${NUXT_MCP_AUTH_TOKEN:-}"

usage() {
  cat >&2 <<EOF
Usage: $0 --url <BASE_URL> [--token <NUXT_MCP_AUTH_TOKEN> | --token-stdin] [options]

Required:
  --url URL              Base URL of the deployed server.
                           Local docker-compose-example:  http://localhost:3000
                           Production behind nginx-proxy: https://prod.example.com

Token (pick ONE — or omit to pull from \$NUXT_MCP_AUTH_TOKEN).
Tokens are expected to be ASCII (e.g. \`openssl rand -hex 32\` output).
Multi-byte values would skew the length-matched wrong-Bearer test in
assertion 3 and weaken the regression guard there:
  --token TOKEN          Pass the value directly. Visible to other local
                         users via \`ps\` for the script's runtime — prefer
                         --token-stdin or the env var on shared hosts.
  --token-stdin          Read the token from stdin (one line). Example:
                           echo "\$NUXT_MCP_AUTH_TOKEN" | $0 --url … --token-stdin
  (env)                  If neither flag is given and \$NUXT_MCP_AUTH_TOKEN
                         is set in the environment, that value is used.

Options:
  --timeout SECS         Per-request curl timeout. Default: ${TIMEOUT}.
  --health-retries N     How many /api/health attempts before bailing.
                         Default: ${HEALTH_RETRIES} (≈ retries × interval seconds).
                         Must be ≥ 1.
  --health-interval SECS Sleep between health attempts. Default: ${HEALTH_INTERVAL}.
  --insecure             Skip TLS certificate verification. Opt-in for
                         self-signed staging hosts ONLY. Never use against
                         production — a broken chain there means MITM until
                         proven otherwise.
  --resolve HOST:IP      Force curl to resolve HOST to IP instead of using DNS.
                         Useful when the server cannot reach its own public IP
                         (hairpin NAT). TLS is still verified against the real
                         certificate — no --insecure needed. Example:
                           --resolve mcp.example.com:127.0.0.1
  --no-color             Disable ANSI output (auto-disabled when stdout is not a TTY).
  -h, --help             Show this help.

Example (env var, recommended):
  NUXT_MCP_AUTH_TOKEN="\$(cat ~/.secrets/bx24-mcp-token)" \\
    ./scripts/verify-deployment.sh --url https://prod.example.com

Example (stdin):
  pass show bx24-mcp-token | ./scripts/verify-deployment.sh \\
    --url https://prod.example.com --token-stdin
EOF
  exit 64
}

# Explicit "needs an argument" check that exits with the documented 64
# rather than bash's default behaviour for \${var:?msg} (exit 1, no usage
# block). Pair with the trailing handler below.
require_arg() {
  # Args: flag-name remaining-arg-count
  if [ "$2" -lt 2 ]; then
    echo "Missing value for $1" >&2
    usage
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)             require_arg "$1" "$#"; URL="$2"; shift 2 ;;
    --token)           require_arg "$1" "$#"; TOKEN="$2"; shift 2 ;;
    --token-stdin)     IFS= read -r TOKEN || true
                       if [ -z "$TOKEN" ]; then
                         echo "--token-stdin: stdin was empty (no token to read)" >&2
                         usage
                       fi
                       shift ;;
    --timeout)         require_arg "$1" "$#"; TIMEOUT="$2"; shift 2 ;;
    --health-retries)  require_arg "$1" "$#"; HEALTH_RETRIES="$2"; shift 2 ;;
    --health-interval) require_arg "$1" "$#"; HEALTH_INTERVAL="$2"; shift 2 ;;
    --insecure)        INSECURE="yes"; shift ;;
    --resolve)         require_arg "$1" "$#"; RESOLVE="$2"; shift 2 ;;
    --no-color)        USE_COLOR="no"; shift ;;
    -h|--help)         usage ;;
    *)                 echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# Token precedence: --token / --token-stdin (set TOKEN) wins, env falls back.
if [ -z "$TOKEN" ] && [ -n "$ENV_TOKEN" ]; then
  TOKEN="$ENV_TOKEN"
fi

# Strip surrounding whitespace / a trailing newline — copy-paste from a
# secret manager often carries one, and curl would send `Bearer …<LF>` and
# get a confusing 401 that misleads the operator into "rotate the token".
TOKEN="${TOKEN#"${TOKEN%%[![:space:]]*}"}"
TOKEN="${TOKEN%"${TOKEN##*[![:space:]]}"}"

# Reject embedded CR/LF in the body of the token after the strip above.
# The strip only handles leading/trailing whitespace; a token like
# `abc\r\nX-Injected: yes` would otherwise reach curl's `-H "Authorization:
# Bearer $TOKEN"` and split into two headers on some curl versions —
# header injection by way of a corrupted paste (e.g. a chat client that
# line-wraps the secret). Threat actor is the operator themselves, so
# severity is low, but the failure mode is silent and surprising.
case "$TOKEN" in
  *$'\r'*|*$'\n'*)
    echo "Error: token contains an embedded newline (CR or LF) after stripping surrounding whitespace." >&2
    echo "       The most likely cause is a chat/email client that line-wrapped the value during copy." >&2
    echo "       Re-paste the token as a single unbroken line, or use --token-stdin with a single-line file." >&2
    exit 64
    ;;
esac

[ -n "$URL" ]   || { echo "Missing --url"   >&2; usage; }
[ -n "$TOKEN" ] || { echo "Missing token (pass --token, --token-stdin, or set NUXT_MCP_AUTH_TOKEN)" >&2; usage; }

# Numeric guards — silent no-op loops (HEALTH_RETRIES=0) would otherwise
# fall through to a misleading "after 0 attempts" message.
case "$HEALTH_RETRIES"  in (*[!0-9]*|"") echo "Invalid --health-retries: $HEALTH_RETRIES (expected positive integer)" >&2; usage ;; esac
case "$TIMEOUT"         in (*[!0-9]*|"") echo "Invalid --timeout: $TIMEOUT (expected positive integer)" >&2; usage ;; esac
case "$HEALTH_INTERVAL" in (*[!0-9]*|"") echo "Invalid --health-interval: $HEALTH_INTERVAL (expected positive integer)" >&2; usage ;; esac
[ "$HEALTH_RETRIES"  -ge 1 ] || { echo "Invalid --health-retries: $HEALTH_RETRIES (must be ≥ 1)" >&2; usage; }
[ "$TIMEOUT"         -ge 1 ] || { echo "Invalid --timeout: $TIMEOUT (must be ≥ 1)" >&2; usage; }
[ "$HEALTH_INTERVAL" -ge 1 ] || { echo "Invalid --health-interval: $HEALTH_INTERVAL (must be ≥ 1)" >&2; usage; }

# Strip a single trailing slash so the route concatenation stays sane.
URL="${URL%/}"

# Build --resolve flag for curl when --resolve HOST:IP was given.
# The flag format curl expects is HOST:PORT:IP for each port, so we expand
# the user-supplied HOST:IP shorthand into two entries (80 + 443).
RESOLVE_ARG=""
if [ -n "$RESOLVE" ]; then
  # A value with no ':' is malformed — reject it up front. Without this guard
  # both ${RESOLVE%%:*} and ${RESOLVE##*:} return the whole string, the
  # non-empty check below passes, and curl later dies with an opaque
  # "Couldn't parse CURLOPT_RESOLVE entry" after the full retry loop.
  case "$RESOLVE" in
    *:*) : ;;
    *) echo "Invalid --resolve: expected HOST:IP, got '$RESOLVE'" >&2; usage ;;
  esac
  _rhost="${RESOLVE%%:*}"
  _rip="${RESOLVE##*:}"
  # Strip spaces — curl rejects host/ip values with embedded whitespace and
  # spaces in RESOLVE_ARG would cause unwanted word-splitting of the flag.
  _rhost="${_rhost// /}"
  _rip="${_rip// /}"
  # Reject a half-specified pair (e.g. ":1.2.3.4" or "host:") here — otherwise it
  # reaches curl as a malformed --resolve and fails later with an opaque error.
  [ -n "$_rhost" ] && [ -n "$_rip" ] || { echo "Invalid --resolve: expected HOST:IP, got '$RESOLVE'" >&2; usage; }
  # Charset-validate both halves. RESOLVE_ARG is intentionally word-split into
  # curl (no arrays under bash 3.2), so a value carrying whitespace/newlines or
  # shell-meta could otherwise smuggle extra curl flags (e.g. --output) past the
  # split. Hostnames: letters/digits/dot/hyphen; IP: digits/dots/colons (v4+v6).
  case "$_rhost" in (*[!A-Za-z0-9.-]*) echo "Invalid --resolve host: '$_rhost'" >&2; usage ;; esac
  case "$_rip"   in (*[!0-9.:]*)       echo "Invalid --resolve ip: '$_rip'"     >&2; usage ;; esac
  RESOLVE_ARG="--resolve ${_rhost}:80:${_rip} --resolve ${_rhost}:443:${_rip}"
fi

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

# Single curl wrapper — captures only the HTTP status code, never the body
# (bodies could leak the MCP toolkit's tool catalogue or version data).
#
# NOTE on `set -e` semantics: command substitution in an assignment does
# NOT propagate the subshell's non-zero exit (POSIX). On a connection
# failure curl prints `000` to stdout and exits 7, so callers see
# STATUS=000 with rc=0; the per-case branches below handle 000 explicitly.
# This is intentional — propagating curl's rc here would abort the script
# before the operator-facing hint can run. (Callers in sections 2-4 ALSO
# append `|| echo "error"` as belt-and-braces, since they're tail calls
# not health-loop iterations and want to keep failing assertions running.)
status_of() {
  # Args: METHOD URL [extra curl args...]
  local method="$1" target="$2"
  shift 2
  # `--insecure` flag is gated by `$INSECURE` (set by the CLI flag). Using
  # a wrapper function rather than a bash array sidesteps the bash 3.2
  # "unbound variable" crash on `"${empty_array[@]}"` under `set -u` —
  # macOS ships /bin/bash 3.2 by default, and the script's shebang is
  # `#!/usr/bin/env bash`, so it MUST stay portable to that interpreter.
  if [ "$INSECURE" = "yes" ]; then
    # shellcheck disable=SC2086  # RESOLVE_ARG: intentional word-split (no arrays in bash 3.2)
    curl -sS -k -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" -X "$method" $RESOLVE_ARG "$target" "$@"
  else
    # shellcheck disable=SC2086
    curl -sS    -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" -X "$method" $RESOLVE_ARG "$target" "$@"
  fi
}

info "Target : $URL  (timeout ${TIMEOUT}s, health retries ${HEALTH_RETRIES}×${HEALTH_INTERVAL}s)"
info "Token  : ${#TOKEN}-char value (not echoed)"
info "TLS    : $([ "$INSECURE" = yes ] && printf 'verification DISABLED (--insecure)' || printf 'verification ON')"
[ -n "$RESOLVE_ARG" ] && info "Resolve: $RESOLVE  (hairpin NAT bypass — DNS skipped, cert still verified)"
echo

# ─── 1. /api/health ────────────────────────────────────────────────────────
info "Waiting for /api/health to become healthy"
HEALTH_OK="no"
LAST_STATUS=""
for i in $(seq 1 "$HEALTH_RETRIES"); do
  STATUS=$(status_of GET "$URL/api/health" || echo "error")
  LAST_STATUS="$STATUS"
  if [ "$STATUS" = "200" ]; then HEALTH_OK="yes"; break; fi
  printf "%s    attempt %d/%d: status=%s%s\n" "$DIM" "$i" "$HEALTH_RETRIES" "${STATUS:-error}" "$RESET"
  sleep "$HEALTH_INTERVAL"
done

if [ "$HEALTH_OK" = "yes" ]; then
  pass "/api/health → 200 (after $i attempt(s))"
else
  fail "/api/health never returned 200 after $HEALTH_RETRIES attempts — bailing on remaining checks"
  echo
  # Distinguish "the upstream container is dead" from "the proxy can reach
  # us but its upstream returns 5xx". An operator with the wrong hint
  # debugs the wrong layer for 15 minutes.
  case "$LAST_STATUS" in
    502|503|504)
      printf "%s  Hint: the proxy responded with %s — the reverse proxy is reachable, but its\n" "$YELLOW" "$LAST_STATUS"
      printf "  upstream (this MCP container) is unhealthy or unreachable. Check\n"
      printf "  the container directly on the host: docker compose ps / docker compose logs -f.%s\n" "$RESET"
      ;;
    000|error)
      printf "%s  Hint: curl could not connect at all (TLS handshake, DNS, or firewall).\n" "$YELLOW"
      printf "  If the host uses a self-signed cert, re-run with --insecure (staging only).%s\n" "$RESET"
      ;;
    *)
      printf "%s  Hint: the server may still be booting (cold pnpm build, slow disk), the\n" "$YELLOW"
      printf "  TLS/reverse-proxy may not be forwarding /api/health, or the container\n"
      printf "  is in a crash loop. Check 'docker compose logs -f' on the host.%s\n" "$RESET"
      ;;
  esac
  exit 1
fi

# Body shape — `jq -e` when available pins the EXACT contract:
#   .status == "ok" AND the body has exactly {status, timestamp} keys, no
#   extras. Catches a regression to {"status":"ok","service":"bx24-mcp"}
#   that would re-introduce the fingerprintable surface removed for #131
#   (and pinned by tests/unit/api/health.test.ts).
# Falls back to a whitespace-tolerant regex when jq isn't on PATH
# (BusyBox / minimal alpine operator hosts) — note that the fallback only
# matches the predicate, not the shape; install jq for the full guarantee.
BODY=$(
  if [ "$INSECURE" = "yes" ]; then
    # shellcheck disable=SC2086
    curl -sS -k --max-time "$TIMEOUT" $RESOLVE_ARG "$URL/api/health" || true
  else
    # shellcheck disable=SC2086
    curl -sS    --max-time "$TIMEOUT" $RESOLVE_ARG "$URL/api/health" || true
  fi
)
if command -v jq >/dev/null 2>&1; then
  if printf '%s' "$BODY" | jq -e '(.status == "ok") and ((. | keys | sort) == ["status","timestamp"])' >/dev/null 2>&1; then
    pass '/api/health body: jq matched .status == "ok" with shape {status, timestamp} only'
  else
    fail "/api/health body failed strict check (status=\"ok\" AND keys={status,timestamp}) — got: $BODY"
  fi
else
  # Whitespace-tolerant: matches both `"status":"ok"` (compact) and
  # `"status": "ok"` (formatted). Server uses compact today, but the
  # fallback should not break if a future serializer adds spaces.
  if printf '%s' "$BODY" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    pass '/api/health body matches "status":"ok" predicate (substring; install jq for strict {status,timestamp} shape check)'
  else
    fail "/api/health body did not match the \"status\":\"ok\" predicate — got: $BODY"
  fi
fi

# ─── 2. /mcp without Authorization → 401 ───────────────────────────────────
# Pinned by server/middleware/mcp-auth.ts (h3 throws createError 401).
# `|| echo "error"` so a curl-level failure doesn't abort the rest of the
# checks under `set -e` — the per-case branches surface the curl failure
# as a fail() and we still get to assertion 3 + 4.
STATUS=$(status_of GET "$URL/mcp" || echo "error")
case "$STATUS" in
  401) pass "/mcp without Authorization → 401 (auth middleware engaged)" ;;
  503) fail "/mcp returned 503 — NUXT_MCP_AUTH_TOKEN is unset or still 'replace-with-secure-token'; the host is not actually configured" ;;
  *)   fail "/mcp without Authorization → expected 401, got $STATUS (see server/middleware/mcp-auth.ts — middleware may be missing or the route is not behind it)" ;;
esac

# ─── 3. /mcp with a wrong Bearer → 401 ─────────────────────────────────────
# Length-matched wrong value: `server/middleware/mcp-auth.ts:42` short-
# circuits to `return false` when the byte lengths differ, BEFORE calling
# `cryptoTimingSafeEqual`. A `not-the-token` value would therefore reject
# via the length short-circuit and never exercise the real comparator.
# Matching the token's length forces the path past the short-circuit so
# the timing-safe content comparison is the one that produces 401 — that's
# the path operators actually depend on at runtime.
#
# Note: `${#TOKEN}` counts characters; `openssl rand -hex` tokens are pure
# ASCII so character count equals byte count. Documented constraint in
# usage().
WRONG="$(printf '%*s' "${#TOKEN}" '' | tr ' ' 'x')"
STATUS=$(status_of GET "$URL/mcp" -H "Authorization: Bearer $WRONG" || echo "error")
case "$STATUS" in
  401) pass "/mcp with wrong Bearer (length-matched) → 401" ;;
  *)   fail "/mcp with wrong Bearer → expected 401, got $STATUS (see server/middleware/mcp-auth.ts \`timingSafeEqual\`)" ;;
esac

# ─── 4. /mcp with the configured Bearer → NOT 401 / 403 / 503 ──────────────
# A bare GET to /mcp with a valid token may legitimately produce 200, 202,
# 405, etc. depending on what the MCP toolkit's handler returns to a non-
# JSON-RPC method. What matters here is that auth passed — i.e. NOT 401 / 403,
# and NOT 503 (which would mean the token equals the placeholder).
STATUS=$(status_of GET "$URL/mcp" -H "Authorization: Bearer $TOKEN" || echo "error")
case "$STATUS" in
  401|403)     fail "/mcp with the configured Bearer → $STATUS (token mismatch — check the value on the host vs the one passed to this script)" ;;
  503)         fail "/mcp with the configured Bearer → 503 (the host is treating the token as the placeholder — re-check NUXT_MCP_AUTH_TOKEN on the host)" ;;
  000|error)   fail "/mcp with the configured Bearer → curl could not connect (TLS handshake / DNS / firewall)" ;;
  *)           pass "/mcp with the configured Bearer → $STATUS (auth passed)" ;;
esac

# ─── 5. JSON-RPC initialize round-trip + tools/list (toolkit dispatcher) ───
# Closes #161. Assertions 1-4 above guard the HTTP-level shape of /mcp but
# never touch the @nuxtjs/mcp-toolkit JSON-RPC dispatcher. A middleware
# refactor whose error lands in Nitro's uncaught-error handler (becoming
# a 500 instead of a JSON-RPC error envelope) would ship green under
# assertions 1-4 alone. This block forces a real round-trip through the
# dispatcher and asserts the server identity from the wire response.
#
# Transport contract: @nuxtjs/mcp-toolkit's node provider runs in
# STATELESS mode by default (providers/node.js: `sessionsEnabled: false`,
# `sessionIdGenerator: undefined`, `enableJsonResponse: true`). The
# SDK therefore: (a) does not issue an Mcp-Session-Id, (b) does not
# require one on follow-up requests, and (c) always replies with
# `application/json` rather than `text/event-stream`. So both calls
# below are plain JSON-RPC POSTs with no session bookkeeping.
#
# Skipped if `jq` is not on PATH: the JSON-RPC predicates below need
# real parsing — substring matching against the body would be too
# brittle to trust as a regression gate.
if command -v jq >/dev/null 2>&1; then
  # `truncate_body` keeps fail-message diagnostics readable AND avoids
  # leaking large server bodies (potentially containing stack traces /
  # internal paths) into operator terminals OR public GHA PR logs.
  truncate_body() {
    printf '%s' "$1" | tr -d '\r' | head -c 200
  }

  # protocolVersion: the SDK negotiates UP — we send the oldest version
  # the toolkit currently supports so we keep working across spec bumps.
  # When @nuxtjs/mcp-toolkit drops support for "2024-11-05", update both
  # this string and the `SUPPORTED_PROTOCOL_VERSIONS` check below.
  INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify-deployment.sh","version":"1.0"}}}'

  if [ "$INSECURE" = "yes" ]; then
    # shellcheck disable=SC2086
    INIT_RAW=$(curl -sS -k --max-time "$TIMEOUT" $RESOLVE_ARG \
      -X POST "$URL/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -w '\n%{http_code}' \
      -d "$INIT_BODY" 2>/dev/null || echo $'\nerror')
  else
    # shellcheck disable=SC2086
    INIT_RAW=$(curl -sS    --max-time "$TIMEOUT" $RESOLVE_ARG \
      -X POST "$URL/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -w '\n%{http_code}' \
      -d "$INIT_BODY" 2>/dev/null || echo $'\nerror')
  fi
  INIT_STATUS=$(printf '%s' "$INIT_RAW" | tail -n1)
  INIT_RESP_BODY=$(printf '%s' "$INIT_RAW" | sed '$d')

  if [ "$INIT_STATUS" != "200" ]; then
    fail "JSON-RPC initialize → HTTP $INIT_STATUS (expected 200; body: $(truncate_body "$INIT_RESP_BODY"))"
  # FORK: change "bx24-template-mcp" to whatever serverInfo.name your fork
  # advertises (set in nuxt.config.ts under `mcp.name` for @nuxtjs/mcp-toolkit).
  elif printf '%s' "$INIT_RESP_BODY" | jq -e '
        .jsonrpc == "2.0"
        and .id == 1
        and (.result.serverInfo.name == "bx24-template-mcp")
        and (.result.protocolVersion | type == "string")
        and (.result.protocolVersion | length > 0)
        and (.result.capabilities | has("tools"))
      ' >/dev/null 2>&1; then
    pass "JSON-RPC initialize → envelope OK; serverInfo.name=bx24-template-mcp; capabilities.tools advertised"
  else
    fail "JSON-RPC initialize → envelope / serverInfo mismatch — got: $(truncate_body "$INIT_RESP_BODY")"
  fi

  # tools/list — no Mcp-Session-Id required (see stateless contract above).
  # FORK: change "b24_user_me" to a stable canary tool that exists in your
  # fork's tool catalogue. The point is to pin AT LEAST ONE name so a
  # handler-registration regression (toolkit dispatcher stops walking the
  # catalogue, registry filter drops everything, etc.) cannot ship green.
  TOOLS_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  if [ "$INSECURE" = "yes" ]; then
    # shellcheck disable=SC2086
    TOOLS_RAW=$(curl -sS -k --max-time "$TIMEOUT" $RESOLVE_ARG \
      -X POST "$URL/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -w '\n%{http_code}' \
      -d "$TOOLS_BODY" 2>/dev/null || echo $'\nerror')
  else
    # shellcheck disable=SC2086
    TOOLS_RAW=$(curl -sS    --max-time "$TIMEOUT" $RESOLVE_ARG \
      -X POST "$URL/mcp" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -w '\n%{http_code}' \
      -d "$TOOLS_BODY" 2>/dev/null || echo $'\nerror')
  fi
  TOOLS_STATUS=$(printf '%s' "$TOOLS_RAW" | tail -n1)
  TOOLS_RESP_BODY=$(printf '%s' "$TOOLS_RAW" | sed '$d')

  if [ "$TOOLS_STATUS" != "200" ]; then
    fail "JSON-RPC tools/list → HTTP $TOOLS_STATUS (expected 200; body: $(truncate_body "$TOOLS_RESP_BODY"))"
  elif printf '%s' "$TOOLS_RESP_BODY" | jq -e '.result.tools | map(.name) | index("b24_user_me")' >/dev/null 2>&1; then
    pass "JSON-RPC tools/list → catalogue contains b24_user_me"
  else
    fail "JSON-RPC tools/list → b24_user_me missing from catalogue (tool registration regression?) — got: $(truncate_body "$TOOLS_RESP_BODY")"
  fi
else
  info "JSON-RPC initialize + tools/list checks skipped — \`jq\` not on PATH. Install jq to enable assertion 5."
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf "%sAll checks passed.%s\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%s%d check(s) failed.%s\n" "$RED" "$FAILED" "$RESET" >&2
  exit 1
fi
