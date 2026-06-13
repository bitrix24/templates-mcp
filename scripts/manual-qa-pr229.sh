#!/usr/bin/env bash
# scripts/manual-qa-pr229.sh — verify PR #229 (docs-225-audit-drift) round-2 state.
#
# Run from the repo root. Reports PASS/FAIL for each round-1 + round-2 fix.
# Linux/macOS/WSL: bash scripts/manual-qa-pr229.sh
#
# shellcheck disable=SC2016
# (Single-quoted literals are intentional — they're the EXACT strings we grep
# for in the project files, e.g. '`Last reviewed: 2026-06-13`'.)
set -uo pipefail
pass=0
fail=0
ok() { printf '  [PASS] %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  [FAIL] %s\n' "$1"; fail=$((fail + 1)); }
has() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else no "$3"; fi
}
hasnt() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then no "$3"; else ok "$3"; fi
}

echo "=================================================="
echo " PR #229 round-2 verification"
echo "=================================================="
if [ ! -f docs/ADDING-TOOLS.md ]; then echo "ERROR: run from repo ROOT."; exit 2; fi
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?')"
echo

echo "1) Round-1 doc-drift fixes still in place"
hasnt docs/ADDING-TOOLS.md 'useBitrix24()  ' 'ADDING-TOOLS no longer teaches useBitrix24()'
has   docs/ADDING-TOOLS.md 'useBitrix24Tenant()' 'ADDING-TOOLS teaches useBitrix24Tenant()'
hasnt docs/ARCHITECTURE.md 'Three today' 'ARCHITECTURE callsite count refreshed'
has   PROJECT-BRIEF.md     'TypeScript 6.x' 'PROJECT-BRIEF: TS 6.x'
has   PROJECT-BRIEF.md     'pnpm 11.x'      'PROJECT-BRIEF: pnpm 11.x'
hasnt docs/RUNBOOK.md      'applies a new `:latest` image' 'RUNBOOK: Watchtower description fixed'
echo

echo "2) Round-2 review fixes"
hasnt docs/ARCHITECTURE.md 'hand-maintained' 'ARCHITECTURE: no more "hand-maintained" contradiction'
has   docs/ARCHITECTURE.md 'tools.tenant-guard.test.ts' 'ARCHITECTURE hot spot #2: tenant-guard test cited'
hasnt skills/run-manual-qa/references/issue-scaffold.md 'Node.js 20+' 'issue-scaffold: Node 20+ removed'
has   skills/run-manual-qa/references/issue-scaffold.md 'Node.js 22+' 'issue-scaffold: Node 22+'
hasnt skills/run-manual-qa/references/issue-scaffold.md 'four §11 deny branches' 'issue-scaffold: "four deny" corrected to three'
has   skills/run-manual-qa/references/issue-scaffold.md 'Three §11 deny branches' 'issue-scaffold: three §11 deny branches'
hasnt skills/manage-bx24-template-mcp/SKILL.md 'Watchtower (auto)' 'SKILL.md: Watchtower "auto" claim fixed'
has   skills/manage-bx24-template-mcp/SKILL.md 'monitor-only' 'SKILL.md: monitor-only mentioned'
echo

echo "3) Last-reviewed stamps refreshed to 2026-06-13"
for f in skills/manage-bx24-template-mcp/SKILL.md \
         skills/manage-bx24-template-mcp/adding-tools.md \
         skills/manage-bx24-template-mcp/feedback.md \
         skills/run-manual-qa/references/issue-scaffold.md; do
  has "$f" '`Last reviewed: 2026-06-13`' "stamp on $f"
done
echo

echo "4) New CI guard added"
if [ -f tests/unit/mcp-stdio/tools.tenant-guard.test.ts ]; then
  ok "tools.tenant-guard.test.ts present"
else
  no "tools.tenant-guard.test.ts MISSING"
fi
echo

echo "5) Renovate carve-out for esbuild override"
has renovate.json 'security:overridden' 'renovate: security:overridden label exists'
has renovate.json '"esbuild"'           'renovate: esbuild rule exists'
echo

echo "6) CHANGELOG entries"
has CHANGELOG.md 'sweep of post-rollout audit drift (issue #225)' 'CHANGELOG: #225 entry'
has CHANGELOG.md 'GHSA-gv7w-rqvm-qjhr'                            'CHANGELOG: esbuild advisory referenced'
echo

echo "7) (optional) suite + typecheck + lint"
if command -v pnpm >/dev/null 2>&1; then
  if pnpm exec vitest run tests/unit/mcp-stdio/tools.tenant-guard.test.ts >/dev/null 2>&1; then
    ok "guard test passes locally"
  else
    no "guard test FAILS locally"
  fi
  if pnpm typecheck >/dev/null 2>&1; then ok "typecheck clean"; else no "typecheck FAILS"; fi
  if pnpm lint >/dev/null 2>&1; then ok "lint clean"; else no "lint FAILS"; fi
else
  echo "  [SKIP] pnpm not installed — local checks skipped"
fi
echo

echo "=================================================="
echo " SUMMARY: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
  echo " RESULT: ALL GREEN  ✅"
  exit 0
else
  echo " RESULT: $fail problem(s) found  ❌"
  exit 1
fi
