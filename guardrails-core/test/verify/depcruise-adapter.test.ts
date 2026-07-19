import { describe, expect, it } from 'vitest';

import { parseDepcruiseJson } from '../../src/verify/depcruise-adapter.js';

const forbiddenEdge = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/scope.ts',
        to: 'node:child_process',
        rule: { name: 'exec-seam', severity: 'error' },
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});

const circular = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/a.ts',
        to: 'guardrails-core/src/b.ts',
        rule: { name: 'no-circular', severity: 'error' },
        cycle: [
          { name: 'guardrails-core/src/b.ts' },
          { name: 'guardrails-core/src/a.ts' },
        ],
      },
    ],
    error: 1,
    warn: 0,
    info: 0,
  },
  modules: [],
});

const warnAndInfoSeverities = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/x.ts',
        to: 'guardrails-core/src/y.ts',
        rule: { name: 'a-warning', severity: 'warn' },
      },
      {
        from: 'guardrails-core/src/p.ts',
        to: 'guardrails-core/src/q.ts',
        rule: { name: 'some-advice', severity: 'info' },
      },
    ],
  },
  modules: [],
});

const mixedSeverity = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/ignored.ts',
        to: 'guardrails-core/src/target.ts',
        rule: { name: 'ignored-rule', severity: 'ignore' },
      },
      {
        from: 'guardrails-core/src/scope.ts',
        to: 'node:child_process',
        rule: { name: 'exec-seam', severity: 'error' },
      },
    ],
  },
  modules: [],
});

describe('parseDepcruiseJson', () => {
  it('maps a forbidden edge to a namespaced, non-fixable error violation', () => {
    const violations = parseDepcruiseJson(forbiddenEdge, '/repo');
    expect(violations).toHaveLength(1);
    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'dependency-cruiser/exec-seam',
        file: 'guardrails-core/src/scope.ts',
        severity: 'error',
        fixable: false,
        tool: 'dependency-cruiser',
      }),
    );
    expect(
      violations.every((violation) => violation.message.includes('exec-seam')),
    ).toBe(true);
    expect(
      violations.every((violation) =>
        violation.message.includes('node:child_process'),
      ),
    ).toBe(true);
    expect(violations.every((violation) => violation.line === undefined)).toBe(
      true,
    );
  });

  it('describes a circular violation with the cycle path', () => {
    const violations = parseDepcruiseJson(circular, '/repo');
    expect(violations).toHaveLength(1);
    expect(violations).toContainEqual(
      expect.objectContaining({ ruleId: 'dependency-cruiser/no-circular' }),
    );
    expect(
      violations.every((violation) =>
        violation.message.includes('Circular dependency'),
      ),
    ).toBe(true);
    expect(
      violations.every((violation) =>
        violation.message.includes('guardrails-core/src/a.ts'),
      ),
    ).toBe(true);
    expect(
      violations.every((violation) =>
        violation.message.includes('guardrails-core/src/b.ts'),
      ),
    ).toBe(true);
  });

  it('maps both warn and info severities to warn', () => {
    const violations = parseDepcruiseJson(warnAndInfoSeverities, '/repo');
    expect(violations).toHaveLength(2);
    expect(violations.every((violation) => violation.severity === 'warn')).toBe(
      true,
    );
    // Both source severities are exercised, not just one.
    expect(violations.map((violation) => violation.ruleId)).toEqual([
      'dependency-cruiser/a-warning',
      'dependency-cruiser/some-advice',
    ]);
  });

  it('drops ignore-severity violations, keeping only reportable ones', () => {
    const violations = parseDepcruiseJson(mixedSeverity, '/repo');
    expect(violations).toHaveLength(1);
    expect(violations).toContainEqual(
      expect.objectContaining({
        ruleId: 'dependency-cruiser/exec-seam',
        severity: 'error',
      }),
    );
  });

  it('passes packageId through when provided', () => {
    const violations = parseDepcruiseJson(
      forbiddenEdge,
      '/repo',
      'guardrails-core',
    );
    expect(violations).toHaveLength(1);
    expect(
      violations.every((violation) => violation.package === 'guardrails-core'),
    ).toBe(true);
  });

  it('returns [] for empty, malformed, or shapeless input', () => {
    expect(parseDepcruiseJson('', '/repo')).toEqual([]);
    expect(parseDepcruiseJson('not json', '/repo')).toEqual([]);
    expect(
      parseDepcruiseJson(JSON.stringify({ modules: [] }), '/repo'),
    ).toEqual([]);
  });
});
