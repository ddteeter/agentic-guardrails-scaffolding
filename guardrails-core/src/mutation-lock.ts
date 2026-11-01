/**
 * The machine-wide mutation lock: held around the stryker run itself, on every
 * rung that runs it (spec: docs/superpowers/specs/2026-11-01-mutation-lock-design.md).
 *
 * Concurrent stryker runs are what thrash a machine with several agent
 * worktrees, so the lock wraps exactly that and nothing else -- not eslint,
 * not tsc, and not a push that has nothing to mutate. It used to wrap the
 * whole push gate from the shell hook, which serialized too much there and
 * nothing at all on the commit rung, where stryker also runs.
 *
 * The lockers are the OS ones the hook already used -- `lockf` (BSD, macOS)
 * and `flock` (util-linux) -- so the lock is held on a file descriptor and a
 * killed holder releases it. Both are told to exit 75 (EX_TEMPFAIL) on a
 * timeout, which is how a wait that ran out is told apart from a stryker run
 * that failed.
 */
import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { MutationLockConfig } from './config.js';
import type { Exec, ExecResult } from './exec.js';
import type { Rung } from './verify/analyzer-policy.js';

/**
A locker this machine has, in the order the hook preferred them.
*/
export type Locker = 'lockf' | 'flock';

const LOCKERS: readonly Locker[] = ['lockf', 'flock'];

/**
 * What a push that gave up waiting says. `ship` classifies on this string, so
 * it lives here, beside the lock that produces it, and `ship` imports it.
 */
export const LOCK_TIMEOUT_MARKER =
  'guardrails: gave up waiting for the gate lock';

/**
The rule id of a push rung that never got the lock.
*/
export const MUTATION_LOCK_TIMEOUT_RULE = 'guardrails/mutation-lock-timeout';

/**
The exit code both lockers give for a wait that ran out.
*/
const LOCK_TIMEOUT_EXIT = 75;

/**
How one rung waits for the lock, and what a wait that runs out means.
*/
export interface LockWait {
  waitSeconds: number;
  /**
   * `defer`: skip mutation testing on this rung -- a later rung re-checks the
   * whole branch, so nothing escapes. `block`: fail the gate, because no later
   * local rung will.
   */
  onTimeout: 'defer' | 'block';
}

/**
 * The lock policy per rung. Stop never waits: a busy machine must not hold up
 * every turn, and a wait there races the hook deadline into "turn not
 * checked", which is worse than a clean deferral to commit. CI takes no lock --
 * a runner has no other gates to contend with.
 */
export function waitFor(
  rung: Rung,
  config: MutationLockConfig,
): LockWait | undefined {
  return WAIT_POLICY[rung]?.(config);
}

/**
 * One entry per rung, `undefined` for the rung that takes no lock. A table
 * rather than a `switch` with an empty `ci` arm: a `case` that returns nothing
 * is indistinguishable, to any test, from the fall-off-the-end it would be
 * without it.
 */
const WAIT_POLICY: Readonly<
  Record<Rung, ((config: MutationLockConfig) => LockWait) | undefined>
> = {
  stop: () => ({ waitSeconds: 0, onTimeout: 'defer' }),
  commit: (config) => ({
    waitSeconds: config.commitWaitSeconds,
    onTimeout: 'defer',
  }),
  push: (config) => ({
    waitSeconds: config.pushWaitSeconds,
    onTimeout: 'block',
  }),
  ci: undefined,
};

/**
 * `command args` run under `lock`, waiting at most `waitSeconds`.
 *
 * `lockf -k` keeps the file, which is what keeps waiters on one inode; `-s`
 * silences lockf's own "already locked" message, since the caller prints its
 * own. `flock -E 75` makes flock's timeout exit match lockf's default.
 */
export function lockerArgv(
  locker: Locker,
  lock: string,
  waitSeconds: number,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const wait = String(waitSeconds);
  const lockArguments =
    locker === 'lockf'
      ? ['-k', '-s', '-t', wait, lock]
      : ['-w', wait, '-E', String(LOCK_TIMEOUT_EXIT), lock];
  return { command: locker, args: [...lockArguments, command, ...args] };
}

/**
 * Which locker this machine has, or `undefined` for neither. Asked through
 * `sh -c 'command -v …'`, as the hook asked, so the answer is the PATH a
 * spawned locker will actually resolve against.
 */
export async function detectLocker(exec: Exec): Promise<Locker | undefined> {
  for (const locker of LOCKERS) {
    // Sequential on purpose: the first one present wins, as in the hook.
    const result = await exec('sh', ['-c', `command -v ${locker}`]);
    if (result.code === 0 && result.spawnFailed !== true) {
      return locker;
    }
  }
  return undefined;
}

/**
Where the lock lives, and how long each rung waits for it.
*/
export interface MutationLock {
  path: string;
  config: MutationLockConfig;
}

/**
What became of a run offered to `runUnderLock`.
*/
export type LockedRun =
  | { kind: 'ran'; result: ExecResult }
  /**
  The lock stayed busy on a rung that defers: nothing ran.
  */
  | { kind: 'deferred' }
  /**
  The lock stayed busy on a rung that blocks: nothing ran. Carries the lock, so
  the report that names it never has to guess whether there was one.
  */
  | { kind: 'timed-out'; lock: MutationLock };

export interface LockedRunOptions {
  exec: Exec;
  rung: Rung;
  /**
  `undefined` means no lock is configured: the command runs bare.
  */
  lock: MutationLock | undefined;
  command: string;
  args: string[];
  cwd: string;
  /**
  Where the lock's own lines go: waiting, unserialized, …
  */
  progress: (line: string) => void;
  /**
  Seam for the lock-file check. Defaults to opening it for append.
  */
  canOpenLock?: (lockPath: string) => boolean;
  /**
  What the command runs with once it HOLDS the lock, in place of `args`, and
  the environment it gets then. Every bare path -- no locker, an unusable lock,
  ci -- keeps `args` and the inherited environment, so whatever these add (the
  progress plugin that writes the holder file) speaks only for the holder.
  */
  locked?: { args: string[]; env: NodeJS.ProcessEnv };
}

/**
 * Run `command` under the mutation lock as the rung's policy says, or report
 * why it did not run.
 *
 * Every path that cannot take the lock -- no locker on the machine, a lock
 * file that cannot be opened -- RUNS the command unserialized and says so. A
 * broken lock must never read as a failed or blocked mutation run: that would
 * turn a machine-setup problem into a code violation an agent tries to fix.
 *
 * KNOWN LIMIT: a locked command that itself exits 75 reads as a timeout.
 * Stryker does not use 75; the holder file (see the spec) is what will tell
 * the two apart for certain.
 */
export async function runUnderLock(
  options: LockedRunOptions,
): Promise<LockedRun> {
  const { exec, command, args, cwd, progress, lock } = options;
  const runBare = async (): Promise<LockedRun> => ({
    kind: 'ran',
    result: await exec(command, args, { cwd }),
  });
  if (lock === undefined) {
    return runBare();
  }
  const wait = waitFor(options.rung, lock.config);
  if (wait === undefined) {
    return runBare();
  }
  const lockPath = lock.path;
  const locker = await detectLocker(exec);
  if (locker === undefined) {
    progress(NO_LOCKER_NOTE);
    return runBare();
  }
  const canOpen = options.canOpenLock ?? canOpenForAppend;
  if (!canOpen(lockPath)) {
    progress(unusableLockNote(lockPath));
    return runBare();
  }
  // Both lockers are silent while they wait, and a quiet half hour looks like
  // a hang -- so ask once without waiting, and say so before the real wait.
  const probe = lockerArgv(locker, lockPath, 0, 'true', []);
  const probed = await exec(probe.command, probe.args, { cwd });
  const isBusy = probed.code === LOCK_TIMEOUT_EXIT;
  if (isBusy && wait.waitSeconds === 0) {
    return { kind: 'deferred' };
  }
  if (isBusy) {
    progress(
      `guardrails: another checkout is running mutation testing — waiting ` +
        `for the mutation lock (up to ${String(wait.waitSeconds)}s)…`,
    );
  }
  const holding = options.locked;
  const run = lockerArgv(
    locker,
    lockPath,
    wait.waitSeconds,
    command,
    holding?.args ?? args,
  );
  const result = await exec(run.command, run.args, {
    cwd,
    processGroup: true,
    ...(holding !== undefined && { env: holding.env }),
  });
  if (isMissingCommand(result, command)) {
    // The locker started but its command did not exist. Re-asked bare so the
    // spawn failure is a real one -- that is what `runVerify`'s tracker reads
    // to report `guardrails/analyzer-missing`, the only honest verdict here.
    return runBare();
  }
  if (result.code !== LOCK_TIMEOUT_EXIT) {
    return { kind: 'ran', result };
  }
  return wait.onTimeout === 'defer'
    ? { kind: 'deferred' }
    : { kind: 'timed-out', lock };
}

const NO_LOCKER_NOTE =
  'guardrails: no lockf or flock on this machine — mutation testing runs ' +
  'unserialized. Install util-linux (flock) to serialize it.';

function unusableLockNote(lockPath: string): string {
  return (
    `guardrails: could not open the mutation lock at ${lockPath} — running ` +
    `unserialized. Set GUARDRAILS_GATE_LOCK to a writable path.`
  );
}

function canOpenForAppend(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, 'a'));
  } catch {
    return false;
  }
  return true;
}

/**
 * Did the locker fail to START its command? Measured: `lockf` exits 1 with
 * `lockf: <command>: No such file or directory`; `flock` reports
 * `failed to execute <command>`. Both are stderr the locker wrote before the
 * command existed, so a command's own output cannot produce either.
 */
function isMissingCommand(result: ExecResult, command: string): boolean {
  return (
    result.code !== 0 &&
    (result.stderr.includes(`: ${command}: No such file or directory`) ||
      result.stderr.includes(`failed to execute ${command}`))
  );
}

/**
 * The lock this machine's gates share: `GUARDRAILS_GATE_LOCK`, or one file in
 * the home directory. An env var rather than a config key on purpose -- which
 * lock to share is a fact about the machine, and a per-repo path would split
 * the one queue the lock exists for.
 */
export function machineLock(
  config: MutationLockConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MutationLock {
  const configured = environment.GUARDRAILS_GATE_LOCK;
  return {
    path:
      configured === undefined || configured === ''
        ? path.join(homedir(), '.guardrails-gate.lock')
        : configured,
    config,
  };
}
