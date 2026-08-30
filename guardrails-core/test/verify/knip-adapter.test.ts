import { describe, expect, it } from 'vitest';

import { parseKnipJson } from '../../src/verify/knip-adapter.js';

const root = '/repo';

const stdout = JSON.stringify({
  issues: [
    {
      file: 'src/orphan.ts',
      files: [{ name: 'src/orphan.ts' }],
      exports: [],
      types: [],
      dependencies: [],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
    {
      file: 'src/index.ts',
      files: [],
      exports: [{ name: 'unusedExport', line: 2, col: 17, pos: 53 }],
      types: [{ name: 'UnusedType', line: 3, col: 13, pos: 94 }],
      dependencies: [{ name: 'left-pad' }],
      devDependencies: [],
      optionalPeerDependencies: [],
      unlisted: [],
      unresolved: [],
      binaries: [],
      duplicates: [],
      enumMembers: [],
      namespaceMembers: [],
      catalog: [],
    },
  ],
});

describe('parseKnipJson', () => {
  it('maps a fully-unused file to knip/files with no line', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/files',
      file: 'src/orphan.ts',
      message: 'Unused file',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('maps unused exports and types with their line numbers', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/exports',
      file: 'src/index.ts',
      line: 2,
      message: 'Unused export: unusedExport',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
    expect(violations).toContainEqual({
      ruleId: 'knip/types',
      file: 'src/index.ts',
      line: 3,
      message: 'Unused type: UnusedType',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('maps an unused dependency with no line', () => {
    const violations = parseKnipJson(stdout, root);
    expect(violations).toContainEqual({
      ruleId: 'knip/dependencies',
      file: 'src/index.ts',
      message: 'Unused dependency: left-pad',
      severity: 'error',
      fixable: false,
      tool: 'knip',
    });
  });

  it('never marks a knip violation fixable', () => {
    const violations = parseKnipJson(stdout, root);
    // `!v.fixable`, not `=== false`: `fixable` is a required `boolean`, so the
    // repo's no-unnecessary-boolean-literal-compare rule autofixes `=== false`
    // → `!`, and for a boolean the two are equivalent. The exact `fixable: false`
    // literal is pinned by the `toContainEqual` cases above.
    expect(violations.every((v) => !v.fixable)).toBe(true);
  });

  it('returns [] on empty or malformed stdout', () => {
    expect(parseKnipJson('', root)).toEqual([]);
    expect(parseKnipJson('not json', root)).toEqual([]);
    expect(parseKnipJson('{}', root)).toEqual([]);
  });
});

/**
 * Guard-rejection suite. Each malformed case is paired with a VALID issue or
 * entry alongside it, so a guard that wrongly ACCEPTS the malformed shape
 * emits a violation and the `toEqual([])` assertion fails. Asserting `[]`
 * against the malformed shape alone is not enough: most guards fail open to
 * `[]` anyway, which is why these mutants survived the original suite.
 */
describe('parseKnipJson guard rejection', () => {
  it('returns an empty array when the top-level JSON is null', () => {
    expect(parseKnipJson('null', root)).toEqual([]);
  });

  it('rejects the whole report when one issue is null, dropping a valid issue too', () => {
    const withNullIssue = JSON.stringify({
      issues: [null, { file: 'src/valid.ts', exports: [{ name: 'thing' }] }],
    });
    expect(parseKnipJson(withNullIssue, root)).toEqual([]);
  });

  it('rejects the whole report when one issue has a non-string file, even with a real violation elsewhere', () => {
    const withBadFile = JSON.stringify({
      issues: [
        { file: 123, exports: [{ name: 'thing' }] },
        { file: 'src/valid.ts', exports: [{ name: 'other' }] },
      ],
    });
    expect(parseKnipJson(withBadFile, root)).toEqual([]);
  });

  it('skips a non-array issue-type value instead of exploding it into spurious violations', () => {
    const withStringExports = JSON.stringify({
      issues: [{ file: 'src/foo.ts', exports: 'not-an-array' }],
    });
    expect(parseKnipJson(withStringExports, root)).toEqual([]);
  });

  it('rejects the whole exports list when one entry is null, keeping a valid entry out too', () => {
    const withNullEntry = JSON.stringify({
      issues: [{ file: 'src/foo.ts', exports: [null, { name: 'thing' }] }],
    });
    expect(parseKnipJson(withNullEntry, root)).toEqual([]);
  });

  it('rejects the whole exports list when one entry has a non-string name', () => {
    const withBadName = JSON.stringify({
      issues: [
        {
          file: 'src/foo.ts',
          exports: [{ name: 123 }, { name: 'thing' }],
        },
      ],
    });
    expect(parseKnipJson(withBadName, root)).toEqual([]);
  });

  it('omits the line key entirely for an entry with no line', () => {
    const withoutLine = JSON.stringify({
      issues: [{ file: 'src/foo.ts', dependencies: [{ name: 'left-pad' }] }],
    });
    const [violation] = parseKnipJson(withoutLine, root);
    expect(Object.hasOwn(violation ?? {}, 'line')).toBe(false);
  });

  it('skips an issue type missing entirely from the issue object', () => {
    const minimalIssue = JSON.stringify({ issues: [{ file: 'src/foo.ts' }] });
    expect(parseKnipJson(minimalIssue, root)).toEqual([]);
  });
});
