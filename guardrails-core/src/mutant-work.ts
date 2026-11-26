/**
 * What a stryker run's dry run and mutant runs did (#200), as counts: how
 * many tests the dry run ran, and what the mutants stryker ran amounted to.
 *
 * Counts and stryker's own mutator and status names only: no test name and
 * no path is kept, so a run log can be shared without naming a project's
 * tests. The progress plugin writes these into its run summary; the gate and
 * the run log read them back with the readers here.
 */
import { isRecord } from './is-record.js';

/**
What the dry run ran.
*/
export interface DryRunCounts {
  tests: number;
  /**
  The distinct files those tests are in; absent when no test named its file.
  */
  testFiles?: number;
}

/**
 * What the mutants stryker ran amounted to: those of this run's plan that
 * were Run, not reused from a cache or settled early.
 */
export interface MutantRuns {
  /**
  The mutants counted.
  */
  ran: number;
  /**
  The tests they ran, added up: stryker's `testsCompleted`.
  */
  testsCompleted: number;
  /**
  Their covering tests, added up, over the mutants that listed them.
  */
  coveredBy: number;
  withCoveredBy: number;
  /**
  Static mutants: reached only as modules load, so every test runs for one.
  */
  static: number;
  /**
  Mutants by stryker's mutator name, then by status.
  */
  byMutator: Record<string, Record<string, number>>;
}

function isCount(value: unknown): value is number {
  // `Number.isFinite` does not coerce, so it is false for every non-number.
  return Number.isFinite(value);
}

/**
Dry-run counts with a test count, or `undefined`. A bad file count goes.
*/
export function dryRunCountsOf(value: unknown): DryRunCounts | undefined {
  if (!isRecord(value) || !isCount(value.tests)) {
    return undefined;
  }
  const { tests, testFiles } = value;
  return isCount(testFiles) ? { tests, testFiles } : { tests };
}

/**
One mutator's status counts, without those that are not numbers.
*/
function statusCountsOf(value: unknown): [string, number][] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).filter((entry): entry is [string, number] =>
    isCount(entry[1]),
  );
}

/**
 * Mutant-run tallies with every count there, or `undefined`. A status count
 * that is not a number goes, and so does a mutator left with none.
 */
export function mutantRunsOf(value: unknown): MutantRuns | undefined {
  if (!isRecord(value) || !isRecord(value.byMutator)) {
    return undefined;
  }
  const { ran, testsCompleted, coveredBy, withCoveredBy } = value;
  const isStatic = value.static;
  if (
    !isCount(ran) ||
    !isCount(testsCompleted) ||
    !isCount(coveredBy) ||
    !isCount(withCoveredBy) ||
    !isCount(isStatic)
  ) {
    return undefined;
  }
  // Built from entries, so no mutator name can reach a prototype.
  const byMutator = Object.fromEntries(
    Object.entries(value.byMutator).flatMap(([mutator, statuses]) => {
      const counts = statusCountsOf(statuses);
      return counts.length === 0
        ? []
        : [[mutator, Object.fromEntries(counts)] as const];
    }),
  );
  return {
    ran,
    testsCompleted,
    coveredBy,
    withCoveredBy,
    static: isStatic,
    byMutator,
  };
}
