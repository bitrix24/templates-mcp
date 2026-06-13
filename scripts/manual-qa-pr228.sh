#!/usr/bin/env bash
# scripts/manual-qa-pr228.sh — verify PR #228 (oauth-221-http-hardening) state.
#
# Verifies the public-OAuth HTTP-surface hardening from issue #221, plus the
# round-2 review fixes. This is a SOURCE-LEVEL verifier: it greps the repo for
# the expected changes and (optionally) runs the affected test files. No live
# server needed — just run from the repo root and hand me the output.
#
#   Linux/macOS/WSL:  bash scripts/manual-qa-pr228.sh
#
# shellcheck disable=SC2016
# (Single-quoted literals are the EXACT strings we grep for in project files.)
set -uo pipefail
pass=0
fail=0
ok() { printf '  [PASS] %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  [FAIL] %s\n' "$1"; fail=$((fail + 1)); }
has()   { if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else no "$3"; fi; }
hasnt() { if grep -qF -- "$2" "$1" 2>/dev/null; then no "$3"; else ok "$3"; fi; }

echo "=================================================="
echo " PR #228 — OAuth HTTP-surface hardening (issue #221)"
echo "=================================================="
if [ ! -f docs/OAUTH-DESIGN.md ]; then echo "ERROR: run from repo ROOT."; exit 2; fi
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?')"
echo

echo "1) Anti-framing on EVERY /api/oauth/callback response path (round-3)"
has server/api/oauth/callback.get.ts 'setAntiFramingHeaders'  'callback has the shared anti-framing helper (round-3)'
has server/api/oauth/callback.get.ts 'X-Frame-Options'        'callback sets X-Frame-Options'
has server/api/oauth/callback.get.ts 'DENY'                   'callback X-Frame-Options: DENY'
has server/api/oauth/callback.get.ts "frame-ancestors 'none'" 'callback CSP frame-ancestors none'
has server/api/oauth/callback.get.ts 'safeBearer'             'callback html-escapes the bearer (defence-in-depth)'
# The helper is called at the TOP of the handler — every throw path gets it.
hasnt server/api/oauth/callback.get.ts 'setResponseHeader(event, "pragma"' 'no duplicate pragma setResponseHeader (folded into helper)'
echo

echo "2) Per-IP rate limiter — install + callback (middleware)"
has server/middleware/oauth-rate-limit.ts 'oauth.install.deny.rate-limited'  'middleware logs the install deny event'
has server/middleware/oauth-rate-limit.ts 'oauth.callback.deny.rate-limited' 'middleware logs the callback deny event (round-3)'
has server/middleware/oauth-rate-limit.ts 'RATE-LIMITED'        'middleware emits shared errorCode RATE-LIMITED'
has server/middleware/oauth-rate-limit.ts 'maxPerWindow: 10'    'install limit is 10/min (headroom over the 5 CI probes)'
has server/middleware/oauth-rate-limit.ts 'maxPerWindow: 30'    'callback limit is 30/min (round-3)'
has server/middleware/oauth-rate-limit.ts 'retry-after'         'middleware sets Retry-After header'
has server/middleware/oauth-rate-limit.ts '<unknown>'           'unknown source-IP bucket documented'
has server/middleware/oauth-rate-limit.ts 'pathname}:${ip}'     'per-route bucket key (install + callback do not collide)'
echo

echo "3) Install-route log sanitiser (control chars + Bidi + length cap)"
has server/api/oauth/install.get.ts 'u009f' 'install regex strips C1 range'
has server/api/oauth/install.get.ts 'u202e' 'install regex strips RTL bidi override (round-3)'
has server/api/oauth/install.get.ts 'ufeff' 'install regex strips zero-width / BOM (round-3)'
has server/api/oauth/install.get.ts 'Trojan Source' 'install comment cites Trojan Source threat (round-3)'
has server/api/oauth/install.get.ts 'slice(0, 253)' 'install caps the logged portal at 253 chars'
has server/api/oauth/install.get.ts "'cache-control', 'no-store'" 'install sets Cache-Control: no-store on every path (round-3)'
echo

echo "4) Per-tenant feedback quota (no cross-tenant starvation)"
has server/utils/github-feedback.ts 'consumeFeedbackQuota' 'consumeFeedbackQuota present'
has server/utils/github-feedback.ts 'memberId'             'quota keyed on the tenant memberId'
has server/utils/github-feedback.ts 'NOT true-LRU'         'eviction policy documented (fails-open)'
echo

echo "5) Docs / skills refreshed for the new surface"
has  skills/manage-bx24-template-mcp/feedback.md 'per tenant'    'feedback skill: quota is per-tenant'
has  skills/manage-bx24-template-mcp/feedback.md 'starve another' 'feedback skill: no cross-tenant starvation'
has  docs/OAUTH-DESIGN.md 'RATE-LIMITED'                            'OAUTH-DESIGN §11: RATE-LIMITED registered'
has  docs/OAUTH-DESIGN.md 'oauth.callback.deny.rate-limited'        'OAUTH-DESIGN §11: callback deny event listed (round-3)'
has  docs/OAUTH-DESIGN.md 'SHARED by two distinct events'           'OAUTH-DESIGN §11: shared errorCode note (round-3)'
has  docs/SECURITY.md 'HTTP-surface hardening (issue #221)'         'SECURITY: threat model updated'
has  docs/SECURITY.md 'on every response'                           'SECURITY: notes anti-framing on every path (round-3)'
has  docs/SECURITY.md '30/min'                                      'SECURITY: callback rate limit doc (round-3)'
has  docs/SECURITY.md 'observability--logging'                      'SECURITY: cross-references §11 (round-3)'
has  skills/run-manual-qa/references/issue-scaffold.md 'oauth.install.deny.rate-limited'  'issue-scaffold: install 429 deny branch'
has  skills/run-manual-qa/references/issue-scaffold.md 'oauth.callback.deny.rate-limited' 'issue-scaffold: callback 429 deny branch (round-3)'
has  skills/run-manual-qa/references/issue-scaffold.md '60-second sliding window'         'issue-scaffold: window semantics (round-3)'
echo

echo "6) Test coverage — round-2 + round-3"
has tests/unit/api/oauth/install.test.ts  'strips C0/C1/DEL control chars'        'install test: control-char strip (round-2)'
has tests/unit/api/oauth/install.test.ts  'Trojan Source defence'                 'install test: Bidi/zero-width strip (round-3)'
has tests/unit/middleware/oauth-rate-limit.test.ts 'toBe(60)'                     'rate-limit test: exact Retry-After pinned'
has tests/unit/middleware/oauth-rate-limit.test.ts 'i < 10'                       'rate-limit test: 11th refused (round-3 headroom upper bound)'
has tests/unit/middleware/oauth-rate-limit.test.ts 'callback path is rate-limited at 30/min' 'rate-limit test: callback path also limited (round-3)'
has tests/unit/middleware/oauth-rate-limit.test.ts 'INDEPENDENT'                  'rate-limit test: install + callback buckets independent (round-3)'
has tests/unit/api/oauth/callback.test.ts 'x-frame-options'                       'callback test: anti-framing header pins'
has tests/unit/api/oauth/callback.test.ts 'STATE-ROW-CORRUPT'                     'callback test: STATE-ROW-CORRUPT branch (round-3)'
has tests/unit/api/oauth/callback.test.ts 'anti-framing on every deny path'       'callback test: anti-framing on all deny paths (round-3)'
echo

echo "7) (optional) run the affected test files + typecheck + lint"
if command -v pnpm >/dev/null 2>&1; then
  if pnpm exec vitest run \
       tests/unit/api/oauth/install.test.ts \
       tests/unit/api/oauth/callback.test.ts \
       tests/unit/middleware/oauth-rate-limit.test.ts >/dev/null 2>&1; then
    ok "affected test files pass locally"
  else
    no "affected test files FAIL locally"
  fi
  if pnpm typecheck >/dev/null 2>&1; then ok "typecheck clean"; else no "typecheck FAILS"; fi
  if pnpm lint >/dev/null 2>&1; then ok "lint clean"; else no "lint FAILS"; fi
else
  echo "  [SKIP] pnpm not installed — local checks skipped"
fi
echo

echo "=================================================="
echo " SUMMARY: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
  echo " RESULT: ALL GREEN  ✅"
  exit 0
else
  echo " RESULT: $fail problem(s) found  ❌"
  exit 1
fi
