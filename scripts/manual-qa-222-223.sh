#!/usr/bin/env bash
# QA verification for the #222 (code-quality) + #223 (test gaps) + zizmor
# enforcement PR. Linux/macOS.
#
# Usage:  bash scripts/manual-qa-222-223.sh
#
# Each has/hasnt check fails fast with a one-line reason. Exit 0 == ALL GREEN.
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
  if eval "$cmd" > /tmp/qa-222-223.log 2>&1; then
    echo "  [PASS] $label"
    pass=$((pass + 1))
  else
    echo "  [FAIL] $label"
    echo "         (cmd: $cmd)"
    tail -3 /tmp/qa-222-223.log | sed 's/^/         /'
    fail=$((fail + 1))
  fi
}

echo "#222.1 - cross-platform path-traversal guard in token-store"
has server/utils/token-store.ts 'split(/[/\\]/).some' 'resolveDbDir splits on both separators'
echo

echo "#222.2 - timingSafeEqual consolidated into one helper"
has server/utils/auth-helpers.ts 'export function timingSafeEqualStr' 'shared helper exists'
has server/middleware/mcp-auth.ts        'timingSafeEqualStr' 'mcp-auth imports the helper'
has server/api/oauth/_health.get.ts      'timingSafeEqualStr' '_health imports the helper'
has server/api/oauth/callback.get.ts     'timingSafeEqualStr' 'callback imports the helper'
hasnt server/middleware/mcp-auth.ts        'function timingSafeEqual(' 'mcp-auth has no local copy'
hasnt server/api/oauth/_health.get.ts      'function timingSafeEqual(' '_health has no local copy'
hasnt server/api/oauth/callback.get.ts     'function timingSafeEqual(' 'callback has no local copy'
echo

echo "#222.3 - stdio RuntimeConfig shim carries the 7 OAuth fields"
has mcp-stdio/nuxt-shims.ts 'bitrix24OauthEnabled: boolean' 'shim interface declares OAuth fields'
has mcp-stdio/nuxt-shims.ts 'bitrix24OauthAdminToken:' 'shim object sets OAuth fields'
echo

echo "#222.4 - findByBearerHash retained + documented (not silently dead)"
has server/utils/token-store.ts 'RETENTION NOTE (issue #222)' 'retention rationale documented'
echo

echo "#222.5 - find-user throws on semantic-validation failure"
has server/mcp/tools/users/find-user.ts 'throw new Bitrix24ToolError' 'find-user throws Bitrix24ToolError'
has server/mcp/tools/users/find-user.ts 'Bitrix24ErrorCode.INVALID_INPUT' 'with INVALID_INPUT code'
echo

echo "#223.1 - distinct tenant-deleted refresh event + test"
has server/utils/bitrix24-oauth.ts 'oauth.refresh.fail.tenant-deleted' 'source emits distinct event'
has tests/unit/utils/bitrix24-oauth.test.ts 'deleted mid-flight' 'test covers the uninstall race'
has docs/OAUTH-DESIGN.md 'tenant-deleted' 'section-11 documents the new event'
echo

echo "#223.2 - refresh expires (unix ts) branch covered"
has tests/unit/utils/bitrix24-oauth.test.ts 'expires` (unix ts)' 'expires-branch test present'
echo

echo "#223.3 - shell-arg gaps covered (stdin / CRLF / unknown)"
has tests/shell/verify-deployment-args.test.sh 'stdin was empty' 'empty --token-stdin tested'
has tests/shell/verify-deployment-args.test.sh 'embedded newline' 'CRLF header-injection tested'
has tests/shell/verify-deployment-args.test.sh 'Unknown argument: --bogus' 'unknown-arg tested'
echo

echo "#223.4 - eval scoreThreshold deferral made actionable"
has evalite.config.ts 'DEFERRED, blocked on a baseline' 'deferral documented with steps'
echo

echo "#223.5 - mcp-stdio in coverage scope"
has vitest.config.ts "'mcp-stdio/**/*.ts'" 'coverage includes mcp-stdio'
has vitest.config.ts 'mcp-stdio/server.ts' 'entrypoint excluded'
echo

echo "#223.6 - flaky-timer guard"
has tests/unit/utils/token-store.test.ts 'vi.useRealTimers()' 'afterEach restores real timers'
echo

echo "zizmor - enforcing + pinned + findings clean"
has .github/workflows/ci.yml 'zizmor is now ENFORCING' 'zizmor flipped to a real gate'
has .github/workflows/ci.yml 'version: "1.25.2"' 'zizmor version pinned'
has .github/workflows/deploy.yml 'zizmor: ignore[cache-poisoning]' 'cache-poisoning annotated'
has .github/workflows/deploy.yml 'zizmor: ignore[superfluous-actions]' 'superfluous-actions annotated'
echo

echo "Local gates"
cmd_passes 'pnpm test:unit'  'unit suite passes (759+)'
cmd_passes 'pnpm typecheck'  'typecheck clean'
cmd_passes 'pnpm lint'       'lint clean'
cmd_passes 'bash tests/shell/verify-deployment-args.test.sh' 'shell arg tests pass'
cmd_passes 'uvx zizmor@1.25.2 --offline .github/workflows/' 'zizmor offline clean (needs uv)'
echo

echo "=============================================="
printf ' SUMMARY: %d passed, %d failed (of %d)\n' "$pass" "$fail" "$total"
if [ "$fail" -eq 0 ]; then
  echo ' RESULT: ALL GREEN  OK'
  exit 0
else
  echo ' RESULT: '"$fail"' problem(s) found  FAIL'
  exit 1
fi
