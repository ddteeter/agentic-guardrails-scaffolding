/**
 * The command-runner seam. Everything that shells out takes an `Exec` so the
 * orchestrator and gate can be unit-tested with canned output; the real
 * `spawnExec` is used by the CLI. Pure Node `child_process` — no bash.
 */

import { spawn } from 'node:child_process';

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
      ...(options?.env === undefined ? {} : { env: options.env }),
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
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
