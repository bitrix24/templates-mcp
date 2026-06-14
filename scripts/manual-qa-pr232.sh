#!/usr/bin/env bash
# Round-2 QA verification for PR #232 (operator UX landing form +
# follow-up fixes from the 5-agent review). Linux/macOS.
#
# Usage:
#   bash scripts/manual-qa-pr232.sh
#
# Each `has` / `hasnt` check fails fast with a one-line reason if the
# anchor drifts. Exit code 0 == ALL GREEN.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0
total=0

has() {
  local file="$1"; local needle="$2"; local label="$3"
  total=$((total + 1))
  if grep -qF -- "$needle" "$file"; then
    echo "  [PASS] $label"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label"
    echo "         (file: $file)"
    echo "         (looking for: $needle)"
    fail=$((fail + 1))
  fi
}

hasnt() {
  local file="$1"; local needle="$2"; local label="$3"
  total=$((total + 1))
  if ! grep -qF -- "$needle" "$file"; then
    echo "  [PASS] $label"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label"
    echo "         (file: $file)"
    echo "         (must NOT contain: $needle)"
    fail=$((fail + 1))
  fi
}

cmd_passes() {
  local cmd="$1"; local label="$2"
  total=$((total + 1))
  if eval "$cmd" > /tmp/qa-pr232.log 2>&1; then
    echo "  [PASS] $label"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label"
    echo "         (cmd: $cmd)"
    tail -3 /tmp/qa-pr232.log | sed 's/^/         /'
    fail=$((fail + 1))
  fi
}

echo "1) Shared HTML/header helpers extracted (#232 review I2 — drift between install/callback resolved)"
has server/utils/oauth-html.ts 'export function setAntiFramingHeaders' 'oauth-html exports setAntiFramingHeaders'
has server/utils/oauth-html.ts 'export function setHtmlResponseHeaders' 'oauth-html exports setHtmlResponseHeaders'
has server/utils/oauth-html.ts 'export function htmlEscape' 'oauth-html exports htmlEscape'
has server/utils/oauth-html.ts "'&#39;'" 'htmlEscape covers single-quote (#232 security N5)'
has server/api/oauth/install.get.ts  "from '~/server/utils/oauth-html'" 'install imports the shared helpers'
has server/api/oauth/callback.get.ts "from '~/server/utils/oauth-html'" 'callback imports the shared helpers'
hasnt server/api/oauth/install.get.ts  'function setAntiFramingHeaders' 'install has no local setAntiFramingHeaders'
hasnt server/api/oauth/callback.get.ts 'function setAntiFramingHeaders' 'callback has no local setAntiFramingHeaders'
echo

echo "2) h3 abstraction: setResponseStatus instead of event.node.res.statusCode (#232 review I1)"
hasnt server/api/oauth/install.get.ts  'event.node.res.statusCode' 'install uses h3 setResponseStatus'
hasnt server/api/oauth/callback.get.ts 'event.node.res.statusCode' 'callback uses h3 setResponseStatus'
has   server/api/oauth/install.get.ts  'setResponseStatus'         'install imports setResponseStatus'
has   server/api/oauth/callback.get.ts 'setResponseStatus'         'callback imports setResponseStatus'
echo

echo "3) Rate-limit middleware skips landing renders (#232 review I3 — F5 self-ban)"
has server/middleware/oauth-rate-limit.ts "url.searchParams.get('portal')" 'middleware peeks at portal param'
has server/middleware/oauth-rate-limit.ts 'F5-er can'                       'middleware comment explains the skip'
has tests/unit/middleware/oauth-rate-limit.test.ts 'landing render' 'unit test pins the skip behaviour'
has tests/unit/middleware/oauth-rate-limit.test.ts 'mixing landing renders and real submits' 'unit test mixes landing+submit'
echo

echo "4) install.get.ts JSDoc + CSP carve-out tightened"
has server/api/oauth/install.get.ts 'ERROR — clientId/redirect missing' 'JSDoc says ERROR for not-configured (#232 docs I4a)'
has server/api/oauth/install.get.ts 'INSTALL_PATH'                          'INSTALL_PATH constant used'
has server/api/oauth/install.get.ts "formAction: INSTALL_PATH"               'form-action sized down from self to install path'
hasnt server/api/oauth/install.get.ts "form-action 'self'"                  'no form-action self in install handler'
echo

echo "5) Landing event payload now includes ip (#232 docs I4b)"
has server/api/oauth/install.get.ts "ip: getRequestIP(event)"                'landing log carries ip'
has docs/OAUTH-DESIGN.md 'marketplace app id — public, not a secret'    '§11 docs the new payload field'
has docs/OAUTH-DESIGN.md '**excluded from the per-IP rate-limit**'           '§11 docs the rate-limit skip'
echo

echo "6) Headers contract: §3 + §6 docs reflect that JSON throws ALSO carry anti-framing (#232 docs I4c)"
has docs/OAUTH-DESIGN.md 'byte-identical JSON **body and status code**' '§3 calls out the body+status guarantee'
has docs/OAUTH-DESIGN.md 'and a strict CSP, even on JSON throws' '§3 mentions the extra response headers'
has docs/DEPLOYMENT.md   'now shows a small HTML landing form instead of redirecting' 'DEPLOYMENT step 5 warns operator'
has docs/SECURITY.md     'form-action /api/oauth/install'             'SECURITY notes the tightened directive'
echo

echo "7) New tests added (12 round-2 cases)"
has tests/unit/api/oauth/install.test.ts 'Accept: */*'                   'CLI default Accept */ * tested (#232 tester I7)'
has tests/unit/api/oauth/install.test.ts 'XSS regression guard'         'malicious clientId tested (#232 tester I5)'
has tests/unit/api/oauth/install.test.ts 'empty scope env falls back'    'empty scope fallback tested (#232 tester N9)'
has tests/unit/api/oauth/install.test.ts 'F5 must not self-ban'          'landing rate-limit skip pinned at install level (#232)'
has tests/unit/api/oauth/install.test.ts 'q-factor not parsed'           'q-factor decision documented in test (#232)'
has tests/unit/api/oauth/install.test.ts 'PORTAL_ALLOW_LIST_RE.source'   'pattern test sources from regex (#232 tester I6)'
has tests/unit/api/oauth/install.test.ts 'oauth.install.deny.portal-format' 'flag-gate positive assertion (#232 tester N9)'
echo

echo "8) Local checks (typecheck + lint + focused tests)"
cmd_passes 'pnpm exec vitest run tests/unit/api/oauth tests/unit/middleware/oauth-rate-limit.test.ts 2>&1 | tail -5 | grep -q passed' 'all install + rate-limit tests pass'
cmd_passes 'pnpm typecheck > /dev/null 2>&1'                                              'typecheck clean'
cmd_passes 'pnpm lint > /dev/null 2>&1'                                                   'lint clean'
echo

echo "=============================================="
printf ' SUMMARY: %d passed, %d failed (of %d)\n' "$pass" "$fail" "$total"
if [ "$fail" -eq 0 ]; then
  echo ' RESULT: ALL GREEN  OK'
  exit 0
else
  echo ' RESULT: '$fail' problem(s) found  FAIL'
  exit 1
fi
