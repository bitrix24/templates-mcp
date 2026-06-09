#!/usr/bin/env bash
# scripts/manual-qa-pr5.sh — manual QA for PR-5 (operator docs for OAuth 2.0).
#
# PR-5 ships documentation only (README, docs/DEPLOYMENT.md, .env.example,
# compose comments, skill files). There is no runtime behaviour to smoke —
# so this check proves the DOCS are internally consistent and match the code
# they describe. It greps the tree; it changes nothing.
#
# Goal: run it, read ALL GREEN (or the list of mismatches), paste the output.
#
# Usage (from the repository root — the folder with docs/ and .env.example):
#   ./scripts/manual-qa-pr5.sh
set -uo pipefail

pass=0
fail=0
ok()  { printf '  [PASS] %s\n' "$1"; pass=$((pass + 1)); }
no()  { printf '  [FAIL] %s\n' "$1"; fail=$((fail + 1)); }

# has FILE TEXT MSG  — PASS when FILE contains the literal TEXT.
has() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else no "$3"; fi
}
# hasnt FILE TEXT MSG — PASS when FILE does NOT contain the literal TEXT.
hasnt() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then no "$3"; else ok "$3"; fi
}

echo "=================================================="
echo " PR-5 docs verification"
echo "=================================================="
if [ ! -f docs/DEPLOYMENT.md ] || [ ! -f .env.example ]; then
  echo "ERROR: run this from the repository ROOT (docs/DEPLOYMENT.md not found)."
  exit 2
fi
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?')"
echo

echo "1) ADMIN_TOKEN is forwarded into BOTH compose files (the round-1 blocker)"
has docker-compose.yml         'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'docker-compose.yml forwards ADMIN_TOKEN'
has docker-compose.example.yml 'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'docker-compose.example.yml forwards ADMIN_TOKEN'
echo

echo "2) All 7 OAuth env vars are documented in .env.example AND DEPLOYMENT.md"
for v in NUXT_BITRIX24_OAUTH_ENABLED NUXT_BITRIX24_OAUTH_CLIENT_ID NUXT_BITRIX24_OAUTH_CLIENT_SECRET \
         NUXT_BITRIX24_OAUTH_REDIRECT_URL NUXT_BITRIX24_OAUTH_SCOPE NUXT_BITRIX24_OAUTH_DB_DIR \
         NUXT_BITRIX24_OAUTH_ADMIN_TOKEN; do
  has .env.example       "$v" ".env.example: $v"
  has docs/DEPLOYMENT.md "$v" "DEPLOYMENT.md: $v"
done
echo

echo "3) The 'NUXT_MCP_AUTH_TOKEN bypassed' migration warning is in all 3 surfaces"
has README.md          'bypassed' 'README has the bypass warning'
has docs/DEPLOYMENT.md 'bypassed' 'DEPLOYMENT.md has the bypass warning'
has .env.example       'BYPASSED' '.env.example has the bypass warning'
echo

echo "4) Doc cross-links point at headings that actually exist"
has docs/DEPLOYMENT.md '## OAuth 2.0 multi-tenant (opt-in)'                       'DEPLOYMENT.md heading exists'
has README.md          '#### Multi-tenant OAuth 2.0 — per-user identity (opt-in)' 'README heading exists'
echo

echo "5) Variable count is correct (six, not five)"
has   docs/DEPLOYMENT.md 'The six vars below'  "says 'six vars'"
hasnt docs/DEPLOYMENT.md 'The five vars below' "no stale 'five vars'"
echo

echo "6) Stale staging language was removed (OAuth is landed, not 'coming')"
hasnt .env.example                             'Enable only AFTER PR-2c merges' '.env.example finalized'
hasnt docker-compose.yml                       'PR-2c lands'                     'compose comment finalized'
hasnt skills/manage-bx24-template-mcp/SKILL.md 'OAuth (Phase 3)'                 'SKILL.md finalized'
echo

echo "7) Rollout table marks PR-5 as landed (#219)"
has docs/OAUTH-DESIGN.md '| PR-5 | #219' 'OAUTH-DESIGN section 10 shows #219'
echo

echo "8) CHANGELOG has the OAuth entry"
has CHANGELOG.md 'OAuth 2.0 multi-tenant (opt-in' 'CHANGELOG entry present'
echo

echo "9) Manual-QA scaffold mirrors the OAuth vars (CI scaffold-sync gate)"
has skills/run-manual-qa/references/issue-scaffold.md 'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'issue-scaffold mirrors OAuth vars'
echo

echo "10) (optional) docker compose files still validate"
if command -v docker >/dev/null 2>&1; then
  if docker compose -f docker-compose.yml config >/dev/null 2>&1; then
    ok "docker-compose.yml valid"
  else
    no "docker-compose.yml INVALID"
  fi
  if docker compose -f docker-compose.example.yml config >/dev/null 2>&1; then
    ok "docker-compose.example.yml valid"
  else
    no "docker-compose.example.yml INVALID"
  fi
else
  echo "  [SKIP] docker not installed — compose validation skipped (not a failure)"
fi
echo

echo "=================================================="
echo " SUMMARY: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
  echo " RESULT: ALL GREEN  ✅"
else
  echo " RESULT: $fail problem(s) found  ❌"
fi
echo "=================================================="
if [ "$fail" -eq 0 ]; then
  exit 0
else
  exit 1
fi
