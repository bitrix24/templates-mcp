# scripts/manual-qa-pr228.ps1 - verify PR #228 (oauth-221-http-hardening) state.
#
# Verifies the public-OAuth HTTP-surface hardening from issue #221 plus the
# round-2 review fixes. Source-level verifier: greps the repo and (optionally)
# runs the affected test files. No live server needed - run from the repo root.
#
# Windows PowerShell: .\scripts\manual-qa-pr228.ps1
# If the script is blocked: Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
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
Write-Host " PR #228 - OAuth HTTP-surface hardening (issue #221)"
Write-Host "=================================================="
if (-not (Test-Path 'docs/OAUTH-DESIGN.md')) { Write-Host "ERROR: run from repo ROOT."; exit 2 }
$branch = (git branch --show-current) 2>$null
Write-Host "Branch: $branch`n"

Write-Host "1) Anti-framing on the /api/oauth/callback HTML pages"
Has 'server/api/oauth/callback.get.ts' 'X-Frame-Options'         'callback sets X-Frame-Options'
Has 'server/api/oauth/callback.get.ts' 'DENY'                    'callback X-Frame-Options: DENY'
Has 'server/api/oauth/callback.get.ts' "frame-ancestors 'none'"  'callback CSP frame-ancestors none'
Has 'server/api/oauth/callback.get.ts' 'safeBearer'              'callback html-escapes the bearer (defence-in-depth)'
Write-Host ""

Write-Host "2) Per-IP install rate limiter (middleware)"
Has 'server/middleware/oauth-rate-limit.ts' 'oauth.install.deny.rate-limited' 'middleware logs the section-11 deny event'
Has 'server/middleware/oauth-rate-limit.ts' 'RATE-LIMITED'        'middleware emits errorCode RATE-LIMITED'
Has 'server/middleware/oauth-rate-limit.ts' 'MAX_PER_WINDOW = 10' 'limit is 10/min (headroom over the 5 CI probes)'
Has 'server/middleware/oauth-rate-limit.ts' 'retry-after'         'middleware sets Retry-After header'
Has 'server/middleware/oauth-rate-limit.ts' '<unknown>'           'unknown source-IP bucket documented'
Write-Host ""

Write-Host "3) Install-route log sanitiser (control chars + length cap)"
Has 'server/api/oauth/install.get.ts' 'U+0080-U+009F' 'install strips C1 controls (round-2)'
Has 'server/api/oauth/install.get.ts' 'u009f'         'install regex includes the C1 range'
Has 'server/api/oauth/install.get.ts' 'slice(0, 253)' 'install caps the logged portal at 253 chars'
Write-Host ""

Write-Host "4) Per-tenant feedback quota (no cross-tenant starvation)"
Has 'server/utils/github-feedback.ts' 'consumeFeedbackQuota' 'consumeFeedbackQuota present'
Has 'server/utils/github-feedback.ts' 'memberId'             'quota keyed on the tenant memberId'
Has 'server/utils/github-feedback.ts' 'NOT true-LRU'         'eviction policy documented (fails-open)'
Write-Host ""

Write-Host "5) Docs / skills refreshed for the new surface"
Has 'skills/manage-bx24-template-mcp/feedback.md' 'per tenant'    'feedback skill: quota is per-tenant'
Has 'skills/manage-bx24-template-mcp/feedback.md' 'starve another' 'feedback skill: no cross-tenant starvation'
Has 'docs/OAUTH-DESIGN.md' 'RATE-LIMITED'                    'OAUTH-DESIGN section-11: RATE-LIMITED registered'
Has 'docs/SECURITY.md' 'HTTP-surface hardening (issue #221)' 'SECURITY: threat model updated'
Has 'docs/SECURITY.md' 'except'                              'SECURITY: out-of-scope DoS carve-out'
Has 'skills/run-manual-qa/references/issue-scaffold.md' 'oauth.install.deny.rate-limited' 'issue-scaffold: 429 deny branch'
Write-Host ""

Write-Host "6) Round-2 test coverage added"
Has 'tests/unit/api/oauth/install.test.ts' 'strips C0/C1/DEL control chars' 'install test: control-char strip'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'toBe(60)' 'rate-limit test: exact Retry-After pinned'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'i < 6'    'rate-limit test: 6th probe asserted (headroom)'
Has 'tests/unit/api/oauth/callback.test.ts' 'x-frame-options'   'callback test: anti-framing header pins'
Write-Host ""

Write-Host "7) (optional) run the affected test files + typecheck + lint"
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm exec vitest run tests/unit/api/oauth/install.test.ts tests/unit/api/oauth/callback.test.ts tests/unit/middleware/oauth-rate-limit.test.ts | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok 'affected test files pass locally' } else { No 'affected test files FAIL locally' }
  pnpm typecheck | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok 'typecheck clean' } else { No 'typecheck FAILS' }
  pnpm lint | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok 'lint clean' } else { No 'lint FAILS' }
} else {
  Write-Host "  [SKIP] pnpm not installed - local checks skipped"
}
Write-Host ""

Write-Host "=================================================="
Write-Host " SUMMARY: $($script:pass) passed, $($script:fail) failed"
if ($script:fail -eq 0) { Write-Host ' RESULT: ALL GREEN'; exit 0 } else { Write-Host " RESULT: $($script:fail) problem(s) found"; exit 1 }
