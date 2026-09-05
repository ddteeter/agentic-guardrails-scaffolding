import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.fallow/',
      '**/*.config.js',
      '**/*.config.ts',
      // dependency-cruiser's hand-authored CommonJS config — a tool config like
      // the *.config.js/ts above, outside any tsconfig, so typed linting can't
      // parse it.
      '.dependency-cruiser.cjs',
      'scripts/**',
      // Self-contained knip drift-probe fixture (guardrails-core/test/drift/
      // registry.test.ts) — its own standalone project, deliberately outside
      // guardrails-core's tsconfig, so ESLint's typed linting can't parse it.
      'guardrails-core/test/drift/knip-fixture/**',
      // A git worktree checked out inside the repository is a whole second
      // checkout of it, carrying its own `eslint.config.js`. ESLint 10 resolves
      // config files per directory, so without this it LOADS those configs --
      // and an older one naming a rule id this major renamed (unicorn 74's
      // `prevent-abbreviations` -> `name-replacements`) fails the whole run
      // with a schema error pointing at a file that is not this checkout's.
      // Same untracked-but-not-ignored failure class as the nested-worktree
      // finding in plan.md; `verify` already drops violations resolving inside
      // a worktree, and this is the bare `eslint .` half of it.
      '.claude/worktrees/**',
      // Stryker's sandbox is a copy of the repo, worktrees and all.
      '.stryker-tmp/**',
    ],
  },

  // Base configs for all TS files
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  unicorn.configs['flat/recommended'],
  sonarjs.configs.recommended,

  // TypeScript parser options
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],

      // Allowlist common short names. Renamed from
      // `unicorn/prevent-abbreviations` in unicorn 74, which deprecated the old
      // id and moved the identical `allowList` option under the new one.
      'unicorn/name-replacements': [
        'error',
        {
          allowList: {
            args: true,
            env: true,
            fn: true,
            img: true,
            params: true,
            props: true,
            ref: true,
            src: true,
            str: true,
          },
        },
      ],

      // Null is used with JSON APIs and many SDKs
      'unicorn/no-null': 'off',

      // Enforce kebab-case filenames
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],

      // CLI entry points legitimately use process.exit
      'unicorn/no-process-exit': 'off',

      // Duplicates typescript-eslint's no-unused-vars
      'sonarjs/no-unused-vars': 'off',
      'sonarjs/unused-import': 'off',
      'sonarjs/no-dead-store': 'off',

      // Intentional shell-outs (child_process, etc.)
      'sonarjs/os-command': 'off',
      'sonarjs/no-os-command-from-path': 'off',

      // Non-security Math.random is fine
      'sonarjs/pseudo-random': 'off',

      // Boundary code with external tools, JSON.parse, and child_process
      // produces false positives on no-unsafe-* rules. Rely on explicit
      // runtime narrowing at boundaries instead.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'error',

      // Logging and string interpolation commonly include numbers/booleans
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Warn on unused vars; allow _ prefix for intentional
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files: relax some rules where fixtures need loose types, and enforce
  // that every test actually asserts something (a judgment-class house rule).
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    plugins: { vitest },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'vitest/expect-expect': 'error',

      // Both of the following arrived with eslint-plugin-unicorn 74 and are
      // right for `src/` (where they stay on at their defaults) and wrong for
      // test files. Relaxed HERE rather than repo-wide, deliberately.

      // `let subject; beforeEach(() => { subject = ... })` is how vitest sets
      // up per-test state; there is no other place to assign it. The rule flags
      // all 31 occurrences of the framework's own idiom.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // One level over the default 3, because `expect(await run(build(arg)))`
      // is the assertion idiom and naming an intermediate for each of 35 sites
      // adds noise without adding clarity. Four, not unlimited: a fifth level
      // is a fixture that wants a builder.
      'unicorn/max-nested-calls': ['error', { max: 4 }],
    },
  },

  // Prettier last — disables conflicting formatting rules
  eslintConfigPrettier,
);
