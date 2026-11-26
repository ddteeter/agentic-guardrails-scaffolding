import { describe, expect, it } from 'vitest';

import type { MutantRuns } from '../src/mutant-work.js';
import type { GateRow } from '../src/run-log.js';
import { summarizeWork, workLines } from '../src/work-stats.js';

type StrykerPart = NonNullable<GateRow['stryker']>;

/**
A gate that took no lock.
*/
const NO_LOCK = Symbol('no lock');

function gate(
  stryker: Partial<StrykerPart> | undefined,
  heldMs: number | typeof NO_LOCK = 600_000,
): GateRow {
  return {
    v: 1,
    kind: 'gate',
    rung: 'push',
    repo: 'app',
    startedAt: '2026-11-19T10:00:00.000Z',
    finishedAt: '2026-11-19T10:10:00.000Z',
    outcome: 'pass',
    lock:
      heldMs === NO_LOCK
        ? undefined
        : { queuedMs: 0, heldMs, depthOnArrival: 0 },
    stryker:
      stryker === undefined
        ? undefined
        : { files: 1, report: 'read', ...stryker },
  };
}

function runs(over: Partial<MutantRuns>): MutantRuns {
  return {
    ran: 0,
    testsCompleted: 0,
    coveredBy: 0,
    withCoveredBy: 0,
    static: 0,
    byMutator: {},
    ...over,
  };
}

function lines(rows: readonly GateRow[]): string[] {
  return workLines(summarizeWork(rows));
}

describe('summarizeWork and workLines (#200)', () => {
  it('says nothing when no run measured anything', () => {
    expect(summarizeWork([gate(undefined), gate({})])).toBeUndefined();
    expect(workLines(undefined)).toEqual([]);
  });

  it('gives the dry run’s share of the lock time held, over runs that know both', () => {
    expect(
      lines([
        gate({ dryRunMs: 120_000 }),
        gate({ dryRunMs: 30_000 }, 300_000),
        gate({ dryRunMs: 999_000 }, NO_LOCK),
        gate({}, 900_000),
        gate({ dryRunMs: 5000 }, 0),
      ]),
    ).toEqual(['  dry run’s share of the lock held: 17% over 2 run(s)']);
  });

  it('gives the tests per gate: in the dry run, its files, and in mutant runs', () => {
    expect(
      lines([
        gate(
          {
            dryRunCounts: { tests: 1800, testFiles: 200 },
            mutantRuns: runs({ ran: 1, testsCompleted: 400 }),
          },
          NO_LOCK,
        ),
        gate({ dryRunCounts: { tests: 40, testFiles: 6 } }, NO_LOCK),
        gate({ dryRunCounts: { tests: 900 } }, NO_LOCK),
      ]),
    ).toEqual([
      '  tests per gate: median 900 in the dry run (in 6 files), 400 in mutant runs',
      '  mutants run: 1 in 1 run(s), 0 static',
    ]);
  });

  it('leaves out the parts of the tests per gate no run measured', () => {
    expect(lines([gate({ dryRunCounts: { tests: 12 } }, NO_LOCK)])).toEqual([
      '  tests per gate: median 12 in the dry run',
    ]);
    expect(
      lines([
        gate({ mutantRuns: runs({ ran: 2, testsCompleted: 5 }) }, NO_LOCK),
      ]),
    ).toEqual([
      '  tests per gate: median 5 in mutant runs',
      '  mutants run: 2 in 1 run(s), 0 static',
    ]);
  });

  it('adds up the mutants run by mutator and status, most first, with their mean coverage', () => {
    expect(
      lines([
        gate(
          {
            mutantRuns: runs({
              ran: 4,
              testsCompleted: 10,
              coveredBy: 9,
              withCoveredBy: 3,
              static: 1,
              byMutator: {
                StringLiteral: { Killed: 1 },
                ConditionalExpression: { Killed: 2, Survived: 1 },
              },
            }),
          },
          NO_LOCK,
        ),
        gate(
          {
            mutantRuns: runs({
              ran: 3,
              testsCompleted: 30,
              coveredBy: 1,
              withCoveredBy: 1,
              byMutator: {
                StringLiteral: { Survived: 1, Killed: 1 },
                ArithmeticOperator: { Timeout: 1 },
              },
            }),
          },
          NO_LOCK,
        ),
      ]),
    ).toEqual([
      '  tests per gate: median 10 in mutant runs',
      '  mutants run: 7 in 2 run(s), 1 static; 2.5 covering tests each on average',
      '    ConditionalExpression 3: Killed 2, Survived 1',
      '    StringLiteral 3: Killed 2, Survived 1',
      '    ArithmeticOperator 1: Timeout 1',
    ]);
  });

  it('says the dry run’s share alongside the rest', () => {
    expect(
      lines([
        gate({
          dryRunMs: 60_000,
          dryRunCounts: { tests: 3 },
          mutantRuns: runs({ ran: 1, testsCompleted: 2 }),
        }),
      ]),
    ).toEqual([
      '  dry run’s share of the lock held: 10% over 1 run(s)',
      '  tests per gate: median 3 in the dry run, 2 in mutant runs',
      '  mutants run: 1 in 1 run(s), 0 static',
    ]);
  });
});
