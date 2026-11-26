/**
 * What a run's dry run and mutant runs did (#200), as the progress plugin
 * sees them: how many tests the dry run ran and in how many files.
 *
 * Fed by the plugin; never throws, and reads every event defensively, since
 * it runs inside stryker and must not fail a run over a measurement. It keeps
 * counts only -- a test's file name is read to tell files apart and then
 * dropped.
 */
import { isRecord } from './is-record.js';
import type { DryRunCounts } from './mutant-work.js';

/**
The dry run's tests, from stryker's `DryRunCompletedEvent`, or `undefined`.
*/
function dryRunTests(event: unknown): unknown[] | undefined {
  const result = isRecord(event) ? event.result : undefined;
  const tests = isRecord(result) ? result.tests : undefined;
  if (!Array.isArray(tests)) {
    return undefined;
  }
  const list: unknown[] = tests;
  return list;
}

export class WorkMeter {
  #dryRun: DryRunCounts | undefined;

  dryRunCompleted(event: unknown): void {
    const tests = dryRunTests(event)?.filter((test) => isRecord(test));
    if (tests === undefined) {
      return;
    }
    const files = new Set(
      tests.flatMap((test) =>
        typeof test.fileName === 'string' ? [test.fileName] : [],
      ),
    );
    this.#dryRun =
      files.size === 0
        ? { tests: tests.length }
        : { tests: tests.length, testFiles: files.size };
  }

  /**
  What the dry run ran, or `undefined` before it said.
  */
  dryRun(): DryRunCounts | undefined {
    return this.#dryRun;
  }
}
