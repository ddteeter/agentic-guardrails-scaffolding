/**
 * `guardrails lock [--timeout=<s>] -- <cmd> [args…]` (#201): run any command
 * under the machine-wide gate lock, name it to whoever queues behind it, and
 * log it to the run log as a `kind: lock` row.
 *
 * The lock is the one `mutation-lock.ts` takes around stryker, by the same
 * lockers. What this adds is a holder for anything else: a whole-repo
 * mutation run, a build or a benchmark that takes the lock by hand would
 * otherwise read, to a gate queued behind it, as "another checkout holds it".
 */
import { createHash, randomUUID } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './config.js';
import {
  type Exec,
  type ExecResult,
  forwardTerminationSignal,
} from './exec.js';
import {
  branchOf,
  type LockRunResult,
  logLockRun,
  projectName,
  startRun,
} from './gate-run-log.js';
import { type JsonFileResult, readJsonFile } from './json-file.js';
import { isRecord } from './is-record.js';
import { holderPath } from './lock-holder.js';
import {
  canOpenForAppend,
  detectLocker,
  isLockBusy,
  LOCK_HELD_VARIABLE,
  LOCK_TIMEOUT_EXIT,
  LOCK_TIMEOUT_MARKER,
  type Locker,
  lockerArgv,
  type LockSighting,
  type LockWatchSeams,
  lookAtLock,
  machineLock,
  type MutationLock,
  watchTheWait,
} from './mutation-lock.js';
import { findGitRoot } from './repo-root.js';
import type { LockRow } from './run-log.js';

/**
What the command line asked for, or why it cannot be run.
*/
export type LockArguments =
  { timeoutSeconds?: number; argv: string[] } | { error: string };

const NO_COMMAND = 'put the command after --: guardrails lock -- <cmd> [args…]';

const TIMEOUT_PREFIX = '--timeout=';

/**
 * The flags before `--`, and the command after it. Nothing after `--` is read
 * as a flag: those are the command's own, `--` included.
 */
export function parseLockArguments(rest: readonly string[]): LockArguments {
  const separator = rest.indexOf('--');
  const argv = rest.slice(separator + 1);
  if (separator === -1 || argv.length === 0) {
    return { error: NO_COMMAND };
  }
  let timeoutSeconds: number | undefined;
  for (const option of rest.slice(0, separator)) {
    if (!option.startsWith(TIMEOUT_PREFIX)) {
      return { error: `unknown flag ${option} (only --timeout=<seconds>)` };
    }
    const text = option.slice(TIMEOUT_PREFIX.length);
    if (!/^\d+$/.test(text)) {
      return { error: `${option} is not a whole number of seconds` };
    }
    timeoutSeconds = Number(text);
  }
  return timeoutSeconds === undefined ? { argv } : { timeoutSeconds, argv };
}

/**
 * How the run log names a command: the basename of its program, and a hash of
 * the whole command line. Never the argument values -- the log is
 * machine-wide, and a command line can carry a token or a home-directory path.
 */
export function commandIdentity(argv: readonly string[]): {
  command: string;
  commandHash: string;
} {
  return {
    command: path.basename(argv[0] ?? ''),
    commandHash: createHash('sha256')
      .update(JSON.stringify(argv))
      .digest('hex')
      .slice(0, 16),
  };
}

/**
The shim's exit when it could not write the start mark (sysexits'
`EX_CANTCREAT`).
*/
const START_MARK_EXIT = 73;

/**
 * The script the locker runs once it holds the lock. It marks the start (the
 * file whose existence tells a real exit 75 from a timeout, and whose mtime is
 * when the lock was taken), writes the holder file -- to a temporary name,
 * then renamed, so a waiter never reads half of it -- and then `exec`s the
 * command, which keeps the pid the holder file names. A holder file that
 * cannot be written costs only its label: the command runs regardless. A
 * start mark that cannot be written stops the run before the command: without
 * it, the command's own exit 75 would read as a lock timeout, so the shim
 * exits `START_MARK_EXIT` instead.
 *
 * `$1` is the start mark, `$2` the holder file, `$3` the holder record up to
 * its `pid`; the command follows. `printf`, not `:`, makes the mark: a failed
 * redirection on a special built-in would end the shell.
 */
const HOLDER_SHIM =
  `{ printf "" > "$1" || exit ${String(START_MARK_EXIT)}; ` +
  String.raw`printf '%s%s,"startedAt":%s000}\n' "$3" "$$" "$(date +%s)" > "$2.$$" && ` +
  'mv -f "$2.$$" "$2"; } 2>/dev/null; shift 3; exec "$@"';

/**
What the holder file says about a `guardrails lock` run, besides its pid.
*/
interface HolderRecord {
  repo: string;
  command: string;
  token: string;
}

/**
 * `argv` run under the lock by the holder shim: the locker, then `sh -c` with
 * the shim, then the command, each argument its own word -- nothing is
 * re-parsed by a shell.
 */
export function holderShimArgv(input: {
  locker: Locker;
  lockPath: string;
  waitSeconds: number;
  startedFile: string;
  record: HolderRecord;
  argv: readonly string[];
}): { command: string; args: string[] } {
  const { kind, ...record } = { kind: 'lock', ...input.record };
  const prefix = `${JSON.stringify({ kind, ...record }).slice(0, -1)},"pid":`;
  return lockerArgv(input.locker, input.lockPath, input.waitSeconds, 'sh', [
    '-c',
    HOLDER_SHIM,
    'guardrails-lock',
    input.startedFile,
    holderPath(input.lockPath),
    prefix,
    ...input.argv,
  ]);
}

type LockPart = NonNullable<LockRow['lock']>;

/**
 * How far a `guardrails lock` run has got with the lock, kept up to date as
 * it goes, so a run killed part-way can still be logged with what it knew.
 */
interface LockTracker {
  /**
  When the lock was asked for; absent until then.
  */
  queuedAt?: number;
  holderOnArrival?: string;
  depthOnArrival: number;
  /**
  The shim's start mark, once the locker is started.
  */
  startedFile?: string;
  token?: string;
}

/**
 * The lock part of the row, from when the lock was asked for, taken (the start
 * mark, or never) and given up. The mark is clamped into that span: its mtime
 * is the filesystem's clock, at the filesystem's granularity.
 */
function lockPartOf(
  tracker: LockTracker,
  acquiredAt: number | undefined,
  releasedAt: number,
): LockPart {
  const queuedAt = tracker.queuedAt ?? releasedAt;
  const acquired = Math.min(
    Math.max(Math.round(acquiredAt ?? releasedAt), queuedAt),
    releasedAt,
  );
  return {
    queuedMs: acquired - queuedAt,
    heldMs: releasedAt - acquired,
    ...(tracker.holderOnArrival !== undefined && {
      holderOnArrival: tracker.holderOnArrival,
    }),
    depthOnArrival: tracker.depthOnArrival,
  };
}

/**
When the start mark was made, or `undefined` when it never was.
*/
function startMarkTime(file: string): number | undefined {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs;
}

/**
 * Remove the start mark, and the holder file when this run wrote it -- its
 * token says so. One another run has written since is left alone.
 */
function cleanUpHolder(
  lockPath: string,
  tracker: LockTracker,
  readJson: (filePath: string) => JsonFileResult = readJsonFile,
): void {
  if (tracker.startedFile !== undefined) {
    removeIfPresent(tracker.startedFile);
  }
  const file = holderPath(lockPath);
  const { parsed } = readJson(file);
  if (
    tracker.token !== undefined &&
    isRecord(parsed) &&
    parsed.token === tracker.token
  ) {
    removeIfPresent(file);
  }
}

/**
 * Remove `file`, which may be gone already: a start mark that was never made,
 * or a holder file another run has replaced since it was read.
 */
function removeIfPresent(file: string): void {
  rmSync(file, { force: true });
}

/**
What became of a command offered to `runCommandUnderLock`.
*/
export type CommandLockRun =
  | { outcome: 'ran'; result: ExecResult; lock: LockPart }
  /**
  Run without the lock: no locker, an unusable lock file, or a lock this
  process already holds through the `guardrails lock` it runs under.
  */
  | { outcome: 'unserialized' | 'already-held'; result: ExecResult }
  /**
  The wait ran out: nothing ran.
  */
  | { outcome: 'lock-timeout'; holding: string; lock: LockPart }
  /**
  The lock was taken but the start mark could not be written: nothing ran.
  */
  | { outcome: 'no-start-mark'; startedFile: string; lock: LockPart };

export interface CommandLockOptions {
  exec: Exec;
  lock: MutationLock;
  /**
  The command and its arguments; never empty.
  */
  argv: string[];
  waitSeconds: number;
  /**
  The checkout the holder file names.
  */
  repoRoot: string;
  cwd: string;
  /**
  Where the lock's own lines go.
  */
  progress: (line: string) => void;
  /**
  Where the command's output goes, as it arrives.
  */
  stream: { stdout: (text: string) => void; stderr: (text: string) => void };
  environment: NodeJS.ProcessEnv;
  /**
  Kept up to date as the run goes; a fresh one by default.
  */
  tracker?: LockTracker;
  /**
  Seams: the run's token, its start mark, the lock-file check, the clock, the
  start mark's time, and the lock-watching seams.
  */
  token?: string;
  startedFile?: string;
  canOpenLock?: (lockPath: string) => boolean;
  clock?: () => number;
  startedAt?: (file: string) => number | undefined;
  watch?: LockWatchSeams;
}

function noLockerNote(name: string): string {
  return (
    `guardrails: no lockf or flock on this machine — running ${name} ` +
    'unserialized. Install util-linux (flock) to serialize it.'
  );
}

function unusableLockNote(lockPath: string, name: string): string {
  return (
    `guardrails: could not open the gate lock at ${lockPath} — running ` +
    `${name} unserialized. Set GUARDRAILS_GATE_LOCK to a writable path.`
  );
}

function arrive(tracker: LockTracker, sighting: LockSighting): void {
  tracker.holderOnArrival = sighting.holding;
  tracker.depthOnArrival = sighting.waiting;
}

/**
 * Run `argv` under the machine-wide gate lock, waiting at most `waitSeconds`
 * (0: try once), or report that the wait ran out.
 *
 * As with the gate's own lock, a lock that cannot be taken -- no locker, a
 * lock file that cannot be opened -- RUNS the command unserialized and says
 * so. Unlike the gate's, a command whose program is missing is never re-run:
 * the shim's `exec` exits 127, and that is the answer.
 */
export async function runCommandUnderLock(
  options: CommandLockOptions,
): Promise<CommandLockRun> {
  const { exec, lock, argv, cwd, progress, environment, stream } = options;
  const [program = '', ...args] = argv;
  const name = path.basename(program);
  const spawnOptions = {
    cwd,
    processGroup: true,
    stopGraceSeconds: lock.config.stopGraceSeconds,
    stream,
  };
  const runBare = async (
    outcome: 'unserialized' | 'already-held',
  ): Promise<CommandLockRun> => ({
    outcome,
    result: await exec(program, args, { ...spawnOptions, env: environment }),
  });
  if (environment[LOCK_HELD_VARIABLE] === lock.path) {
    progress(
      `guardrails: the gate lock (${lock.path}) is already held by the ` +
        `guardrails lock this runs under — running ${name} without queueing for it.`,
    );
    return runBare('already-held');
  }
  const locker = await detectLocker(exec);
  if (locker === undefined) {
    progress(noLockerNote(name));
    return runBare('unserialized');
  }
  if (!(options.canOpenLock ?? canOpenForAppend)(lock.path)) {
    progress(unusableLockNote(lock.path, name));
    return runBare('unserialized');
  }
  return runLocked(options, locker, name);
}

async function runLocked(
  options: CommandLockOptions,
  locker: Locker,
  name: string,
): Promise<CommandLockRun> {
  const { exec, lock, cwd, progress, waitSeconds } = options;
  const clock = options.clock ?? Date.now;
  const tracker = options.tracker ?? { depthOnArrival: 0 };
  tracker.queuedAt = clock();
  const isBusy = await isLockBusy(exec, locker, lock.path, cwd);
  const look = (): Promise<LockSighting> =>
    lookAtLock(exec, lock.path, options.watch);
  if (isBusy && waitSeconds === 0) {
    const sighting = await look();
    arrive(tracker, sighting);
    return {
      outcome: 'lock-timeout',
      holding: sighting.holding,
      lock: lockPartOf(tracker, undefined, clock()),
    };
  }
  const watching = isBusy
    ? await watchTheWait(
        look,
        waitSeconds,
        progress,
        options.watch,
        'gate lock',
      )
    : undefined;
  if (watching !== undefined) {
    arrive(tracker, watching.first);
  }
  const token = options.token ?? randomUUID();
  const startedFile =
    options.startedFile ??
    path.join(tmpdir(), `guardrails-lock-${token}.started`);
  tracker.token = token;
  tracker.startedFile = startedFile;
  const shim = holderShimArgv({
    locker,
    lockPath: lock.path,
    waitSeconds,
    startedFile,
    record: { repo: options.repoRoot, command: name, token },
    argv: options.argv,
  });
  let result: ExecResult;
  try {
    result = await exec(shim.command, shim.args, {
      cwd,
      processGroup: true,
      stopGraceSeconds: lock.config.stopGraceSeconds,
      stream: options.stream,
      env: { ...options.environment, [LOCK_HELD_VARIABLE]: lock.path },
    });
  } finally {
    watching?.stop();
  }
  const releasedAt = clock();
  const acquiredAt = (options.startedAt ?? startMarkTime)(startedFile);
  cleanUpHolder(lock.path, tracker);
  const part = lockPartOf(tracker, acquiredAt, releasedAt);
  if (acquiredAt === undefined && result.code === LOCK_TIMEOUT_EXIT) {
    const { holding } = await look();
    return { outcome: 'lock-timeout', holding, lock: part };
  }
  if (acquiredAt === undefined && result.code === START_MARK_EXIT) {
    return { outcome: 'no-start-mark', startedFile, lock: part };
  }
  return { outcome: 'ran', result, lock: part };
}

const LOCK_USAGE =
  'usage: guardrails lock [--timeout=<seconds>] -- <cmd> [args…]';

/**
What `lockCommand` needs of the CLI. `CliDependencies` is one.
*/
export interface LockCommandDependencies {
  exec: Exec;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
  Ends the process on a signal; defaults to `process.exit`.
  */
  exit?: (code: number) => void;
  /**
  Calls `handler` on SIGINT or SIGTERM until the returned function is called.
  Defaults to listening on this process.
  */
  onTermination?: (handler: (signal: TerminationSignal) => void) => () => void;
}

type TerminationSignal = 'SIGINT' | 'SIGTERM';

function onProcessTermination(
  handler: (signal: TerminationSignal) => void,
): () => void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

/**
The exit code a shell reports for a command, and why, when it was not its own.
*/
function exitOf(
  result: ExecResult,
  name: string,
  stderr: (text: string) => void,
): number {
  if (result.spawnFailed === true) {
    stderr(`guardrails lock: could not start ${name} (${result.stderr}).\n`);
    return MISSING_COMMAND_EXIT;
  }
  return result.signal === undefined
    ? result.code
    : SIGNAL_EXIT_BASE + osConstants.signals[result.signal];
}

const MISSING_COMMAND_EXIT = 127;
const SIGNAL_EXIT_BASE = 128;
const TERMINATION_EXITS: Readonly<Record<TerminationSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * `guardrails lock [--timeout=<s>] -- <cmd> [args…]`: run the command under
 * the gate lock and exit with its code -- 75, with the gate's lock-timeout
 * line, when the wait ran out; 73, naming the file, when the start mark could
 * not be written; 127 for a program that could not start; 2 for a command
 * line it cannot read. One `kind: lock` row goes to the run log,
 * from the signal handler when the run is stopped part-way.
 */
export async function lockCommand(
  dependencies: LockCommandDependencies,
  rest: readonly string[],
): Promise<number> {
  const parsed = parseLockArguments(rest);
  if ('error' in parsed) {
    dependencies.stderr(`guardrails lock: ${parsed.error}\n${LOCK_USAGE}\n`);
    return 2;
  }
  const environment = dependencies.env ?? process.env;
  const { exec, cwd, stderr } = dependencies;
  const repoRoot = findGitRoot(cwd) ?? cwd;
  const config = loadConfig(repoRoot, environment);
  const lock = machineLock(config.mutationLock, environment);
  const waitSeconds =
    parsed.timeoutSeconds ?? config.mutationLock.pushWaitSeconds;
  const identity = commandIdentity(parsed.argv);
  const start = startRun();
  const tracker: LockTracker = { depthOnArrival: 0 };
  const log = (run: Omit<LockRunResult, 'command' | 'commandHash'>): void => {
    logLockRun({
      lockPath: lock.path,
      repoRoot,
      branch,
      project,
      start,
      run: { ...identity, ...run },
      environment,
      warn: (line) => {
        stderr(`${line}\n`);
      },
    });
  };
  const branch = await branchOf(exec, repoRoot);
  const project = await projectName(exec, repoRoot);
  const release = (dependencies.onTermination ?? onProcessTermination)(
    (signal) => {
      log({
        exitCode: TERMINATION_EXITS[signal],
        signal,
        outcome: 'killed',
        ...(tracker.queuedAt !== undefined && {
          lock: lockPartOf(
            tracker,
            tracker.startedFile === undefined
              ? undefined
              : startMarkTime(tracker.startedFile),
            Date.now(),
          ),
        }),
      });
      cleanUpHolder(lock.path, tracker);
      forwardTerminationSignal(
        signal,
        dependencies.exit ?? ((code) => process.exit(code)),
      );
    },
  );
  let run: CommandLockRun;
  try {
    run = await runCommandUnderLock({
      exec,
      lock,
      argv: parsed.argv,
      waitSeconds,
      repoRoot,
      cwd,
      progress: (line) => {
        stderr(`${line}\n`);
      },
      stream: { stdout: dependencies.stdout, stderr },
      environment,
      tracker,
    });
  } finally {
    release();
  }
  if (run.outcome === 'lock-timeout') {
    stderr(
      `${LOCK_TIMEOUT_MARKER} after ${String(waitSeconds)}s (${run.holding}).\n`,
    );
    log({ exitCode: LOCK_TIMEOUT_EXIT, outcome: run.outcome, lock: run.lock });
    return LOCK_TIMEOUT_EXIT;
  }
  if (run.outcome === 'no-start-mark') {
    stderr(
      `guardrails lock: could not write the start mark at ${run.startedFile} — ` +
        `${identity.command} was not run. Point TMPDIR at a writable directory.\n`,
    );
    log({ exitCode: START_MARK_EXIT, outcome: run.outcome, lock: run.lock });
    return START_MARK_EXIT;
  }
  const exitCode = exitOf(run.result, identity.command, stderr);
  log({
    exitCode,
    signal: run.result.signal,
    outcome: run.outcome,
    ...('lock' in run && { lock: run.lock }),
  });
  return exitCode;
}
