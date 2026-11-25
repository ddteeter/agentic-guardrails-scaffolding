/**
 * The gate's rows in the machine-wide run log (#176).
 *
 * A gate records when it started and how loaded the machine was, collects
 * the stryker run's record from `runVerify`, and appends one row when it
 * finishes. Commit and push gates always write one; a stop gate only when
 * stryker had something in scope, since a stop turn with nothing to mutate
 * is noise and there are hundreds. Nothing here can fail a gate: a log that
 * cannot be written is one line on stderr.
 */
import { availableParallelism } from 'node:os';
import path from 'node:path';

import type { Exec } from './exec.js';
import { readFileSync } from 'node:fs';

import {
  appendRun,
  type GateRow,
  type LockRow,
  parseRuns,
  type ShipRow,
  type MachineSample,
  runLogPath,
  sampleMachine,
} from './run-log.js';
import type { MutationRunRecord } from './verify/mutation-run.js';

export interface RunStart {
  startedAt: string;
  machine: MachineSample;
}

export interface RunClock {
  now: () => Date;
  sample: () => MachineSample;
  cores: () => number;
}

const SYSTEM_CLOCK: RunClock = {
  now: () => new Date(),
  sample: () => sampleMachine(),
  cores: availableParallelism,
};

export function startRun(clock: RunClock = SYSTEM_CLOCK): RunStart {
  return { startedAt: clock.now().toISOString(), machine: clock.sample() };
}

export interface GateRunInput {
  /**
  The gate lock's path; no lock, no machine-wide log to write to.
  */
  lockPath: string | undefined;
  repoRoot: string;
  exec: Exec;
  rung: string;
  start: RunStart;
  mutationRun: MutationRunRecord | undefined;
  isBlocked: boolean;
  /**
  `GUARDRAILS_SHIP_ID` and the like.
  */
  environment: Readonly<Record<string, string | undefined>>;
  warn: (line: string) => void;
  clock?: RunClock;
}

/**
 * What the gate amounted to: a block or a pass, or -- when stryker never got
 * the lock -- a timeout (blocking) or a deferral (passing).
 */
function outcomeOf(
  mutationRun: MutationRunRecord | undefined,
  isBlocked: boolean,
): string {
  if (mutationRun?.didRun === false) {
    return isBlocked ? 'lock-timeout' : 'defer';
  }
  return isBlocked ? 'block' : 'pass';
}

export async function branchOf(
  exec: Exec,
  repoRoot: string,
): Promise<string | undefined> {
  const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
  });
  const branch = head.stdout.trim();
  return branch !== '' && head.code === 0 ? branch : undefined;
}

/**
Append this gate's row, when it should have one.
*/
export async function logGateRun(input: GateRunInput): Promise<void> {
  const { lockPath, mutationRun } = input;
  const isStopWithoutStryker =
    input.rung === 'stop' && mutationRun === undefined;
  if (lockPath === undefined || isStopWithoutStryker) {
    return;
  }
  const clock = input.clock ?? SYSTEM_CLOCK;
  const ship = input.environment.GUARDRAILS_SHIP_ID;
  const row: GateRow = {
    v: 1,
    kind: 'gate',
    rung: input.rung,
    repo: path.basename(input.repoRoot),
    branch: await branchOf(input.exec, input.repoRoot),
    ship: ship === '' ? undefined : ship,
    startedAt: input.start.startedAt,
    finishedAt: clock.now().toISOString(),
    outcome: outcomeOf(mutationRun, input.isBlocked),
    ...(mutationRun?.lock !== undefined && { lock: mutationRun.lock }),
    ...(mutationRun !== undefined && { stryker: mutationRun.stryker }),
    machine: {
      cores: clock.cores(),
      concurrency: mutationRun?.concurrency ?? 'default',
      start: input.start.machine,
      end: clock.sample(),
    },
  };
  const error = appendRun(runLogPath(lockPath), row);
  if (error !== undefined) {
    input.warn(`guardrails: could not write the run log (${error}).`);
  }
}

/**
 * What a `guardrails lock` run (#201) amounted to: the `LockRow` fields that
 * are its own, with the base and machine parts left to `logLockRun`.
 */
export type LockRunResult = Pick<
  LockRow,
  'command' | 'commandHash' | 'exitCode' | 'signal' | 'outcome' | 'lock'
>;

export interface LockRunInput {
  lockPath: string;
  repoRoot: string;
  /**
  Read before the run, so a run killed by a signal can still be logged
  synchronously on its way out.
  */
  branch: string | undefined;
  start: RunStart;
  run: LockRunResult;
  environment: Readonly<Record<string, string | undefined>>;
  warn: (line: string) => void;
  clock?: RunClock | undefined;
}

/**
 * Append a `guardrails lock` run's row. Synchronous, so the signal handler of
 * a run being killed can write it before the process exits.
 */
export function logLockRun(input: LockRunInput): void {
  const clock = input.clock ?? SYSTEM_CLOCK;
  const ship = input.environment.GUARDRAILS_SHIP_ID;
  const row: LockRow = {
    v: 1,
    kind: 'lock',
    repo: path.basename(input.repoRoot),
    branch: input.branch,
    ship: ship === '' ? undefined : ship,
    startedAt: input.start.startedAt,
    finishedAt: clock.now().toISOString(),
    ...input.run,
    machine: {
      cores: clock.cores(),
      concurrency: 'default',
      start: input.start.machine,
      end: clock.sample(),
    },
  };
  const error = appendRun(runLogPath(input.lockPath), row);
  if (error !== undefined) {
    input.warn(`guardrails: could not write the run log (${error}).`);
  }
}

export interface ShipRunInput {
  lockPath: string | undefined;
  repoRoot: string;
  shipId: string;
  start: RunStart;
  status: { state: string; branch: string; pr: number | null };
  pushMs: number | undefined;
  ciMs: number | undefined;
  warn: (line: string) => void;
  clock?: RunClock | undefined;
}

/**
 * How long this ship's gates took, together: every gate row stamped with its
 * id -- the gate ship runs before the push, and the hook's, which is quick
 * when it finds that gate's pass and runs in full when it does not (#204).
 * `undefined` when no gate wrote a row (no stryker lock, an older hook, a
 * ship that never reached a gate).
 */
function gateMsOf(file: string, shipId: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const times = parseRuns(text)
    .filter((row) => row.kind === 'gate' && row.ship === shipId)
    .map((gate) => Date.parse(gate.finishedAt) - Date.parse(gate.startedAt));
  return times.length === 0
    ? undefined
    : times.reduce((total, ms) => total + ms, 0);
}

/**
Append a ship's row, with its gate's time read back from the gate's row.
*/
export function logShipRun(input: ShipRunInput): void {
  const { lockPath } = input;
  if (lockPath === undefined) {
    return;
  }
  const clock = input.clock ?? SYSTEM_CLOCK;
  const file = runLogPath(lockPath);
  const row: ShipRow = {
    v: 1,
    kind: 'ship',
    repo: path.basename(input.repoRoot),
    branch: input.status.branch,
    ship: input.shipId,
    startedAt: input.start.startedAt,
    finishedAt: clock.now().toISOString(),
    pr: input.status.pr,
    state: input.status.state,
    pushMs: input.pushMs ?? 0,
    gateMs: gateMsOf(file, input.shipId),
    ciMs: input.ciMs,
    machine: {
      cores: clock.cores(),
      concurrency: 'default',
      start: input.start.machine,
      end: clock.sample(),
    },
  };
  const error = appendRun(file, row);
  if (error !== undefined) {
    input.warn(`guardrails: could not write the run log (${error}).`);
  }
}
