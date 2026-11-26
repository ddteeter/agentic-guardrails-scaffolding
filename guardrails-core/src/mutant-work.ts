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
