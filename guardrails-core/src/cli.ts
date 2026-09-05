#!/usr/bin/env node
/**
 * The `guardrails` CLI entry — the single command every runtime calls (§2).
 * Pure Node, no bash, so one command string works on macOS/Linux/Windows and in
 * both hook dialects. This file only wires real process I/O to `runCommand`;
 * all command logic lives in the tested `cli-core.ts`.
 */

import process from 'node:process';

import { type CliDependencies, runCommand } from './cli-core.js';
import { spawnExec } from './exec.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const dependencies: CliDependencies = {
  exec: spawnExec,
  readStdin,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const [command, ...rest] = process.argv.slice(2);

try {
  process.exitCode = await runCommand(command, rest, dependencies);
} catch (error: unknown) {
  process.stderr.write(`guardrails: ${String(error)}\n`);
  process.exitCode = 1;
}
