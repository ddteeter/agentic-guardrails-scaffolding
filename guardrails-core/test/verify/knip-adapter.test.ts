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
    expect(violations.every((v) => !v.fixable)).toBe(true);
  });

  it('threads packageId onto every violation when given', () => {
    const violations = parseKnipJson(stdout, root, 'guardrails-core');
    expect(violations.every((v) => v.package === 'guardrails-core')).toBe(true);
  });

  it('returns [] on empty or malformed stdout', () => {
    expect(parseKnipJson('', root)).toEqual([]);
    expect(parseKnipJson('not json', root)).toEqual([]);
    expect(parseKnipJson('{}', root)).toEqual([]);
  });
});
