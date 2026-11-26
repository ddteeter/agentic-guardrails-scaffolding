/**
 * What one stryker run in a gate amounts to, for the run log (#176): its lock
 * timing, its cache outcome, its phase times from the progress plugin's
 * summary, and its mutant counts from stryker's JSON report.
 *
 * Pure: `runStryker` reads the summary and the report and hands their text
 * over. Every source may be missing -- an unlocked run has no timing, a run
 * without the built plugin no summary, a crash no report -- and the record
 * then says only what it knows.
 */
import {
  parseRunSummary,
  type RunSummary,
  type TimeoutCosts,
  type TimeoutSettings,
} from '../lock-holder.js';
import type { DryRunCounts } from '../mutant-work.js';
import type { LockTiming } from '../mutation-lock.js';
import type { CacheOutcome } from './prepare-cache.js';
import { statusCounts } from './stryker-adapter.js';

/**
The lock part of a run-log row.
*/
interface LockRecord {
  queuedMs: number;
  heldMs: number;
  holderOnArrival?: string;
  depthOnArrival: number;
}

/**
The stryker part of a run-log row.
*/
interface StrykerRecord {
  files: number;
  cache: CacheOutcome;
  dryRunMs?: number;
  mutatingMs?: number;
  mutants?: number;
  reused?: number;
  timeouts?: number;
  survivors?: number;
  noCoverage?: number;
  /**
  Timed-out mutants re-tested alone after the run (#202).
  */
  retested?: number;
  /**
  Of those, the ones that did not time out again.
  */
  rescored?: number;
  /**
  What the re-test measured, alone (#236): see `RetestCounts`.
  */
  retestMutatingMs?: number;
  retestBudgetMs?: number;
  retestTimedOut?: number;
  /**
  What this run's timeouts cost, from the plugin's summary (#236).
  */
  timeoutCost?: TimeoutCosts;
  /**
  The settings its timeout budgets were made of (#236).
  */
  timeoutSettings?: TimeoutSettings;
  /**
  How many tests the dry run ran, and in how many files (#200).
  */
  dryRunCounts?: DryRunCounts;
  report: 'read' | 'missing';
}

export interface MutationRunRecord {
  /**
  Stryker ran, rather than being deferred or giving up on the lock.
  */
  didRun: boolean;
  lock?: LockRecord;
  stryker: StrykerRecord;
  /**
  Stryker's configured `concurrency`, set by `runStryker`.
  */
  concurrency?: string;
}

export interface MutationRunInputs {
  files: number;
  cache: CacheOutcome;
  /**
  Absent when the run took no lock.
  */
  timing?: LockTiming | undefined;
  /**
  Whether stryker ran at all, rather than being deferred or timed out.
  */
  didRun: boolean;
  /**
  The plugin's summary file, or `''` when there is none.
  */
  summaryText: string;
  /**
  Stryker's JSON report, or `''` when there is none.
  */
  reportText: string;
  /**
  What the timeout re-test did, when one ran (#202).
  */
  retest?: RetestCounts | undefined;
}

/**
What a timeout re-test amounted to (#202).
*/
export interface RetestCounts extends RetestMeasurement {
  retested: number;
  rescored: number;
}

/**
 * What the re-test's own run summary says (#236). It runs at concurrency 1,
 * so its mutating time is what its mutants cost, one after another, and
 * against the budget stryker gave the ones that timed out again it shows
 * what a timeout costs beyond its budget: the worker restart. Each is absent
 * when the summary does not say.
 */
export interface RetestMeasurement {
  /**
  The re-test's mutating time.
  */
  retestMutatingMs?: number;
  /**
  The timeout budget of its wall-clock timeouts, added up.
  */
  retestBudgetMs?: number;
  /**
  Its wall-clock timeouts.
  */
  retestTimedOut?: number;
}

/**
What the re-test's run summary, `summaryText`, measured.
*/
export function retestMeasurement(summaryText: string): RetestMeasurement {
  const summary = parseRunSummary(summaryText);
  const { mutatingMs } = phaseTimes(summary);
  const costs = summary?.timeouts;
  return {
    ...(mutatingMs !== undefined && { retestMutatingMs: mutatingMs }),
    ...(costs !== undefined && {
      retestBudgetMs: costs.budgetMs,
      retestTimedOut: costs.wallClock,
    }),
  };
}

/**
 * The lock part. A run that held the lock splits its time at the moment
 * stryker started, which the plugin's summary records; without a summary the
 * split is unknown and all of it counts as held, as if the lock was free. A
 * run that never got the lock only queued.
 */
function lockRecord(
  timing: LockTiming,
  didRun: boolean,
  summary: RunSummary | undefined,
): LockRecord {
  const acquiredAt = didRun
    ? Math.min(
        Math.max(summary?.startedAt ?? timing.queuedAt, timing.queuedAt),
        timing.releasedAt,
      )
    : timing.releasedAt;
  return {
    queuedMs: acquiredAt - timing.queuedAt,
    heldMs: timing.releasedAt - acquiredAt,
    ...(timing.holderOnArrival !== undefined && {
      holderOnArrival: timing.holderOnArrival,
    }),
    depthOnArrival: timing.depthOnArrival,
  };
}

function phaseTimes(
  summary: RunSummary | undefined,
): Pick<StrykerRecord, 'dryRunMs' | 'mutatingMs' | 'reused'> {
  if (summary === undefined) {
    return {};
  }
  const { startedAt, planReadyAt, reportReadyAt } = summary;
  return {
    ...(planReadyAt !== undefined && { dryRunMs: planReadyAt - startedAt }),
    ...(planReadyAt !== undefined &&
      reportReadyAt !== undefined && {
        mutatingMs: reportReadyAt - planReadyAt,
      }),
    reused: summary.reused,
  };
}

export function mutationRunRecord(
  inputs: MutationRunInputs,
): MutationRunRecord {
  const summary = inputs.didRun
    ? parseRunSummary(inputs.summaryText)
    : undefined;
  const counts = inputs.didRun ? statusCounts(inputs.reportText) : undefined;
  const stryker: StrykerRecord = {
    files: inputs.files,
    cache: inputs.cache,
    ...phaseTimes(summary),
    ...(summary?.timeouts !== undefined && { timeoutCost: summary.timeouts }),
    ...(summary?.settings !== undefined && {
      timeoutSettings: summary.settings,
    }),
    ...(summary?.dryRunCounts !== undefined && {
      dryRunCounts: summary.dryRunCounts,
    }),
    ...(counts !== undefined && {
      mutants: counts.total,
      timeouts: counts.Timeout ?? 0,
      survivors: counts.Survived ?? 0,
      noCoverage: counts.NoCoverage ?? 0,
    }),
    ...inputs.retest,
    report: counts === undefined ? 'missing' : 'read',
  };
  return {
    didRun: inputs.didRun,
    ...(inputs.timing !== undefined && {
      lock: lockRecord(inputs.timing, inputs.didRun, summary),
    }),
    stryker,
  };
}
