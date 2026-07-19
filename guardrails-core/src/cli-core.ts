/**
 * Command logic for the `guardrails` CLI, with all process I/O injected as
 * `CliDeps` so every subcommand is unit-testable without spawning a process.
 * `cli.ts` is a thin bootstrap that supplies the real dependencies.
 */

import { auditDiff } from './audit.js';
import { runAutofix } from './autofix.js';
import { loadConfig, toGateConfig } from './config.js';
import type { Exec } from './exec.js';
import { runCommitGate, runStopGate } from './gate.js';
import {
  type Dialect,
  formatCopilotStopOutput,
  formatPreToolUseDeny,
  formatStopHookOutput,
  parseHookInput,
  resolveLocalBin,
} from './hook-io.js';
import { collectManifestFiles, isPathAllowed, isWithinRepo } from './scope.js';
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
    profile: 'ci',
    resolveBin: binResolver(repoRoot),
  });
  printViolations(deps, violations);
  deps.stderr(
    violations.length === 0
      ? 'guardrails: clean (0 violations).\n'
      : `guardrails: ${violations.length} violation(s).\n`,
  );
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

async function gateStopCommand(
  deps: CliDeps,
  dialect: Dialect,
): Promise<number> {
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
  const output =
    dialect === 'copilot'
      ? formatCopilotStopOutput(decision)
      : formatStopHookOutput(decision);
  if (output) {
    deps.stdout(JSON.stringify(output));
  }
  return 0;
}

async function gateCommitCommand(deps: CliDeps): Promise<number> {
  const repoRoot = deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations, findings, blocked } = await runCommitGate({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  printViolations(deps, violations);
  for (const finding of findings) {
    deps.stderr(
      `${finding.file}:${finding.line} added ${finding.kind}: ${finding.text}\n`,
    );
  }
  return blocked ? 1 : 0;
}

const SHELL_TOOLS = /^(?:bash|shell|powershell)$/i;
// Requires `commit`/`push` immediately after `git`, so it won't match
// `git -C <path> commit` — acceptable, since the git-native pre-commit hook
// (Husky) is the hard floor that catches those commits regardless.
const GIT_WRITE = /\bgit\s+(?:commit|push)\b/;

/** `gate --mode=pretooluse`: the Copilot commit/push gate. Self-filters on the
 * shell-tool + git-commit/push command shape rather than relying on hook
 * matcher config, because VS Code's Copilot hook host ignores matchers — the
 * command must gate itself regardless of how `.github/hooks` is configured. */
async function gatePreToolUseCommand(
  deps: CliDeps,
  dialect: Dialect,
): Promise<void> {
  const input = parseHookInput(await deps.readStdin());
  if (
    input.toolName === undefined ||
    !SHELL_TOOLS.test(input.toolName) ||
    input.command === undefined ||
    !GIT_WRITE.test(input.command)
  ) {
    return; // allow (silent)
  }
  const repoRoot = input.cwd ?? deps.cwd;
  const config = loadConfig(repoRoot);
  const { violations, findings, blocked } = await runCommitGate({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: deps.exec,
    resolveBin: binResolver(repoRoot),
  });
  if (!blocked) {
    return; // allow (silent)
  }
  const reason =
    `guardrails: ${violations.length} violation(s), ` +
    `${findings.length} added suppression(s). ` +
    `Resolve them before committing (run 'guardrails verify').`;
  deps.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
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

function denyPreToolUse(deps: CliDeps, reason: string, dialect: Dialect): void {
  deps.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
}

/** Read-family tool names across dialects: Claude's `Read`, Copilot's `view`. */
const READ_TOOLS = /^(?:read|view)$/i;

function isReadTool(toolName: string | undefined): boolean {
  return toolName !== undefined && READ_TOOLS.test(toolName);
}

async function scopeCheckCommand(
  deps: CliDeps,
  dialect: Dialect,
): Promise<void> {
  const input = parseHookInput(await deps.readStdin());
  const repoRoot = input.cwd ?? deps.cwd;
  if (input.filePath === undefined) {
    return;
  }
  // Read: the fixer may read anything WITHIN the repo (manifest, edited files,
  // even node_modules rule sources — that in-repo exploration is how the
  // thorough tier diagnoses subtle rules), but nothing OUTSIDE it (e.g. the
  // user's ~/.claude project memory). Covers both dialects' read tool: Claude's
  // `Read` and Copilot's `view`.
  if (isReadTool(input.toolName)) {
    if (!isWithinRepo(repoRoot, input.filePath)) {
      denyPreToolUse(
        deps,
        `Fixer read-scope: ${input.filePath} is outside the repository. ` +
          `The fixer may only read files within the repo.`,
        dialect,
      );
    }
    return;
  }
  // Edit/Write: only the files named in the violations manifest. No active
  // manifest → the fixer isn't running; don't interfere.
  const files = collectManifestFiles(stateDirectory(repoRoot));
  if (files.size > 0 && !isPathAllowed(files, repoRoot, input.filePath)) {
    denyPreToolUse(
      deps,
      `Fixer scope-lock: ${input.filePath} is not in the violations ` +
        `manifest. The fixer may only edit files listed there.`,
      dialect,
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

function resolveDialect(rest: string[]): Dialect {
  return flag(rest, 'dialect') === 'copilot' ? 'copilot' : 'claude';
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
      const mode = flag(rest, 'mode');
      const dialect = resolveDialect(rest);
      if (mode === 'commit') {
        return gateCommitCommand(deps);
      }
      if (mode === 'pretooluse') {
        await gatePreToolUseCommand(deps, dialect);
        return 0;
      }
      return gateStopCommand(deps, dialect);
    }
    case 'audit': {
      return auditCommand(deps);
    }
    case 'state': {
      return stateCommand(deps, flag(rest, 'session') ?? 'default');
    }
    case 'scope-check': {
      const dialect = resolveDialect(rest);
      await scopeCheckCommand(deps, dialect);
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
        'usage: guardrails <verify|autofix|audit|gate [--mode=stop|commit|pretooluse] [--dialect=copilot]|state|scope-check|session-start|session-end>\n',
      );
      return 1;
    }
  }
}
