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

echo "1) Anti-framing on the /api/oauth/callback HTML pages"
has server/api/oauth/callback.get.ts 'X-Frame-Options'      'callback sets X-Frame-Options'
has server/api/oauth/callback.get.ts 'DENY'                 'callback X-Frame-Options: DENY'
has server/api/oauth/callback.get.ts "frame-ancestors 'none'" 'callback CSP frame-ancestors none'
has server/api/oauth/callback.get.ts 'safeBearer'           'callback html-escapes the bearer (defence-in-depth)'
echo

echo "2) Per-IP install rate limiter (middleware)"
has server/middleware/oauth-rate-limit.ts 'oauth.install.deny.rate-limited' 'middleware logs the §11 deny event'
has server/middleware/oauth-rate-limit.ts 'RATE-LIMITED'        'middleware emits errorCode RATE-LIMITED'
has server/middleware/oauth-rate-limit.ts 'MAX_PER_WINDOW = 10' 'limit is 10/min (headroom over the 5 CI probes)'
has server/middleware/oauth-rate-limit.ts 'retry-after'         'middleware sets Retry-After header'
has server/middleware/oauth-rate-limit.ts '<unknown>'           'unknown source-IP bucket documented'
echo

echo "3) Install-route log sanitiser (control chars + length cap)"
has server/api/oauth/install.get.ts 'U+0080-U+009F' 'install strips C1 controls (round-2)'
has server/api/oauth/install.get.ts 'u009f'         'install regex includes the C1 range'
has server/api/oauth/install.get.ts 'slice(0, 253)' 'install caps the logged portal at 253 chars'
echo

echo "4) Per-tenant feedback quota (no cross-tenant starvation)"
has server/utils/github-feedback.ts 'consumeFeedbackQuota' 'consumeFeedbackQuota present'
has server/utils/github-feedback.ts 'memberId'             'quota keyed on the tenant memberId'
has server/utils/github-feedback.ts 'NOT true-LRU'         'eviction policy documented (fails-open)'
echo

echo "5) Docs / skills refreshed for the new surface"
has  skills/manage-bx24-template-mcp/feedback.md 'per tenant'    'feedback skill: quota is per-tenant'
has  skills/manage-bx24-template-mcp/feedback.md 'starve another' 'feedback skill: no cross-tenant starvation'
has  docs/OAUTH-DESIGN.md 'RATE-LIMITED'                    'OAUTH-DESIGN §11: RATE-LIMITED registered'
has  docs/SECURITY.md 'HTTP-surface hardening (issue #221)' 'SECURITY: threat model updated'
has  docs/SECURITY.md 'except'                              'SECURITY: out-of-scope DoS carve-out'
has  skills/run-manual-qa/references/issue-scaffold.md 'oauth.install.deny.rate-limited' 'issue-scaffold: 429 deny branch'
echo

echo "6) Round-2 test coverage added"
has tests/unit/api/oauth/install.test.ts 'strips C0/C1/DEL control chars' 'install test: control-char strip'
has tests/unit/middleware/oauth-rate-limit.test.ts 'toBe(60)' 'rate-limit test: exact Retry-After pinned'
has tests/unit/middleware/oauth-rate-limit.test.ts 'i < 6'    'rate-limit test: 6th probe asserted (headroom)'
has tests/unit/api/oauth/callback.test.ts 'x-frame-options'   'callback test: anti-framing header pins'
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
