# scripts/manual-qa-pr2c.ps1 — manual QA for PR-2c (OAuth install/callback/health surface).
#
# Goal: prove the new OAuth surface gates correctly under BOTH configurations
# without needing a real Bitrix24 portal.
#
#   - Scenario A — NUXT_BITRIX24_OAUTH_ENABLED=false (production default):
#                  every OAuth endpoint refuses with 503 FLAG-OFF;
#                  /api/health stays 200.
#   - Scenario B — NUXT_BITRIX24_OAUTH_ENABLED=true + dummy CLIENT_ID +
#                  REDIRECT_URL: install/callback/_health gates work per
#                  OAUTH-DESIGN.md §11; happy install → 302 + CSRF cookie.
#
# Usage:
#   1. Boot the app locally (pnpm dev OR docker compose up).
#   2. (Optional) `$env:MCP_BASE = "http://localhost:3000"` to override URL.
#   3. .\scripts\manual-qa-pr2c.ps1
#
# Detects scenario automatically via /api/oauth/install probe.

$ErrorActionPreference = "Continue"
$Base = if ($env:MCP_BASE) { $env:MCP_BASE } else { "http://localhost:3000" }
$script:Pass = 0
$script:Fail = 0

function Green([string]$msg) {
  Write-Host "✓ " -ForegroundColor Green -NoNewline
  Write-Host $msg
  $script:Pass++
}
function Red([string]$msg) {
  Write-Host "✗ " -ForegroundColor Red -NoNewline
  Write-Host $msg
  $script:Fail++
}

function Invoke-Probe([string]$url) {
  try {
    $resp = Invoke-WebRequest -Uri $url -Method Get -SkipHttpErrorCheck -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
    return @{ Status = $resp.StatusCode; Body = $resp.Content; Headers = $resp.Headers }
  } catch {
    return @{ Status = 0; Body = ""; Headers = @{} }
  }
}

function Assert-Status([string]$name, [int]$expected, [string]$url) {
  $r = Invoke-Probe $url
  if ($r.Status -eq $expected) {
    Green "$name → $expected"
  } else {
    Red "$name → expected $expected, got $($r.Status) ($url)"
  }
}

function Assert-ErrorCode([string]$name, [string]$code, [string]$url) {
  $r = Invoke-Probe $url
  if ($r.Body -match """errorCode"":""$code""") {
    Green "$name → errorCode=$code"
  } else {
    $preview = if ($r.Body.Length -gt 200) { $r.Body.Substring(0, 200) } else { $r.Body }
    Red "$name → expected errorCode=$code, body was: $preview"
  }
}

Write-Host "=== PR-2c manual QA against $Base ==="
Write-Host ""

# Detect scenario.
$probe = Invoke-Probe "$Base/api/oauth/install"
$body = $probe.Body

if ($body -match '"errorCode":"FLAG-OFF"') {
  Write-Host "Detected: Scenario A — NUXT_BITRIX24_OAUTH_ENABLED=false (default)"
  Write-Host ""

  Write-Host "--- Webhook flow unchanged ---"
  Assert-Status "GET /api/health" 200 "$Base/api/health"

  Write-Host ""
  Write-Host "--- OAuth endpoints refuse with FLAG-OFF ---"
  Assert-ErrorCode "/api/oauth/install (any portal)" "FLAG-OFF" "$Base/api/oauth/install?portal=acme.bitrix24.com"
  Assert-ErrorCode "/api/oauth/callback (any params)" "FLAG-OFF" "$Base/api/oauth/callback?code=x&state=y"
  Assert-ErrorCode "/api/oauth/_health" "FLAG-OFF" "$Base/api/oauth/_health"

} elseif ($body -match '"errorCode":"NOT-CONFIGURED"') {
  Write-Host "Detected: Scenario C — flag ON but CLIENT_ID/REDIRECT_URL missing"
  Write-Host ""
  Assert-ErrorCode "/api/oauth/install (any portal, no config)" "NOT-CONFIGURED" "$Base/api/oauth/install?portal=acme.bitrix24.com"
  Write-Host "  → Fix: set NUXT_BITRIX24_OAUTH_CLIENT_ID and _REDIRECT_URL."

} elseif ($body -match '"errorCode":"PORTAL-FORMAT"') {
  Write-Host "Detected: Scenario B — NUXT_BITRIX24_OAUTH_ENABLED=true, configured"
  Write-Host ""

  Write-Host "--- Portal allow-list rejection ---"
  Assert-ErrorCode "install with evil.example.com" "PORTAL-FORMAT" "$Base/api/oauth/install?portal=evil.example.com"
  Assert-ErrorCode "install with unlisted TLD (.us)" "PORTAL-FORMAT" "$Base/api/oauth/install?portal=acme.bitrix24.us"
  Assert-ErrorCode "install with no portal" "PORTAL-FORMAT" "$Base/api/oauth/install"

  Write-Host ""
  Write-Host "--- Happy-path install (302 + CSRF cookie) ---"
  $install = Invoke-Probe "$Base/api/oauth/install?portal=acme.bitrix24.com"
  if ($install.Status -eq 302) {
    Green "install with acme.bitrix24.com → 302"
    $location = $install.Headers["Location"]
    if ($location -match "acme\.bitrix24\.com/oauth/authorize/") {
      Green "  Location → https://acme.bitrix24.com/oauth/authorize/..."
    } else {
      Red "  Location header missing or wrong (got: $location)"
    }
    $cookies = $install.Headers["Set-Cookie"]
    if ($cookies -is [Array]) { $cookies = $cookies -join "; " }
    if ($cookies -match "bx24_oauth_csrf=") {
      Green "  Set-Cookie: bx24_oauth_csrf=... set"
    } else {
      Red "  Set-Cookie bx24_oauth_csrf missing"
    }
    if ($cookies -match "(?i)httponly") {
      Green "  Cookie HttpOnly"
    } else {
      Red "  Cookie HttpOnly attribute missing"
    }
    if ($cookies -match "(?i)samesite=lax") {
      Green "  Cookie SameSite=Lax"
    } else {
      Red "  Cookie SameSite=Lax attribute missing"
    }
  } else {
    Red "install with acme.bitrix24.com → expected 302, got $($install.Status)"
  }

  Write-Host ""
  Write-Host "--- Callback gates ---"
  Assert-ErrorCode "callback with no code" "PARAMS-MISSING" "$Base/api/oauth/callback?state=somestate"
  Assert-ErrorCode "callback with no state" "PARAMS-MISSING" "$Base/api/oauth/callback?code=somecode"
  Assert-ErrorCode "callback with unknown state" "STATE-MISSING" "$Base/api/oauth/callback?code=x&state=$(('0' * 32))"

  Write-Host ""
  Write-Host "--- /mcp Bearer auth (PR #217 — the last wire) ---"
  $mcp = Invoke-Probe "$Base/mcp"
  if ($mcp.Status -eq 401) {
    Green "/mcp without Bearer -> 401"
  } else {
    Red "/mcp without Bearer -> expected 401, got $($mcp.Status)"
  }
  $wwwAuth = $mcp.Headers["WWW-Authenticate"]
  if ($wwwAuth -match 'BEARER-UNKNOWN') {
    Green "  WWW-Authenticate carries errorCode=BEARER-UNKNOWN"
  } else {
    Red "  WWW-Authenticate missing or wrong errorCode"
  }

  Write-Host ""
  Write-Host "--- /api/oauth/_health gates ---"
  $health = Invoke-Probe "$Base/api/oauth/_health"
  switch ($health.Status) {
    200 {
      if ($health.Body -match '"enabled":true') {
        Green "_health (no admin token, localhost) → 200 + enabled=true"
      } else {
        Red "_health 200 but body shape unexpected: $($health.Body)"
      }
    }
    401 {
      if ($health.Body -match "ADMIN-TOKEN") {
        Green "_health (admin token configured) → 401 ADMIN-TOKEN-MISSING"
      } else {
        Red "_health 401 but body unexpected: $($health.Body)"
      }
    }
    default {
      Red "_health → unexpected status $($health.Status) (body: $($health.Body))"
    }
  }

} else {
  $preview = if ($body.Length -gt 200) { $body.Substring(0, 200) } else { $body }
  Red "Could not detect scenario — /api/oauth/install returned: $preview"
  Write-Host "Is the server running on $Base?"
  exit 2
}

Write-Host ""
Write-Host "=== Result: $script:Pass passed, $script:Fail failed ==="
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
