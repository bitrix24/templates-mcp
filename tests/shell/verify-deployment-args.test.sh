#!/usr/bin/env bash
# Behavioural tests for scripts/verify-deployment.sh argument validation.
#
# These exercise only the pre-flight guards (numeric ranges, --resolve shape),
# which exit before any network call — so the suite needs no server, no network,
# and no extra tooling beyond bash. Run locally with:
#
#   bash tests/shell/verify-deployment-args.test.sh
#
# Complements the static `shellcheck` CI job: this is the first *behavioural*
# coverage of the script (part of the issue #194 test-debt), guarding the
# operator-facing validation contract against regressions.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../../scripts/verify-deployment.sh"

[ -x "$script" ] || { echo "FATAL: $script not found or not executable" >&2; exit 2; }

pass=0
fail=0

# assert_fails <expected-stderr-substring> <script args...>
# Asserts the script exits non-zero AND prints the substring on stderr.
assert_fails() {
  local want="$1"; shift
  local out rc
  out="$("$script" "$@" 2>&1 1>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: expected non-zero exit for [$*], got 0"
    fail=$((fail + 1))
    return
  fi
  case "$out" in
    *"$want"*) pass=$((pass + 1)) ;;
    *)
      echo "FAIL: for [$*]"
      echo "      expected stderr to contain: $want"
      echo "      got:                        $out"
      fail=$((fail + 1))
      ;;
  esac
}

base=(--url https://example.com --token x)

# Numeric guards reject zero, non-integers, and negatives, and echo the value.
# Each knob is checked against BOTH barriers: the case-pattern (non-digit/empty,
# which also catches the leading-'-' of a negative) and the `-ge 1` range check.
assert_fails "Invalid --health-retries: 0 (must be ≥ 1)"      "${base[@]}" --health-retries 0
assert_fails "Invalid --health-retries: abc (expected"        "${base[@]}" --health-retries abc
assert_fails "Invalid --health-retries: -1 (expected"         "${base[@]}" --health-retries -1
assert_fails "Invalid --timeout: 0 (must be ≥ 1)"             "${base[@]}" --timeout 0
assert_fails "Invalid --timeout: 1.5 (expected"               "${base[@]}" --timeout 1.5
assert_fails "Invalid --timeout: -1 (expected"                "${base[@]}" --timeout -1
assert_fails "Invalid --health-interval: 0 (must be ≥ 1)"     "${base[@]}" --health-interval 0
assert_fails "Invalid --health-interval: -1 (expected"        "${base[@]}" --health-interval -1

# --resolve must be HOST:IP. Reject a half-specified pair, a value with no colon
# at all (regression: both %%/## expansions return the whole string, so the
# non-empty check alone passed it through to curl), and a spaces-only value.
assert_fails "Invalid --resolve: expected HOST:IP"            "${base[@]}" --resolve :1.2.3.4
assert_fails "Invalid --resolve: expected HOST:IP"            "${base[@]}" --resolve host:
assert_fails "Invalid --resolve: expected HOST:IP"            "${base[@]}" --resolve nocolon
assert_fails "Invalid --resolve: expected HOST:IP"            "${base[@]}" --resolve "   "
# …and a value carrying shell-meta / whitespace that could smuggle curl flags.
assert_fails "Invalid --resolve host"                         "${base[@]}" --resolve 'h$(id):1.2.3.4'

# Required args still enforced.
assert_fails "Missing --url"                                  --token x
assert_fails "Missing token"                                  --url https://example.com

# --- issue #223: stdin / header-injection / unknown-arg guards ---

# assert_fails_stdin <stdin-content> <expected-substring> <args...>
# Like assert_fails but feeds <stdin-content> on the script's stdin — the
# --token-stdin path reads one line from stdin, so the empty-stdin case can
# only be exercised deterministically by piping a known (empty) value in.
assert_fails_stdin() {
  local stdin_content="$1"; local want="$2"; shift 2
  local out rc
  out="$(printf '%s' "$stdin_content" | "$script" "$@" 2>&1 1>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: expected non-zero exit for [$*] (stdin='$stdin_content'), got 0"
    fail=$((fail + 1))
    return
  fi
  case "$out" in
    *"$want"*) pass=$((pass + 1)) ;;
    *)
      echo "FAIL: for [$*] (stdin='$stdin_content')"
      echo "      expected stderr to contain: $want"
      echo "      got:                        $out"
      fail=$((fail + 1))
      ;;
  esac
}

# (a) --token-stdin with EMPTY stdin → usage error (EX_USAGE/64). Without this
# the operator gets a later, opaque "missing token" much further down.
assert_fails_stdin "" "--token-stdin: stdin was empty"        --url https://example.com --token-stdin

# (b) token carrying an embedded CR/LF → rejected (EX_USAGE/64). This is the
# header-injection guard (security-relevant): a line-wrapped paste would
# otherwise split the `Authorization:` header on some curl builds. The newline
# must sit in the token BODY — surrounding whitespace is stripped first — so a
# mid-token CRLF is used here.
assert_fails "token contains an embedded newline"             --url https://example.com --token "$(printf 'abc\r\nX-Injected: yes')"

# (c) unknown flag → usage error (EX_USAGE/64); a typo'd option must not be
# silently ignored and fall through to a default.
assert_fails "Unknown argument: --bogus"                      "${base[@]}" --bogus

echo "----"
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
