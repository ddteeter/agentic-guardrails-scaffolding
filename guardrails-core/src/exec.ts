/**
 * The command-runner seam. Everything that shells out takes an `Exec` so the
 * orchestrator and gate can be unit-tested with canned output; the real
 * `spawnExec` is used by the CLI. Pure Node `child_process` — no bash.
 */

import { spawn } from 'node:child_process';
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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

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
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolve({
        stdout,
        stderr: `${stderr}${error.message}`,
        code: 1,
        spawnFailed: true,
      });
    });
    child.on('close', (code, signal) => {
      // `code ?? 0` is kept, but it is no longer the only thing a caller has to
      // go on: a kill sets `code` to null and `signal` to the name, so the
      // coalesced zero is now accompanied by the evidence that contradicts it.
      resolve({
        stdout,
        stderr,
        code: code ?? 0,
        ...(signal !== null && { signal }),
      });
    });
  });
