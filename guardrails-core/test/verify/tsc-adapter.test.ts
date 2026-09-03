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

  it('parses a path that itself contains a (line,col)-shaped segment', () => {
    // Greedy match must anchor on the FINAL `(line,col): error`, not the first
    // parenthesized group inside the path (e.g. a "Foo (1,2)" directory).
    const out = 'src/dir (1,2)/foo.ts(3,7): error TS2322: nope.';
    expect(parseTscOutput(out, root)[0]).toMatchObject({
      file: 'src/dir (1,2)/foo.ts',
      line: 3,
      ruleId: 'TS2322',
    });
  });

  it('returns an empty array when there are no diagnostics', () => {
    expect(parseTscOutput('', root)).toEqual([]);
    expect(parseTscOutput('\n\n', root)).toEqual([]);
  });

  it('parses a diagnostic with a multi-digit column number', () => {
    // The column group is `\d+` (one or more digits) but never captured, so a
    // narrowed `\d` (single digit) fails to match once the column reaches two
    // digits — this pins the `+` quantifier.
    const out = 'src/foo.ts(100,42): error TS2554: Expected 1 argument.';
    expect(parseTscOutput(out, root)).toEqual([
      {
        ruleId: 'TS2554',
        file: 'src/foo.ts',
        line: 100,
        message: 'Expected 1 argument.',
        severity: 'error',
        fixable: false,
        tool: 'tsc',
      },
    ]);
  });

  it('does not match a line with a stray trailing carriage return', () => {
    // `stdout.split('\n')` can leave a trailing '\r' from CRLF output; `.`
    // never matches a line terminator (including '\r'), so the trailing `$`
    // anchor correctly fails to match here — this pins the `$` anchor.
    const out = 'src/foo.ts(1,1): error TS2304: msg\r';
    expect(parseTscOutput(out, root)).toEqual([]);
  });

  it('does not match a diagnostic preceded by unanchored content containing a carriage return', () => {
    // The leading `^` anchor forces the match to start at index 0; a '\r'
    // before the diagnostic blocks the greedy `.+` from reaching across it to
    // find a match starting later — this pins the `^` anchor.
    const out = 'prefix\rsrc/foo.ts(1,1): error TS2304: msg';
    expect(parseTscOutput(out, root)).toEqual([]);
  });
});
