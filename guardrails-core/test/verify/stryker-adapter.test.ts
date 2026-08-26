import { describe, expect, it } from 'vitest';

import { parseStrykerJson } from '../../src/verify/stryker-adapter.js';

const report = JSON.stringify({
  schemaVersion: '1.0',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/changed.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '1',
          mutatorName: 'ConditionalExpression',
          status: 'Survived',
          location: {
            start: { line: 12, column: 3 },
            end: { line: 12, column: 9 },
          },
        },
        {
          id: '2',
          mutatorName: 'BlockStatement',
          status: 'Killed',
          location: {
            start: { line: 20, column: 1 },
            end: { line: 22, column: 2 },
          },
        },
        {
          id: '3',
          mutatorName: 'ArithmeticOperator',
          status: 'NoCoverage',
          location: {
            start: { line: 30, column: 1 },
            end: { line: 30, column: 5 },
          },
        },
      ],
    },
    'src/untouched.ts': {
      language: 'typescript',
      source: '',
      mutants: [
        {
          id: '4',
          mutatorName: 'EqualityOperator',
          status: 'Survived',
          location: {
            start: { line: 5, column: 1 },
            end: { line: 5, column: 8 },
          },
        },
      ],
    },
  },
});

describe('parseStrykerJson', () => {
  it('emits one violation per Survived mutant in a changed file', () => {
    // No packageId argument: the exact-object match below asserts the
    // emitted violation carries no `package` key.
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toContainEqual({
      ruleId: 'stryker/survived',
      file: 'src/changed.ts',
      line: 12,
      message:
        'ConditionalExpression mutant survived — a test executes this line but does not assert its behavior',
      severity: 'error',
      fixable: false,
      tool: 'stryker',
    });
  });

  it('ignores Killed, NoCoverage, and survivors in unchanged files', () => {
    const result = parseStrykerJson(report, ['src/changed.ts']);
    expect(result).toHaveLength(1);
    expect(result.map((v) => v.line)).toEqual([12]);
  });

  it('adds the package id when given', () => {
    const result = parseStrykerJson(
      report,
      ['src/changed.ts'],
      'guardrails-core',
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        package: 'guardrails-core',
        ruleId: 'stryker/survived',
      }),
    );
  });

  it('returns [] on malformed or wrong-shaped JSON', () => {
    expect(parseStrykerJson('not json', ['src/changed.ts'])).toEqual([]);
    expect(parseStrykerJson('{"files":"nope"}', ['src/changed.ts'])).toEqual(
      [],
    );
  });
});
