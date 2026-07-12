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
