/**
 * Command logic for the `guardrails` CLI, with all process I/O injected as
 * `CliDependencies` so every subcommand is unit-testable without spawning a process.
 * `cli.ts` is a thin bootstrap that supplies the real dependencies.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { auditDiff, type AuditFinding } from './audit.js';
import { type EffectiveBase, resolveEffectiveBase } from './base-reference.js';
import { runAutofix } from './autofix.js';
import { formatDecisionReport, summarizeDecisions } from './decision-log.js';
import { addedSuppressions } from './edit-suppressions.js';
import {
  CONFIG_FILE_NAME,
  loadConfig,
  type RepoConfig,
  type SanctionedFile,
  parseSanctionsJson,
  readConfigText,
  toGateConfig,
} from './config.js';
import { type Exec, terminateChildren } from './exec.js';
import {
  runCommitGate,
  runStopGate,
  unreadableDiffMessage,
  type CommitDelegation,
  type CommitGateOptions,
} from './gate.js';
import { leaseWaitNote } from './gate-decision.js';
import { findGitRoot, resolveRepoRoot } from './repo-root.js';
import { repoSourceReader } from './repo-source.js';
import {
  formatGrantReport,
  newlySanctioned,
  newlySanctionedFiles,
  type SanctionCountDrift,
  type SanctionGrant,
  sanctionIntegrity,
  type SanctionPlacementIssue,
  toMalformedViolations,
} from './sanctions.js';
import {
  findingsFromManifest,
  formatProposals,
  proposeSanctions,
} from './sanction-proposal.js';
import { readJsonFile } from './json-file.js';
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
  claudeSkillEntries,
  guidanceEntries,
  guidanceRoot,
} from './scaffold/templates.js';
import { parseManifest, MANIFEST_PATH } from './scaffold/manifest.js';
import { staleArtifacts } from './scaffold/staleness.js';
import {
  foreignHooksPath,
  foreignHooksPathWarning,
  HOOKS_DIRECTORY,
} from './scaffold/hooks-path.js';
import { initCommand } from './scaffold/init.js';
import { foregroundWait, foregroundWaitDenial } from './foreground-wait.js';
import { commandTarget } from './command-target.js';
import { isPushGatedByHook } from './push-hook.js';
import { COMMAND_START, withoutQuotedHeredocBodies } from './shell-command.js';
import { collectSessionScope, isWithinRepo } from './scope.js';
import {
  baseReferenceCache,
  deleteSession,
  isAgentIdentityReported,
  loadLeases,
  loadRecurrence,
  loadSession,
  markAgentIdentityReported,
  readDecisions,
  saveLeases,
  shipStatusFile,
  stateDirectory,
  sweepStale,
} from './state-store.js';
import { ship, shipSummary, writeShipStatus } from './ship.js';
import { withHeartbeat } from './state.js';
import { hasErrors, isViolation, type Violation } from './violation.js';
import type { Rung } from './verify/analyzer-policy.js';
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
  /**
   * The process environment, injected for the same reason as `selfPath`: so
   * the session-root lookup (`sessionCwd`) has a seam. Falls back to
   * `process.env`, read here rather than in the logic-free `cli.ts`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Stop every analyzer still running; defaults to `terminateChildren`. A seam
   * for the hook deadline, whose real effect is on processes a test cannot
   * afford to start.
   */
  terminate?: () => number;
  /**
   * End the process; defaults to `process.exit`. The hook deadline's way out of
   * a gate that is still pending.
   */
  exit?: (code: number) => void;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function binResolver(repoRoot: string): (tool: string) => string {
  return (tool) => resolveLocalBin(repoRoot, tool);
}

/**
 * The `CommitGateOptions` fields both commit-rung callers derive the same way
 * from `config` and `repoRoot` — `gateCommitCommand` (`.husky/pre-commit`) and
 * `gatePreToolUseCommand` (the Copilot commit/push gate). Extracted once the
 * `dupes` analyzer flagged the two call sites as a 12-line clone: this mapping
 * is the one thing they must evolve together — a config field forwarded to
 * `runCommitGate` at one call site and not the other is a real regression, not
 * an accident of two similar-looking sites. Each caller still spreads its own
 * extra fields (`sessionId`, `profile`, `changedScope`) on top.
 */
function commitGateOptionsFromConfig(
  repoRoot: string,
  config: RepoConfig,
  exec: Exec,
  baseBranch: string = config.baseBranch,
): Pick<
  CommitGateOptions,
  | 'repoRoot'
  | 'baseBranch'
  | 'exec'
  | 'resolveBin'
  | 'sanctionedSuppressions'
  | 'sanctionedFiles'
  | 'analyzers'
  | 'analyzerRungs'
  | 'config'
> {
  return {
    repoRoot,
    baseBranch,
    exec,
    resolveBin: binResolver(repoRoot),
    sanctionedSuppressions: config.sanctionedSuppressions,
    sanctionedFiles: config.sanctionedFiles,
    analyzers: config.analyzers,
    analyzerRungs: config.analyzerRungs,
    config: toGateConfig(config),
  };
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

/**
 * Which ref this run verifies against, and a line saying so when it is not the
 * configured default (#104).
 *
 * Silent fallback, visible resolution. Every failure path inside
 * `resolveEffectiveBase` lands on `config.baseBranch`, which is WIDER than a
 * pull request's base -- so a wrong answer costs time, never coverage, and is
 * not worth a message on a rung that runs every turn. A base that is NOT the
 * configured one is worth a message, because it is the difference between a
 * 30-second run and a 30-minute one, and nobody should have to guess which
 * they are getting.
 */
async function resolveBase(
  dependencies: CliDependencies,
  repoRoot: string,
  config: RepoConfig,
  explicit?: string,
): Promise<EffectiveBase> {
  return resolveEffectiveBase({
    exec: dependencies.exec,
    repoRoot,
    configBase: config.baseBranch,
    // Straight through, not conditionally spread -- see `EffectiveBaseOptions`.
    explicit,
    cache: baseReferenceCache(repoRoot),
  });
}

/**
 * The resolved base, plus a line saying so when it is not the configured one
 * (#104).
 *
 * Silent fallback, visible resolution. Every failure path inside
 * `resolveEffectiveBase` lands on `config.baseBranch`, which is WIDER than a
 * pull request's base -- so a wrong answer costs time, never coverage, and is
 * not worth a message. A base that is NOT the configured one IS worth one,
 * because it is the difference between a 30-second run and one you kill at 30
 * minutes, and nobody should have to guess which they are getting.
 *
 * The hook rungs (stop, pretooluse) call `resolveBase` directly instead: they
 * answer a hook with a JSON decision, and an advisory line on stderr is noise
 * in a channel nobody asked to read.
 */
async function reportedBase(
  dependencies: CliDependencies,
  repoRoot: string,
  config: RepoConfig,
  rest: string[],
): Promise<EffectiveBase> {
  const resolved = await resolveBase(
    dependencies,
    repoRoot,
    config,
    flag(rest, 'base'),
  );
  if (resolved.base !== config.baseBranch) {
    const why =
      resolved.source === 'flag' ? '--base' : "this branch's pull request";
    dependencies.stderr(
      `guardrails: verifying against ${resolved.base} (${why}), not the ` +
        `configured ${config.baseBranch}.\n`,
    );
  }
  return resolved;
}

/**
 * The preamble of every command a person or a git hook runs directly (verify,
 * the commit/push/ci gates, ship): the repository root, its config, and the
 * base -- reported when it is not the configured one.
 */
async function directContext(
  dependencies: CliDependencies,
  rest: string[],
): Promise<{ repoRoot: string; config: RepoConfig; base: EffectiveBase }> {
  const repoRoot = await commandRepoRoot(dependencies);
  const config = loadConfig(repoRoot);
  const base = await reportedBase(dependencies, repoRoot, config, rest);
  return { repoRoot, config, base };
}

/**
 * The one-line verdict, with warnings counted apart from errors: a
 * non-blocking advisory printed as "1 violation(s)." beside a zero exit sent
 * agents looking for a failure that was not there.
 */
function verdictLine(violations: readonly Violation[]): string {
  if (violations.length === 0) {
    return 'clean (0 violations).';
  }
  const errorCount = violations.filter(
    (violation) => violation.severity === 'error',
  ).length;
  const warningCount = violations.length - errorCount;
  return `${errorCount} error(s), ${warningCount} warning(s).`;
}

async function verifyCommand(
  dependencies: CliDependencies,
  rest: string[],
): Promise<number> {
  const { repoRoot, config, base } = await directContext(dependencies, rest);
  const { violations, skippedAnalyzers } = await runVerify({
    repoRoot,
    baseBranch: base.base,
    exec: dependencies.exec,
    profile: 'ci',
    resolveBin: binResolver(repoRoot),
    analyzers: config.analyzers,
    analyzerRungs: config.analyzerRungs,
  });
  printViolations(dependencies, violations);
  dependencies.stderr(`guardrails: ${verdictLine(violations)}\n`);
  warnAboutSilentSkips(dependencies, skippedAnalyzers);
  return hasErrors(violations) ? 1 : 0;
}

/**
 * The preamble every stdin-driven hook command shares: read the host's payload,
 * then resolve the repository root FROM the cwd that payload reports.
 *
 * The two lines always travel together — the root is derived from the parsed
 * input, so neither is useful without the other — and three commands carried a
 * copy each until the `dupes` analyzer reported it.
 */
async function hookContext(
  dependencies: CliDependencies,
): Promise<{ input: HookInput; repoRoot: string }> {
  const input = parseHookInput(await dependencies.readStdin());
  return { input, repoRoot: await commandRepoRoot(dependencies, input.cwd) };
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
  const { input, repoRoot } = await hookContext(dependencies);
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

/**
 * Where a SESSION-scoped rung (stop, session-start, session-end) should look
 * for its repository: the session's root, not wherever the shell last went.
 *
 * A hook payload's `cwd` follows the agent's shell. Probed live on Claude
 * Code: after a `cd` into a nested worktree the Stop payload named the
 * worktree, while CLAUDE_PROJECT_DIR still named the launch root -- and under
 * `claude --worktree` CLAUDE_PROJECT_DIR is the worktree itself, so it is the
 * session's own root in both cases. In the dialed.run adoption an
 * orchestrating session's Stop gate verified -- and sent fixers into -- lane
 * worktrees other agents were mid-way through, about 150 times.
 *
 * Only for Claude Code's main thread: a subagent (`agent_id` present) works in
 * its own checkout, and Codex and Copilot expose no project root at all, so
 * they keep the payload cwd. A CLAUDE_PROJECT_DIR outside any repository (a
 * session launched in a home directory) is ignored rather than verified.
 * Tool-scoped rungs never use this: a lane agent's commit gate must check the
 * lane's worktree.
 */
function sessionCwd(
  dependencies: CliDependencies,
  input: HookInput,
  dialect: Dialect,
): string | undefined {
  const projectDirectory = (dependencies.env ?? process.env).CLAUDE_PROJECT_DIR;
  const isSessionRoot =
    dialect === 'claude' &&
    input.agentId === undefined &&
    projectDirectory !== undefined &&
    findGitRoot(projectDirectory) !== undefined;
  return isSessionRoot ? projectDirectory : input.cwd;
}

async function gateStopCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<number> {
  const input = parseHookInput(await dependencies.readStdin());
  const repoRoot = await commandRepoRoot(
    dependencies,
    sessionCwd(dependencies, input, dialect),
  );
  const sessionId = input.sessionId ?? 'default';
  const config = loadConfig(repoRoot);
  // Quiet, and cached: this runs on every turn, so it must cost at most one
  // host call per branch per TTL and must not add a line to the hook channel.
  const base = await resolveBase(dependencies, repoRoot, config);
  const { decision } = await runStopGate({
    repoRoot,
    sessionId,
    baseBranch: base.base,
    exec: dependencies.exec,
    config: toGateConfig(config),
    resolveBin: binResolver(repoRoot),
    analyzers: config.analyzers,
    analyzerRungs: config.analyzerRungs,
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
/**
 * The commit rung's delegation pointer, mirroring the stop gate's.
 *
 * #49: the terse-pointer → fixer loop existed only at `stop`, so commit-rung
 * violations arrived with no delegation path — and the surface that actually
 * consumes agent context, the PreToolUse deny, said "run `guardrails verify`",
 * which dumps every violation into the transcript. On the reported adoption
 * that was 214 mutants worked through inline.
 *
 * Falls back to the old counts-and-verify wording when no fixer is known, so
 * a caller without a config still gets something actionable.
 *
 * `waitFor` is the commit rung's half of the cross-rung collision guard (#76):
 * when a Stop-rung fixer already holds some of these files, this surface is
 * where the instruction to put a SECOND one in them would otherwise be given.
 * The wording mirrors the stop gate's — same facts, this rung's next move.
 */
function commitPointer(
  violationCount: number,
  findingCount: number,
  delegation: CommitDelegation,
): string {
  const counts =
    `guardrails: ${violationCount} violation(s), ` +
    `${findingCount} added suppression(s). `;
  if (delegation.waitFor !== undefined) {
    return (
      `${counts}Written to ${delegation.manifestPath}, but ` +
      `${leaseWaitNote(delegation.waitFor)}. Do NOT read either manifest, and ` +
      `do NOT spawn a fixer yet: two fixers editing one file lose each ` +
      `other's work, and a dead-code or unused-import finding computed ` +
      `against a file another fixer is changing is not a finding. Wait for ` +
      `that ${delegation.waitFor.fixerAgent} to report, then commit again.`
    );
  }
  return (
    `${counts}Written to ${delegation.manifestPath}. Do NOT read it. Spawn ` +
    `the ${delegation.fixerAgent} subagent and give it that path to fix, then ` +
    `commit again.`
  );
}

async function gateCommitCommand(
  dependencies: CliDependencies,
  changedScope: 'branch' | 'staged',
  profile: Rung,
  rest: string[],
): Promise<number> {
  const { repoRoot, config, base } = await directContext(dependencies, rest);
  const {
    violations,
    findings,
    blocked,
    skippedAnalyzers,
    delegation,
    unreadable,
    cached,
  } = await runCommitGate({
    ...commitGateOptionsFromConfig(
      repoRoot,
      config,
      dependencies.exec,
      base.base,
    ),
    changedScope,
    profile,
  });
  if (cached === true) {
    // Said, so a two-second push gate is never mistaken for one that ran. No
    // early return: a cached result is an empty, unblocked one, so the rest of
    // this function already passes it.
    dependencies.stderr(
      'guardrails: push gate skipped — this exact tree already passed it ' +
        'against the same base (cached: true).\n',
    );
  }
  printGateDetail(dependencies, violations, findings);
  // Before the pass/block decision, because it qualifies either one: a gate
  // that blocked still checked less than the adopter thinks it did.
  warnAboutSilentSkips(dependencies, skippedAnalyzers);
  if (unreadable !== undefined) {
    // Deliberately ABOVE the `enforcement === 'warn'` softening below, and
    // returning 1 unconditionally: `warn` trades a block for a report on
    // findings the gate actually made, and this is the ABSENCE of a verdict
    // rather than a finding. A killed diff reported as a zero exit is the
    // fail-open this closes (#92).
    dependencies.stderr(`guardrails: ${unreadableDiffMessage(unreadable)}\n`);
    return 1;
  }
  if (!blocked) {
    return 0;
  }
  // The dump above STAYS on this surface, unlike the PreToolUse deny. Two
  // different readers: `.husky/pre-commit` prints into a developer's terminal,
  // where hiding the violations behind a file path would be a regression, and
  // an agent committing through Bash has already been stopped at the
  // PreToolUse gate before reaching here. So this surface gains the pointer
  // rather than trading the detail for it (#49).
  dependencies.stderr(
    `guardrails: the above is also written to ${delegation.manifestPath} — ` +
      `an agent can spawn the ${delegation.fixerAgent} subagent against that ` +
      `path instead of working through it inline.\n`,
  );
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
/**
 * git's global options: a flag token, or `-c`/`-C` plus its separate value.
 *
 * The value alternative requires a NON-`-` first character, and that is what
 * keeps the run linear. Without it the two alternatives can tile the same token
 * sequence two ways -- `-c -c` as one flag-plus-value, or as two flags -- so a
 * run of k flags has Fibonacci(k) equivalent partitions, every one of which a
 * failing overall match must exhaust. That is the textbook `(a|aa)*`
 * catastrophic-backtracking shape, and it was real here: measured 5.69s at 40
 * tokens and 51s at 64, on `input.command` from the Bash PreToolUse hook --
 * the agent's highest-frequency tool, so a long enough command would have hung
 * the session. With the constraint, a token beginning `-` can only be read as
 * a flag and a token that does not can only be a value: exactly one parse.
 *
 * `sonarjs/regex-complexity` cannot see this. Assembling the pattern from
 * `String.raw` fragments -- done to get the literal under the complexity
 * ceiling -- also takes it out of static analysis, which is how this shipped
 * past a lint that had caught the same class before. `cli-core.test.ts` pins
 * the property by TIMING instead: the guarantee is "no exponential path
 * exists", which no example input can assert on its own.
 */
const GIT_GLOBAL_OPTIONS = String.raw`(?:[ \t]+(?:-[cC][ \t]+[^-\s][^ \t]*|-[^ \t]+))*`;
const GIT_WRITE = new RegExp(
  `${COMMAND_START}git${GIT_GLOBAL_OPTIONS}[ \t]+(?:commit|push)\\b`,
);
const GIT_COMMIT = new RegExp(
  `${COMMAND_START}git${GIT_GLOBAL_OPTIONS}[ \t]+commit\\b`,
);

/**
 * What takes a push out of reach of its pre-push hook: the flag that skips it,
 * or a hooks path chosen on the command line. A push carrying either is gated
 * here as it always was, whatever the hook says.
 */
const HOOK_BYPASS = /--no-verify\b|hooksPath/;

/**
 * Is this a push and nothing else -- no commit riding along, no hook bypass --
 * so that the pre-push hook is the gate it will meet?
 */
function isPlainPush(command: string): boolean {
  const text = withoutQuotedHeredocBodies(command);
  return !GIT_COMMIT.test(text) && !HOOK_BYPASS.test(text);
}

/**
 * Is this hook call a shell tool running a git write (commit or push)? The
 * only calls the pretooluse gate has an opinion about.
 */
function isShellGitWrite(input: HookInput): boolean {
  return (
    // Equivalent mutants on the two `!== undefined` clauses: forcing either
    // true still answers false, because the regex test on the very next line
    // stringifies `undefined` to "undefined", which matches neither pattern.
    // Stryker disable next-line ConditionalExpression
    input.toolName !== undefined &&
    SHELL_TOOLS.test(input.toolName) &&
    // Stryker disable next-line ConditionalExpression
    input.command !== undefined &&
    GIT_WRITE.test(withoutQuotedHeredocBodies(input.command))
  );
}

/**
 * Deny a foreground wait (see `foreground-wait.ts`), and say whether it did.
 *
 * Claude Code only, and only its `Bash` tool: that is the shell whose
 * `run_in_background` wakes the agent once, when the command exits. Telling a
 * Codex or Copilot agent to background a command its shell cannot background
 * would leave it no way to run the command at all.
 *
 * The config is read from the checkout the command runs in, the way
 * `decidingHook` reads its deadline -- by walking the filesystem, because this
 * runs on every Bash call and a git spawn per call is a cost every command
 * would pay.
 */
function didDenyForegroundWait(
  dependencies: CliDependencies,
  input: HookInput,
  dialect: Dialect,
): boolean {
  if (
    dialect !== 'claude' ||
    input.toolName !== 'Bash' ||
    input.runInBackground === true
  ) {
    return false;
  }
  const where = input.cwd ?? dependencies.cwd;
  const config = loadConfig(findGitRoot(where) ?? where);
  const wait = config.denyForegroundWaits
    ? foregroundWait(input.command ?? '', config.foregroundSleepLimitSeconds)
    : undefined;
  if (wait === undefined) {
    return false;
  }
  denyPreToolUse(dependencies, foregroundWaitDenial(wait), dialect);
  return true;
}

/**
 * The remedy when the write's repository cannot be told: the two literal
 * shapes `commandTarget` always resolves.
 */
function unknownTargetMessage(reason: string): string {
  return (
    `guardrails: cannot tell which repository this git write lands in ` +
    `(${reason}), so it was not checked. Use a literal path: ` +
    '`cd <dir> && git ...` or `git -C <dir> ...`.'
  );
}

/**
 * The repository the command's git write lands in (#123) -- not the one the
 * payload's `cwd` names, which is where the shell stood BEFORE a `cd` or a
 * `git -C` moved it. Denies the write, and answers `undefined`, when that
 * cannot be told: guessing would gate the wrong repository, which is the bug.
 */
async function writeRepoRoot(
  dependencies: CliDependencies,
  input: HookInput,
  dialect: Dialect,
): Promise<string | undefined> {
  const target = commandTarget(
    input.command ?? '',
    input.cwd ?? dependencies.cwd,
    homedir(),
  );
  if (target.kind === 'unknown') {
    denyPreToolUse(dependencies, unknownTargetMessage(target.reason), dialect);
    return undefined;
  }
  return commandRepoRoot(dependencies, target.directory);
}

/**
 * The environment variable a delegated pretooluse run reads its repository
 * root from. Set only by `delegateToTarget`, on the run it spawns, so that run
 * gates exactly that root: re-reading `cd ../x` from the rewritten cwd would
 * land somewhere else.
 */
const PRETOOLUSE_TARGET = 'GUARDRAILS_PRETOOLUSE_TARGET';

/**
Where this CLI was resolved from, as a filesystem path.
*/
function selfLocation(dependencies: CliDependencies): string {
  return dependencies.selfPath ?? fileURLToPath(import.meta.url);
}

/**
 * Where `repoRoot`'s own guardrails-core CLI resolves from, the way the hook
 * command resolves it when run there. Empty when nothing resolves.
 */
function resolveCliFrom(repoRoot: string): { cli?: string } {
  try {
    const requireFrom = createRequire(path.join(repoRoot, 'package.json'));
    return { cli: requireFrom.resolve('guardrails-core/cli') };
  } catch {
    return {};
  }
}

/**
 * The deny for a write into a repository that adopted guardrails but has no
 * guardrails-core of its own (#115's remedy, naming the target).
 */
function targetInstallRemedy(repoRoot: string): string {
  return (
    `guardrails: this git write lands in ${repoRoot}, which has a ` +
    `${CONFIG_FILE_NAME} but no guardrails-core installed inside it, so its ` +
    `gate cannot run. Run \`npm ci\` in ${repoRoot}, then retry.`
  );
}

/**
 * Hand a write that lands in ANOTHER repository to that repository's own
 * install (#123): its config, its pinned version, its tree. The payload's cwd
 * is rewritten to the target root too, so a target whose guardrails-core
 * predates the marker still gates the right tree through its own `cwd` path.
 *
 * A target with no install of its own is denied when it adopted guardrails
 * (there is a gate that should have run) and allowed when it did not (there
 * is nothing to enforce, and its git hooks still run). A delegate that fails
 * throws, so `decidingHook` denies the write rather than letting it through.
 */
async function delegateToTarget(
  dependencies: CliDependencies,
  stdin: string,
  repoRoot: string,
  dialect: Dialect,
): Promise<void> {
  const { cli } = resolveCliFrom(repoRoot);
  if (cli === undefined || !isWithinRepo(realpathSync(repoRoot), cli)) {
    if (existsSync(path.join(repoRoot, CONFIG_FILE_NAME))) {
      denyPreToolUse(dependencies, targetInstallRemedy(repoRoot), dialect);
    }
    return;
  }
  const result = await dependencies.exec(
    process.execPath,
    [
      '-e',
      "import('guardrails-core/cli')",
      'guardrails',
      'gate',
      '--mode=pretooluse',
      `--dialect=${dialect}`,
    ],
    {
      cwd: repoRoot,
      env: {
        ...(dependencies.env ?? process.env),
        [PRETOOLUSE_TARGET]: repoRoot,
      },
      // Valid JSON by now: only a payload `parseHookInput` already parsed
      // reaches here, through `isShellGitWrite`.
      input: JSON.stringify({ ...JSON.parse(stdin), cwd: repoRoot }),
    },
  );
  // A spawn failure needs no clause of its own: `spawnExec` reports it with
  // exit code 1. A kill does: Node reports it as a null code, coalesced to 0.
  if (result.signal !== undefined || result.code !== 0) {
    const killed = result.signal === undefined ? '' : ` on ${result.signal}`;
    throw new Error(
      `the guardrails-core in ${repoRoot} exited ${result.code}${killed}: ` +
        result.stderr.trim(),
    );
  }
  dependencies.stdout(result.stdout);
  dependencies.stderr(result.stderr);
}

/**
 * The root this run gates in-process, or `undefined` once the write is
 * decided another way: denied because its target is unknowable, or handed to
 * the target repository's own install. A delegated run takes its root from
 * the marker and never delegates again.
 */
async function gateRoot(
  dependencies: CliDependencies,
  input: HookInput,
  stdin: string,
  dialect: Dialect,
): Promise<string | undefined> {
  const marked = (dependencies.env ?? process.env)[PRETOOLUSE_TARGET];
  if (marked !== undefined) {
    return marked;
  }
  const repoRoot = await writeRepoRoot(dependencies, input, dialect);
  if (
    repoRoot === undefined ||
    isWithinRepo(repoRoot, selfLocation(dependencies))
  ) {
    return repoRoot;
  }
  await delegateToTarget(dependencies, stdin, repoRoot, dialect);
  return undefined;
}

/** `gate --mode=pretooluse`: the Copilot commit/push gate. Self-filters on the
 * shell-tool + git-commit/push command shape rather than relying on hook
 * matcher config, because VS Code's Copilot hook host ignores matchers — the
 * command must gate itself regardless of how `.github/hooks` is configured. */
async function gatePreToolUseCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<void> {
  const stdin = await dependencies.readStdin();
  const input = parseHookInput(stdin);
  if (didDenyForegroundWait(dependencies, input, dialect)) {
    return;
  }
  if (!isShellGitWrite(input)) {
    return; // allow (silent)
  }
  const repoRoot = await gateRoot(dependencies, input, stdin, dialect);
  if (repoRoot === undefined) {
    return; // decided already: denied, or handed to the target's install
  }
  // A push whose pre-push hook runs the push gate meets a superset of these
  // checks there, under the machine-wide lock. Pre-running them here bought an
  // unlocked, deadline-bounded duplicate. A commit is unchanged.
  if (
    isPlainPush(input.command ?? '') &&
    (await isPushGatedByHook(dependencies.exec, repoRoot))
  ) {
    return; // allow (silent): the pre-push hook is the gate
  }
  const config = loadConfig(repoRoot);
  // Quiet: this rung answers a hook with a JSON decision.
  const base = await resolveBase(dependencies, repoRoot, config);
  const { violations, findings, blocked, delegation, unreadable } =
    await runCommitGate({
      ...commitGateOptionsFromConfig(
        repoRoot,
        config,
        dependencies.exec,
        base.base,
      ),
      sessionId: input.sessionId,
    });
  if (!blocked) {
    return; // allow (silent)
  }
  if (unreadable !== undefined) {
    // Denied, never allowed-with-a-warning, and not softened by `warn`: this
    // rung stands in front of the agent's own `git commit`, so allowing here
    // would let a suppression reach a commit that nothing audited (#92).
    denyPreToolUse(dependencies, unreadableDiffMessage(unreadable), dialect);
    return;
  }
  // No `delegation === undefined` branch: `blocked` narrows the result union,
  // so the compiler already knows a block carries one. That is the point of the
  // union -- the guard it replaces was unreachable code the tests could never
  // reach and a mutant could therefore never be killed on.
  const reason = commitPointer(violations.length, findings.length, delegation);
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

const CONFIG_FILE = CONFIG_FILE_NAME;

/** `sanctions-check`: CI approval-visibility gate for the diff-auditor's escape
 * hatch. It can only FAIL on a malformed `sanctionedSuppressions` entry in the
 * head config (exit 1, listing each). A newly-granted exemption — a key absent
 * from the merge-base config, or a key whose total count increased — is never a
 * failure: it is printed prominently for the reviewer and the check exits 0, so
 * it can be a required status check without deadlocking the very merge that
 * constitutes its approval. The gate itself (`runCommitGate`) is what enforces
 * reality: an occurrence beyond the declared count still blocks the commit
 * regardless of what this check reports. See src/sanctions.ts. */
/**
 * Print the exemptions this branch introduces, for the reviewer whose merge IS
 * the approval.
 *
 * The two forms get SEPARATE headings on purpose. A path grant covers every
 * occurrence of one kind in one file, with no count bounding it and nothing
 * re-deriving it afterwards; a keyed grant is exact and verified every run.
 * Someone skimming this output should never have to work out which kind they
 * are being asked to approve.
 *
 * Extracted from `sanctionsCheckCommand` because adding the second form pushed
 * that function to cyclomatic 15, which `fallow health` caught at the pre-push
 * gate.
 */
function reportNewGrants(
  dependencies: CliDependencies,
  grants: readonly SanctionGrant[],
  fileGrants: readonly SanctionedFile[],
): void {
  if (grants.length === 0 && fileGrants.length === 0) {
    dependencies.stderr(
      'guardrails: no new diff-auditor exemptions granted.\n',
    );
    return;
  }
  if (grants.length > 0) {
    dependencies.stderr(
      `guardrails: ${grants.length} new diff-auditor exemption(s) granted on ` +
        `this branch (reviewed by merging this pull request):\n`,
    );
    for (const line of formatGrantReport(grants)) {
      dependencies.stderr(`${line}\n`);
    }
  }
  // Reported separately and labelled, because a path grant is the broader of
  // the two: it covers every occurrence of one kind in one file, with no count
  // bounding it, and review is its only safeguard. A reviewer skimming this
  // output should not have to work out which kind of grant they are approving.
  if (fileGrants.length > 0) {
    dependencies.stderr(
      `guardrails: ${fileGrants.length} new WHOLE-FILE exemption(s) granted ` +
        `on this branch. These cover every occurrence of a kind in a file, ` +
        `with no count to bound them:\n`,
    );
    for (const file of fileGrants) {
      dependencies.stderr(`  - ${file.path} [${file.kind}]: ${file.reason}\n`);
    }
  }
}

/**
 * A declared budget that no longer matches the source. Factual, not a judgment
 * about whether the exemption is deserved, so it blocks: an over-provisioned
 * budget silently shrinks how much the auditor is watching.
 */
function reportCountDrift(
  dependencies: CliDependencies,
  drift: readonly SanctionCountDrift[],
): void {
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
}

/**
 * A granted Stryker directive whose SCOPE has moved (#79).
 *
 * Blocks for the same reason the count guard does, and with more urgency: the
 * over-extension case is a fail-open. An unbound `restore` lets its `disable`
 * run to end of file, so the mutants after it are never generated and the
 * mutation score reads clean — nothing else in the loop can notice.
 */
function reportPlacementIssues(
  dependencies: CliDependencies,
  issues: readonly SanctionPlacementIssue[],
): void {
  for (const issue of issues) {
    dependencies.stderr(
      `  - ${issue.file}:${issue.line} ${issue.text} — ${issue.detail}\n`,
    );
  }
  dependencies.stderr(
    `guardrails: ${issues.length} granted Stryker directive(s) no longer ` +
      `cover what they were granted for. A \`restore\` only binds when a ` +
      `statement follows it, and a \`disable\` with no binding \`restore\` ` +
      `runs to end of file — silencing every mutant after it at a green ` +
      `score. Move the directive, or close the region.\n`,
  );
}

async function sanctionsCheckCommand(
  dependencies: CliDependencies,
): Promise<number> {
  const headText = readConfigText(dependencies.cwd);
  const { valid: headSanctions, files: headFiles } = parseSanctionsJson(
    headText ?? '',
  );
  const readSource = repoSourceReader(dependencies.cwd);
  // The three FACTUAL failures, in one precedence, shared with the local rungs
  // (#103). Each is rendered here with its own remediation paragraph; the rungs
  // render the same result as manifest violations. What must never differ
  // between them is the ORDER -- a stale count means the source moved under the
  // policy file, and every placement report that follows would be noise about
  // the same one defect -- so the order lives in `sanctionIntegrity`, once.
  const integrity = sanctionIntegrity(headText, readSource);
  if (integrity.kind === 'malformed') {
    printViolations(
      dependencies,
      toMalformedViolations(integrity.entries, CONFIG_FILE),
    );
    dependencies.stderr(
      `guardrails: ${integrity.entries.length} malformed sanction entry(ies) in ` +
        `${CONFIG_FILE} — fix before merging.\n`,
    );
    return 1;
  }
  if (integrity.kind === 'drift') {
    reportCountDrift(dependencies, integrity.entries);
    return 1;
  }
  if (integrity.kind === 'placement') {
    reportPlacementIssues(dependencies, integrity.entries);
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
  // yet, so every entry on the branch reads as newly granted. Expressed as
  // parsing an EMPTY config rather than defaulting two arrays: `{}` is exactly
  // what "no base policy" means, and it leaves no `?? []` whose
  // ArrayDeclaration mutant would be provably equivalent and need a sanctioned
  // suppression. (StringLiteral is globally excluded in stryker.conf.json, so
  // the literal introduces no mutant of its own.)
  const baseParsed = parseSanctionsJson(base.code === 0 ? base.stdout : '{}');
  const known = baseParsed.valid;
  const knownFiles = baseParsed.files;
  const grants = newlySanctioned(known, headSanctions);
  const fileGrants = newlySanctionedFiles(knownFiles, headFiles);
  reportNewGrants(dependencies, grants, fileGrants);
  return 0;
}

/**
 * Read a violations manifest the caller named. The path is agent-supplied
 * input, so it is confined to the repo the same way every other path in this
 * CLI is: reading outside it on the strength of an argument is the over-read
 * the scope-lock exists to prevent. Returns `undefined` when the path is
 * unusable, so the caller can fail rather than silently derive nothing.
 */
function readManifest(
  dependencies: CliDependencies,
  manifest: string,
): Violation[] | undefined {
  if (!isWithinRepo(dependencies.cwd, manifest)) {
    dependencies.stderr(
      `guardrails: ${manifest} is outside the repository; refusing to read it.\n`,
    );
    return undefined;
  }
  const { parsed } = readJsonFile(path.resolve(dependencies.cwd, manifest));
  if (!Array.isArray(parsed)) {
    dependencies.stderr(
      `guardrails: no readable violations manifest at ${manifest}.\n`,
    );
    return undefined;
  }
  return parsed.filter((entry) => isViolation(entry));
}

/**
 * `sanction`: DERIVE the grant entry each added suppression would need, and
 * install nothing.
 *
 * The key is `file|kind|text` where `text` must match the auditor's lexer
 * exactly, so a hand-written key is a guess until `sanctions-check` says
 * otherwise — and the recorded cost of having no derivation path was an agent
 * reverse-engineering `audit.d.ts` out of `dist/`, then editing the policy file
 * 57 times from the main thread. There is deliberately no `--apply`: see
 * src/sanction-proposal.ts.
 */
async function sanctionCommand(
  dependencies: CliDependencies,
  rest: string[],
): Promise<number> {
  // `flag` reads `--from=<path>` only, so a space-separated `--from x.json`
  // parses as NO flag and would fall through to the working diff -- deriving
  // proposals from a different scope than the caller asked for, silently. A
  // quiet wrong-mode answer is the exact failure this command exists to remove.
  // Checked on the BARE token alone rather than as "no value AND a bare
  // --from": the compound form's first clause can never be false when the
  // second is true, which is an equivalent mutant, and a caller who wrote both
  // spellings is ambiguous enough to reject anyway.
  if (rest.includes('--from')) {
    dependencies.stderr(
      'guardrails: --from takes its value with an equals sign: ' +
        '`guardrails sanction --from=<manifest>`.\n',
    );
    return 1;
  }
  const manifest = flag(rest, 'from');
  const readSource = repoSourceReader(dependencies.cwd);
  let findings;
  if (manifest === undefined) {
    const diff = await dependencies.exec('git', ['diff', 'HEAD'], {
      cwd: dependencies.cwd,
    });
    findings = auditDiff(diff.stdout);
  } else {
    const violations = readManifest(dependencies, manifest);
    if (violations === undefined) {
      return 1;
    }
    findings = findingsFromManifest(violations, readSource);
  }
  const { valid, files } = parseSanctionsJson(
    readConfigText(dependencies.cwd) ?? '',
  );
  const proposals = proposeSanctions(findings, {
    readSource,
    sanctions: valid,
    files,
  });
  for (const line of formatProposals(proposals)) {
    dependencies.stderr(`${line}\n`);
  }
  return 0;
}

/**
 * Exit code for an audit that could not read its input.
 *
 * Distinct from 1, which means "findings were found": a caller reading this
 * command's exit code has to be able to tell "nothing to report" from "nothing
 * was examined". Returning 0 for a killed `git diff` reported a clean audit of
 * a diff nobody had seen (#92).
 */
const AUDIT_UNREADABLE_EXIT = 2;

async function auditCommand(dependencies: CliDependencies): Promise<number> {
  const args = ['diff', 'HEAD'];
  const diff = await dependencies.exec('git', args, { cwd: dependencies.cwd });
  if (diff.signal !== undefined) {
    dependencies.stderr(
      `guardrails: ${unreadableDiffMessage({
        command: `git ${args.join(' ')}`,
        signal: diff.signal,
      })}\n`,
    );
    return AUDIT_UNREADABLE_EXIT;
  }
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

/**
 * `guardrails report` — where the work landed (#83). Reads the durable decision
 * log and prints the delegation share, the escalation causes, and the rules
 * behind them.
 */
function reportCommand(dependencies: CliDependencies): number {
  const records = readDecisions(stateDirectory(dependencies.cwd));
  dependencies.stdout(formatDecisionReport(summarizeDecisions(records)));
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
 * Read-family tool names across dialects: Claude's `Read`, `Grep` and `Glob`,
 * Copilot's `view` and `search` (whose documented aliases are `Grep`/`Glob`,
 * already covered).
 *
 * Search belongs here, not in the edit branch below. `hookFilePaths` reads
 * `tool_input.path`, which on `Grep`/`Glob` is the directory to search rather
 * than a file to change — so before search joined this list, a fixer grepping
 * its own repository was denied as an unlisted WRITE target, and the tool was
 * useless the moment it was granted.
 *
 * They are reads, and they take the read rule: anywhere inside the repo, never
 * outside it. A search rooted outside would reach exactly what the read-lock
 * exists to keep out (the user's `~/.claude` memory, say) one `pattern` at a
 * time, which is why granting the tools did not mean exempting them.
 */
const READ_TOOLS = /^(?:read|view|grep|glob|search)$/i;

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
 * A PRESENT `agentId` is read the same way on every host: the fixer types are
 * confined, any other reported type is not, and a subagent whose type we
 * somehow did not get is confined -- unknown is not "not the fixer". The host
 * writes these fields, so a fixer cannot rename itself out of the lock.
 *
 * An ABSENT one is where the hosts differ, and `isAbsenceMainThread` carries
 * that:
 *
 * - **claude** reports identity on every hook event, and its SDK documents
 *   `agent_id` as present only inside a subagent -- "Absent for the main
 *   thread, even in --agent sessions". Absence positively identifies the MAIN
 *   THREAD, which is never the fixer.
 * - **codex** has reported subagent identity on `PreToolUse` since
 *   openai/codex#22882, but its main-thread payload is identical to every
 *   payload an older Codex sent, fixer included. So absence means "main
 *   thread" only once this session has shown a present `agent_id` (see
 *   `isAgentIdentityReported`); until then the session-scoped lock stands,
 *   because Codex has no per-agent tool allowlist and this hook is its only
 *   enforcement.
 * - **copilot** reports nothing on `preToolUse` -- only on
 *   `subagentStart`/`subagentStop` -- so absence is "I cannot tell you" and
 *   everyone in the session is confined.
 */
function isFixerCaller(
  input: HookInput,
  isAbsenceMainThread: boolean,
): boolean {
  if (input.agentId === undefined) {
    return !isAbsenceMainThread;
  }
  return (
    input.agentType === undefined || FIXER_AGENT_TYPES.has(input.agentType)
  );
}

/**
 * Is this a call the host positively attributes to a fixer -- a fixer TYPE,
 * not merely a caller the lock confines? Only that is evidence the fixer is
 * alive; a heartbeat from anything else would keep a dead fixer's lease
 * looking held.
 */
function isReportedFixer(input: HookInput): boolean {
  // No type is no fixer type: `?? ''` rather than a separate guard, which
  // would be redundant at runtime and exist only to narrow for the compiler.
  return (
    input.agentId !== undefined && FIXER_AGENT_TYPES.has(input.agentType ?? '')
  );
}

/**
 * Whether a missing `agentId` identifies the main thread on this dialect, for
 * this session -- see `isFixerCaller`. A Codex call that carries one is the
 * proof, so it is recorded here for the calls after it.
 */
function isAbsenceMainThread(
  input: HookInput,
  dialect: Dialect,
  directory: string,
  sessionId: string,
): boolean {
  if (dialect === 'claude') {
    return true;
  }
  if (dialect !== 'codex') {
    return false;
  }
  const isReported = isAgentIdentityReported(directory, sessionId);
  if (!isReported && input.agentId !== undefined) {
    markAgentIdentityReported(directory, sessionId);
  }
  return isReported;
}

/**
 * Stamp the session's fixer leases as seen working (see
 * `FixerLease.lastSeenAt`), in every checkout the call touches. The fixer's
 * own tool calls pass through this hook, which makes it the one place its
 * liveness is visible to the gates waiting on it.
 */
function recordFixerHeartbeat(
  roots: readonly string[],
  sessionId: string,
  now: number,
): void {
  const unique = new Set(roots.map((entry) => path.resolve(entry)));
  for (const root of unique) {
    const directory = stateDirectory(root);
    const leases = loadLeases(directory);
    const next = withHeartbeat(leases, sessionId, now);
    if (next.some((lease, index) => lease !== leases[index])) {
      saveLeases(directory, next);
    }
  }
}

/**
 * Whether the scope-lock applies to this caller, given an open fix loop --
 * and, as a side effect, the bookkeeping that caller's identity proves: a
 * Codex `agent_id` settles how to read its absence for the rest of the
 * session, and a fixer's call is its heartbeat.
 */
function isConfinedCaller(
  input: HookInput,
  dialect: Dialect,
  repoRoot: string,
  roots: readonly string[],
  now: number,
): boolean {
  const sessionId = input.sessionId ?? 'default';
  if (isReportedFixer(input)) {
    recordFixerHeartbeat(roots, sessionId, now);
  }
  return isFixerCaller(
    input,
    isAbsenceMainThread(input, dialect, stateDirectory(repoRoot), sessionId),
  );
}

async function scopeCheckCommand(
  dependencies: CliDependencies,
  dialect: Dialect,
): Promise<void> {
  const { input, repoRoot } = await hookContext(dependencies);
  // Each path as the payload named it (for the message) and resolved (for
  // the checks).
  const targets = hookFilePaths(input).map((file) => ({
    file,
    absolute: path.resolve(repoRoot, file),
  }));
  // The cwd's checkout, plus the checkout each target sits in: a fixer can run
  // from the parent while its manifest and files live in a nested worktree.
  const targetRoots = targets
    .map((target) => findGitRoot(target.absolute))
    .filter((found) => found !== undefined);
  const now = Date.now();
  const roots = [repoRoot, ...targetRoots];
  const scope = collectSessionScope(roots, input.sessionId, now);
  // Every branch below is a FIXER lock, so a caller the host tells us is not
  // the fixer is left alone entirely.
  const isConfined =
    scope.active && isConfinedCaller(input, dialect, repoRoot, roots, now);
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
  //
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
    const outside = targets.find(
      (target) => !scope.allowsRead(target.absolute),
    )?.file;
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
  const denied = targets.find(
    (target) => !scope.allowsEdit(target.absolute),
  )?.file;
  if (isConfined && denied !== undefined) {
    denyPreToolUse(
      dependencies,
      `Fixer scope-lock: ${denied} is not editable. The fixer may ` +
        `only edit files named in the violations manifest, and never ` +
        `package.json or guardrails.config.json.`,
      dialect,
    );
    return;
  }
  if (isConfined) {
    refuseAddedSuppressions(dependencies, input, repoRoot, dialect);
  }
}

/**
 * The text a file holds now, or nothing if it does not exist yet -- the
 * "before" of a whole-file write.
 */
function currentText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Deny a fixer edit that ADDS a suppression (#77), before it lands rather than
 * one rework cycle later at the next gate. The message carries the route the
 * contract asks for instead, because "you were caught" is not an instruction.
 */
function refuseAddedSuppressions(
  dependencies: CliDependencies,
  input: HookInput,
  repoRoot: string,
  dialect: Dialect,
): void {
  const proposed = (input.edits ?? []).map((edit) => ({
    file: edit.file,
    before: edit.before ?? currentText(path.resolve(repoRoot, edit.file)),
    after: edit.after,
  }));
  const [first, ...rest] = addedSuppressions(proposed);
  if (first === undefined) {
    return;
  }
  const more = rest.length > 0 ? ` and ${rest.length} more` : '';
  denyPreToolUse(
    dependencies,
    `Fixer suppression-lock: this edit adds ${first.kind} ` +
      `(\`${first.text}\` in ${first.file})${more}. A fixer never ` +
      `suppresses. If the violation cannot be fixed honestly, leave the code ` +
      `as it is and report it as unfixable with your reason; the main agent ` +
      `decides whether it earns a grant.`,
    dialect,
  );
}

async function sessionEndCommand(
  dependencies: CliDependencies,
): Promise<number> {
  const input = parseHookInput(await dependencies.readStdin());
  const sessionId = input.sessionId ?? 'default';
  const repoRoot = await commandRepoRoot(
    dependencies,
    sessionCwd(dependencies, input, 'claude'),
  );
  deleteSession(stateDirectory(repoRoot), sessionId);
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

/**
 * `ship`: push, find or open the pull request, wait for its checks, and write
 * the outcome to a status file -- one command for an agent to background and
 * be woken by once (see `ship.ts`). Exit 0 only on green.
 *
 * Paths given as flags are read from where the command was run, as a shell
 * user means them; the default status file lives in the repository's state.
 */
async function shipCommand(
  dependencies: CliDependencies,
  rest: string[],
): Promise<number> {
  const { repoRoot, base } = await directContext(dependencies, rest);
  const named = flag(rest, 'status-file');
  const statusPath =
    named === undefined
      ? shipStatusFile(stateDirectory(repoRoot))
      : path.resolve(dependencies.cwd, named);
  const bodyFile = flag(rest, 'body-file');
  const status = await ship({
    exec: dependencies.exec,
    repoRoot,
    baseBranch: base.base,
    bodyFile:
      bodyFile === undefined
        ? undefined
        : path.resolve(dependencies.cwd, bodyFile),
  });
  writeShipStatus(statusPath, status);
  dependencies.stdout(
    `${shipSummary(status, path.relative(repoRoot, statusPath))}\n`,
  );
  return status.state === 'green' ? 0 : 1;
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
  const selfPath = selfLocation(dependencies);
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

/**
 * Warn when the vendored guidance has rotted (#106).
 *
 * `src/guidance.ts` points violations at the consumer's COPY of a guidance doc
 * rather than at `node_modules`, so a copy left behind by an upgrade is a doc
 * the tool actively sends agents to read while it is out of date. `init --plan`
 * has always detected this; nothing ran it, which is why an adopting repo sat
 * 49 lines behind for six weeks.
 *
 * On `session-start` because that is the cheapest rung that fires often enough
 * to matter: the check is a checksum over files already on disk, with no
 * `detect()` and no spawn, and once a session is the right cadence for
 * something that changes only when the package is upgraded.
 *
 * Both classes are reported, and the drifted one is not a lesser case: an
 * edited file is excluded from every future upgrade, permanently and silently,
 * and this is the only place that is ever said out loud.
 */
function warnAboutStaleGuidance(
  dependencies: CliDependencies,
  repoRoot: string,
): void {
  const readSource = repoSourceReader(repoRoot);
  const manifest = parseManifest(
    readJsonFile(path.join(repoRoot, MANIFEST_PATH)).parsed,
  );
  const shipped = [
    ...guidanceEntries(guidanceRoot()),
    ...claudeSkillEntries(guidanceRoot()),
  ];
  const { updatable, drifted } = staleArtifacts(shipped, manifest, readSource);
  if (updatable.length > 0) {
    dependencies.stderr(
      `guardrails: ${updatable.length} scaffolded file(s) are behind the ` +
        `installed version and unmodified locally — ` +
        `${updatable.join(', ')}. Run \`npx guardrails-core init --apply\` ` +
        `to upgrade them. Violations point agents at these copies, so a stale ` +
        `one is guidance the tool is actively recommending.\n`,
    );
  }
  if (drifted.length > 0) {
    dependencies.stderr(
      `guardrails: ${drifted.length} scaffolded file(s) were edited after ` +
        `scaffolding — ${drifted.join(', ')}. \`init\` will leave them alone ` +
        `from now on, so they will not receive upstream improvements. If the ` +
        `edit is worth keeping, keep it; if it was accidental, restore it with ` +
        `\`npx guardrails-core init --apply --force\`.\n`,
    );
  }
}

/**
 * Deny this call if it is a git write; let anything else through. The one
 * shape of refusal every host honours on a pre-tool hook.
 */
function denyGitWrite(
  dependencies: CliDependencies,
  input: HookInput,
  reason: string,
  dialect: Dialect,
): void {
  if (isShellGitWrite(input)) {
    denyPreToolUse(dependencies, reason, dialect);
  }
}

/**
 * Block the stop once with `reason`; on the host's retry, release with the
 * reason on stderr instead. Blocking again would only spend the host's
 * continuation cap (eight on Claude Code and Copilot) on a condition the agent
 * may be unable to change.
 */
function blockStopOnce(
  dependencies: CliDependencies,
  input: HookInput,
  reason: string,
): void {
  if (input.stopHookActive === true) {
    dependencies.stderr(`${reason}\n`);
    return;
  }
  dependencies.stdout(JSON.stringify({ decision: 'block', reason }));
}

/**
What a gate run came to: nothing to report, or the error it threw.
*/
async function settled(run: Promise<unknown>): Promise<{ failure?: string }> {
  try {
    await run;
    return {};
  } catch (error: unknown) {
    return { failure: String(error) };
  }
}

/**
 * Give up on a gate that ran out of time: stop its analyzers, decide on what
 * is known, and end the process before the abandoned gate can write anything.
 *
 * Exits synchronously, straight after the decision is written: the gate is
 * still pending, and the analyzers dying under SIGTERM would hand it a round of
 * "analyzer failed" results to record as this turn's violations if the event
 * loop got another turn. The decision is a few hundred bytes, which a pipe
 * takes in one write.
 */
function abandonGate(
  dependencies: CliDependencies,
  input: HookInput,
  mode: 'pretooluse' | 'stop',
  dialect: Dialect,
  seconds: number,
): void {
  if (mode === 'pretooluse') {
    denyGitWrite(
      dependencies,
      input,
      `guardrails: the commit gate did not finish within ${seconds}s, so ` +
        `this git command was not checked. Something else is likely loading ` +
        `the machine (another gate, a test run); retry when it is quieter.`,
      dialect,
    );
  } else {
    dependencies.stderr(
      `guardrails: the stop gate did not finish within ${seconds}s, so this ` +
        `turn was not checked. The commit and push gates still apply.\n`,
    );
  }
  stopAnalyzers(dependencies, 0);
}

/**
Stop every analyzer still running, then end the process with `code`.
*/
function stopAnalyzers(dependencies: CliDependencies, code: number): void {
  (dependencies.terminate ?? terminateChildren)();
  (dependencies.exit ?? ((exitCode: number) => process.exit(exitCode)))(code);
}

/**
The exit status of a process ended by SIGTERM: 128 plus the signal's number.
*/
const TERMINATED_EXIT_CODE = 143;

/**
 * Run a hook gate so that a SIGTERM to this CLI stops its analyzers before it
 * ends. Node's default disposition dies on the spot, and `child.kill` reaches
 * one process, not its group: so when a delegating run's deadline SIGTERMs
 * the delegate (`delegateToTarget`), or a host kills a hook it gave up on,
 * the analyzers this process spawned would be orphaned, holding the
 * machine-wide lock for as long as they run. The listener is removed once
 * the gate has decided.
 */
async function terminable(
  dependencies: CliDependencies,
  gate: () => Promise<number>,
): Promise<number> {
  const onTerminate = (): void => {
    stopAnalyzers(dependencies, TERMINATED_EXIT_CODE);
  };
  process.once('SIGTERM', onTerminate);
  try {
    return await gate();
  } finally {
    process.off('SIGTERM', onTerminate);
  }
}

/**
 * Run a hook-mode gate so that it always DECIDES -- when it crashes, and when
 * it runs out of time.
 *
 * Claude Code and Codex treat a hook that crashes as non-blocking, so a bug in
 * the gate -- or a git that could not be spawned -- was a silent pass. And
 * every host treats a hook TIMEOUT as fail-open, so a gate still running when
 * the host gave up on it had decided nothing; in the field such gates ran on
 * for up to twenty minutes, analyzers and all. The gate therefore gets its own
 * deadline (`hookDeadlineSeconds`, below the host timeout), and output from a
 * gate abandoned at that deadline is dropped so it cannot contradict the
 * decision already given.
 *
 * Stdin is read once here so the payload is still in hand on either path.
 */
async function decidingHook(
  dependencies: CliDependencies,
  mode: 'pretooluse' | 'stop',
  dialect: Dialect,
): Promise<number> {
  const stdin = await dependencies.readStdin();
  const input = parseHookInput(stdin);
  const where =
    (mode === 'stop' ? sessionCwd(dependencies, input, dialect) : input.cwd) ??
    dependencies.cwd;
  const seconds = loadConfig(findGitRoot(where) ?? where).hookDeadlineSeconds;
  let isAbandoned = false;
  const unlessAbandoned =
    (write: (text: string) => void) =>
    (text: string): void => {
      if (!isAbandoned) {
        write(text);
      }
    };
  const replayed: CliDependencies = {
    ...dependencies,
    readStdin: () => Promise.resolve(stdin),
    stdout: unlessAbandoned(dependencies.stdout),
    stderr: unlessAbandoned(dependencies.stderr),
  };
  // Settles, never rejects: a gate that throws AFTER the deadline must not
  // surface as an unhandled rejection.
  const gate = settled(
    mode === 'pretooluse'
      ? gatePreToolUseCommand(replayed, dialect)
      : gateStopCommand(replayed, dialect),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => {
      resolve('expired');
    }, seconds * 1000);
  });
  const outcome = await Promise.race([gate, deadline]);
  clearTimeout(timer);
  if (outcome === 'expired') {
    isAbandoned = true;
    abandonGate(dependencies, input, mode, dialect, seconds);
    return 0;
  }
  if (outcome.failure !== undefined) {
    const reason =
      `guardrails: the ${mode} gate failed before it could decide ` +
      `(${outcome.failure}), so this was not checked.`;
    if (mode === 'pretooluse') {
      denyGitWrite(dependencies, input, reason, dialect);
    } else {
      blockStopOnce(dependencies, input, reason);
    }
  }
  return 0;
}

/**
 * Hook commands that only maintain state or tidy formatting: with no trusted
 * install there is nothing useful for them to do, and nothing to enforce.
 */
const SILENT_HOOK_COMMANDS: ReadonlySet<string | undefined> = new Set([
  'autofix',
  'session-start',
  'session-end',
]);

/**
The remedy every hook-mode refusal carries.
*/
function installRemedy(dependencies: CliDependencies): string {
  const checkout = findGitRoot(dependencies.cwd) ?? dependencies.cwd;
  return (
    `guardrails: guardrails-core is not installed in this checkout ` +
    `(${checkout}) -- the copy that ran belongs to an enclosing directory, ` +
    `which is what a fresh worktree nested inside another checkout resolves ` +
    `to. Run \`npm ci\` in ${checkout}, then retry.`
  );
}

/**
 * A CLI resolved from outside the repository it is guarding: from an
 * ancestor's node_modules (a nested worktree with no install of its own), or a
 * linked install.
 *
 * Exit 1 used to answer every command, and the hosts read that two ways:
 * Claude Code and Codex treat it as a NON-blocking error, so every gate was
 * silently skipped -- a commit with the hook-skipping flag went through
 * ungated -- while Copilot treats a non-zero pre-tool exit as a DENY, so it
 * blocked every tool call, including the install that would have fixed it.
 * The one block every host honours is an explicit decision on stdout, so the
 * hook modes answer with one, on exactly the actions they guard, and stay out
 * of the way otherwise. Direct commands (verify, the git-hook rungs, CI) keep
 * exit 1, which already blocks there.
 */
async function untrustedInstallCommand(
  command: string | undefined,
  rest: string[],
  dependencies: CliDependencies,
  outside: string,
): Promise<number> {
  const mode = flag(rest, 'mode');
  if (command === 'gate' && mode === 'pretooluse') {
    const input = parseHookInput(await dependencies.readStdin());
    denyGitWrite(
      dependencies,
      input,
      installRemedy(dependencies),
      resolveDialect(rest),
    );
    return 0;
  }
  if (command === 'gate' && mode === 'stop') {
    const input = parseHookInput(await dependencies.readStdin());
    blockStopOnce(dependencies, input, installRemedy(dependencies));
    return 0;
  }
  if (SILENT_HOOK_COMMANDS.has(command)) {
    return 0;
  }
  dependencies.stderr(outside);
  return 1;
}

/**
 * `gate --mode=...`: one rung per mode. Split out of `runCommand`, whose
 * switch had crossed the complexity threshold once the hook modes gained
 * their own deciding wrapper.
 */
function gateCommand(
  dependencies: CliDependencies,
  rest: string[],
): Promise<number> {
  const mode = flag(rest, 'mode');
  if (mode === 'commit') {
    return gateCommitCommand(dependencies, 'staged', 'commit', rest);
  }
  // Same checks, branch-wide scope: `push` is the local rung that catches
  // what a staged-scope commit cannot, and `ci` is its authoritative twin.
  // `push` and `ci` share the branch-wide scope but are DISTINCT rungs:
  // an analyzer a consumer moved to `push` must run there, and `ci` sits
  // above it so `verify`'s twin never checks less (#61).
  if (mode === 'push') {
    return gateCommitCommand(dependencies, 'branch', 'push', rest);
  }
  if (mode === 'ci') {
    return gateCommitCommand(dependencies, 'branch', 'ci', rest);
  }
  const hookMode = mode === 'pretooluse' ? 'pretooluse' : 'stop';
  return terminable(dependencies, () =>
    decidingHook(dependencies, hookMode, resolveDialect(rest)),
  );
}

export async function runCommand(
  command: string | undefined,
  rest: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const outside = outsideRepoMessage(dependencies);
  // scope-check runs whatever copy resolved: it reads only state files, and
  // enforcing the lock with an ancestor's copy beats not enforcing it.
  if (outside !== undefined && command !== 'scope-check') {
    return untrustedInstallCommand(command, rest, dependencies, outside);
  }
  switch (command) {
    case 'verify': {
      return verifyCommand(dependencies, rest);
    }
    case 'autofix': {
      return autofixCommand(dependencies);
    }
    case 'gate': {
      return gateCommand(dependencies, rest);
    }
    case 'audit': {
      return auditCommand(dependencies);
    }
    case 'sanctions-check': {
      return sanctionsCheckCommand(dependencies);
    }
    case 'sanction': {
      return sanctionCommand(dependencies, rest);
    }
    case 'state': {
      return stateCommand(dependencies, flag(rest, 'session') ?? 'default');
    }
    case 'report': {
      return reportCommand(dependencies);
    }
    case 'scope-check': {
      const dialect = resolveDialect(rest);
      await scopeCheckCommand(dependencies, dialect);
      return 0;
    }
    case 'session-start': {
      sweepStale(stateDirectory(dependencies.cwd), SESSION_TTL_MS, Date.now());
      warnAboutStaleGuidance(dependencies, dependencies.cwd);
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
    case 'ship': {
      return shipCommand(dependencies, rest);
    }
    default: {
      dependencies.stderr(
        'usage: guardrails-core <command>\n' +
          '  init [--plan|--apply] [--json] [--force] [--enforcement=warn|block]\n' +
          '       [--analyzers=<tool>=<off|auto|required>[,...]] [--distribution=solo|team]\n' +
          '  gate --mode=stop|commit|push|ci|pretooluse [--dialect=codex|copilot]\n' +
          '       [--base=<ref>]\n' +
          '  verify [--base=<ref>]\n' +
          '  sanction [--from=<violations manifest>]\n' +
          '  ship [--body-file=<f>] [--status-file=<f>] [--base=<ref>]\n' +
          '  autofix | audit | sanctions-check | install-hooks\n' +
          '  state | report | scope-check | session-start | session-end\n',
      );
      return 1;
    }
  }
}
