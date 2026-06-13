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

Write-Host "1) Anti-framing on EVERY /api/oauth/callback response path (round-3)"
Has 'server/api/oauth/callback.get.ts' 'setAntiFramingHeaders'   'callback has the shared anti-framing helper (round-3)'
Has 'server/api/oauth/callback.get.ts' 'X-Frame-Options'         'callback sets X-Frame-Options'
Has 'server/api/oauth/callback.get.ts' 'DENY'                    'callback X-Frame-Options: DENY'
Has 'server/api/oauth/callback.get.ts' "frame-ancestors 'none'"  'callback CSP frame-ancestors none'
Has 'server/api/oauth/callback.get.ts' 'safeBearer'              'callback html-escapes the bearer (defence-in-depth)'
Write-Host ""

Write-Host "2) Per-IP rate limiter - install + callback (middleware)"
Has 'server/middleware/oauth-rate-limit.ts' 'oauth.install.deny.rate-limited'  'middleware logs the install deny event'
Has 'server/middleware/oauth-rate-limit.ts' 'oauth.callback.deny.rate-limited' 'middleware logs the callback deny event (round-3)'
Has 'server/middleware/oauth-rate-limit.ts' 'RATE-LIMITED'        'middleware emits shared errorCode RATE-LIMITED'
Has 'server/middleware/oauth-rate-limit.ts' 'maxPerWindow: 10'    'install limit is 10/min (headroom over the 5 CI probes)'
Has 'server/middleware/oauth-rate-limit.ts' 'maxPerWindow: 30'    'callback limit is 30/min (round-3)'
Has 'server/middleware/oauth-rate-limit.ts' 'retry-after'         'middleware sets Retry-After header'
Has 'server/middleware/oauth-rate-limit.ts' '<unknown>'           'unknown source-IP bucket documented'
Write-Host ""

Write-Host "3) Install-route log sanitiser (controls + Bidi + length cap)"
Has 'server/api/oauth/install.get.ts' 'u009f' 'install regex strips C1 range'
Has 'server/api/oauth/install.get.ts' 'u202e' 'install regex strips RTL bidi override (round-3)'
Has 'server/api/oauth/install.get.ts' 'ufeff' 'install regex strips zero-width / BOM (round-3)'
Has 'server/api/oauth/install.get.ts' 'Trojan Source' 'install comment cites Trojan Source threat (round-3)'
Has 'server/api/oauth/install.get.ts' 'slice(0, 253)' 'install caps the logged portal at 253 chars'
Has 'server/api/oauth/install.get.ts' "'cache-control', 'no-store'" 'install sets Cache-Control: no-store on every path (round-3)'
Write-Host ""

Write-Host "4) Per-tenant feedback quota (no cross-tenant starvation)"
Has 'server/utils/github-feedback.ts' 'consumeFeedbackQuota' 'consumeFeedbackQuota present'
Has 'server/utils/github-feedback.ts' 'memberId'             'quota keyed on the tenant memberId'
Has 'server/utils/github-feedback.ts' 'NOT true-LRU'         'eviction policy documented (fails-open)'
Write-Host ""

Write-Host "5) Docs / skills refreshed for the new surface"
Has 'skills/manage-bx24-template-mcp/feedback.md' 'per tenant'    'feedback skill: quota is per-tenant'
Has 'skills/manage-bx24-template-mcp/feedback.md' 'starve another' 'feedback skill: no cross-tenant starvation'
Has 'docs/OAUTH-DESIGN.md' 'RATE-LIMITED'                            'OAUTH-DESIGN section-11: RATE-LIMITED registered'
Has 'docs/OAUTH-DESIGN.md' 'oauth.callback.deny.rate-limited'        'OAUTH-DESIGN section-11: callback deny event listed (round-3)'
Has 'docs/OAUTH-DESIGN.md' 'SHARED by two distinct events'           'OAUTH-DESIGN section-11: shared errorCode note (round-3)'
Has 'docs/SECURITY.md' 'HTTP-surface hardening (issue #221)'         'SECURITY: threat model updated'
Has 'docs/SECURITY.md' 'on every response'                           'SECURITY: notes anti-framing on every path (round-3)'
Has 'docs/SECURITY.md' '30/min'                                      'SECURITY: callback rate limit doc (round-3)'
Has 'docs/SECURITY.md' 'observability--logging'                      'SECURITY: cross-references section-11 (round-3)'
Has 'skills/run-manual-qa/references/issue-scaffold.md' 'oauth.install.deny.rate-limited'  'issue-scaffold: install 429 deny branch'
Has 'skills/run-manual-qa/references/issue-scaffold.md' 'oauth.callback.deny.rate-limited' 'issue-scaffold: callback 429 deny branch (round-3)'
Has 'skills/run-manual-qa/references/issue-scaffold.md' '60-second sliding window'         'issue-scaffold: window semantics (round-3)'
Write-Host ""

Write-Host "6) Test coverage - round-2 + round-3"
Has 'tests/unit/api/oauth/install.test.ts'  'strips C0/C1/DEL control chars'        'install test: control-char strip (round-2)'
Has 'tests/unit/api/oauth/install.test.ts'  'Trojan Source defence'                 'install test: Bidi/zero-width strip (round-3)'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'toBe(60)'                     'rate-limit test: exact Retry-After pinned'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'i < 10'                       'rate-limit test: 11th refused (round-3 headroom upper bound)'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'callback path is rate-limited at 30/min' 'rate-limit test: callback path also limited (round-3)'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'INDEPENDENT'                  'rate-limit test: install + callback buckets independent (round-3)'
Has 'tests/unit/api/oauth/callback.test.ts' 'x-frame-options'                       'callback test: anti-framing header pins'
Has 'tests/unit/api/oauth/callback.test.ts' 'STATE-ROW-CORRUPT'                     'callback test: STATE-ROW-CORRUPT branch (round-3)'
Has 'tests/unit/api/oauth/callback.test.ts' 'anti-framing on every deny path'       'callback test: anti-framing on all deny paths (round-3)'
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
