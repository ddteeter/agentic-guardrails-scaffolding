/**
 * Command logic for the `guardrails` CLI, with all process I/O injected as
 * `CliDependencies` so every subcommand is unit-testable without spawning a process.
 * `cli.ts` is a thin bootstrap that supplies the real dependencies.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditDiff, type AuditFinding } from './audit.js';
import { runAutofix } from './autofix.js';
import {
  loadConfig,
  parseSanctionsJson,
  readConfigText,
  toGateConfig,
} from './config.js';
import type { Exec } from './exec.js';
import { runCommitGate, runStopGate } from './gate.js';
import { findGitRoot, resolveRepoRoot } from './repo-root.js';
import {
  formatGrantReport,
  newlySanctioned,
  sanctionCountDrift,
  toMalformedViolations,
} from './sanctions.js';
import {
  type Dialect,
  formatCopilotStopOutput,
  formatPreToolUseDeny,
  formatStopHookOutput,
  hookFilePaths,
  type HookInput,
  parseHookInput,
  resolveLocalBin,
} from './hook-io.js';
import { detect } from './scaffold/detect.js';
import {
  foreignHooksPath,
  foreignHooksPathWarning,
  HOOKS_DIRECTORY,
} from './scaffold/hooks-path.js';
import { initCommand } from './scaffold/init.js';
import { collectManifestScope, isPathAllowed, isWithinRepo } from './scope.js';
import {
  deleteSession,
  loadRecurrence,
  loadSession,
  stateDirectory,
  sweepStale,
} from './state-store.js';
import { hasErrors, type Violation } from './violation.js';
import { runVerify, silentSkipWarning } from './verify/index.js';
import { resolveBaseReference } from './verify/git.js';

export interface CliDependencies {
  exec: Exec;
  readStdin: () => Promise<string>;
  cwd: string;
  /**
   * Where this CLI was resolved from, as a filesystem path. Injected rather
   * than read from `import.meta.url` here so the check has a test seam.
   * Optional because `cli.ts` — the only real caller — must stay a
   * logic-free wire kept out of the mutation gate's diff scope: any change to
   * it charges that file's entire (currently zero) mutation coverage to
   * whatever diff touches it. `outsideRepoMessage` falls back to reading
   * `import.meta.url` itself, from inside `cli-core.ts`, which is already
   * fully covered.
   */
  selfPath?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function binResolver(repoRoot: string): (tool: string) => string {
  return (tool) => resolveLocalBin(repoRoot, tool);
}

function printViolations(
  dependencies: CliDependencies,
  violations: readonly Violation[],
): void {
  for (const violation of violations) {
    dependencies.stderr(
      `${violation.file}:${violation.line ?? '?'} ` +
        `[${violation.ruleId}] ${violation.message} (${violation.tool})\n`,
    );
  }
}

/** The stderr detail the two `enforcement`-governed gates share: every
 *  violation, then every added suppression the diff-auditor found. */
function printGateDetail(
  dependencies: CliDependencies,
  violations: readonly Violation[],
  findings: readonly AuditFinding[],
): void {
  printViolations(dependencies, violations);
  for (const finding of findings) {
    dependencies.stderr(
      `${finding.file}:${finding.line} added ${finding.kind}: ${finding.text}\n`,
    );
  }
}

/** Said outright on both `warn` paths: a zero exit (or a silent allow) must
 *  never be mistakable for a clean gate, and the reader is told exactly which
 *  setting makes it enforce. */
const NOT_BLOCKING_NOTE =
  'guardrails: not blocking (enforcement: warn). Set "enforcement": ' +
  '"block" in guardrails.config.json to make this gate enforce.\n';

/**
 * The repository root every command works from — the git toplevel, never the
 * directory the command happened to be invoked in.
 *
 * A hook payload's `cwd` and `deps.cwd` are both "where this ran", which is not
 * the same question. Trusting them made a subdirectory invocation silently
 * fail-open: `guardrails.config.json`, `tsconfig.json` and `package.json` all
 * resolve at the ROOT, so from `src/` the config vanished, every analyzer
 * became `auto` + undeclared (skip-in-silence), and `gate --mode=stop` reported
 * a clean turn over a live type error. `stateDirectory` moved with it, so the
 * recurrence ledger fragmented and nested `.guardrails/` directories escaped
 * the root-anchored `.gitignore` pattern.
 *
 * `resolveRepoRoot` degrades to `cwd` rather than throwing, so a non-git
 * directory keeps behaving exactly as it did. `install-hooks` already resolved
 * this way through `detect`, for the same reason spelled out on its own
 * docstring — this makes the rest of the CLI agree with it.
 */
function commandRepoRoot(
  dependencies: CliDependencies,
  hookCwd?: string,
): Promise<string> {
  return resolveRepoRoot(dependencies.exec, hookCwd ?? dependencies.cwd);
}

async function verifyCommand(dependencies: CliDependencies): Promise<number> {
  const repoRoot = await commandRepoRoot(dependencies);
  const config = loadConfig(repoRoot);
  const { violations, skippedAnalyzers } = await runVerify({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: dependencies.exec,
    profile: 'ci',
    resolveBin: binResolver(repoRoot),
    analyzers: config.analyzers,
  });
  printViolations(dependencies, violations);
  dependencies.stderr(
    violations.length === 0
      ? 'guardrails: clean (0 violations).\n'
      : `guardrails: ${violations.length} violation(s).\n`,
  );
  warnAboutSilentSkips(dependencies, skippedAnalyzers);
  return hasErrors(violations) ? 1 : 0;
}

/**
 * Print `init`'s silent-skip warning at a rung that actually checks something.
 *
 * `adopting-guardrails` names a green `verify` as the exit criterion of an
 * adoption ("not 'files written' — green"), and the branch gates are what
 * enforce it afterwards. Until now the only command that mentioned an analyzer
 * being skipped was `init`, so every later run — including the one the adopter
 * was told to trust — printed `clean (0 violations)` with no hint that most of
 * the pack had not run. A warning delivered once, at scaffold time, is not
 * where a reader is standing when they draw the conclusion.
 *
 * Written after the count so it reads as a qualification of the result just
 * stated, and to stderr like every other advisory line, so a `--json` consumer
 * on stdout is unaffected.
 */
function warnAboutSilentSkips(
  dependencies: CliDependencies,
  silent: readonly (readonly [string, string])[],
): void {
  if (silent.length > 0) {
    dependencies.stderr(`guardrails: ${silentSkipWarning(silent)}\n`);
  }
}

async function autofixCommand(dependencies: CliDependencies): Promise<number> {
  const input = parseHookInput(await dependencies.readStdin());
  const repoRoot = await commandRepoRoot(dependencies, input.cwd);
  // No empty-list guard here: runAutofix filters to TypeScript files and returns
  // before spawning eslint when nothing is left, so a guard would only add a
  // branch whose two sides are indistinguishable through this function's one
  // seam. `hookFilePaths` carries the file-shape logic and is tested directly.
  await runAutofix({
    repoRoot,
    files: hookFilePaths(input),
    exec: dependencies.exec,
    resolveBin: binResolver(repoRoot),
  });
  return 0;
}

async function gateStopCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<number> {
  const input = parseHookInput(await dependencies.readStdin());
  const repoRoot = await commandRepoRoot(dependencies, input.cwd);
  const sessionId = input.sessionId ?? 'default';
  const config = loadConfig(repoRoot);
  const { decision } = await runStopGate({
    repoRoot,
    sessionId,
    baseBranch: config.baseBranch,
    exec: dependencies.exec,
    config: toGateConfig(config),
    resolveBin: binResolver(repoRoot),
    analyzers: config.analyzers,
    isRetry: input.stopHookActive,
  });
  const output =
    dialect === 'claude'
      ? formatStopHookOutput(decision)
      : formatCopilotStopOutput(decision);
  if (decision.outcome === 'release') {
    dependencies.stderr(
      'guardrails: releasing Stop retry with unresolved violations; ' +
        'the commit and CI gates remain active.\n',
    );
  }
  if (output) {
    dependencies.stdout(JSON.stringify(output));
  }
  return 0;
}

/**
 * The commit/push/ci gate. All three run the same checks; they differ only in
 * which change set the diff-scoped analyzers see.
 *
 * `commit` narrows to the staged files, because under branch scope stryker
 * re-mutates everything the branch has touched on every commit and the cost of
 * committing grows the longer a branch runs. `push` and `ci` keep the branch
 * scope, which is what catches the one thing staged scope cannot see: a commit
 * that removes the test killing a mutant in a file it does not itself touch.
 */
async function gateCommitCommand(
  dependencies: CliDependencies,
  changedScope: 'branch' | 'staged',
): Promise<number> {
  const repoRoot = await commandRepoRoot(dependencies);
  const config = loadConfig(repoRoot);
  const { violations, findings, blocked, skippedAnalyzers } =
    await runCommitGate({
      repoRoot,
      baseBranch: config.baseBranch,
      exec: dependencies.exec,
      resolveBin: binResolver(repoRoot),
      sanctionedSuppressions: config.sanctionedSuppressions,
      analyzers: config.analyzers,
      changedScope,
    });
  printGateDetail(dependencies, violations, findings);
  // Before the pass/block decision, because it qualifies either one: a gate
  // that blocked still checked less than the adopter thinks it did.
  warnAboutSilentSkips(dependencies, skippedAnalyzers);
  if (!blocked) {
    return 0;
  }
  // `enforcement` governs the commit and preToolUse gates only; the Claude Code
  // Stop loop is deliberately never softened (see RepoConfig.enforcement). Under
  // `warn` the findings are still printed in full above — a zero exit must never
  // be mistakable for a clean gate, so it is stated outright.
  if (config.enforcement === 'warn') {
    dependencies.stderr(NOT_BLOCKING_NOTE);
    return 0;
  }
  return 1;
}

const SHELL_TOOLS = /^(?:bash|shell|powershell)$/i;
// Requires `commit`/`push` immediately after `git`, so it won't match
// `git -C <path> commit` — acceptable, since the git-native pre-commit hook
// (Husky) is the hard floor that catches those commits regardless.
//
// `git` must also sit where a shell would START a command: the beginning of the
// string, or just past a separator. Without that, prose naming a git write
// counted as one — and this matcher now governs Claude Code's Bash tool, not
// only Copilot's much rarer shell calls, so a spurious match is paid
// interactively on an ordinary command. Measured on this repository before the
// anchor: `echo remember to git commit later` ran the whole branch-scoped
// commit gate, stryker included, for 1m43s.
//
// This is a command-POSITION test, not a shell parser — `FOO=1 git commit` and
// `xargs git commit` are misses. That is the same direction the `git -C` note
// above already accepts, and for the same reason: neither skips the git hooks,
// so the git-native floor still catches them. What must never be missed is a
// command that BYPASSES that floor, and `--no-verify` is written on a command,
// which is exactly what this matches.
//
// The padding after the separator is `[ \t]*`, not `\s*`, and that is not
// cosmetic: a newline is itself a separator, so `\s*` could match the same
// character the class just did, and the two readings of one input are what make
// the pattern backtrack super-linearly. Keeping the two disjoint — newline only
// in the class, spaces and tabs only in the padding — leaves exactly one way to
// match and no ambiguity to explore.
//
// Command substitution needs no alternative of its own: `$(git commit)` is
// matched by the `(` already in the class. An explicit `\$\(` branch was
// unreachable — no input distinguished the two patterns — which is the kind of
// dead alternation a regex mutator does not decompose finely enough to report.
/**
 * A git write in COMMAND POSITION, with git's global options allowed between
 * `git` and the subcommand.
 *
 * The separator and padding classes are deliberately DISJOINT -- `\n` in the
 * separator, `[ \t]` in the padding -- so no input has two readings. An earlier
 * version put `\n` in both, and this repo's own lint caught the super-linear
 * backtracking before it landed. The option run is bounded the same way: each
 * option is one non-space token, so it cannot overlap the padding around it.
 *
 * `-c` and `-C` are spelled out because they take a SEPARATE value token
 * (`-c core.hooksPath=/dev/null`); every other global option is either a flag
 * or carries its value with an `=`, so one token covers it.
 *
 * The option run exists for `git -c core.hooksPath=/dev/null commit`, which
 * DEFEATS the git-hook floor and is the exact bypass the scaffolded AGENTS.md
 * forbids by name -- an instruction naming a bypass the hook cannot see is
 * worse than no instruction. `git -C <path> commit` and `git --no-pager commit`
 * come along for free; the former was previously an accepted miss on the
 * grounds that the hooks still run, which stays true and now costs nothing.
 *
 * Still a command-POSITION test, not a shell parser: `FOO=1 git commit` and
 * `xargs git commit` remain misses, for the reason already recorded -- neither
 * skips the git hooks, so the git-native floor still catches them.
 */
const COMMAND_START = String.raw`(?:^|[\n;&|()\`{}])[ \t]*`;
/**
git's global options: a flag token, or `-c`/`-C` plus its separate value.
*/
const GIT_GLOBAL_OPTIONS = String.raw`(?:[ \t]+(?:-[cC][ \t]+[^ \t]+|-[^ \t]+))*`;
const GIT_WRITE = new RegExp(
  `${COMMAND_START}git${GIT_GLOBAL_OPTIONS}[ \t]+(?:commit|push)\\b`,
);

/** `gate --mode=pretooluse`: the Copilot commit/push gate. Self-filters on the
 * shell-tool + git-commit/push command shape rather than relying on hook
 * matcher config, because VS Code's Copilot hook host ignores matchers — the
 * command must gate itself regardless of how `.github/hooks` is configured. */
async function gatePreToolUseCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<void> {
  const input = parseHookInput(await dependencies.readStdin());
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
  const repoRoot = await commandRepoRoot(dependencies, input.cwd);
  const config = loadConfig(repoRoot);
  const { violations, findings, blocked } = await runCommitGate({
    repoRoot,
    baseBranch: config.baseBranch,
    exec: dependencies.exec,
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
  // Under `warn` the gate reports and allows. stderr rather than a deny payload,
  // because both hook dialects treat a deny payload as the block itself — there
  // is no "allow, but say this" channel — and stderr still surfaces in the
  // transcript. It prints the same detail its commit-gate sibling does: counts
  // alone on a hook that then allows the commit through are exactly what makes
  // a warn read as a pass.
  if (config.enforcement === 'warn') {
    printGateDetail(dependencies, violations, findings);
    dependencies.stderr(`${reason}\n`);
    dependencies.stderr(NOT_BLOCKING_NOTE);
    return;
  }
  dependencies.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
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
/** Reads a repo-relative source file for the count drift-guard. A key that
 *  escapes the repo (`../`) reads as absent rather than reaching outside it:
 *  the policy file is checked-in text, but it is still input. */
function repoSourceReader(
  repoRoot: string,
): (file: string) => string | undefined {
  return (file) => {
    const full = path.join(repoRoot, file);
    return isWithinRepo(repoRoot, file) && existsSync(full)
      ? readFileSync(full, 'utf8')
      : undefined;
  };
}

async function sanctionsCheckCommand(
  dependencies: CliDependencies,
): Promise<number> {
  const headText = readConfigText(dependencies.cwd) ?? '';
  const { valid: headSanctions, malformed } = parseSanctionsJson(headText);
  if (malformed.length > 0) {
    printViolations(
      dependencies,
      toMalformedViolations(malformed, CONFIG_FILE),
    );
    dependencies.stderr(
      `guardrails: ${malformed.length} malformed sanctionedSuppressions ` +
        `entry(ies) in ${CONFIG_FILE} — fix before merging.\n`,
    );
    return 1;
  }

  // Declared budgets must still match the source. Like `malformed`, this is a
  // FACTUAL error rather than a judgment about whether an exemption is
  // deserved, so it blocks -- an over-provisioned budget silently shrinks how
  // much the auditor is watching.
  const drift = sanctionCountDrift(
    headSanctions,
    repoSourceReader(dependencies.cwd),
  );
  if (drift.length > 0) {
    for (const entry of drift) {
      dependencies.stderr(
        `  - ${entry.key}: declared ${entry.declared}, found ${entry.actual}\n`,
      );
    }
    dependencies.stderr(
      `guardrails: ${drift.length} sanctionedSuppressions entry(ies) in ` +
        `${CONFIG_FILE} no longer match the source. Update \`count\` to the ` +
        `number of occurrences that remain, or drop the entry if the ` +
        `suppression is gone.\n`,
    );
    return 1;
  }

  const config = loadConfig(dependencies.cwd);
  // Resolve the base branch first: in a CI checkout it exists only as
  // `origin/<branch>`, and an unresolved merge-base would silently make every
  // entry read as newly granted -- turning the one report a reviewer relies on
  // into 40 lines of noise.
  const resolved = await resolveBaseReference(
    dependencies.exec,
    dependencies.cwd,
    config.baseBranch,
  );
  const baseReference = resolved.ref ?? config.baseBranch;
  const mergeBase = await dependencies.exec(
    'git',
    ['merge-base', baseReference, 'HEAD'],
    {
      cwd: dependencies.cwd,
    },
  );
  const sha = mergeBase.stdout.trim();
  const ref = sha && mergeBase.code === 0 ? sha : baseReference;
  const base = await dependencies.exec(
    'git',
    ['show', `${ref}:${CONFIG_FILE}`],
    {
      cwd: dependencies.cwd,
    },
  );
  // A missing base file (first adoption of guardrails) means nothing is known
  // yet, so every entry on the branch reads as newly granted.
  // Equivalent mutant on the `[]` default: `newlySanctioned` compares by key, so
  // a placeholder entry maps to an undefined key that no real entry can match —
  // every head entry still reads as newly granted, exactly as with [].
  // Stryker disable next-line ArrayDeclaration
  const known = base.code === 0 ? parseSanctionsJson(base.stdout).valid : [];
  const grants = newlySanctioned(known, headSanctions);
  if (grants.length === 0) {
    dependencies.stderr(
      'guardrails: no new diff-auditor exemptions granted.\n',
    );
    return 0;
  }
  dependencies.stderr(
    `guardrails: ${grants.length} new diff-auditor exemption(s) granted on ` +
      `this branch (reviewed by merging this pull request):\n`,
  );
  for (const line of formatGrantReport(grants)) {
    dependencies.stderr(`${line}\n`);
  }
  return 0;
}

async function auditCommand(dependencies: CliDependencies): Promise<number> {
  const diff = await dependencies.exec('git', ['diff', 'HEAD'], {
    cwd: dependencies.cwd,
  });
  const findings = auditDiff(diff.stdout);
  for (const finding of findings) {
    dependencies.stderr(
      `${finding.file}:${finding.line} ${finding.kind}: ${finding.text}\n`,
    );
  }
  return findings.length > 0 ? 1 : 0;
}

function stateCommand(
  dependencies: CliDependencies,
  sessionId: string,
): number {
  const directory = stateDirectory(dependencies.cwd);
  dependencies.stdout(
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

function denyPreToolUse(
  dependencies: CliDependencies,
  reason: string,
  dialect: Dialect,
): void {
  dependencies.stdout(JSON.stringify(formatPreToolUseDeny(reason, dialect)));
}

/**
Read-family tool names across dialects: Claude's `Read`, Copilot's `view`.
*/
const READ_TOOLS = /^(?:read|view)$/i;

function isReadTool(toolName: string | undefined): boolean {
  // Equivalent mutant on the `!== undefined` half: READ_TOOLS.test(undefined)
  // tests the string "undefined", which the anchored pattern rejects anyway.
  // Stryker disable next-line ConditionalExpression
  return toolName !== undefined && READ_TOOLS.test(toolName);
}

/**
 * The agent types the scope-lock is FOR, as the hosts report them.
 *
 * Not agent-settable: the host writes these fields, so a fixer cannot rename
 * itself out of the lock.
 */
const FIXER_AGENT_TYPES: ReadonlySet<string> = new Set([
  'guardrail-fixer',
  'guardrail-fixer-thorough',
]);

/**
 * Should this caller be confined to the violations manifest?
 *
 * The manifest is keyed by SESSION, and a subagent shares its parent's session
 * id -- so without agent identity the lock cannot tell the fixer from the main
 * agent or from a sibling subagent fanned out in parallel, and confines all of
 * them.
 *
 * The dialect is what makes absence readable, and it is why `agentId` is
 * parsed at all:
 *
 * - **claude** reports identity on EVERY hook event, and its SDK documents
 *   `agent_id` as present only inside a subagent -- "Absent for the main
 *   thread, even in --agent sessions". So on this dialect a missing `agentId`
 *   positively identifies the MAIN THREAD, which is never the fixer. Without
 *   this branch the main agent stayed confined during a fix, because a normal
 *   session's main thread sends neither field and looked identical to a host
 *   that cannot report at all.
 * - **codex / copilot** report nothing on `preToolUse` -- Copilot only on
 *   `subagentStart`/`subagentStop`, Codex not at all (`openai/codex#16226`).
 *   Absence there is "I cannot tell you", so the session-scoped lock stands.
 *   That is the conservative direction on purpose: Codex has no per-agent tool
 *   allowlist, so this hook is its only enforcement.
 *
 * No surface ends up less protected than before; what changes is how narrowly
 * the lock applies where the host gives us enough to narrow it.
 */
function isFixerCaller(input: HookInput, dialect: Dialect): boolean {
  if (dialect !== 'claude') {
    // These hosts report nothing on `preToolUse`, so there is nothing to
    // narrow by: everyone in the session is confined, as before.
    return true;
  }
  if (input.agentId === undefined) {
    return false;
  }
  // A subagent whose type we somehow did not get is confined rather than
  // trusted: unknown is not the same as "not the fixer".
  return (
    input.agentType === undefined || FIXER_AGENT_TYPES.has(input.agentType)
  );
}

async function scopeCheckCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<void> {
  const input = parseHookInput(await dependencies.readStdin());
  const repoRoot = await commandRepoRoot(dependencies, input.cwd);
  const scope = collectManifestScope(stateDirectory(repoRoot), input.sessionId);
  // Every branch below is a FIXER lock, so a caller the host tells us is not
  // the fixer is left alone entirely.
  const isConfined = scope.active && isFixerCaller(input, dialect);
  // Codex custom agents do not expose a per-agent tool allowlist. While a
  // fixer manifest is active, the repo-level hook therefore enforces the same
  // no-shell/no-MCP boundary that Claude and Copilot express declaratively.
  if (
    isConfined &&
    (SHELL_TOOLS.test(input.toolName ?? '') ||
      (input.toolName?.startsWith('mcp__') ?? false))
  ) {
    denyPreToolUse(
      dependencies,
      'Fixer capability-lock: shell and MCP tools are unavailable while a ' +
        'guardrail fixer is active.',
      dialect,
    );
    return;
  }
  // No empty-list guard: both branches below reduce to "no path violates the
  // scope" over an empty list, so an early return would only add a branch that
  // no test can distinguish.
  const filePaths = hookFilePaths(input);
  // Read: the fixer may read anything WITHIN the repo (manifest, edited files,
  // even node_modules rule sources — that in-repo exploration is how the
  // thorough tier diagnoses subtle rules), but nothing OUTSIDE it (e.g. the
  // user's ~/.claude project memory). Covers both dialects' read tool: Claude's
  // `Read` and Copilot's `view`.
  //
  // Gated on `scope.active` for the same reason the two branches around it are:
  // with no manifest, no fixer is running and this is the MAIN agent, which
  // reads outside the repo as a matter of course. Ungated, this branch made the
  // read-lock permanent for every session in every repo that scaffolds
  // guardrails -- a false positive that reached the main agent, not the fixer.
  if (isConfined && isReadTool(input.toolName)) {
    const outside = filePaths.find((file) => !isWithinRepo(repoRoot, file));
    if (outside !== undefined) {
      denyPreToolUse(
        dependencies,
        `Fixer read-scope: ${outside} is outside the repository. ` +
          `The fixer may only read files within the repo.`,
        dialect,
      );
    }
    return;
  }
  // Edit/Write: only the files named in the violations manifest. No active
  // manifest → the fixer isn't running; don't interfere. Keyed on `active`
  // rather than on the file set being non-empty, because those two differ in
  // exactly the case that matters: a manifest whose every violation named a
  // denied policy file (see DENIED_FILE_NAMES) yields NO editable files while a
  // fixer IS running, and reading that as "no fixer" would hand it the whole
  // repo. Such a fixer has nothing it may legitimately edit, so every write is
  // denied and the attempt escalates to the main agent.
  const denied = filePaths.find(
    (file) => !isPathAllowed(scope.files, repoRoot, file),
  );
  if (isConfined && denied !== undefined) {
    denyPreToolUse(
      dependencies,
      `Fixer scope-lock: ${denied} is not editable. The fixer may ` +
        `only edit files named in the violations manifest, and never ` +
        `package.json or guardrails.config.json.`,
      dialect,
    );
  }
}

async function sessionEndCommand(
  dependencies: CliDependencies,
): Promise<number> {
  const input = parseHookInput(await dependencies.readStdin());
  const sessionId = input.sessionId ?? 'default';
  deleteSession(
    stateDirectory(await commandRepoRoot(dependencies, input.cwd)),
    sessionId,
  );
  return 0;
}

/**
 * `install-hooks`: activates the git-native pre-commit gate that
 * `.githooks/pre-commit` does nothing without. `scripts.prepare` (wired by
 * `init --apply`'s `package.json` merger) invokes this on every
 * `npm install`, which is what gets a fresh clone or a teammate's checkout
 * onto the gate without them running anything by hand.
 *
 * Reads the repo through `detect` rather than trusting `deps.cwd`, for two
 * reasons that are really one: `core.hooksPath` is per-clone LOCAL git
 * config, so it has to be read AND written at the repo root git resolved
 * (setting it from a subdirectory — `npm install` inside a monorepo package —
 * configures the wrong repository, or none), and `detect` is the one place
 * that reads it. Running on every `npm install` is exactly why the
 * foreign-hooksPath check belongs here too: without it this command does not
 * merely break a husky consumer's hooks once, it re-breaks them immediately
 * after `husky` restores them, forever. That refusal exits 0 — a warning, not
 * a failed `npm install`.
 */
async function installHooksCommand(
  dependencies: CliDependencies,
): Promise<number> {
  const facts = await detect({
    exec: dependencies.exec,
    cwd: dependencies.cwd,
  });
  const existingHooksPath = foreignHooksPath(facts.hooksPath);
  if (existingHooksPath !== undefined) {
    dependencies.stderr(
      `guardrails: ${foreignHooksPathWarning(existingHooksPath)}\n`,
    );
    return 0;
  }
  const result = await dependencies.exec(
    'git',
    ['config', 'core.hooksPath', HOOKS_DIRECTORY],
    { cwd: facts.repoRoot },
  );
  if (result.code !== 0) {
    dependencies.stderr(
      `guardrails: git config core.hooksPath failed (exit ${result.code}): ` +
        `${result.stderr}\n`,
    );
    return 1;
  }
  return 0;
}

function flag(rest: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return rest
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function resolveDialect(rest: string[]): Dialect {
  const dialect = flag(rest, 'dialect');
  return dialect === 'copilot' || dialect === 'codex' ? dialect : 'claude';
}

/**
 * The message for a CLI that resolved from outside the repository it is about
 * to guard, or `undefined` when it did not — or when there is no repository to
 * bound it against.
 *
 * Node resolves `guardrails-core` by walking up from the hook's cwd, and that
 * walk does not stop at the repository (spec §3, layout F). So a stray install
 * in an ancestor — `~/node_modules`, typically — satisfies every hook in a repo
 * that never installed guardrails, at whatever version that ancestor holds,
 * with no signal at all.
 *
 * `findGitRoot` rather than `resolveRepoRoot`: the latter falls back to `cwd`,
 * which would make "no repository here" indistinguishable from "the root is
 * cwd" and reject the hoisted-subpackage layout the walk exists to support.
 */
function outsideRepoMessage(dependencies: CliDependencies): string | undefined {
  const selfPath = dependencies.selfPath ?? fileURLToPath(import.meta.url);
  const repoRoot = findGitRoot(dependencies.cwd);
  if (repoRoot === undefined || isWithinRepo(repoRoot, selfPath)) {
    return undefined;
  }
  return (
    `guardrails: resolved from ${selfPath}, which is outside ` +
    `${repoRoot}. This happens when guardrails-core comes from an ` +
    `ancestor directory's node_modules, or from a linked install ` +
    `(npm link, or a file: dependency) pointing outside the repo. ` +
    `Install guardrails-core in this repository (npm install) instead.\n`
  );
}

export async function runCommand(
  command: string | undefined,
  rest: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const outside = outsideRepoMessage(dependencies);
  if (outside !== undefined) {
    dependencies.stderr(outside);
    return 1;
  }
  switch (command) {
    case 'verify': {
      return verifyCommand(dependencies);
    }
    case 'autofix': {
      return autofixCommand(dependencies);
    }
    case 'gate': {
      const mode = flag(rest, 'mode');
      if (mode === 'commit') {
        return gateCommitCommand(dependencies, 'staged');
      }
      // Same checks, branch-wide scope: `push` is the local rung that catches
      // what a staged-scope commit cannot, and `ci` is its authoritative twin.
      if (mode === 'push' || mode === 'ci') {
        return gateCommitCommand(dependencies, 'branch');
      }
      if (mode === 'pretooluse') {
        await gatePreToolUseCommand(dependencies, resolveDialect(rest));
        return 0;
      }
      return gateStopCommand(dependencies, resolveDialect(rest));
    }
    case 'audit': {
      return auditCommand(dependencies);
    }
    case 'sanctions-check': {
      return sanctionsCheckCommand(dependencies);
    }
    case 'state': {
      return stateCommand(dependencies, flag(rest, 'session') ?? 'default');
    }
    case 'scope-check': {
      const dialect = resolveDialect(rest);
      await scopeCheckCommand(dependencies, dialect);
      return 0;
    }
    case 'session-start': {
      sweepStale(stateDirectory(dependencies.cwd), SESSION_TTL_MS, Date.now());
      return 0;
    }
    case 'session-end': {
      return sessionEndCommand(dependencies);
    }
    case 'init': {
      return initCommand(dependencies, rest);
    }
    case 'install-hooks': {
      return installHooksCommand(dependencies);
    }
    default: {
      dependencies.stderr(
        'usage: guardrails-core <command>\n' +
          '  init [--plan|--apply] [--json] [--force] [--enforcement=warn|block]\n' +
          '       [--analyzers=<tool>=<off|auto|required>[,...]] [--distribution=solo|team]\n' +
          '  gate --mode=stop|commit|push|ci|pretooluse [--dialect=codex|copilot]\n' +
          '  verify | autofix | audit | sanctions-check | install-hooks\n' +
          '  state | scope-check | session-start | session-end\n',
      );
      return 1;
    }
  }
}
