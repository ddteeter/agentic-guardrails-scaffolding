import { describe, expect, it } from 'vitest';

import { parseTscOutput } from '../../src/verify/tsc-adapter.js';

const root = '/repo';

describe('parseTscOutput', () => {
  it('maps a standard tsc diagnostic into a violation', () => {
    const out =
      "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(parseTscOutput(out, root)).toEqual([
      {
        ruleId: 'TS2322',
        file: 'src/foo.ts',
        line: 12,
        message: "Type 'string' is not assignable to type 'number'.",
        severity: 'error',
        fixable: false,
        tool: 'tsc',
      },
    ]);
  });

  it('parses multiple diagnostics and ignores summary lines', () => {
    const out = [
      "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      "src/b.ts(9,3): error TS7006: Parameter 'x' implicitly has an 'any' type.",
      '',
      'Found 2 errors in 2 files.',
    ].join('\n');
    const violations = parseTscOutput(out, root);
    expect(violations.map((v) => v.ruleId)).toEqual(['TS2304', 'TS7006']);
    expect(violations.map((v) => v.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('relativizes absolute paths against the repo root', () => {
    const out = '/repo/packages/api/src/x.ts(3,1): error TS2554: Expected 1.';
    expect(parseTscOutput(out, root)[0]?.file).toBe('packages/api/src/x.ts');
  });

  it('ignores indented related-information continuation lines', () => {
    // tsc --pretty false emits related info as extra lines that do not match
    // the `error TSxxxx` shape; they must not produce spurious violations.
    const out = [
      "src/a.ts(3,7): error TS2345: Argument of type 'A' is not assignable.",
      "src/a.ts(1,1): error TS6203: 'A' is declared here.",
      '  and is referenced above.',
    ].join('\n');
    const violations = parseTscOutput(out, root);
    expect(violations.map((v) => v.ruleId)).toEqual(['TS2345', 'TS6203']);
    expect(violations).toHaveLength(2);
  });

  it('returns an empty array when there are no diagnostics', () => {
    expect(parseTscOutput('', root)).toEqual([]);
    expect(parseTscOutput('\n\n', root)).toEqual([]);
  });

  it('carries the package id through when provided', () => {
    const out = "src/foo.ts(1,1): error TS2304: Cannot find name 'x'.";
    expect(parseTscOutput(out, root, 'packages/api')[0]?.package).toBe(
      'packages/api',
    );
  });
});
