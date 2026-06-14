# QA verification for the #222 + #223 + zizmor-enforcement PR. PowerShell
# mirror of manual-qa-222-223.sh. Covers the static anchor checks + the pnpm
# gates; the bash shell-test and the uvx-zizmor offline run are Linux/CI-only
# (Git-Bash / uv may be absent on Windows) and are reported as skipped here.
#
# Usage:  .\scripts\manual-qa-222-223.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$pass = 0
$fail = 0
$total = 0

function Has {
    param([string]$File, [string]$Needle, [string]$Label)
    $script:total++
    if ((Get-Content -Raw -LiteralPath $File) -like "*$Needle*") {
        Write-Host "  [PASS] $Label"; $script:pass++
    }
    else {
        Write-Host "  [FAIL] $Label"; Write-Host "         (file: $File)"; Write-Host "         (looking for: $Needle)"; $script:fail++
    }
}

function Hasnt {
    param([string]$File, [string]$Needle, [string]$Label)
    $script:total++
    if (-not ((Get-Content -Raw -LiteralPath $File) -like "*$Needle*")) {
        Write-Host "  [PASS] $Label"; $script:pass++
    }
    else {
        Write-Host "  [FAIL] $Label"; Write-Host "         (file: $File)"; Write-Host "         (must NOT contain: $Needle)"; $script:fail++
    }
}

function CmdPasses {
    param([string]$Cmd, [string]$Label)
    $script:total++
    Invoke-Expression "$Cmd 2>&1" | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  [PASS] $Label"; $script:pass++ }
    else { Write-Host "  [FAIL] $Label"; Write-Host "         (cmd: $Cmd)"; $script:fail++ }
}

Write-Host '#222.1 - cross-platform path-traversal guard in token-store'
Has 'server/utils/token-store.ts' 'split(/[/\\]/).some' 'resolveDbDir splits on both separators'
Write-Host ''

Write-Host '#222.2 - timingSafeEqual consolidated into one helper'
Has 'server/utils/auth-helpers.ts' 'export function timingSafeEqualStr' 'shared helper exists'
Has 'server/middleware/mcp-auth.ts'    'timingSafeEqualStr' 'mcp-auth imports the helper'
Has 'server/api/oauth/_health.get.ts'  'timingSafeEqualStr' '_health imports the helper'
Has 'server/api/oauth/callback.get.ts' 'timingSafeEqualStr' 'callback imports the helper'
Hasnt 'server/middleware/mcp-auth.ts'    'function timingSafeEqual(' 'mcp-auth has no local copy'
Hasnt 'server/api/oauth/_health.get.ts'  'function timingSafeEqual(' '_health has no local copy'
Hasnt 'server/api/oauth/callback.get.ts' 'function timingSafeEqual(' 'callback has no local copy'
Write-Host ''

Write-Host '#222.3 - stdio RuntimeConfig shim carries the 7 OAuth fields'
Has 'mcp-stdio/nuxt-shims.ts' 'bitrix24OauthEnabled: boolean' 'shim interface declares OAuth fields'
Has 'mcp-stdio/nuxt-shims.ts' 'bitrix24OauthAdminToken:' 'shim object sets OAuth fields'
Write-Host ''

Write-Host '#222.4 - findByBearerHash retained + documented'
Has 'server/utils/token-store.ts' 'RETENTION NOTE (issue #222)' 'retention rationale documented'
Write-Host ''

Write-Host '#222.5 - find-user throws on semantic-validation failure'
Has 'server/mcp/tools/users/find-user.ts' 'throw new Bitrix24ToolError' 'find-user throws Bitrix24ToolError'
Has 'server/mcp/tools/users/find-user.ts' 'Bitrix24ErrorCode.INVALID_INPUT' 'with INVALID_INPUT code'
Write-Host ''

Write-Host '#223.1 - distinct tenant-deleted refresh event + test'
Has 'server/utils/bitrix24-oauth.ts' 'oauth.refresh.fail.tenant-deleted' 'source emits distinct event'
Has 'tests/unit/utils/bitrix24-oauth.test.ts' 'deleted mid-flight' 'test covers the uninstall race'
Has 'docs/OAUTH-DESIGN.md' 'tenant-deleted' 'section-11 documents the new event'
Write-Host ''

Write-Host '#223.2 - refresh expires (unix ts) branch covered'
Has 'tests/unit/utils/bitrix24-oauth.test.ts' 'expires` (unix ts)' 'expires-branch test present'
Write-Host ''

Write-Host '#223.3 - shell-arg gaps covered (stdin / CRLF / unknown)'
Has 'tests/shell/verify-deployment-args.test.sh' 'stdin was empty' 'empty --token-stdin tested'
Has 'tests/shell/verify-deployment-args.test.sh' 'embedded newline' 'CRLF header-injection tested'
Has 'tests/shell/verify-deployment-args.test.sh' 'Unknown argument: --bogus' 'unknown-arg tested'
Write-Host ''

Write-Host '#223.4 - eval scoreThreshold deferral made actionable'
Has 'evalite.config.ts' 'DEFERRED, blocked on a baseline' 'deferral documented with steps'
Write-Host ''

Write-Host '#223.5 - mcp-stdio in coverage scope'
Has 'vitest.config.ts' "'mcp-stdio/**/*.ts'" 'coverage includes mcp-stdio'
Has 'vitest.config.ts' 'mcp-stdio/server.ts' 'entrypoint excluded'
Write-Host ''

Write-Host '#223.6 - flaky-timer guard'
Has 'tests/unit/utils/token-store.test.ts' 'vi.useRealTimers()' 'afterEach restores real timers'
Write-Host ''

Write-Host 'zizmor - enforcing + pinned + findings clean'
Has '.github/workflows/ci.yml' 'zizmor is now ENFORCING' 'zizmor flipped to a real gate'
Has '.github/workflows/ci.yml' 'version: "1.25.2"' 'zizmor version pinned'
Has '.github/workflows/deploy.yml' 'zizmor: ignore[cache-poisoning]' 'cache-poisoning annotated'
Has '.github/workflows/deploy.yml' 'zizmor: ignore[superfluous-actions]' 'superfluous-actions annotated'
Write-Host ''

Write-Host 'Local gates (pnpm)'
CmdPasses 'pnpm test:unit' 'unit suite passes (759+)'
CmdPasses 'pnpm typecheck' 'typecheck clean'
CmdPasses 'pnpm lint'      'lint clean'
Write-Host '  [SKIP] bash shell-arg tests + uvx zizmor offline run - Linux/CI only'
Write-Host ''

Write-Host '=============================================='
Write-Host (' SUMMARY: {0} passed, {1} failed (of {2})' -f $pass, $fail, $total)
if ($fail -eq 0) { Write-Host ' RESULT: ALL GREEN  OK'; exit 0 }
else { Write-Host (' RESULT: {0} problem(s) found  FAIL' -f $fail); exit 1 }
