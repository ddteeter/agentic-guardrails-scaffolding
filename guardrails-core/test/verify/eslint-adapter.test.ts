import { describe, expect, it } from 'vitest';

import { parseEslintJson } from '../../src/verify/eslint-adapter.js';

const root = '/repo';

const stdout = JSON.stringify([
  {
    filePath: '/repo/src/foo.ts',
    messages: [
      {
        ruleId: '@typescript-eslint/no-explicit-any',
        severity: 2,
        message: 'Unexpected any. Specify a different type.',
        line: 3,
        column: 10,
      },
      {
        ruleId: 'no-unused-vars',
        severity: 1,
        message: "'x' is defined but never used.",
        line: 5,
        column: 3,
        fix: { range: [10, 12], text: '' },
      },
    ],
  },
  {
    filePath: '/repo/src/bar.ts',
    messages: [],
  },
]);

describe('parseEslintJson', () => {
  it('maps eslint messages into normalized violations', () => {
    const violations = parseEslintJson(stdout, root);
    expect(violations).toEqual([
      {
        ruleId: '@typescript-eslint/no-explicit-any',
        file: 'src/foo.ts',
        line: 3,
        message: 'Unexpected any. Specify a different type.',
        severity: 'error',
        fixable: false,
        tool: 'eslint',
      },
      {
        ruleId: 'no-unused-vars',
        file: 'src/foo.ts',
        line: 5,
        message: "'x' is defined but never used.",
        severity: 'warn',
        fixable: true,
        tool: 'eslint',
      },
    ]);
  });

  it('treats a fixable message (has a fix) as autofix-class', () => {
    const [, warn] = parseEslintJson(stdout, root);
    expect(warn?.fixable).toBe(true);
  });

  it('maps a parse error (null ruleId) to a stable id', () => {
    const parseError = JSON.stringify([
      {
        filePath: '/repo/src/broken.ts',
        messages: [
          {
            ruleId: null,
            severity: 2,
            message: 'Parsing error: Unexpected token',
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    const violations = parseEslintJson(parseError, root);
    expect(violations[0]).toMatchObject({
      ruleId: 'eslint/parse-error',
      severity: 'error',
      fixable: false,
    });
  });

  it('returns an empty array for empty or non-JSON stdout', () => {
    expect(parseEslintJson('', root)).toEqual([]);
    expect(parseEslintJson('not json', root)).toEqual([]);
  });

  it('carries the package id through when provided', () => {
    const violations = parseEslintJson(stdout, root, 'packages/api');
    expect(violations[0]?.package).toBe('packages/api');
  });
});
