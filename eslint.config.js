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
      'scripts/**',
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

      // Allowlist common short names
      'unicorn/prevent-abbreviations': [
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
    },
  },

  // Prettier last — disables conflicting formatting rules
  eslintConfigPrettier,
);
