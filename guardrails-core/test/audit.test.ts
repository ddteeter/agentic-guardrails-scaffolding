import { describe, expect, it } from 'vitest';

import { auditDiff } from '../src/audit.js';

/** Build a minimal unified diff for one file with the given body lines. */
function diff(file: string, hunk: string, startLine = 1): string {
  const added = hunk.split('\n').length;
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${startLine},0 +${startLine},${added} @@`,
    hunk,
  ].join('\n');
}

describe('auditDiff', () => {
  it('returns no findings for a clean addition', () => {
    expect(auditDiff(diff('a.ts', '+  return user.id;'))).toEqual([]);
  });

  it('flags a newly-added eslint-disable', () => {
    const findings = auditDiff(
      diff('a.ts', '+  // eslint-disable-next-line no-console'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'a.ts', kind: 'eslint-disable' });
  });

  it('flags a newly-added @ts-expect-error / @ts-ignore', () => {
    expect(auditDiff(diff('a.ts', '+  // @ts-expect-error'))[0]?.kind).toBe(
      'ts-suppress',
    );
    expect(auditDiff(diff('a.ts', '+  // @ts-ignore'))[0]?.kind).toBe(
      'ts-suppress',
    );
  });

  it('flags an added `as any` cast', () => {
    expect(auditDiff(diff('a.ts', '+  const x = foo as any;'))[0]?.kind).toBe(
      'cast-any',
    );
    expect(
      auditDiff(diff('a.ts', '+  return bar as unknown as Baz;'))[0]?.kind,
    ).toBe('cast-any');
  });

  it('flags a skipped or focused test', () => {
    expect(
      auditDiff(diff('a.test.ts', "+  it.skip('x', () => {});"))[0]?.kind,
    ).toBe('skipped-test');
    expect(
      auditDiff(diff('a.test.ts', "+  describe.only('x', () => {});"))[0]?.kind,
    ).toBe('skipped-test');
    expect(
      auditDiff(diff('a.test.ts', "+  xit('x', () => {});"))[0]?.kind,
    ).toBe('skipped-test');
  });

  it('flags Java @SuppressWarnings and @Disabled', () => {
    expect(
      auditDiff(diff('A.java', '+  @SuppressWarnings("unchecked")'))[0]?.kind,
    ).toBe('suppress-warnings');
    expect(auditDiff(diff('A.java', '+  @Disabled'))[0]?.kind).toBe(
      'disabled-test',
    );
  });

  it('ignores suppressions on removed (-) lines — removing them is good', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-  const x = foo as any;',
      '+  const x = foo as Bar;',
    ].join('\n');
    expect(auditDiff(patch)).toEqual([]);
  });

  it('ignores the +++ file header line', () => {
    // The `+++ b/file` header must not be mistaken for an added line.
    expect(auditDiff(diff('as-any-helper.ts', '+  const ok = 1;'))).toEqual([]);
  });

  it('reports the correct new-file line number', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,3 @@',
      ' context line',
      '+  const x = foo as any;',
      ' another context',
    ].join('\n');
    // hunk starts at new line 10: context=10, added=11.
    expect(auditDiff(patch)[0]?.line).toBe(11);
  });

  it('collects findings across multiple files in one diff', () => {
    const patch = [
      diff('a.ts', '+  const x = foo as any;'),
      diff('B.java', '+  @Disabled'),
    ].join('\n');
    const kinds = auditDiff(patch).map((f) => f.kind);
    expect(kinds).toContain('cast-any');
    expect(kinds).toContain('disabled-test');
  });
});
