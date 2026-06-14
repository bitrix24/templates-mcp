# Round-2 QA verification for PR #232 (operator UX landing form +
# follow-up fixes from the 5-agent review). PowerShell mirror of
# manual-qa-pr232.sh — same coverage, identical exit semantics.
#
# Usage:  .\scripts\manual-qa-pr232.ps1
#
# Each Has/Hasnt call fails fast with a one-line reason if the anchor
# drifts. Exit code 0 == ALL GREEN.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$pass = 0
$fail = 0
$total = 0

function Has {
    param([string]$File, [string]$Needle, [string]$Label)
    $script:total++
    if ((Get-Content -Raw -LiteralPath $File) -like "*$Needle*") {
        Write-Host "  [PASS] $Label"
        $script:pass++
    }
    else {
        Write-Host "  [FAIL] $Label"
        Write-Host "         (file: $File)"
        Write-Host "         (looking for: $Needle)"
        $script:fail++
    }
}

function Hasnt {
    param([string]$File, [string]$Needle, [string]$Label)
    $script:total++
    if (-not ((Get-Content -Raw -LiteralPath $File) -like "*$Needle*")) {
        Write-Host "  [PASS] $Label"
        $script:pass++
    }
    else {
        Write-Host "  [FAIL] $Label"
        Write-Host "         (file: $File)"
        Write-Host "         (must NOT contain: $Needle)"
        $script:fail++
    }
}

function CmdPasses {
    param([string]$Cmd, [string]$Label)
    $script:total++
    $out = Invoke-Expression "$Cmd 2>&1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [PASS] $Label"
        $script:pass++
    }
    else {
        Write-Host "  [FAIL] $Label"
        Write-Host "         (cmd: $Cmd)"
        $script:fail++
    }
}

Write-Host '1) Shared HTML/header helpers extracted (#232 review I2)'
Has 'server/utils/oauth-html.ts' 'export function setAntiFramingHeaders' 'oauth-html exports setAntiFramingHeaders'
Has 'server/utils/oauth-html.ts' 'export function setHtmlResponseHeaders' 'oauth-html exports setHtmlResponseHeaders'
Has 'server/utils/oauth-html.ts' 'export function htmlEscape' 'oauth-html exports htmlEscape'
Has 'server/utils/oauth-html.ts' "'&#39;'" 'htmlEscape covers single-quote (#232 security N5)'
Has 'server/api/oauth/install.get.ts'  "from '~/server/utils/oauth-html'" 'install imports the shared helpers'
Has 'server/api/oauth/callback.get.ts' "from '~/server/utils/oauth-html'" 'callback imports the shared helpers'
Hasnt 'server/api/oauth/install.get.ts'  'function setAntiFramingHeaders' 'install has no local setAntiFramingHeaders'
Hasnt 'server/api/oauth/callback.get.ts' 'function setAntiFramingHeaders' 'callback has no local setAntiFramingHeaders'
Write-Host ''

Write-Host '2) h3 abstraction: setResponseStatus instead of event.node.res.statusCode (#232 review I1)'
Hasnt 'server/api/oauth/install.get.ts'  'event.node.res.statusCode' 'install uses h3 setResponseStatus'
Hasnt 'server/api/oauth/callback.get.ts' 'event.node.res.statusCode' 'callback uses h3 setResponseStatus'
Has   'server/api/oauth/install.get.ts'  'setResponseStatus'         'install imports setResponseStatus'
Has   'server/api/oauth/callback.get.ts' 'setResponseStatus'         'callback imports setResponseStatus'
Write-Host ''

Write-Host '3) Rate-limit middleware skips landing renders (#232 review I3 - F5 self-ban)'
Has 'server/middleware/oauth-rate-limit.ts' "url.searchParams.get('portal')" 'middleware peeks at portal param'
Has 'server/middleware/oauth-rate-limit.ts' 'F5-er can'                       'middleware comment explains the skip'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'landing render' 'unit test pins the skip behaviour'
Has 'tests/unit/middleware/oauth-rate-limit.test.ts' 'mixing landing renders and real submits' 'unit test mixes landing+submit'
Write-Host ''

Write-Host '4) install.get.ts JSDoc + CSP carve-out tightened'
Has 'server/api/oauth/install.get.ts' 'ERROR — clientId/redirect missing' 'JSDoc mentions not-configured event'
Has 'server/api/oauth/install.get.ts' 'INSTALL_PATH'                          'INSTALL_PATH constant used'
Has 'server/api/oauth/install.get.ts' 'formAction: INSTALL_PATH'               'form-action sized down from self to install path'
Hasnt 'server/api/oauth/install.get.ts' "form-action 'self'"                  'no form-action self in install handler'
Write-Host ''

Write-Host '5) Landing event payload now includes ip (#232 docs I4b)'
Has 'server/api/oauth/install.get.ts' 'ip: getRequestIP(event)'                'landing log carries ip'
Has 'docs/OAUTH-DESIGN.md' 'marketplace app id — public, not a secret' 'section-11 docs the new payload field'
Has 'docs/OAUTH-DESIGN.md' 'excluded from the per-IP rate-limit'           'section-11 docs the rate-limit skip'
Write-Host ''

Write-Host '6) Headers contract: section-3 + section-6 docs reflect JSON throws ALSO carry anti-framing'
Has 'docs/OAUTH-DESIGN.md' 'byte-identical JSON **body and status code**' 'section-3 calls out body+status guarantee'
Has 'docs/OAUTH-DESIGN.md' 'and a strict CSP, even on JSON throws'        'section-3 mentions extra response headers'
Has 'docs/DEPLOYMENT.md'   'now shows a small HTML landing form instead of redirecting' 'DEPLOYMENT step 5 warns operator'
Has 'docs/SECURITY.md'     'form-action /api/oauth/install'                'SECURITY notes the tightened directive'
Write-Host ''

Write-Host '7) New tests added (12 round-2 cases)'
Has 'tests/unit/api/oauth/install.test.ts' 'Accept: */*'                   'CLI default Accept */ * tested'
Has 'tests/unit/api/oauth/install.test.ts' 'XSS regression guard'         'malicious clientId tested'
Has 'tests/unit/api/oauth/install.test.ts' 'empty scope env falls back'    'empty scope fallback tested'
Has 'tests/unit/api/oauth/install.test.ts' 'F5 must not self-ban'          'landing rate-limit skip pinned at install level'
Has 'tests/unit/api/oauth/install.test.ts' 'q-factor not parsed'           'q-factor decision documented'
Has 'tests/unit/api/oauth/install.test.ts' 'PORTAL_ALLOW_LIST_RE.source'   'pattern test sources from regex'
Has 'tests/unit/api/oauth/install.test.ts' 'oauth.install.deny.portal-format' 'flag-gate positive assertion'
Write-Host ''

Write-Host '8) Local checks (typecheck + lint + focused tests)'
CmdPasses 'pnpm exec vitest run tests/unit/api/oauth tests/unit/middleware/oauth-rate-limit.test.ts' 'install + rate-limit tests pass'
CmdPasses 'pnpm typecheck' 'typecheck clean'
CmdPasses 'pnpm lint'      'lint clean'
Write-Host ''

Write-Host '=============================================='
Write-Host (' SUMMARY: {0} passed, {1} failed (of {2})' -f $pass, $fail, $total)
if ($fail -eq 0) {
    Write-Host ' RESULT: ALL GREEN  OK'
    exit 0
}
else {
    Write-Host (' RESULT: {0} problem(s) found  FAIL' -f $fail)
    exit 1
}
