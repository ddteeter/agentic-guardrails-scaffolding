/**
 * What a rung's dry runs and mutant runs did, for `guardrails stats` (#200):
 * the dry run's share of the lock time held, how many tests a gate ran, and
 * the mutants stryker ran by mutator and status -- so time can be read
 * against the number and kind of mutants.
 *
 * Read from the run-log rows' `dryRunMs`, `lock.heldMs`, `dryRunCounts` and
 * `mutantRuns`. Counts and stryker's mutator names only.
 */
import type { MutantRuns } from './mutant-work.js';
import type { GateRow } from './run-log.js';

/**
A mutator, its mutants, and their statuses, most first.
*/
type MutatorRow = [string, number, [string, number][]];

export interface WorkSummary {
  /**
  Dry-run time against lock time held, over the runs that know both.
  */
  share?: { dryRunMs: number; heldMs: number; runs: number } | undefined;
  /**
  Medians per gate, each over the runs that measured it.
  */
  dryRunTests?: number | undefined;
  dryRunTestFiles?: number | undefined;
  mutantTests?: number | undefined;
  /**
  The mutants stryker ran, added up over the runs that counted them.
  */
  mutants?:
    | (Omit<MutantRuns, 'byMutator' | 'testsCompleted'> & {
        runs: number;
        byMutator: MutatorRow[];
      })
    | undefined;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
The middle value (nearest rank), or `undefined` for none.
*/
function median(values: readonly number[]): number | undefined {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)];
}

function present<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function shareOf(rows: readonly GateRow[]): WorkSummary['share'] {
  const share = { dryRunMs: 0, heldMs: 0, runs: 0 };
  for (const { stryker, lock } of rows) {
    const dryRunMs = stryker?.dryRunMs;
    // No lock holds nothing, and a run that held nothing has no share.
    const heldMs = lock?.heldMs ?? 0;
    if (dryRunMs !== undefined && heldMs > 0) {
      share.dryRunMs += dryRunMs;
      share.heldMs += heldMs;
      share.runs += 1;
    }
  }
  return share.runs === 0 ? undefined : share;
}

function byCountThenName(
  [leftName, left]: readonly [string, number, ...unknown[]],
  [rightName, right]: readonly [string, number, ...unknown[]],
): number {
  return right - left || leftName.localeCompare(rightName);
}

function mutatorRows(all: readonly MutantRuns[]): MutatorRow[] {
  const table = new Map<string, Map<string, number>>();
  const entries = all.flatMap((runs) => Object.entries(runs.byMutator));
  for (const [mutator, statuses] of entries) {
    const counts = table.get(mutator) ?? new Map<string, number>();
    for (const [status, count] of Object.entries(statuses)) {
      counts.set(status, (counts.get(status) ?? 0) + count);
    }
    table.set(mutator, counts);
  }
  return [...table]
    .map(([mutator, counts]): MutatorRow => {
      const statuses = [...counts].toSorted(byCountThenName);
      return [mutator, sum(statuses.map(([, count]) => count)), statuses];
    })
    .toSorted(byCountThenName);
}

function mutantsOf(all: readonly MutantRuns[]): WorkSummary['mutants'] {
  if (all.length === 0) {
    return undefined;
  }
  const total = (key: 'ran' | 'coveredBy' | 'withCoveredBy' | 'static') =>
    sum(all.map((runs) => runs[key]));
  return {
    runs: all.length,
    ran: total('ran'),
    coveredBy: total('coveredBy'),
    withCoveredBy: total('withCoveredBy'),
    static: total('static'),
    byMutator: mutatorRows(all),
  };
}

/**
What the rung's runs say about their work, or `undefined` if none says.
*/
export function summarizeWork(
  rows: readonly GateRow[],
): WorkSummary | undefined {
  const parts = present(rows.map((row) => row.stryker));
  const counts = present(parts.map((part) => part.dryRunCounts));
  const runs = present(parts.map((part) => part.mutantRuns));
  const summary: WorkSummary = {
    share: shareOf(rows),
    dryRunTests: median(counts.map((each) => each.tests)),
    dryRunTestFiles: median(present(counts.map((each) => each.testFiles))),
    mutantTests: median(runs.map((each) => each.testsCompleted)),
    mutants: mutantsOf(runs),
  };
  return Object.values(summary).every((value) => value === undefined)
    ? undefined
    : summary;
}

function testsLine(summary: WorkSummary): string[] {
  const { dryRunTests, dryRunTestFiles, mutantTests } = summary;
  const parts = [
    ...(dryRunTests === undefined
      ? []
      : [
          `${String(dryRunTests)} in the dry run` +
            (dryRunTestFiles === undefined
              ? ''
              : ` (in ${String(dryRunTestFiles)} files)`),
        ]),
    ...(mutantTests === undefined
      ? []
      : [`${String(mutantTests)} in mutant runs`]),
  ];
  return parts.length === 0
    ? []
    : [`  tests per gate: median ${parts.join(', ')}`];
}

function mutantLines(mutants: WorkSummary['mutants']): string[] {
  if (mutants === undefined) {
    return [];
  }
  const coverage =
    mutants.withCoveredBy === 0
      ? ''
      : `; ${String(Math.round((mutants.coveredBy / mutants.withCoveredBy) * 10) / 10)} covering tests each on average`;
  return [
    `  mutants run: ${String(mutants.ran)} in ${String(mutants.runs)} run(s), ` +
      `${String(mutants.static)} static${coverage}`,
    ...mutants.byMutator.map(
      ([mutator, count, statuses]) =>
        `    ${mutator} ${String(count)}: ${statuses
          .map(([status, each]) => `${status} ${String(each)}`)
          .join(', ')}`,
    ),
  ];
}

/**
The summary as `guardrails stats` prints it under a rung.
*/
export function workLines(summary: WorkSummary | undefined): string[] {
  if (summary === undefined) {
    return [];
  }
  const { share } = summary;
  return [
    ...(share === undefined
      ? []
      : [
          `  dry run’s share of the lock held: ` +
            `${String(Math.round((share.dryRunMs / share.heldMs) * 100))}% ` +
            `over ${String(share.runs)} run(s)`,
        ]),
    ...testsLine(summary),
    ...mutantLines(summary.mutants),
  ];
}
