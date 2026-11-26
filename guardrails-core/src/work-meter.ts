/**
 * What a run's dry run and mutant runs did (#200), as the progress plugin
 * sees them: how many tests the dry run ran and in how many files, and for
 * the mutants stryker ran -- not those reused or settled early -- how many
 * tests they ran, how many tests covered them, how many were static, and
 * their statuses by mutator.
 *
 * Fed by the plugin; never throws, and reads every event defensively, since
 * it runs inside stryker and must not fail a run over a measurement. It keeps
 * counts and stryker's mutator and status names only -- a test's file name is
 * read to tell files apart and then dropped.
 */
import { isRecord } from './is-record.js';
import type { DryRunCounts, MutantRuns } from './mutant-work.js';
import { runBudgets } from './timeout-meter.js';

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

function isCount(value: unknown): value is number {
  // `Number.isFinite` does not coerce, so it is false for every non-number.
  return Number.isFinite(value);
}

/**
The tallies other than the mutator table, which is kept as maps.
*/
type Tallies = Omit<MutantRuns, 'byMutator'>;

/**
The mutants a plan said stryker would run, and what those reported so far.
*/
interface Planned {
  /**
  The Run plans' mutant ids not yet reported.
  */
  pending: Set<unknown>;
  tallies: Tallies;
  /**
  Statuses by mutator: maps, so no name stryker reports can reach a prototype.
  */
  byMutator: Map<string, Map<string, number>>;
}

/**
`result`'s covering tests, added to `tallies`, when it lists them.
*/
function addCoverage(tallies: Tallies, coveredBy: unknown): void {
  if (!Array.isArray(coveredBy)) {
    return;
  }
  tallies.coveredBy += coveredBy.length;
  tallies.withCoveredBy += 1;
}

function addStatus(planned: Planned, mutator: string, status: string): void {
  const statuses = planned.byMutator.get(mutator) ?? new Map<string, number>();
  statuses.set(status, (statuses.get(status) ?? 0) + 1);
  planned.byMutator.set(mutator, statuses);
}

export class WorkMeter {
  #dryRun: DryRunCounts | undefined;
  /**
  Unset before the plan.
  */
  #planned: Planned | undefined;

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

  planReady(event: unknown): void {
    this.#planned = {
      pending: new Set(runBudgets(event).keys()),
      tallies: {
        ran: 0,
        testsCompleted: 0,
        coveredBy: 0,
        withCoveredBy: 0,
        static: 0,
      },
      byMutator: new Map(),
    };
  }

  tested(result: unknown): void {
    const planned = this.#planned;
    if (
      planned === undefined ||
      !isRecord(result) ||
      !planned.pending.has(result.id)
    ) {
      return;
    }
    const { mutatorName, status } = result;
    if (typeof mutatorName !== 'string' || typeof status !== 'string') {
      return;
    }
    planned.pending.delete(result.id);
    const { tallies } = planned;
    tallies.ran += 1;
    if (isCount(result.testsCompleted)) {
      tallies.testsCompleted += result.testsCompleted;
    }
    addCoverage(tallies, result.coveredBy);
    if (result.static === true) {
      tallies.static += 1;
    }
    addStatus(planned, mutatorName, status);
  }

  /**
  What the dry run ran, or `undefined` before it said.
  */
  dryRun(): DryRunCounts | undefined {
    return this.#dryRun;
  }

  /**
  What the mutants stryker ran amounted to, or `undefined` before the plan.
  */
  mutantRuns(): MutantRuns | undefined {
    const planned = this.#planned;
    if (planned === undefined) {
      return undefined;
    }
    const byMutator = Object.fromEntries(
      [...planned.byMutator].map(([mutator, statuses]) => [
        mutator,
        Object.fromEntries(statuses),
      ]),
    );
    return { ...planned.tallies, byMutator };
  }
}
