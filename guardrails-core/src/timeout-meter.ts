/**
 * What a run's timeouts cost (#236), as the progress plugin sees them.
 *
 * Stryker gives every mutant it runs a timeout of `timeoutFactor × netTime +
 * timeoutMS + the dry run's overhead`, and a wall-clock Timeout then restarts
 * the test runner process. Neither the restart nor a mutant's own duration is
 * reported to a plugin: what it sees is the plan (each mutant's timeout) and
 * each result as it completes. So this adds up, per kind of result, the
 * budget stryker set and the time since the result before -- which is the
 * mutant's real cost at concurrency 1, the timeout re-test's setting (#202).
 *
 * Fed by the plugin; never throws, and reads every event defensively, since
 * it runs inside stryker and must not fail a run over a measurement.
 */
import path from 'node:path';

import { isRecord } from './is-record.js';
import {
  type TimeoutCosts,
  type TimeoutFile,
  type TimeoutSettings,
  timeoutSettingsOf,
} from './lock-holder.js';
import { isHitLimitReason } from './timeout-reason.js';

/**
At most this many files are named.
*/
const TOP_FILES = 5;

interface FileTally {
  count: number;
  firstLine: number;
  lastLine: number;
}

function isCount(value: unknown): value is number {
  // `Number.isFinite` does not coerce, so it is false for every non-number.
  return Number.isFinite(value);
}

/**
`fileName` relative to `root`, with `/` between its parts.
*/
function repoRelative(root: string, fileName: string): string {
  const relative = path.isAbsolute(fileName)
    ? path.relative(root, fileName)
    : fileName;
  return relative.split(path.sep).join('/');
}

/**
The line a result's location starts on, or `0` when it does not say.
*/
function startLine(location: unknown): number {
  const start = isRecord(location) ? location.start : undefined;
  const line = isRecord(start) ? start.line : undefined;
  return isCount(line) ? line : 0;
}

/**
The timeout stryker gave a Run plan, or `0` when it does not say.
*/
function budgetOf(plan: Readonly<Record<string, unknown>>): number {
  const { runOptions } = plan;
  const timeout = isRecord(runOptions) ? runOptions.timeout : undefined;
  return isCount(timeout) ? timeout : 0;
}

/**
Each Run plan's mutant id, and the timeout stryker gave it.
*/
function runBudgets(event: unknown): Map<unknown, number> {
  const budgets = new Map<unknown, number>();
  const plans = isRecord(event) ? event.mutantPlans : undefined;
  if (!Array.isArray(plans)) {
    return budgets;
  }
  const list: unknown[] = plans;
  for (const plan of list) {
    if (!isRecord(plan) || plan.plan !== 'Run') {
      continue;
    }
    const { mutant } = plan;
    if (isRecord(mutant) && typeof mutant.id === 'string') {
      budgets.set(mutant.id, budgetOf(plan));
    }
  }
  return budgets;
}

/**
The mutants a plan said stryker would run, and when the last one reported.
*/
interface Planned {
  /**
  The Run plans not yet reported: each mutant's timeout, by its id.
  */
  budgets: Map<unknown, number>;
  /**
  When the last counted result (or the plan) arrived.
  */
  last: number;
}

function byCountThenName(
  [leftFile, left]: [string, FileTally],
  [rightFile, right]: [string, FileTally],
): number {
  return right.count - left.count || leftFile.localeCompare(rightFile);
}

export class TimeoutMeter {
  readonly #root: string;
  readonly #options: TimeoutSettings | undefined;
  #dryRun: TimeoutSettings | undefined;
  /**
  Unset before the plan.
  */
  #planned: Planned | undefined;
  readonly #costs: Omit<TimeoutCosts, 'byFile'> = {
    wallClock: 0,
    hitLimit: 0,
    budgetMs: 0,
    wallClockGapMs: 0,
    otherGapMs: 0,
  };
  readonly #files = new Map<string, FileTally>();

  /**
   * `root` is the repo, which file names are made relative to; `options` is
   * what stryker injects, read for its timeout settings and nothing else.
   */
  constructor(root: string, options: unknown) {
    this.#root = root;
    const { timeoutMS, timeoutFactor, concurrency } = isRecord(options)
      ? options
      : {};
    this.#options = timeoutSettingsOf({
      timeoutMS,
      timeoutFactor,
      concurrency,
    });
  }

  #tallyFile(result: Readonly<Record<string, unknown>>): void {
    if (typeof result.fileName !== 'string') {
      return;
    }
    const file = repoRelative(this.#root, result.fileName);
    const line = startLine(result.location);
    const tally = this.#files.get(file);
    this.#files.set(file, {
      count: (tally?.count ?? 0) + 1,
      firstLine: Math.min(tally?.firstLine ?? line, line),
      lastLine: Math.max(tally?.lastLine ?? line, line),
    });
  }

  dryRunCompleted(event: unknown): void {
    const timing = isRecord(event) ? event.timing : undefined;
    if (isRecord(timing)) {
      this.#dryRun = timeoutSettingsOf({
        dryRunNetMs: timing.net,
        dryRunOverheadMs: timing.overhead,
      });
    }
  }

  planReady(event: unknown, at: number): void {
    this.#planned = { budgets: runBudgets(event), last: at };
  }

  tested(result: unknown, at: number): void {
    const planned = this.#planned;
    if (planned === undefined || !isRecord(result)) {
      return;
    }
    const budget = planned.budgets.get(result.id);
    if (budget === undefined) {
      return;
    }
    planned.budgets.delete(result.id);
    const gap = at - planned.last;
    planned.last = at;
    if (result.status !== 'Timeout') {
      this.#costs.otherGapMs += gap;
      return;
    }
    if (isHitLimitReason(result.statusReason)) {
      this.#costs.hitLimit += 1;
      this.#costs.otherGapMs += gap;
      return;
    }
    this.#costs.wallClock += 1;
    this.#costs.budgetMs += budget;
    this.#costs.wallClockGapMs += gap;
    this.#tallyFile(result);
  }

  /**
  The settings known so far, or `undefined` for none.
  */
  settings(): TimeoutSettings | undefined {
    return this.#options === undefined && this.#dryRun === undefined
      ? undefined
      : { ...this.#options, ...this.#dryRun };
  }

  /**
  What the timeouts cost, or `undefined` before the plan.
  */
  costs(): TimeoutCosts | undefined {
    if (this.#planned === undefined) {
      return undefined;
    }
    const byFile: TimeoutFile[] = [...this.#files]
      .toSorted(byCountThenName)
      .slice(0, TOP_FILES)
      .map(([file, tally]) => ({ file, ...tally }));
    return { ...this.#costs, byFile };
  }
}
