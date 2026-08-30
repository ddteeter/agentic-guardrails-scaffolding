/**
 * Command logic for the `guardrails` CLI, with all process I/O injected as
 * `CliDeps` so every subcommand is unit-testable without spawning a process.
 * `cli.ts` is a thin bootstrap that supplies the real dependencies.
 */

import { auditDiff } from './audit.js';
import { runAutofix } from './autofix.js';
import {
  loadConfig,
  parseSanctionsJson,
  readConfigText,
  toGateConfig,
} from './config.js';
import type { Exec } from './exec.js';
import { runCommitGate, runStopGate } from './gate.js';
import {
  formatGrantReport,
  newlySanctioned,
  toMalformedViolations,
} from './sanctions.js';
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
    analyzers: config.analyzers,
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
  // Equivalent mutant (`true`): with no file path, the mutated branch calls
  // runAutofix with `[undefined]`, whose own `isTypeScriptFile` filter rejects
  // it (`/\.tsx?$/.test(undefined)` coerces to the string "undefined" and is
  // false), so the file list is empty and eslint is never spawned — identical
  // observable behavior through the only seam this function has. The guard is
  // redundant with that filter, and every reshaping of it leaves one equivalent
  // mutant: `[x].filter(...)` and the ternary form each move the equivalence
  // from the `true` variant to the `false` one rather than removing it.
  // Stryker disable next-line ConditionalExpression
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
    analyzers: config.analyzers,
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
    sanctionedSuppressions: config.sanctionedSuppressions,
    analyzers: config.analyzers,
  });
  printViolations(deps, violations);
  for (const finding of findings) {
    deps.stderr(
      `${finding.file}:${finding.line} added ${finding.kind}: ${finding.text}\n`,
    );
  }
  if (!blocked) {
    return 0;
  }
  // `enforcement` governs the commit and preToolUse gates only; the Claude Code
  // Stop loop is deliberately never softened (see RepoConfig.enforcement). Under
  // `warn` the findings are still printed in full above — a zero exit must never
  // be mistakable for a clean gate, so it is stated outright.
  if (config.enforcement === 'warn') {
    deps.stderr(
      'guardrails: not blocking (enforcement: warn). Set "enforcement": ' +
        '"block" in guardrails.config.json to make this gate enforce.\n',
    );
    return 0;
  }
  return 1;
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
    // Equivalent mutants on the two `=== undefined` clauses: bypassing either
    // still returns early, because the regex test on the very next line
    // stringifies `undefined` to "undefined", which matches neither pattern.
    // Stryker disable next-line ConditionalExpression
    input.toolName === undefined ||
    !SHELL_TOOLS.test(input.toolName) ||
    // Stryker disable next-line ConditionalExpression
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
    sanctionedSuppressions: config.sanctionedSuppressions,
    analyzers: config.analyzers,
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

const CONFIG_FILE = 'guardrails.config.json';

/** `sanctions-check`: CI approval-visibility gate for the diff-auditor's escape
 * hatch. It can only FAIL on a malformed `sanctionedSuppressions` entry in the
 * head config (exit 1, listing each). A newly-granted exemption — a key absent
 * from the merge-base config, or a key whose total count increased — is never a
 * failure: it is printed prominently for the reviewer and the check exits 0, so
 * it can be a required status check without deadlocking the very merge that
 * constitutes its approval. The gate itself (`runCommitGate`) is what enforces
 * reality: an occurrence beyond the declared count still blocks the commit
 * regardless of what this check reports. See src/sanctions.ts. */
async function sanctionsCheckCommand(deps: CliDeps): Promise<number> {
  const headText = readConfigText(deps.cwd) ?? '';
  const { valid: headSanctions, malformed } = parseSanctionsJson(headText);
  if (malformed.length > 0) {
    printViolations(deps, toMalformedViolations(malformed, CONFIG_FILE));
    deps.stderr(
      `guardrails: ${malformed.length} malformed sanctionedSuppressions ` +
        `entry(ies) in ${CONFIG_FILE} — fix before merging.\n`,
    );
    return 1;
  }

  const config = loadConfig(deps.cwd);
  const mergeBase = await deps.exec(
    'git',
    ['merge-base', config.baseBranch, 'HEAD'],
    { cwd: deps.cwd },
  );
  const sha = mergeBase.stdout.trim();
  const ref = mergeBase.code === 0 && sha ? sha : config.baseBranch;
  const base = await deps.exec('git', ['show', `${ref}:${CONFIG_FILE}`], {
    cwd: deps.cwd,
  });
  // A missing base file (first adoption of guardrails) means nothing is known
  // yet, so every entry on the branch reads as newly granted.
  // Equivalent mutant on the `[]` default: `newlySanctioned` compares by key, so
  // a placeholder entry maps to an undefined key that no real entry can match —
  // every head entry still reads as newly granted, exactly as with [].
  // Stryker disable next-line ArrayDeclaration
  const known = base.code === 0 ? parseSanctionsJson(base.stdout).valid : [];
  const grants = newlySanctioned(known, headSanctions);
  if (grants.length === 0) {
    deps.stderr('guardrails: no new diff-auditor exemptions granted.\n');
    return 0;
  }
  deps.stderr(
    `guardrails: ${grants.length} new diff-auditor exemption(s) granted on ` +
      `this branch (reviewed by merging this pull request):\n`,
  );
  for (const line of formatGrantReport(grants)) {
    deps.stderr(`${line}\n`);
  }
  return 0;
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
  // Equivalent mutant on the `!== undefined` half: READ_TOOLS.test(undefined)
  // tests the string "undefined", which the anchored pattern rejects anyway.
  // Stryker disable next-line ConditionalExpression
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
    case 'sanctions-check': {
      return sanctionsCheckCommand(deps);
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
        'usage: guardrails <verify|autofix|audit|gate [--mode=stop|commit|pretooluse] [--dialect=copilot]|sanctions-check|state|scope-check|session-start|session-end>\n',
      );
      return 1;
    }
  }
}
