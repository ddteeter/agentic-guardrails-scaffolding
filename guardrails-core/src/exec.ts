/**
 * The command-runner seam. Everything that shells out takes an `Exec` so the
 * orchestrator and gate can be unit-tested with canned output; the real
 * `spawnExec` is used by the CLI. Pure Node `child_process` — no bash.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * `true` when the process could not be STARTED (e.g. the binary is missing).
   * Exit code cannot carry this: a non-zero code is the normal case for these
   * tools — eslint exits 1 on findings, tsc on type errors — so without this
   * flag an absent analyzer is indistinguishable from a clean one, and the gate
   * fails open. Absent (not `false`) on a process that ran, so existing test
   * fakes stay valid.
   */
  spawnFailed?: true;
  /**
   * The signal that terminated the process, when one did.
   *
   * The third way a run can produce no verdict, after "never started" and
   * "ran and failed": it was killed part-way. Node reports that as
   * `code === null, signal === 'SIGTERM'`, and this seam spawns with
   * `shell: false`, so there is no shell to translate it into 128+N — the null
   * arrives raw and would otherwise be coalesced to a zero. A killed analyzer
   * writes nothing, every adapter parses nothing out of nothing, and the result
   * is indistinguishable from a clean run. Absent (not `null`) on a process
   * that exited on its own, so existing test fakes stay valid.
   */
  signal?: NodeJS.Signals;
  /**
   * `true` when the run was stopped because it outlived `timeoutMs`. `signal`
   * then says how it was stopped; this says why, which a signal alone cannot --
   * the same SIGTERM arrives from a hook deadline or a Ctrl-C. Absent on a run
   * that ended on its own.
   */
  timedOut?: true;
}

/**
 * The signals a run can plausibly be killed by, as a value the exit-code
 * decoder can iterate. Listing them beats iterating `os.constants.signals`
 * wholesale: the constants object also carries signals a killed process never
 * reports (`SIGCHLD`, `SIGCONT`, `SIGWINCH`), and enumerating it yields
 * `string` keys that would need a cast back to `NodeJS.Signals`.
 */
const KILL_SIGNALS = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGABRT',
  'SIGFPE',
  'SIGKILL',
  'SIGSEGV',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGXCPU',
  'SIGXFSZ',
] as const satisfies readonly NodeJS.Signals[];

/** What a shell adds to a signal number to report a killed child as an exit
 *  code. 128 itself is therefore NOT a kill — it is git's own code for a bad
 *  revision, among others. */
const SIGNAL_EXIT_BASE = 128;

/**
 * The signal behind a 128+N exit code, when there is one.
 *
 * `ExecResult.signal` is the reliable answer and this is the fallback for when
 * it is absent: nothing guarantees guardrails spawns an analyzer directly. A
 * wrapper in between — `npx`, a package-manager shim, a shell script — waits on
 * the child itself and re-reports the kill the way a shell does, by which point
 * the signal is gone and only the number remains. 143 (SIGTERM, a timeout) and
 * 137 (SIGKILL, usually an OOM killer) are the two that show up in the field.
 *
 * Used only to CHOOSE THE WORDING of a failure that is already being reported,
 * never to turn a passing run into a failing one — 128+N overlaps with exit
 * codes a tool is free to use for its own purposes, and that ambiguity may
 * mislabel a failure but must never invent one.
 */
export function signalFromExitCode(code: number): NodeJS.Signals | undefined {
  return KILL_SIGNALS.find(
    (name) => SIGNAL_EXIT_BASE + osConstants.signals[name] === code,
  );
}

export type Exec = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /**
    Written to the child's stdin, which is then closed.
    */
    input?: string;
    /**
     * Start the child as the leader of its own process group, and terminate
     * the whole group rather than the child alone.
     *
     * For a child that WRAPS the real work -- `lockf … stryker` -- and does not
     * pass a SIGTERM on. Measured: killing `lockf -k` frees the lock and leaves
     * its command running, so an abandoned gate would leave stryker mutating
     * unlocked. A group is also out of reach of the terminal's Ctrl-C, which is
     * why `forwardTerminationSignal` exists.
     */
    processGroup?: boolean;
    /**
     * For a `processGroup` child: how long its group may take to stop after
     * the one SIGINT `terminateChildren` sends, before it is SIGKILLed.
     * Defaults to `DEFAULT_STOP_GRACE_SECONDS`.
     */
    stopGraceSeconds?: number;
    /**
     * Stop the child once it has run this long, and flag the result
     * `timedOut`. A plain child gets SIGTERM; a `processGroup` child is
     * stopped the way `terminateChildren` stops one -- one SIGINT, then a
     * SIGKILL after its `stopGraceSeconds`. For a consumer-supplied command,
     * such as `mutationCache.seedFrom`, whose cost the gate cannot know and
     * must not wait on indefinitely.
     */
    timeoutMs?: number;
  },
) => Promise<ExecResult>;

/**
 * How long a stopped process group gets to exit before it is SIGKILLed.
 * Long enough for stryker to write a partial incremental report of a large
 * run; short enough that a hung one does not hold the machine-wide lock.
 */
export const DEFAULT_STOP_GRACE_SECONDS = 30;

/**
 * Every child `spawnExec` started that has not yet finished.
 *
 * Module state, deliberately: the CLI is one short-lived process per hook call,
 * and the deadline that needs this (`cli-core`'s hook deadline) has no other
 * handle on processes started several adapters deep.
 */
const live = new Set<ChildProcess>();

/**
 * Stop every child still running, and say how many there were: `SIGTERM` to
 * a plain child, and to a process group one SIGINT with a SIGKILL after its
 * grace (`stopGroup`).
 *
 * A hook that stops waiting must also stop the work: every host treats a hook
 * timeout as fail-open, and a gate abandoned that way kept tsc or stryker
 * running for up to twenty minutes in the field, holding a machine-wide lock
 * the next gate then queued behind. Direct children only -- the analysers we
 * spawn are resolved to their own binaries, not wrapped in a shell, and each
 * one cleans up its own workers on SIGTERM.
 */
export function terminateChildren(): number {
  const count = live.size;
  for (const child of live) {
    stop(child);
  }
  return count;
}

/**
SIGTERM to a plain child; to a process group, `stopGroup`.
*/
function stop(child: ChildProcess): void {
  const { pid } = child;
  if (pid === undefined) {
    // Never started: its 'error' is still on its way. Measured (Node 24):
    // `child.kill()` in this window signals the CALLER's whole process
    // group, so a gate abandoned while an analyzer spawn was failing would
    // kill itself and the hook that ran it. There is nothing to stop.
    return;
  }
  const grace = groups.get(child);
  if (grace === undefined) {
    child.kill('SIGTERM');
  } else {
    stopGroup(child, pid, grace);
  }
}

/**
The live children started with `processGroup`, each with its stop grace in
seconds. A subset of `live`.
*/
const groups = new Map<ChildProcess, number>();

/**
The groups already told to stop. Each is told once.
*/
const stopped = new WeakSet<ChildProcess>();

/**
 * Stop the group `pid` leads: one SIGINT, then a SIGKILL once `grace` runs
 * out, if any of it is still running.
 *
 * One signal, because stryker saves a partial incremental report on the
 * first and exits without one on a second (measured, plan.md 2026-11-07) --
 * so a gate told to stop twice, or by its deadline and then a signal, must
 * not pass both on. SIGINT, because that is the interrupt stryker documents.
 *
 * The SIGKILL comes from a detached `sh`, not a timer here: the CLI exits
 * straight after stopping its children (the hook deadline must), and a
 * stryker that hangs while it shuts down would otherwise hold the
 * machine-wide lock with nothing left to end it.
 */
function stopGroup(child: ChildProcess, pid: number, grace: number): void {
  if (stopped.has(child)) {
    return;
  }
  stopped.add(child);
  try {
    // A negative pid addresses the group the child leads.
    process.kill(-pid, 'SIGINT');
  } catch {
    // Already gone -- the group exited between the check and the kill.
    return;
  }
  const reaper = spawn(
    'sh',
    [
      '-c',
      'sleep "$1"; kill -s KILL -- "-$2" 2>/dev/null',
      'sh',
      String(grace),
      String(pid),
    ],
    { detached: true, stdio: 'ignore' },
  );
  reaper.on('error', () => {
    // No sh: the group keeps its SIGINT and nothing more.
  });
  reaper.unref();
}

/**
The exit code a shell reports for a run ended by `signal`.
*/
const SIGNAL_EXIT_CODES: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * What the CLI does on SIGINT or SIGTERM while process groups are live:
 * terminate every child (groups included), then exit with the code a shell
 * would report. Installed only while a group is running -- see `spawnExec` --
 * so a CLI with none keeps Node's default handling.
 */
export function forwardTerminationSignal(
  signal: 'SIGINT' | 'SIGTERM',
  exit: (code: number) => void,
): void {
  terminateChildren();
  exit(SIGNAL_EXIT_CODES[signal]);
}

function onSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  forwardTerminationSignal(signal, (code) => process.exit(code));
}

function trackGroup(child: ChildProcess, grace: number): void {
  if (groups.size === 0) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }
  groups.set(child, grace);
}

function untrackGroup(child: ChildProcess): void {
  if (!(groups.delete(child) && groups.size === 0)) {
    return;
  }

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}

export const spawnExec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      // Passing `env` replaces the inherited environment. This lets a caller
      // strip inherited git variables (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE)
      // that git exports into hook processes — without it, a `git` spawned from
      // inside a hook would target the hook's repo regardless of `cwd`.
      ...(options?.env !== undefined && { env: options.env }),
      shell: false,
      detached: options?.processGroup === true,
    });
    live.add(child);
    if (options?.processGroup === true) {
      trackGroup(child, options.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS);
    }
    if (options?.input !== undefined) {
      child.stdin.end(options.input);
    }
    let isTimedOut = false;
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            isTimedOut = true;
            stop(child);
          }, options.timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      live.delete(child);
      untrackGroup(child);
      resolve({
        stdout,
        stderr: `${stderr}${error.message}`,
        code: 1,
        spawnFailed: true,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      live.delete(child);
      untrackGroup(child);
      // `code ?? 0` is kept, but it is no longer the only thing a caller has to
      // go on: a kill sets `code` to null and `signal` to the name, so the
      // coalesced zero is now accompanied by the evidence that contradicts it.
      resolve({
        stdout,
        stderr,
        code: code ?? 0,
        ...(signal !== null && { signal }),
        ...(isTimedOut && { timedOut: true }),
      });
    });
  });
