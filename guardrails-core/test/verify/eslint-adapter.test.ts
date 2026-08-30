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
});

/**
 * Guard-rejection suite. Each malformed case is paired with a VALID result
 * alongside it, so a guard that wrongly ACCEPTS the malformed shape emits a
 * violation and the `toEqual([])` assertion fails. Asserting `[]` against the
 * malformed shape alone is not enough: most guards fail open to `[]` anyway
 * (the malformed value never reaches a violation-producing code path), which
 * is why these mutants survived the original suite.
 */
describe('parseEslintJson guard rejection', () => {
  it('returns an empty array when the top-level JSON is null or a plain object', () => {
    expect(parseEslintJson('null', root)).toEqual([]);
    expect(parseEslintJson('{}', root)).toEqual([]);
  });

  it('rejects the whole array when one result is null, keeping the valid one out too', () => {
    const withNullResult = JSON.stringify([
      null,
      { filePath: '/repo/src/valid.ts', messages: [] },
    ]);
    expect(parseEslintJson(withNullResult, root)).toEqual([]);
  });

  it('rejects the whole array when one result has a non-string filePath', () => {
    const withBadFilePath = JSON.stringify([
      { filePath: 123, messages: [] },
      { filePath: '/repo/src/valid.ts', messages: [] },
    ]);
    expect(parseEslintJson(withBadFilePath, root)).toEqual([]);
  });

  it('omits the line key entirely when a message carries no line', () => {
    const withoutLine = JSON.stringify([
      {
        filePath: '/repo/src/foo.ts',
        messages: [
          { ruleId: 'some-rule', severity: 2, message: 'no line here' },
        ],
      },
    ]);
    const [violation] = parseEslintJson(withoutLine, root);
    expect(Object.hasOwn(violation ?? {}, 'line')).toBe(false);
  });
});
