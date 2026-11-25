import { describe, expect, it } from 'vitest';

import { mutationRunRecord } from '../../src/verify/mutation-run.js';
import { statusCounts } from '../../src/verify/stryker-adapter.js';

const CACHE = { local: 'kept', seed: 'off' } as const;

function mutant(status: string): Record<string, unknown> {
  return {
    status,
    mutatorName: 'ConditionalExpression',
    location: { start: { line: 1 } },
  };
}

const REPORT = JSON.stringify({
  files: {
    'src/a.ts': {
      mutants: [mutant('Killed'), mutant('Timeout'), mutant('Survived')],
    },
    'src/b.ts': { mutants: [mutant('NoCoverage'), mutant('Killed')] },
  },
});

const SUMMARY = JSON.stringify({
  startedAt: 1300,
  planReadyAt: 1400,
  reportReadyAt: 1900,
  total: 5,
  reused: 2,
});

describe('statusCounts', () => {
  it('counts every mutant, and each status', () => {
    expect(statusCounts(REPORT)).toEqual({
      total: 5,
      Killed: 2,
      Timeout: 1,
      Survived: 1,
      NoCoverage: 1,
    });
  });

  it('reads nothing from a payload that is not a report', () => {
    expect(statusCounts('nope')).toBeUndefined();
  });
});

describe('mutationRunRecord', () => {
  it('splits the lock at stryker’s start, and times the phases', () => {
    expect(
      mutationRunRecord({
        files: 2,
        cache: CACHE,
        timing: {
          queuedAt: 1000,
          releasedAt: 2000,
          holderOnArrival: 'app (push), mutating 3/9',
          depthOnArrival: 1,
        },
        didRun: true,
        summaryText: SUMMARY,
        reportText: REPORT,
      }),
    ).toEqual({
      didRun: true,
      lock: {
        queuedMs: 300,
        heldMs: 700,
        holderOnArrival: 'app (push), mutating 3/9',
        depthOnArrival: 1,
      },
      stryker: {
        files: 2,
        cache: CACHE,
        dryRunMs: 100,
        mutatingMs: 500,
        reused: 2,
        mutants: 5,
        timeouts: 1,
        survivors: 1,
        noCoverage: 1,
        report: 'read',
      },
    });
  });

  it('counts the whole lock time as held without a summary', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      timing: { queuedAt: 1000, releasedAt: 2000, depthOnArrival: 0 },
      didRun: true,
      summaryText: '',
      reportText: REPORT,
    });
    expect(record.lock).toEqual({
      queuedMs: 0,
      heldMs: 1000,
      depthOnArrival: 0,
    });
    expect(record.lock).not.toHaveProperty('holderOnArrival');
    expect(record.stryker).not.toHaveProperty('dryRunMs');
    expect(record.stryker).not.toHaveProperty('reused');
  });

  it.each([
    ['before the ask', 500, { queuedMs: 0, heldMs: 1000 }],
    ['after the release', 2500, { queuedMs: 1000, heldMs: 0 }],
  ])('keeps a start %s inside the lock’s time', (_label, startedAt, split) => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      timing: { queuedAt: 1000, releasedAt: 2000, depthOnArrival: 0 },
      didRun: true,
      summaryText: JSON.stringify({ startedAt, total: 0, reused: 0 }),
      reportText: REPORT,
    });
    expect(record.lock).toMatchObject(split);
  });

  it('times only the dry run of a run stopped before mutation ended', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: JSON.stringify({
        startedAt: 0,
        planReadyAt: 40,
        total: 3,
        reused: 0,
      }),
      reportText: '',
    });
    expect(record.stryker).toMatchObject({ dryRunMs: 40, report: 'missing' });
    expect(record.stryker).not.toHaveProperty('mutatingMs');
    expect(record.stryker).not.toHaveProperty('mutants');
    expect(record).not.toHaveProperty('lock');
  });

  it('times no phase of a run whose summary has no plan', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: JSON.stringify({
        startedAt: 0,
        reportReadyAt: 90,
        total: 0,
        reused: 1,
      }),
      reportText: REPORT,
    });
    expect(record.stryker).toMatchObject({ reused: 1, report: 'read' });
    expect(record.stryker).not.toHaveProperty('dryRunMs');
    expect(record.stryker).not.toHaveProperty('mutatingMs');
  });

  it('only queued, and read nothing, when the run never got the lock', () => {
    expect(
      mutationRunRecord({
        files: 3,
        cache: CACHE,
        timing: {
          queuedAt: 1000,
          releasedAt: 61_000,
          holderOnArrival: 'app (push), mutating 3/9',
          depthOnArrival: 2,
        },
        didRun: false,
        summaryText: SUMMARY,
        reportText: REPORT,
      }),
    ).toEqual({
      didRun: false,
      lock: {
        queuedMs: 60_000,
        heldMs: 0,
        holderOnArrival: 'app (push), mutating 3/9',
        depthOnArrival: 2,
      },
      stryker: { files: 3, cache: CACHE, report: 'missing' },
    });
  });

  it('counts the timeouts re-tested alone, and how many were re-scored (#202)', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: '',
      reportText: REPORT,
      retest: { retested: 3, rescored: 1 },
    });
    expect(record.stryker).toMatchObject({ retested: 3, rescored: 1 });
  });

  it('copies what the timeouts cost, and the settings, from the summary (#236)', () => {
    const timeoutCost = {
      wallClock: 2,
      hitLimit: 1,
      budgetMs: 13_000,
      wallClockGapMs: 22_000,
      otherGapMs: 3000,
      byFile: [{ file: 'src/a.ts', count: 2, firstLine: 3, lastLine: 9 }],
    };
    const timeoutSettings = { timeoutMS: 5000, dryRunOverheadMs: 90_000 };
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: JSON.stringify({
        ...JSON.parse(SUMMARY),
        timeouts: timeoutCost,
        settings: timeoutSettings,
      }),
      reportText: REPORT,
    });
    expect(record.stryker).toMatchObject({
      timeouts: 1,
      timeoutCost,
      timeoutSettings,
    });
  });

  it('says nothing of timeout costs a summary does not hold', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: SUMMARY,
      reportText: REPORT,
    });
    expect(record.stryker).not.toHaveProperty('timeoutCost');
    expect(record.stryker).not.toHaveProperty('timeoutSettings');
  });

  it('copies what the re-test measured (#236)', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: '',
      reportText: REPORT,
      retest: {
        retested: 2,
        rescored: 0,
        retestMutatingMs: 30_000,
        retestBudgetMs: 12_000,
        retestTimedOut: 2,
      },
    });
    expect(record.stryker).toMatchObject({
      retested: 2,
      retestMutatingMs: 30_000,
      retestBudgetMs: 12_000,
      retestTimedOut: 2,
    });
  });

  it('says nothing of a re-test that did not happen', () => {
    const record = mutationRunRecord({
      files: 1,
      cache: CACHE,
      didRun: true,
      summaryText: '',
      reportText: REPORT,
    });
    expect(record.stryker).not.toHaveProperty('retested');
    expect(record.stryker).not.toHaveProperty('rescored');
  });
});
