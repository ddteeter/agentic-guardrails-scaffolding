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
}

export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<ExecResult>;

export const spawnExec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
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
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
