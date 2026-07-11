/**
 * Command logic for the `guardrails` CLI, with all process I/O injected as
 * `CliDeps` so every subcommand is unit-testable without spawning a process.
 * `cli.ts` is a thin bootstrap that supplies the real dependencies.
 */

import { auditDiff } from './audit.js';
import { runAutofix } from './autofix.js';
import { loadConfig, toGateConfig } from './config.js';
import type { Exec } from './exec.js';
import { runStopGate } from './gate.js';
import {
  formatStopHookOutput,
  parseHookInput,
  resolveLocalBin,
} from './hook-io.js';
import { collectManifestFiles, isPathAllowed } from './scope.js';
import {
  deleteSession,
  loadRecurrence,
  loadSession,
  stateDirectory,
  sweepStale,
} from './state-store.js';
import { hasErrors, type Violation } from './violation.js';
import { runVerify } from './verify/index.js';

export interface CliDeps {
  exec: Exec;
  readStdin: () => Promise<string>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function binResolver(repoRoot: string): (tool: string) => string {
  return (tool) => resolveLocalBin(repoRoot, tool);
}

function printViolations(
  deps: CliDeps,
  violations: readonly Violation[],
): void {
  for (const violation of violations) {
    deps.stderr(
      `${violation.file}:${violation.line ?? '?'} ` +
        `[${violation.ruleId}] ${violation.message} (${violation.tool})\n`,
    );
  }
}

async function verifyCommand(deps: CliDeps): Promise<number> {
  const repoRoot = deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations } = await runVerify({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  printViolations(deps, violations);
  deps.stderr(`${violations.length} violation(s).\n`);
  return hasErrors(violations) ? 1 : 0;
}

async function autofixCommand(deps: CliDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  const repoRoot = input.cwd ?? deps.cwd;
  if (input.filePath !== undefined) {
    await runAutofix({
      repoRoot,
      files: [input.filePath],
      exec: deps.exec,
      resolveBin: binResolver(repoRoot),
    });
  }
  return 0;
}

async function gateStopCommand(deps: CliDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  const repoRoot = input.cwd ?? deps.cwd;
  const sessionId = input.sessionId ?? 'default';
  const config = loadConfig(repoRoot);
  const { decision } = await runStopGate({
    repoRoot,
    sessionId,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    config: toGateConfig(config),
    resolveBin: binResolver(repoRoot),
  });
  const output = formatStopHookOutput(decision);
  if (output) {
    deps.stdout(JSON.stringify(output));
  }
  return 0;
}

async function gateCommitCommand(deps: CliDeps): Promise<number> {
  const repoRoot = deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations } = await runVerify({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  const diff = await deps.exec('git', ['diff', '--cached'], { cwd: repoRoot });
  const findings = auditDiff(diff.stdout);
  printViolations(deps, violations);
  for (const finding of findings) {
    deps.stderr(
      `${finding.file}:${finding.line} added ${finding.kind}: ${finding.text}\n`,
    );
  }
  return hasErrors(violations) || findings.length > 0 ? 1 : 0;
}

async function auditCommand(deps: CliDeps): Promise<number> {
  const diff = await deps.exec('git', ['diff', 'HEAD'], { cwd: deps.cwd });
  const findings = auditDiff(diff.stdout);
  for (const finding of findings) {
    deps.stderr(
      `${finding.file}:${finding.line} ${finding.kind}: ${finding.text}\n`,
    );
  }
  return findings.length > 0 ? 1 : 0;
}

function stateCommand(deps: CliDeps, sessionId: string): number {
  const directory = stateDirectory(deps.cwd);
  deps.stdout(
    `${JSON.stringify(
      {
        session: loadSession(directory, sessionId),
        recurrence: loadRecurrence(directory),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function scopeCheckCommand(deps: CliDeps): Promise<void> {
  const input = parseHookInput(await deps.readStdin());
  const repoRoot = input.cwd ?? deps.cwd;
  if (input.filePath === undefined) {
    return;
  }
  const files = collectManifestFiles(stateDirectory(repoRoot));
  // No active manifest → the fixer isn't running; don't interfere.
  if (files.size > 0 && !isPathAllowed(files, repoRoot, input.filePath)) {
    deps.stdout(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `Fixer scope-lock: ${input.filePath} is not in the violations ` +
            `manifest. The fixer may only edit files listed there.`,
        },
      }),
    );
  }
}

async function sessionEndCommand(deps: CliDeps): Promise<number> {
  const input = parseHookInput(await deps.readStdin());
  const sessionId = input.sessionId ?? 'default';
  deleteSession(stateDirectory(input.cwd ?? deps.cwd), sessionId);
  return 0;
}

function flag(rest: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return rest
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

export async function runCommand(
  command: string | undefined,
  rest: string[],
  deps: CliDeps,
): Promise<number> {
  switch (command) {
    case 'verify': {
      return verifyCommand(deps);
    }
    case 'autofix': {
      return autofixCommand(deps);
    }
    case 'gate': {
      return flag(rest, 'mode') === 'commit'
        ? gateCommitCommand(deps)
        : gateStopCommand(deps);
    }
    case 'audit': {
      return auditCommand(deps);
    }
    case 'state': {
      return stateCommand(deps, flag(rest, 'session') ?? 'default');
    }
    case 'scope-check': {
      await scopeCheckCommand(deps);
      return 0;
    }
    case 'session-start': {
      sweepStale(stateDirectory(deps.cwd), SESSION_TTL_MS, Date.now());
      return 0;
    }
    case 'session-end': {
      return sessionEndCommand(deps);
    }
    default: {
      deps.stderr(
        'usage: guardrails <verify|autofix|audit|gate|state|scope-check|session-start|session-end>\n',
      );
      return 1;
    }
  }
}
