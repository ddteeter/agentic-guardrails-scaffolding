import { describe, expect, it } from 'vitest';

import {
  hasErrors,
  isViolation,
  recurrenceKey,
  type Violation,
} from '../src/violation.js';

const base: Violation = {
  ruleId: 'ts/no-assertionless-test',
  file: 'src/foo.ts',
  message: 'Test has no assertions',
  severity: 'error',
  fixable: false,
  tool: 'eslint',
};

describe('isViolation', () => {
  it('accepts a well-formed violation', () => {
    expect(isViolation(base)).toBe(true);
  });

  it('accepts optional line and package', () => {
    expect(isViolation({ ...base, line: 42, package: 'packages/api' })).toBe(
      true,
    );
  });

  it('rejects a missing ruleId', () => {
    const { ruleId: _ruleId, ...rest } = base;
    expect(isViolation(rest)).toBe(false);
  });

  it('rejects an unknown severity', () => {
    expect(isViolation({ ...base, severity: 'fatal' })).toBe(false);
  });

  it('rejects a non-boolean fixable', () => {
    expect(isViolation({ ...base, fixable: 'yes' })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isViolation(null)).toBe(false);
    expect(isViolation('nope')).toBe(false);
  });
});

describe('relatedTests', () => {
  it('accepts a violation carrying the covering test files', () => {
    expect(isViolation({ ...base, relatedTests: ['test/a.test.ts'] })).toBe(
      true,
    );
  });

  it('rejects a relatedTests that is not an array of strings', () => {
    // Present-but-wrongly-typed is the case that matters: this field is read
    // straight out of a JSON manifest, and a fixer told its test lives at
    // `42` has been misled by the channel that exists to orient it.
    expect(isViolation({ ...base, relatedTests: 'test/a.test.ts' })).toBe(
      false,
    );
    expect(isViolation({ ...base, relatedTests: [42] })).toBe(false);
    // A MIXED array is the case that separates "every entry is a string" from
    // "some entry is": with `some`, this payload validates and the fixer is
    // handed `42` as a path to open.
    expect(isViolation({ ...base, relatedTests: ['test/a.test.ts', 42] })).toBe(
      false,
    );
  });

  it('accepts a violation with no relatedTests at all', () => {
    expect(isViolation(base)).toBe(true);
  });
});

describe('hasErrors', () => {
  it('is true when any violation is error severity', () => {
    expect(hasErrors([{ ...base, severity: 'warn' }, base])).toBe(true);
  });

  it('is false when all violations are warnings', () => {
    expect(hasErrors([{ ...base, severity: 'warn' }])).toBe(false);
  });

  it('is false for an empty set', () => {
    expect(hasErrors([])).toBe(false);
  });
});

describe('recurrenceKey', () => {
  it('is the bare ruleId in a single-repo layout', () => {
    expect(recurrenceKey(base)).toBe('ts/no-assertionless-test');
  });

  it('is namespaced by package in a workspace layout', () => {
    expect(recurrenceKey({ ...base, package: 'packages/api' })).toBe(
      'packages/api:ts/no-assertionless-test',
    );
  });
});

describe('isViolation field-by-field rejection', () => {
  // Each case violates EXACTLY ONE clause, so every clause is load-bearing:
  // bypassing any single one must let a bad violation through and fail here.
  const cases: [string, unknown][] = [
    ['null', null],
    ['a primitive', 'not-an-object'],
    ['an empty ruleId', { ...base, ruleId: '' }],
    ['a non-string ruleId', { ...base, ruleId: 7 }],
    ['an empty file', { ...base, file: '' }],
    ['a non-string file', { ...base, file: 7 }],
    ['a non-string message', { ...base, message: 7 }],
    ['an unknown severity', { ...base, severity: 'critical' }],
    ['a non-string severity', { ...base, severity: 7 }],
    ['a non-boolean fixable', { ...base, fixable: 'yes' }],
    ['a non-string tool', { ...base, tool: 7 }],
    ['a non-number line', { ...base, line: '42' }],
    ['a non-string package', { ...base, package: 7 }],
    ['a non-string guidance', { ...base, guidance: 7 }],
  ];

  for (const [label, value] of cases) {
    it(`rejects ${label}`, () => {
      expect(isViolation(value)).toBe(false);
    });
  }

  it('accepts an optional guidance path', () => {
    expect(isViolation({ ...base, guidance: 'docs/guardrails/x.md' })).toBe(
      true,
    );
  });
});
