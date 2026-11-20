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
import { type RunSummary, parseRunSummary } from '../lock-holder.js';
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
    ...(counts !== undefined && {
      mutants: counts.total,
      timeouts: counts.Timeout ?? 0,
      survivors: counts.Survived ?? 0,
      noCoverage: counts.NoCoverage ?? 0,
    }),
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
