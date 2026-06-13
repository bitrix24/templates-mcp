# scripts/manual-qa-pr229.ps1 - verify PR #229 (docs-225-audit-drift) round-2 state.
#
# Run from the repo root. Reports PASS/FAIL for each round-1 + round-2 fix.
# Windows PowerShell: .\scripts\manual-qa-pr229.ps1
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
Write-Host " PR #229 round-2 verification"
Write-Host "=================================================="
if (-not (Test-Path 'docs/ADDING-TOOLS.md')) { Write-Host "ERROR: run from repo ROOT."; exit 2 }
$branch = (git branch --show-current) 2>$null
Write-Host "Branch: $branch`n"

Write-Host "1) Round-1 doc-drift fixes still in place"
Hasnt 'docs/ADDING-TOOLS.md' 'useBitrix24()  '   'ADDING-TOOLS no longer teaches useBitrix24()'
Has   'docs/ADDING-TOOLS.md' 'useBitrix24Tenant()' 'ADDING-TOOLS teaches useBitrix24Tenant()'
Hasnt 'docs/ARCHITECTURE.md' 'Three today' 'ARCHITECTURE callsite count refreshed'
Has   'PROJECT-BRIEF.md'     'TypeScript 6.x' 'PROJECT-BRIEF: TS 6.x'
Has   'PROJECT-BRIEF.md'     'pnpm 11.x'      'PROJECT-BRIEF: pnpm 11.x'
Hasnt 'docs/RUNBOOK.md'      'applies a new `:latest` image' 'RUNBOOK: Watchtower description fixed'
Write-Host ""

Write-Host "2) Round-2 review fixes"
Hasnt 'docs/ARCHITECTURE.md' 'hand-maintained' 'ARCHITECTURE: no more "hand-maintained" contradiction'
Has   'docs/ARCHITECTURE.md' 'tools.tenant-guard.test.ts' 'ARCHITECTURE hot spot #2: tenant-guard test cited'
Hasnt 'skills/run-manual-qa/references/issue-scaffold.md' 'Node.js 20+' 'issue-scaffold: Node 20+ removed'
Has   'skills/run-manual-qa/references/issue-scaffold.md' 'Node.js 22+' 'issue-scaffold: Node 22+'
Hasnt 'skills/run-manual-qa/references/issue-scaffold.md' 'four §11 deny branches' 'issue-scaffold: "four deny" corrected to three'
Has   'skills/run-manual-qa/references/issue-scaffold.md' 'Three §11 deny branches' 'issue-scaffold: three §11 deny branches'
Hasnt 'skills/manage-bx24-template-mcp/SKILL.md' 'Watchtower (auto)' 'SKILL.md: Watchtower "auto" claim fixed'
Has   'skills/manage-bx24-template-mcp/SKILL.md' 'monitor-only' 'SKILL.md: monitor-only mentioned'
Write-Host ""

Write-Host "3) Last-reviewed stamps refreshed to 2026-06-13"
$skills = @(
  'skills/manage-bx24-template-mcp/SKILL.md',
  'skills/manage-bx24-template-mcp/adding-tools.md',
  'skills/manage-bx24-template-mcp/feedback.md',
  'skills/run-manual-qa/references/issue-scaffold.md'
)
foreach ($f in $skills) { Has $f '`Last reviewed: 2026-06-13`' "stamp on $f" }
Write-Host ""

Write-Host "4) New CI guard added"
if (Test-Path 'tests/unit/mcp-stdio/tools.tenant-guard.test.ts') { Ok 'tools.tenant-guard.test.ts present' }
else { No 'tools.tenant-guard.test.ts MISSING' }
Write-Host ""

Write-Host "5) Renovate carve-out for esbuild override"
Has 'renovate.json' 'security:overridden' 'renovate: security:overridden label exists'
Has 'renovate.json' '"esbuild"'           'renovate: esbuild rule exists'
Write-Host ""

Write-Host "6) CHANGELOG entries"
Has 'CHANGELOG.md' 'sweep of post-rollout audit drift (issue #225)' 'CHANGELOG: #225 entry'
Has 'CHANGELOG.md' 'GHSA-gv7w-rqvm-qjhr'                            'CHANGELOG: esbuild advisory referenced'
Write-Host ""

Write-Host "7) (optional) suite + typecheck + lint"
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  pnpm exec vitest run tests/unit/mcp-stdio/tools.tenant-guard.test.ts | Out-Null 2>$null
  if ($LASTEXITCODE -eq 0) { Ok 'guard test passes locally' } else { No 'guard test FAILS locally' }
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
