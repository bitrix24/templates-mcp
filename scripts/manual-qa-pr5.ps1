# scripts/manual-qa-pr5.ps1 - manual QA for PR-5 (operator docs for OAuth 2.0).
#
# PR-5 ships documentation only. This check proves the docs are internally
# consistent and match the code they describe. It greps the tree; it changes
# nothing. Run it, read ALL GREEN (or the list of mismatches), paste the output.
#
# Usage (Windows PowerShell, from the repository ROOT - the folder with docs/
# and .env.example):
#     ./scripts/manual-qa-pr5.ps1
# If Windows blocks the script, run this once in the same window first:
#     Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
$script:pass = 0
$script:fail = 0
function Ok($m) { Write-Host "  [PASS] $m"; $script:pass++ }
function No($m) { Write-Host "  [FAIL] $m"; $script:fail++ }
function FileHas($file, $text) {
  if (-not (Test-Path $file)) { return $false }
  return [bool](Select-String -Path $file -SimpleMatch -Pattern $text -Quiet)
}
function Has($file, $text, $msg)   { if (FileHas $file $text) { Ok $msg } else { No $msg } }
function Hasnt($file, $text, $msg) { if (FileHas $file $text) { No $msg } else { Ok $msg } }

Write-Host "=================================================="
Write-Host " PR-5 docs verification"
Write-Host "=================================================="
if (-not (Test-Path 'docs/DEPLOYMENT.md') -or -not (Test-Path '.env.example')) {
  Write-Host "ERROR: run this from the repository ROOT (docs/DEPLOYMENT.md not found)."
  exit 2
}
$branch = (git branch --show-current) 2>$null
Write-Host "Branch: $branch`n"

Write-Host "1) ADMIN_TOKEN is forwarded into BOTH compose files (the round-1 blocker)"
Has 'docker-compose.yml'         'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'docker-compose.yml forwards ADMIN_TOKEN'
Has 'docker-compose.example.yml' 'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'docker-compose.example.yml forwards ADMIN_TOKEN'
Write-Host ""

Write-Host "2) All 7 OAuth env vars are documented in .env.example AND DEPLOYMENT.md"
$vars = @(
  'NUXT_BITRIX24_OAUTH_ENABLED','NUXT_BITRIX24_OAUTH_CLIENT_ID','NUXT_BITRIX24_OAUTH_CLIENT_SECRET',
  'NUXT_BITRIX24_OAUTH_REDIRECT_URL','NUXT_BITRIX24_OAUTH_SCOPE','NUXT_BITRIX24_OAUTH_DB_DIR',
  'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN'
)
foreach ($v in $vars) {
  Has '.env.example'       $v ".env.example: $v"
  Has 'docs/DEPLOYMENT.md' $v "DEPLOYMENT.md: $v"
}
Write-Host ""

Write-Host "3) The 'NUXT_MCP_AUTH_TOKEN bypassed' migration warning is in all 3 surfaces"
Has 'README.md'          'bypassed' 'README has the bypass warning'
Has 'docs/DEPLOYMENT.md' 'bypassed' 'DEPLOYMENT.md has the bypass warning'
Has '.env.example'       'BYPASSED' '.env.example has the bypass warning'
Write-Host ""

Write-Host "4) Doc cross-links point at headings that actually exist"
Has 'docs/DEPLOYMENT.md' '## OAuth 2.0 multi-tenant (opt-in)' 'DEPLOYMENT.md heading exists'
if (FileHas 'README.md' 'Multi-tenant OAuth 2.0') { Ok 'README heading exists' } else { No 'README heading missing' }
Write-Host ""

Write-Host "5) Variable count is correct (six, not five)"
Has   'docs/DEPLOYMENT.md' 'The six vars below'  "says 'six vars'"
Hasnt 'docs/DEPLOYMENT.md' 'The five vars below' "no stale 'five vars'"
Write-Host ""

Write-Host "6) Stale staging language was removed (OAuth is landed, not 'coming')"
Hasnt '.env.example'                             'Enable only AFTER PR-2c merges' '.env.example finalized'
Hasnt 'docker-compose.yml'                       'PR-2c lands'                     'compose comment finalized'
Hasnt 'skills/manage-bx24-template-mcp/SKILL.md' 'OAuth (Phase 3)'                 'SKILL.md finalized'
Write-Host ""

Write-Host "7) Rollout table marks PR-5 as landed (#219)"
Has 'docs/OAUTH-DESIGN.md' '| PR-5 | #219' 'OAUTH-DESIGN section 10 shows #219'
Write-Host ""

Write-Host "8) CHANGELOG has the OAuth entry"
Has 'CHANGELOG.md' 'OAuth 2.0 multi-tenant (opt-in' 'CHANGELOG entry present'
Write-Host ""

Write-Host "9) Manual-QA scaffold mirrors the OAuth vars (CI scaffold-sync gate)"
Has 'skills/run-manual-qa/references/issue-scaffold.md' 'NUXT_BITRIX24_OAUTH_ADMIN_TOKEN' 'issue-scaffold mirrors OAuth vars'
Write-Host ""

Write-Host "10) (optional) docker compose files still validate"
if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose -f docker-compose.yml config | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "docker-compose.yml valid" } else { No "docker-compose.yml INVALID" }
  docker compose -f docker-compose.example.yml config | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "docker-compose.example.yml valid" } else { No "docker-compose.example.yml INVALID" }
} else {
  Write-Host "  [SKIP] docker not installed - compose validation skipped (not a failure)"
}
Write-Host ""

Write-Host "=================================================="
Write-Host " SUMMARY: $($script:pass) passed, $($script:fail) failed"
if ($script:fail -eq 0) { Write-Host " RESULT: ALL GREEN" } else { Write-Host " RESULT: $($script:fail) problem(s) found" }
Write-Host "=================================================="
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
