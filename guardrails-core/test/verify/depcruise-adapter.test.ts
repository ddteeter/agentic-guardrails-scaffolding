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

const infoSeverity = JSON.stringify({
  summary: {
    violations: [
      {
        from: 'guardrails-core/src/x.ts',
        to: 'guardrails-core/src/y.ts',
        rule: { name: 'some-advice', severity: 'info' },
      },
    ],
  },
  modules: [],
});

describe('parseDepcruiseJson', () => {
  it('maps a forbidden edge to a namespaced, non-fixable error violation', () => {
    const [v] = parseDepcruiseJson(forbiddenEdge, '/repo');
    expect(v).toMatchObject({
      ruleId: 'dependency-cruiser/exec-seam',
      file: 'guardrails-core/src/scope.ts',
      severity: 'error',
      fixable: false,
      tool: 'dependency-cruiser',
    });
    expect(v.message).toContain('exec-seam');
    expect(v.message).toContain('node:child_process');
    expect(v.line).toBeUndefined();
  });

  it('describes a circular violation with the cycle path', () => {
    const [v] = parseDepcruiseJson(circular, '/repo');
    expect(v.ruleId).toBe('dependency-cruiser/no-circular');
    expect(v.message).toContain('Circular dependency');
    expect(v.message).toContain('guardrails-core/src/a.ts');
    expect(v.message).toContain('guardrails-core/src/b.ts');
  });

  it('maps info/warn severities to warn', () => {
    const [v] = parseDepcruiseJson(infoSeverity, '/repo');
    expect(v.severity).toBe('warn');
  });

  it('passes packageId through when provided', () => {
    const [v] = parseDepcruiseJson(forbiddenEdge, '/repo', 'guardrails-core');
    expect(v.package).toBe('guardrails-core');
  });

  it('returns [] for empty, malformed, or shapeless input', () => {
    expect(parseDepcruiseJson('', '/repo')).toEqual([]);
    expect(parseDepcruiseJson('not json', '/repo')).toEqual([]);
    expect(
      parseDepcruiseJson(JSON.stringify({ modules: [] }), '/repo'),
    ).toEqual([]);
  });
});
