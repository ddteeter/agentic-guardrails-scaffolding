import { describe, expect, it } from 'vitest';

import { parseIncrementalCache } from '../../src/verify/incremental-cache.js';
import {
  RETESTED_REASON,
  dropMutants,
  planRetest,
  rescore,
  timeoutKeys,
} from '../../src/verify/timeout-retest.js';

interface MutantSpec {
  status?: string;
  killedBy?: string[];
  statusReason?: string;
  testsCompleted?: number;
  line?: number;
  endLine?: number;
  replacement?: string;
}

function mutant(spec: MutantSpec = {}): Record<string, unknown> {
  const line = spec.line ?? 1;
  return {
    id: String(line),
    mutatorName: 'UpdateOperator',
    replacement: spec.replacement ?? 'index--',
    status: spec.status ?? 'Timeout',
    coveredBy: ['0'],
    location: {
      start: { line, column: 3 },
      end: { line: spec.endLine ?? line, column: 10 },
    },
    ...(spec.killedBy !== undefined && { killedBy: spec.killedBy }),
    ...(spec.statusReason !== undefined && {
      statusReason: spec.statusReason,
    }),
    ...(spec.testsCompleted !== undefined && {
      testsCompleted: spec.testsCompleted,
    }),
  };
}

function report(files: Record<string, unknown[]>): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(
      Object.entries(files).map(([file, mutants]) => [
        file,
        { language: 'typescript', source: `// ${file}\n`, mutants },
      ]),
    ),
    testFiles: {
      'test/a.test.ts': { source: '', tests: [{ id: '0', name: 'a' }] },
    },
  });
}

const KEY_LINE_3 = 'src/a.ts@3:3-3:10\nUpdateOperator: index--';

function plan(
  reportJson: string,
  overrides: Partial<Parameters<typeof planRetest>[1]> = {},
) {
  return planRetest(reportJson, {
    inScope: ['src/a.ts', 'src/b.ts'],
    lineRanges: new Map(),
    cachedTimeouts: new Set(),
    limit: 10,
    ...overrides,
  });
}

describe('planRetest: which timed-out mutants are re-tested', () => {
  it('picks a Timeout no test is named as killing, keyed as stryker keys it', () => {
    const picked = plan(report({ 'src/a.ts': [mutant({ line: 3 })] }));
    expect([...picked.keys]).toEqual([KEY_LINE_3]);
    expect(picked.mutate).toEqual(['src/a.ts:3-3']);
    expect(picked.candidates).toBe(1);
  });

  it('spans every line of a mutant that crosses lines', () => {
    const picked = plan(
      report({ 'src/a.ts': [mutant({ line: 3, endLine: 6 })] }),
    );
    expect(picked.mutate).toEqual(['src/a.ts:3-6']);
  });

  it.each<[string, MutantSpec]>([
    ['a Timeout a named test killed', { killedBy: ['0'] }],
    [
      'a hit-limit Timeout, which load cannot cause',
      { statusReason: 'Hit limit reached (1001/1000)' },
    ],
    ['a Killed mutant', { status: 'Killed', killedBy: ['0'] }],
    ['a Survived mutant', { status: 'Survived', testsCompleted: 1 }],
  ])('leaves out %s', (_label, spec) => {
    const picked = plan(report({ 'src/a.ts': [mutant(spec)] }));
    expect(picked.keys.size).toBe(0);
    expect(picked.candidates).toBe(0);
  });

  it('picks a wall-clock Timeout whose killedBy is empty', () => {
    const picked = plan(report({ 'src/a.ts': [mutant({ killedBy: [] })] }));
    expect(picked.candidates).toBe(1);
  });

  it('leaves out a file outside this run’s scope', () => {
    const picked = plan(report({ 'src/c.ts': [mutant()] }));
    expect(picked.candidates).toBe(0);
  });

  it('leaves out a mutant outside the planned line ranges', () => {
    const picked = plan(
      report({ 'src/a.ts': [mutant({ line: 3 }), mutant({ line: 20 })] }),
      { lineRanges: new Map([['src/a.ts', [{ start: 1, end: 5 }]]]) },
    );
    expect([...picked.keys]).toEqual([KEY_LINE_3]);
  });

  it('leaves out a Timeout the cache already held before the run', () => {
    const picked = plan(report({ 'src/a.ts': [mutant({ line: 3 })] }), {
      cachedTimeouts: new Set([KEY_LINE_3]),
    });
    expect(picked.candidates).toBe(0);
  });

  it('caps the re-test at the first `limit`, by file then line', () => {
    const picked = plan(
      report({
        'src/b.ts': [mutant({ line: 1 })],
        'src/a.ts': [mutant({ line: 9 }), mutant({ line: 2 })],
      }),
      { limit: 2 },
    );
    expect(picked.mutate).toEqual(['src/a.ts:2-2', 'src/a.ts:9-9']);
    expect(picked.keys.size).toBe(2);
    expect(picked.candidates).toBe(3);
  });

  it('re-tests nothing when the limit is 0', () => {
    const picked = plan(report({ 'src/a.ts': [mutant()] }), { limit: 0 });
    expect(picked.keys.size).toBe(0);
    expect(picked.candidates).toBe(1);
  });

  it('names a line once when two picked mutants share it', () => {
    const picked = plan(
      report({
        'src/a.ts': [
          mutant({ line: 4 }),
          mutant({ line: 4, replacement: 'x' }),
        ],
      }),
    );
    expect(picked.mutate).toEqual(['src/a.ts:4-4']);
    expect(picked.keys.size).toBe(2);
  });

  it('plans nothing for a payload that is not a report', () => {
    expect(plan('not json').candidates).toBe(0);
  });

  it('leaves out a mutant whose location does not say its columns', () => {
    const bare = {
      mutatorName: 'UpdateOperator',
      status: 'Timeout',
      location: { start: { line: 1 } },
    };
    expect(plan(report({ 'src/a.ts': [bare] })).candidates).toBe(0);
  });
});

describe('timeoutKeys', () => {
  it('keys every Timeout in a cache, and nothing else', () => {
    const keys = timeoutKeys(
      report({
        'src/a.ts': [
          mutant({ line: 3 }),
          mutant({ line: 5, status: 'Killed' }),
        ],
      }),
    );
    expect([...keys]).toEqual([KEY_LINE_3]);
  });

  it('is empty for no cache', () => {
    expect(timeoutKeys('').size).toBe(0);
  });
});

describe('dropMutants', () => {
  it('drops exactly the keyed mutants and keeps the rest of the cache', () => {
    const cache = report({
      'src/a.ts': [mutant({ line: 3 }), mutant({ line: 5 })],
    });
    const dropped = dropMutants(cache, new Set([KEY_LINE_3]));
    const parsed = parseIncrementalCache(dropped ?? '');
    const lines = parsed?.files
      .get('src/a.ts')
      ?.mutants.map((each) => each.raw.id);
    expect(lines).toEqual(['5']);
    expect(parsed?.testFiles.has('test/a.test.ts')).toBe(true);
  });

  it('is undefined for a cache it cannot read', () => {
    expect(dropMutants('', new Set([KEY_LINE_3]))).toBeUndefined();
  });
});

function statusesIn(reportJson: string): unknown[] {
  return (
    parseIncrementalCache(reportJson)
      ?.files.get('src/a.ts')
      ?.mutants.map((each) => [
        each.status,
        each.raw.statusReason,
        each.raw.testsCompleted,
      ]) ?? []
  );
}

describe('rescore', () => {
  const first = report({
    'src/a.ts': [mutant({ line: 3 }), mutant({ line: 5 })],
  });
  const keys = new Set([KEY_LINE_3]);

  it('takes the re-run’s Survived, and says the mutant first timed out', () => {
    const second = report({
      'src/a.ts': [
        mutant({ line: 3, status: 'Survived', testsCompleted: 2 }),
        mutant({ line: 5, status: 'Survived', testsCompleted: 2 }),
      ],
    });
    const result = rescore(first, second, keys);
    expect(statusesIn(result.report)).toEqual([
      ['Survived', RETESTED_REASON, 2],
      ['Timeout', undefined, undefined],
    ]);
    expect(result).toMatchObject({ rescored: 1, timedOutAgain: 0, missing: 0 });
  });

  it('takes the re-run’s Killed with its killing tests', () => {
    const second = report({
      'src/a.ts': [mutant({ line: 3, status: 'Killed', killedBy: ['0'] })],
    });
    const result = rescore(first, second, keys);
    const rescored = parseIncrementalCache(result.report)?.files.get('src/a.ts')
      ?.mutants[0];
    expect(rescored?.status).toBe('Killed');
    expect(rescored?.killedBy).toEqual(['0']);
    expect(result.rescored).toBe(1);
  });

  it('keeps a mutant that timed out again as a Timeout', () => {
    const second = report({ 'src/a.ts': [mutant({ line: 3 })] });
    const result = rescore(first, second, keys);
    expect(statusesIn(result.report)).toEqual([
      ['Timeout', undefined, undefined],
      ['Timeout', undefined, undefined],
    ]);
    expect(result).toMatchObject({ rescored: 0, timedOutAgain: 1, missing: 0 });
  });

  it('keeps a Timeout the re-run did not report', () => {
    const result = rescore(first, report({ 'src/a.ts': [] }), keys);
    expect(statusesIn(result.report)).toEqual([
      ['Timeout', undefined, undefined],
      ['Timeout', undefined, undefined],
    ]);
    expect(result).toMatchObject({ rescored: 0, timedOutAgain: 0, missing: 1 });
  });

  it('keeps the first report whole when the re-run’s is not a report', () => {
    const result = rescore(first, '', keys);
    expect(result.report).toBe(first);
    expect(result.missing).toBe(1);
  });
});
