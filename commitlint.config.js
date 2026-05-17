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
      ],
    ],
    'header-max-length': [2, 'always', 120],
  },
}
