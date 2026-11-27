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
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

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
 * The clone a git common directory belongs to: the folder holding `.git`,
 * or the directory's own name less a trailing `.git` -- a bare repository's
 * `foo.git`, a submodule's `.git/modules/lib`.
 */
function cloneNameOf(commonDirectory: string): string {
  const base = path.basename(commonDirectory);
  if (base === '.git') {
    return path.basename(path.dirname(commonDirectory));
  }
  return base.endsWith('.git') ? base.slice(0, -'.git'.length) : base;
}

/**
 * The project a checkout belongs to (#236): one name for every worktree of a
 * clone, where the folder name differs per lane. Always a basename, never a
 * path; the folder's own name when git cannot say.
 */
export async function projectName(
  exec: Exec,
  repoRoot: string,
): Promise<string> {
  const result = await exec('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
  });
  // An empty answer resolves to `repoRoot` itself, and so to its name.
  const name =
    result.code === 0
      ? cloneNameOf(path.resolve(repoRoot, result.stdout.trim()))
      : '';
  return name === '' ? path.basename(repoRoot) : name;
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
    project: await projectName(input.exec, input.repoRoot),
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
  /**
  `projectName`'s answer, read before the run for the same reason.
  */
  project: string;
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
    project: input.project,
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
  /**
  `projectName`'s answer: the writer is synchronous.
  */
  project: string;
  shipId: string;
  /**
   * `runLogSize` when the ship started: its gates' rows can only follow it,
   * so the rows before it -- the machine's whole history -- are never read.
   * 0, the default, reads the whole log.
   */
  logOffset?: number | undefined;
  start: RunStart;
  status: { state: string; branch: string; pr: number | null };
  pushMs: number | undefined;
  ciMs: number | undefined;
  warn: (line: string) => void;
  clock?: RunClock | undefined;
}

/**
 * The run log beside `lockPath` in bytes, 0 when there is none yet or no
 * lock: where a ship starting now finds the rows written after it
 * (`logOffset`).
 */
export function runLogSize(lockPath: string | undefined): number {
  if (lockPath === undefined) {
    return 0;
  }
  try {
    return statSync(runLogPath(lockPath)).size;
  } catch {
    return 0;
  }
}

/**
 * The log's text from byte `offset` on -- or all of it, when it is shorter
 * than `offset`, as a log replaced since is. `undefined` when it cannot be
 * read. Rows are appended whole, so `offset` falls between two.
 */
export function readRunLogFrom(
  file: string,
  offset: number,
): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = fstatSync(descriptor);
    const start = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * How long this ship's gates took, together: every gate row stamped with its
 * id -- the gate ship runs before the push, and the hook's, which is quick
 * when it finds that gate's pass and runs in full when it does not (#204).
 * `undefined` when no gate wrote a row (no stryker lock, an older hook, a
 * ship that never reached a gate). Only the rows from `offset` on are read:
 * the log is machine-wide and never trimmed.
 */
function gateMsOf(
  file: string,
  shipId: string,
  offset: number,
): number | undefined {
  const text = readRunLogFrom(file, offset);
  if (text === undefined) {
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
    project: input.project,
    branch: input.status.branch,
    ship: input.shipId,
    startedAt: input.start.startedAt,
    finishedAt: clock.now().toISOString(),
    pr: input.status.pr,
    state: input.status.state,
    pushMs: input.pushMs ?? 0,
    gateMs: gateMsOf(file, input.shipId, input.logOffset ?? 0),
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
