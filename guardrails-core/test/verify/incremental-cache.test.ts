import { describe, expect, it } from 'vitest';

import {
  cacheTestFiles,
  dropUntrusted,
  filterToScope,
  hasPerTestCoverage,
  parseIncrementalCache,
  serializeIncrementalCache,
  type IncrementalCache,
} from '../../src/verify/incremental-cache.js';

interface MutantSpec {
  status?: string;
  killedBy?: unknown;
  coveredBy?: unknown;
  line?: number;
}

function mutant(spec: MutantSpec = {}): Record<string, unknown> {
  return {
    id: String(spec.line ?? 1),
    mutatorName: 'ConditionalExpression',
    replacement: 'true',
    status: spec.status ?? 'Killed',
    static: false,
    location: {
      start: { line: spec.line ?? 1, column: 1 },
      end: { line: spec.line ?? 1, column: 9 },
    },
    ...(spec.killedBy !== undefined && { killedBy: spec.killedBy }),
    ...(spec.coveredBy !== undefined && { coveredBy: spec.coveredBy }),
  };
}

function report(
  files: Record<string, unknown[]>,
  testFiles: Record<string, string[]> = {},
): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60, break: null },
    files: Object.fromEntries(
      Object.entries(files).map(([file, mutants]) => [
        file,
        { language: 'typescript', source: `// ${file}\n`, mutants },
      ]),
    ),
    testFiles: Object.fromEntries(
      Object.entries(testFiles).map(([file, ids]) => [
        file,
        {
          source: `// ${file}\n`,
          tests: ids.map((id) => ({ id, name: `test ${id}` })),
        },
      ]),
    ),
  };
}

function parsed(
  files: Record<string, unknown[]>,
  testFiles: Record<string, string[]> = {},
): IncrementalCache {
  const cache = parseIncrementalCache(JSON.stringify(report(files, testFiles)));
  if (cache === undefined) {
    throw new Error('fixture did not parse');
  }
  return cache;
}

/**
The statuses left in a cache, per file — what a rewrite is judged by.
*/
function statuses(cache: IncrementalCache): Record<string, string[]> {
  return Object.fromEntries(
    [...cache.files].map(([file, entry]) => [
      file,
      entry.mutants.map((each) => each.status),
    ]),
  );
}

describe('parseIncrementalCache', () => {
  it('maps each file to its mutants and each test id to its test file', () => {
    const cache = parsed(
      {
        'src/a.ts': [
          mutant({ killedBy: ['0'], coveredBy: ['0', '1'] }),
          mutant({ status: 'Survived', coveredBy: ['1'], line: 2 }),
        ],
      },
      { 'a.test.ts': ['0'], 'b.test.ts': ['1', '2'] },
    );
    expect(statuses(cache)).toEqual({ 'src/a.ts': ['Killed', 'Survived'] });
    expect(cache.files.get('src/a.ts')?.mutants[0]).toMatchObject({
      killedBy: ['0'],
      coveredBy: ['0', '1'],
    });
    expect([...cache.testFileOf]).toEqual([
      ['0', 'a.test.ts'],
      ['1', 'b.test.ts'],
      ['2', 'b.test.ts'],
    ]);
  });

  it('reads an absent killedBy or coveredBy as no tests', () => {
    const cache = parsed({ 'src/a.ts': [mutant({ status: 'NoCoverage' })] });
    expect(cache.files.get('src/a.ts')?.mutants[0]).toMatchObject({
      killedBy: [],
      coveredBy: [],
    });
  });

  it('reads a report with no testFiles section as one naming no tests', () => {
    const raw = report({ 'src/a.ts': [mutant({ killedBy: ['0'] })] });
    delete raw.testFiles;
    expect(parseIncrementalCache(JSON.stringify(raw))?.testFileOf.size).toBe(0);
  });

  it('leaves a test id claimed by two test files unresolved', () => {
    // Ambiguous is not traceable: which file killed the mutant cannot be told,
    // so neither may vouch for it.
    const cache = parsed(
      { 'src/a.ts': [mutant({ killedBy: ['0'] })] },
      { 'a.test.ts': ['0', '1'], 'b.test.ts': ['0'] },
    );
    expect([...cache.testFileOf]).toEqual([['1', 'a.test.ts']]);
  });

  it('leaves a test id one file declares twice unresolved', () => {
    const cache = parsed({}, { 'a.test.ts': ['0', '0', '1'] });
    expect([...cache.testFileOf]).toEqual([['1', 'a.test.ts']]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['the empty string a missing file reads as', ''],
    ['a JSON primitive', '5'],
    ['an array', '[]'],
    ['no files section', '{}'],
    ['a files section that is not an object', '{"files":"nope"}'],
    ['a files section that is an array', '{"files":[]}'],
    ['a file entry that is not an object', '{"files":{"a.ts":5}}'],
    ['a null file entry', '{"files":{"a.ts":null}}'],
    ['a file entry with no mutants list', '{"files":{"a.ts":{}}}'],
    [
      'a file whose mutants list is not an array',
      '{"files":{"a.ts":{"mutants":{}}}}',
    ],
  ])('rejects %s', (_label, json) => {
    expect(parseIncrementalCache(json)).toBeUndefined();
  });

  it.each([
    ['a mutant that is not an object', 5],
    ['a mutant with no status', { ...mutant(), status: undefined }],
    ['a mutant with a numeric status', { ...mutant(), status: 1 }],
    ['a mutant with no mutator name', { ...mutant(), mutatorName: undefined }],
    ['a mutant with no location', { ...mutant(), location: undefined }],
    ['a mutant whose location has no start', { ...mutant(), location: {} }],
    [
      'a mutant whose start line is not a number',
      { ...mutant(), location: { start: { line: '1' } } },
    ],
    ['a killedBy that is not an array', mutant({ killedBy: '0' })],
    ['a killedBy holding a non-string', mutant({ killedBy: [0] })],
    ['a coveredBy that is not an array', mutant({ coveredBy: {} })],
    ['a coveredBy holding a non-string', mutant({ coveredBy: ['0', 1] })],
  ])('rejects %s', (_label, bad) => {
    const json = JSON.stringify(report({ 'src/a.ts': [mutant(), bad] }));
    expect(parseIncrementalCache(json)).toBeUndefined();
  });

  it.each([
    ['a testFiles section that is not an object', 'nope'],
    ['a testFiles section that is an array', []],
    ['a test file entry that is not an object', { 'a.test.ts': 5 }],
    ['a null test file entry', { 'a.test.ts': null }],
    ['a test file entry with no tests list', { 'a.test.ts': {} }],
    [
      'a test file whose tests list is not an array',
      { 'a.test.ts': { tests: {} } },
    ],
    ['a test that is not an object', { 'a.test.ts': { tests: [5] } }],
    ['a test with no id', { 'a.test.ts': { tests: [{ name: 'x' }] } }],
    ['a test with a numeric id', { 'a.test.ts': { tests: [{ id: 0 }] } }],
  ])('rejects %s', (_label, testFiles) => {
    const raw = { ...report({ 'src/a.ts': [mutant()] }), testFiles };
    expect(parseIncrementalCache(JSON.stringify(raw))).toBeUndefined();
  });
});

describe('serializeIncrementalCache', () => {
  it('round-trips every field stryker wrote, known or not', () => {
    // Stryker reads the rewritten file back as ITS cache, so anything this
    // parser does not model — `source`, `replacement`, `thresholds`, the test
    // sources it diffs — must survive unchanged.
    const raw = report(
      { 'src/a.ts': [mutant({ killedBy: ['0'] })] },
      { 'a.test.ts': ['0'] },
    );
    const cache = parseIncrementalCache(JSON.stringify(raw));
    expect(cache && JSON.parse(serializeIncrementalCache(cache))).toStrictEqual(
      raw,
    );
  });

  it('writes only the mutants and files a rewrite kept', () => {
    const cache = parsed({
      'src/a.ts': [mutant({ killedBy: ['0'] }), mutant({ status: 'Survived' })],
      'src/b.ts': [mutant()],
    });
    const kept = dropUntrusted(filterToScope(cache, ['src/a.ts']), new Set());
    const written: unknown = JSON.parse(serializeIncrementalCache(kept));
    expect(written).toMatchObject({
      schemaVersion: '1.0',
      files: { 'src/a.ts': { source: '// src/a.ts\n' } },
    });
    expect(parseIncrementalCache(JSON.stringify(written))).toBeDefined();
    expect(
      statuses(parseIncrementalCache(serializeIncrementalCache(kept)) ?? cache),
    ).toEqual({ 'src/a.ts': [] });
  });
});

describe('filterToScope', () => {
  it('keeps the files this run mutates and drops the rest', () => {
    // Critique B: a cache that also holds some other file used to be thrown
    // away whole. Only the foreign file has to go — stryker folds a cached
    // file it does not mutate back into its report (drift test 0.3), so it
    // cannot stay, but the in-scope verdicts are still this run's.
    const cache = parsed({
      'src/a.ts': [mutant()],
      'src/foreign.ts': [mutant()],
    });
    expect(statuses(filterToScope(cache, ['src/a.ts', 'src/new.ts']))).toEqual({
      'src/a.ts': ['Killed'],
    });
  });

  it('keeps nothing when this run mutates nothing', () => {
    const cache = parsed({ 'src/a.ts': [mutant()] });
    expect(filterToScope(cache, []).files.size).toBe(0);
  });
});

describe('hasPerTestCoverage', () => {
  it('is true when any one mutant names a covering test', () => {
    // A `NoCoverage` mutant legitimately names none; one attributed mutant
    // anywhere proves the runner reports per-test data at all.
    const cache = parsed({
      'src/a.ts': [mutant({ status: 'NoCoverage' })],
      'src/b.ts': [
        mutant({ status: 'NoCoverage' }),
        mutant({ coveredBy: ['0'] }),
      ],
    });
    expect(hasPerTestCoverage(cache)).toBe(true);
  });

  it('is false when no mutant names a covering test', () => {
    // Without per-test data stryker's differ reuses a Survived verdict however
    // the tests changed (the `command` runner, measured in
    // `stryker-incremental.test.ts`).
    const cache = parsed({
      'src/a.ts': [mutant(), mutant({ coveredBy: [] })],
    });
    expect(hasPerTestCoverage(cache)).toBe(false);
  });

  it('is false for a cache with no files', () => {
    expect(hasPerTestCoverage(parsed({}))).toBe(false);
  });
});

describe('cacheTestFiles', () => {
  it('lists each test file the cache names once', () => {
    const cache = parsed({}, { 'a.test.ts': ['0', '1'], 'b.test.ts': ['2'] });
    expect(cacheTestFiles(cache)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('dropUntrusted', () => {
  const testFiles = { 'a.test.ts': ['0'], 'b.test.ts': ['1'] };

  it('drops Survived and NoCoverage whatever changed (stryker-js#6119)', () => {
    // A cached survivor is exactly what the next test is written to kill, and
    // stryker reuses a STATIC survivor even after that test lands (drift test
    // 0.2), so the verdict is never carried forward.
    const cache = parsed(
      {
        'src/a.ts': [
          mutant({ status: 'Survived', coveredBy: ['0'] }),
          mutant({ status: 'NoCoverage' }),
          mutant({ killedBy: ['0'] }),
        ],
      },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set()))).toEqual({
      'src/a.ts': ['Killed'],
    });
  });

  it('keeps a kill whose killing tests all sit in unchanged files', () => {
    const cache = parsed(
      { 'src/a.ts': [mutant({ killedBy: ['0', '1'] })] },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set(['c.test.ts'])))).toEqual({
      'src/a.ts': ['Killed'],
    });
  });

  it('drops a kill when any one of its killing tests sits in a changed file', () => {
    // Changed AT ALL — the caller does not ask whether lines were only added,
    // because a test is weakened by adding lines as easily as by removing them
    // (an early `return`, a `try` around the assertion).
    const cache = parsed(
      {
        'src/a.ts': [
          mutant({ killedBy: ['0', '1'] }),
          mutant({ killedBy: ['0'], line: 2 }),
        ],
      },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set(['b.test.ts'])))).toEqual({
      'src/a.ts': ['Killed'],
    });
  });

  it('drops a kill whose killing test resolves to no test file', () => {
    const cache = parsed(
      { 'src/a.ts': [mutant({ killedBy: ['0', 'gone'] })] },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set()))).toEqual({
      'src/a.ts': [],
    });
  });

  it('drops a kill that names no killing test at all', () => {
    // Nothing to vouch for it — `every` over an empty list must not.
    const cache = parsed(
      { 'src/a.ts': [mutant({ coveredBy: ['0'] })] },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set()))).toEqual({
      'src/a.ts': [],
    });
  });

  it('keeps a Timeout through its covering tests, which is all stryker records', () => {
    // Stryker writes no `killedBy` for a Timeout: the run was cut off, not
    // failed by a named test. The tests that could have hung it are its
    // covering ones, so those stand in — and a changed one drops it.
    const cache = parsed(
      {
        'src/a.ts': [
          mutant({ status: 'Timeout', coveredBy: ['0'] }),
          mutant({ status: 'Timeout', coveredBy: ['1'], line: 2 }),
          mutant({ status: 'Timeout', line: 3 }),
        ],
      },
      testFiles,
    );
    const kept = dropUntrusted(cache, new Set(['b.test.ts']));
    expect(kept.files.get('src/a.ts')?.mutants).toEqual([
      expect.objectContaining({ status: 'Timeout', coveredBy: ['0'] }),
    ]);
  });

  it('judges a Timeout that does name a killer by its killer', () => {
    const cache = parsed(
      {
        'src/a.ts': [
          mutant({ status: 'Timeout', killedBy: ['0'], coveredBy: ['1'] }),
        ],
      },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set(['b.test.ts'])))).toEqual({
      'src/a.ts': ['Timeout'],
    });
  });

  it('does not let a Killed mutant fall back to its covering tests', () => {
    // Only a Timeout has a reason to name no killer.
    const cache = parsed(
      { 'src/a.ts': [mutant({ coveredBy: ['0'] })] },
      testFiles,
    );
    expect(statuses(dropUntrusted(cache, new Set()))).toEqual({
      'src/a.ts': [],
    });
  });

  it.each(['Ignored', 'CompileError', 'RuntimeError', 'Pending'])(
    'drops a %s verdict, which it has no rule to vouch for',
    (status) => {
      const cache = parsed(
        { 'src/a.ts': [mutant({ status, killedBy: ['0'] })] },
        testFiles,
      );
      expect(statuses(dropUntrusted(cache, new Set()))).toEqual({
        'src/a.ts': [],
      });
    },
  );

  it('leaves the test map alone, so the next run still diffs against it', () => {
    const cache = parsed({ 'src/a.ts': [mutant()] }, testFiles);
    expect(dropUntrusted(cache, new Set(['a.test.ts'])).testFileOf).toEqual(
      cache.testFileOf,
    );
  });
});
