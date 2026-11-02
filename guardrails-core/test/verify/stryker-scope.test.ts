import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isAnalyzerSelected, strykerScope } from '../../src/verify/index.js';

const repoRoot = '/repo';

/**
A `readFile` over an in-memory tree; a missing path rejects, as the real one
does.
*/
function reader(
  tree: Readonly<Record<string, string>>,
): (filePath: string) => Promise<string> {
  return (filePath) => {
    const relative = path.relative(repoRoot, filePath);
    const content = tree[relative];
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${relative}`))
      : Promise.resolve(content);
  };
}

const config = JSON.stringify({ mutate: ['src/**/*.ts', '!src/generated/**'] });

describe('strykerScope', () => {
  it('keeps a changed production file inside the mutate globs', async () => {
    const scope = await strykerScope(
      ['src/feature.ts'],
      repoRoot,
      reader({ 'stryker.conf.json': config, 'src/feature.ts': 'export {};' }),
    );
    expect(scope.inScope).toEqual(['src/feature.ts']);
    expect(scope.negations).toEqual(['!src/generated/**']);
  });

  it('is empty for a change set of tests, config and docs only', async () => {
    const scope = await strykerScope(
      ['src/feature.test.ts', 'vitest.config.ts', 'README.md'],
      repoRoot,
      reader({ 'stryker.conf.json': config }),
    );
    expect(scope.inScope).toEqual([]);
    expect(scope.outOfScope).toEqual([]);
  });

  it('is empty for an executable entry, which is not mutated', async () => {
    const scope = await strykerScope(
      ['src/cli.ts'],
      repoRoot,
      reader({
        'stryker.conf.json': config,
        'src/cli.ts': '#!/usr/bin/env node\n',
      }),
    );
    expect(scope.inScope).toEqual([]);
  });

  it('is empty for a file outside every positive glob, and reports it', async () => {
    const scope = await strykerScope(
      ['scripts/tool.ts'],
      repoRoot,
      reader({ 'stryker.conf.json': config, 'scripts/tool.ts': 'export {};' }),
    );
    expect(scope.inScope).toEqual([]);
    expect(scope.outOfScope.map((violation) => violation.file)).toEqual([
      'scripts/tool.ts',
    ]);
  });

  it('widens to every production file when there is no stryker config', async () => {
    const scope = await strykerScope(
      ['scripts/tool.ts'],
      repoRoot,
      reader({ 'scripts/tool.ts': 'export {};' }),
    );
    expect(scope.inScope).toEqual(['scripts/tool.ts']);
    expect(scope.config).toBe('');
  });
});

describe('isAnalyzerSelected', () => {
  const declared = new Set(['@stryker-mutator/core']);
  const base = {
    analyzers: {},
    analyzerRungs: {},
    declared,
    profile: 'push',
    hasChangedFiles: true,
  } as const;

  it('selects a declared stryker on the push rung by default', () => {
    expect(isAnalyzerSelected('stryker', base)).toBe(true);
  });

  it('does not select stryker the config turned off', () => {
    expect(
      isAnalyzerSelected('stryker', { ...base, analyzers: { stryker: 'off' } }),
    ).toBe(false);
  });

  it('does not select stryker moved to a rung above push', () => {
    expect(
      isAnalyzerSelected('stryker', {
        ...base,
        analyzerRungs: { stryker: 'ci' },
      }),
    ).toBe(false);
  });

  it('does not select a changed-files analyzer when nothing changed', () => {
    expect(
      isAnalyzerSelected('stryker', { ...base, hasChangedFiles: false }),
    ).toBe(false);
  });

  it('still selects an undeclared auto stryker, which runs if it resolves', () => {
    expect(
      isAnalyzerSelected('stryker', { ...base, declared: new Set<string>() }),
    ).toBe(true);
  });

  it('does not select stryker on the stop rung when it is moved to push', () => {
    expect(
      isAnalyzerSelected('stryker', {
        ...base,
        profile: 'stop',
        analyzerRungs: { stryker: 'push' },
      }),
    ).toBe(false);
  });
});
