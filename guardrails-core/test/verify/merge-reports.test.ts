import { describe, expect, it } from 'vitest';

import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import { mergeReports } from '../../src/verify/merge-reports.js';

function mutant(
  id: string,
  status: string,
  killedBy: string[],
  coveredBy = killedBy,
): Record<string, unknown> {
  return {
    id,
    mutatorName: 'ConditionalExpression',
    status,
    location: { start: { line: 1, column: 1 } },
    killedBy,
    coveredBy,
  };
}

interface Shard {
  files: Record<string, unknown>;
  testFiles?: Record<string, unknown>;
}

function report(shard: Shard, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: '1.0', ...extra, ...shard });
}

/**
 * Two shards of one CI run: each mutated its own production file, and both
 * ran the same test file — so the same test sits in both, under the SAME id
 * by coincidence of numbering ("0") and a DIFFERENT test under "1".
 */
const shardA = report({
  files: {
    'src/a.ts': { source: 'a', mutants: [mutant('0', 'Killed', ['0'])] },
  },
  testFiles: {
    'test/a.test.ts': {
      source: 'ta',
      tests: [
        { id: '0', name: 'a works' },
        { id: '1', name: 'a fails' },
      ],
    },
  },
});

const shardB = report({
  files: {
    'src/b.ts': { source: 'b', mutants: [mutant('0', 'Killed', ['1'])] },
  },
  testFiles: {
    'test/b.test.ts': { source: 'tb', tests: [{ id: '0', name: 'b works' }] },
    'test/a.test.ts': {
      source: 'ta',
      tests: [
        { id: '1', name: 'a works' },
        { id: '2', name: 'a fails' },
      ],
    },
  },
});

/**
The merged report, parsed — or a failure the test can read.
*/
function merged(texts: string[]) {
  const text = mergeReports(texts);
  if (text === undefined) {
    throw new Error('merge refused');
  }
  const cache = parseIncrementalCache(text);
  if (cache === undefined) {
    throw new Error('merge produced an unreadable cache');
  }
  return cache;
}

/**
The test file each of `file`'s mutants was killed in.
*/
function killingFiles(texts: string[], file: string): (string | undefined)[] {
  const cache = merged(texts);
  return (cache.files.get(file)?.mutants ?? []).flatMap((each) =>
    each.killedBy.map((id) => cache.testFileOf.get(id)),
  );
}

describe('mergeReports', () => {
  it('returns a single report unchanged in meaning', () => {
    expect(killingFiles([shardA], 'src/a.ts')).toEqual(['test/a.test.ts']);
    expect(merged([shardA]).raw.schemaVersion).toBe('1.0');
  });

  it('unions disjoint shards, keeping every kill on its own test file', () => {
    const texts = [shardA, shardB];
    expect(merged(texts).files.keys().toArray()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(killingFiles(texts, 'src/a.ts')).toEqual(['test/a.test.ts']);
    // Shard B's "1" is test/a.test.ts's SECOND test there; read in shard A's
    // numbering it would be "a fails", and in the merge it must still be a
    // test of test/a.test.ts rather than whatever "1" happens to be.
    expect(killingFiles(texts, 'src/b.ts')).toEqual(['test/a.test.ts']);
  });

  it('keeps one copy of a test file both shards ran', () => {
    const cache = merged([shardA, shardB]);
    const ids = [...cache.testFileOf].filter(
      ([, file]) => file === 'test/a.test.ts',
    );
    expect(ids).toHaveLength(2);
  });

  it('resolves a shard’s test to the same merged test as the other shard’s', () => {
    // Both shards' "a works" are one test: shard A's id "0", shard B's "1".
    const cache = merged([shardA, shardB]);
    const killerOfA = cache.files.get('src/a.ts')?.mutants[0]?.killedBy;
    const killerOfB = cache.files.get('src/b.ts')?.mutants[0]?.killedBy;
    expect(killerOfA).toEqual(killerOfB);
  });

  it('tells apart two tests of one file that share a name', () => {
    const text = mergeReports([
      report({
        files: {
          'src/a.ts': {
            source: 'a',
            mutants: [
              mutant('0', 'Killed', ['0']),
              mutant('1', 'Killed', ['1']),
            ],
          },
        },
        testFiles: {
          'test/a.test.ts': {
            tests: [
              { id: '0', name: 'same' },
              { id: '1', name: 'same' },
            ],
          },
        },
      }),
    ]);
    const cache = text === undefined ? undefined : parseIncrementalCache(text);
    const [first, second] = cache?.files.get('src/a.ts')?.mutants ?? [];
    expect(first?.killedBy).not.toEqual(second?.killedBy);
    expect(cache?.testFileOf.size).toBe(2);
  });

  it('re-keys coveredBy as well as killedBy', () => {
    const cache = merged([
      shardA,
      report({
        files: {
          'src/b.ts': {
            source: 'b',
            mutants: [mutant('0', 'Timeout', [], ['0'])],
          },
        },
        testFiles: {
          'test/b.test.ts': { tests: [{ id: '0', name: 'b works' }] },
        },
      }),
    ]);
    const [coverer] = cache.files.get('src/b.ts')?.mutants[0]?.coveredBy ?? [];
    expect(coverer && cache.testFileOf.get(coverer)).toBe('test/b.test.ts');
  });

  it('keeps an id no test declares unresolvable, rather than letting it alias another shard’s test', () => {
    const cache = merged([
      shardA,
      report({
        files: {
          'src/b.ts': { source: 'b', mutants: [mutant('0', 'Killed', ['9'])] },
        },
        testFiles: {},
      }),
    ]);
    const [killer] = cache.files.get('src/b.ts')?.mutants[0]?.killedBy ?? [];
    expect(killer).toBeDefined();
    expect(killer && cache.testFileOf.get(killer)).toBeUndefined();
  });

  it('gives every mutant an id unique across the merge', () => {
    const cache = merged([shardA, shardB]);
    const ids = cache.files
      .values()
      .flatMap((entry) => entry.mutants.map((each) => each.raw.id))
      .toArray();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves a list stryker did not write absent', () => {
    const { coveredBy, ...withoutCoverage } = mutant('0', 'Killed', ['0']);
    expect(coveredBy).toEqual(['0']);
    const cache = merged([
      report({
        files: { 'src/a.ts': { source: 'a', mutants: [withoutCoverage] } },
        testFiles: { 'test/a.test.ts': { tests: [{ id: '0', name: 'a' }] } },
      }),
    ]);
    expect(cache.files.get('src/a.ts')?.mutants[0]?.raw).not.toHaveProperty(
      'coveredBy',
    );
  });

  it('keeps the fields of a test and a file it does not rewrite', () => {
    const cache = merged([shardA]);
    const raw = cache.raw.testFiles;
    expect(raw).toMatchObject({
      'test/a.test.ts': {
        source: 'ta',
        tests: [{ name: 'a works' }, { name: 'a fails' }],
      },
    });
    expect(cache.files.get('src/a.ts')?.raw.source).toBe('a');
  });

  it('reads a report with no testFiles at all', () => {
    const cache = merged([
      report({
        files: {
          'src/a.ts': { source: 'a', mutants: [mutant('0', 'Killed', ['0'])] },
        },
      }),
    ]);
    const [killer] = cache.files.get('src/a.ts')?.mutants[0]?.killedBy ?? [];
    expect(killer && cache.testFileOf.get(killer)).toBeUndefined();
  });

  describe('fails closed', () => {
    it('refuses a production file two reports both mutated', () => {
      expect(mergeReports([shardA, shardA])).toBeUndefined();
    });

    it('refuses a set with one malformed report in it', () => {
      expect(mergeReports([shardA, '{"files": 3}'])).toBeUndefined();
      expect(mergeReports([shardA, 'not json'])).toBeUndefined();
    });

    it('refuses an empty set', () => {
      expect(mergeReports([])).toBeUndefined();
    });

    it('refuses a test file the reports ran at different sources', () => {
      expect(
        mergeReports([
          shardA,
          report({
            files: { 'src/b.ts': { source: 'b', mutants: [] } },
            testFiles: {
              'test/a.test.ts': {
                source: 'changed',
                tests: [{ id: '0', name: 'a works' }],
              },
            },
          }),
        ]),
      ).toBeUndefined();
    });

    it('refuses a test id one report declares twice', () => {
      expect(
        mergeReports([
          report({
            files: { 'src/a.ts': { source: 'a', mutants: [] } },
            testFiles: {
              'test/a.test.ts': { tests: [{ id: '0', name: 'a' }] },
              'test/b.test.ts': { tests: [{ id: '0', name: 'b' }] },
            },
          }),
        ]),
      ).toBeUndefined();
    });
  });
});
