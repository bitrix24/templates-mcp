/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'chore', 'test', 'refactor', 'ci', 'perf', 'build', 'revert'],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'tools',
        'client',
        'auth',
        'security',
        'deploy',
        'evals',
        'skill',
        'feedback',
        'deps',
        'docs',
        'ci',
        'tsconfig',
        'lint',
        'types',
        'test',
        // app/* — Nuxt frontend (landing page, future client UI).
        'app',
        // mcp-stdio/* — DXT bundle (Claude-Desktop-installable stdio
        // transport built alongside the HTTP server). First-class
        // packaging shape; see docs/ARCHITECTURE.md.
        'dxt',
        // server/utils/* — shared helpers (sdk-helpers, wire-coerce,
        // v3-filter, define-action-tool, task-lifecycle, checklist, …)
        // get their own scope. Submodule-level scopes (sdk-helpers etc.)
        // are intentionally NOT separate entries — keeping a single
        // `utils` scope matches the broad-scope convention used by the
        // rest of the enum (tools/client/auth/…).
        'utils',
      ],
    ],
    'header-max-length': [2, 'always', 120],
  },
}
