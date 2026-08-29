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
