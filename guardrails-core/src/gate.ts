/**
 * Gate composition (§2.1 + §2.3). Wires verify + the diff-auditor + the
 * decision engine + persistence into the Stop-boundary control loop, and is
 * the shared core both the Claude Code stop-gate and the Copilot commit-gate
 * call. Every shell-out goes through the injected `Exec`.
 *
 * The auditor is snapshot-based, not SubagentStop-based, so the identical
 * mechanism works at the Copilot commit gate: at the first delegation of a fix
 * loop we snapshot the suppressions already present in the working diff; every
 * subsequent cycle flags only suppressions absent from that baseline — i.e. the
 * ones added during the loop — and surfaces them as violations so they flow
 * through the normal escalation ladder.
 *
 * **Outside a fix loop the auditor reports nothing**, and that is the whole
 * point of the baseline rather than a hole in it. A suppression sitting in the
 * working diff before any fixer has run is the main agent's own, deliberate or
 * not; the gate has a diff, not an author, so the honest thing it can say is
 * "this appeared while the fixer had the manifest". Reporting it earlier is
 * how this went wrong: the findings used to be computed against a baseline
 * that did not exist yet, so the FIRST cycle flagged everything already in the
 * diff, blocked the turn, and told the main agent to spawn a fixer against a
 * change no fixer had made — after which the retry passed anyway, because the
 * delegate had by then written the snapshot that forgave it. One wasted
 * subagent round-trip, pointed at the wrong culprit, per deliberate
 * suppression. The commit, push and CI gates audit the whole branch diff with
 * no snapshot at all, so nothing escapes by not being reported here; they are
 * where a suppression is answered for, and where `sanctionedSuppressions` can
 * answer for it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { auditDiff, findingKey, type AuditFinding } from './audit.js';
import type { SanctionedFile, SanctionedSuppression } from './config.js';
import type { Exec } from './exec.js';
import { withGuidance } from './guidance.js';
import {
  decideGate,
  type GateConfig,
  type GateDecision,
} from './gate-decision.js';
import type { AnalyzerMode } from './verify/analyzer-policy.js';
import {
  loadRecurrence,
  loadSession,
  manifestFile,
  saveRecurrence,
  saveSession,
  stateDirectory,
  writeViolations,
} from './state-store.js';
import { hasErrors, type Violation } from './violation.js';
import { parseFileList } from './verify/git.js';
import { runVerify } from './verify/index.js';
import { loadWorkspaceResolver, withPackages } from './workspaces.js';
import { resolveBaseReference } from './verify/git.js';

export interface StopGateOptions {
  repoRoot: string;
  sessionId: string;
  baseBranch: string;
  exec: Exec;
  config: GateConfig;
  resolveBin?: (tool: string) => string;
  /**
  Per-analyzer opt-in (`RepoConfig.analyzers`), forwarded to `runVerify`.
  */
  analyzers?: Readonly<Record<string, AnalyzerMode>>;
  /**
  Claude/Copilot says this Stop is a retry caused by an earlier block.
  */
  isRetry?: boolean | undefined;
}

export interface StopGateResult {
  decision: GateDecision;
  auditFindings: AuditFinding[];
}

export interface CommitGateOptions {
  repoRoot: string;
  /**
   * Session to key the manifest on, when the caller has one. The PreToolUse
   * hook does; `.husky/pre-commit` does not, so this is optional and falls
   * back to a fixed id. See `commitManifestId`.
   *
   * `| undefined` rather than a bare optional, so a caller can forward a
   * possibly-absent id directly. The conditional spread it replaces
   * (`...(id !== undefined && { sessionId: id })`) produced a provably
   * equivalent mutant: forcing it true passes `undefined`, which is exactly
   * what the fallback already means. Same idiom as `StopGateOptions.isRetry`.
   */
  sessionId?: string | undefined;
  /**
   * Fixer names and the loose-class rule, for the delegation pointer. Required
   * so a block always has somebody to name: an optional config would put the
   * "manifest but no fixer" state back into the result type.
   */
  config: GateConfig;
  baseBranch: string;
  exec: Exec;
  resolveBin?: (tool: string) => string;
  /**
   * Reviewed exemptions (RepoConfig.sanctionedSuppressions). Each grant spends
   * a budget of `count` (default 1) occurrences of its `file|kind|text` key —
   * NOT every occurrence of that key in the file — so a second identical
   * directive beyond the granted count still blocks. See `sanctionBudget`.
   */
  sanctionedSuppressions?: readonly SanctionedSuppression[];
  /**
   * Path-scoped exemptions (`RepoConfig.sanctionedFiles`), for generated code.
   * Unlike the keyed grants above these spend no budget: every occurrence of
   * the named kind in the named file is exempt, because a generated file's
   * occurrence count changes on every regeneration. See `SanctionedFile`.
   */
  sanctionedFiles?: readonly SanctionedFile[];
  /**
  Per-analyzer opt-in (`RepoConfig.analyzers`), forwarded to `runVerify`.
  */
  analyzers?: Readonly<Record<string, AnalyzerMode>>;
  /**
   * Which change set the diff-scoped analyzers see. `'staged'` at the
   * pre-commit rung, `'branch'` (the default) at pre-push and CI.
   *
   * The diff-auditor and sanction budget below are deliberately NOT affected:
   * they always audit the branch's cumulative diff, because a suppression
   * introduced in an earlier commit on this branch must keep flagging. Only the
   * analyzers narrow.
   */
  changedScope?: 'branch' | 'staged';
}

/**
 * A commit-rung verdict. A DISCRIMINATED UNION on `blocked`, so
 * "blocked, therefore delegated" is a fact the compiler carries rather than a
 * guard every caller repeats — and the impossible state (a manifest with
 * nobody named to fix it, or a block with nowhere to delegate) cannot be
 * expressed at all.
 */
export type CommitGateResult = CommitGateCommon &
  (
    | { blocked: false; delegation?: undefined }
    | { blocked: true; delegation: CommitDelegation }
  );

/**
 * Where a block's violations were written and who to spawn against them.
 *
 * The terse-pointer → fixer loop used to exist only at the stop rung (#49), so
 * the commit rung blocked with no delegation path at all — and the asymmetry
 * ran backwards to effort: eslint and tsc are mechanical and often
 * auto-fixable, while surviving mutants are the most labour-intensive class in
 * the pack and were the one class with no fixer.
 */
interface CommitDelegation {
  manifestPath: string;
  fixerAgent: string;
}

interface CommitGateCommon {
  violations: Violation[];
  findings: AuditFinding[];
  /** Passed straight through from `runVerify` — see `VerifyResult`. The rung
   *  that enforces has the same duty as the one that reports: a gate that
   *  passes while three analyzers never ran is a pass the adopter reads as a
   *  guarantee. */
  skippedAnalyzers: readonly (readonly [string, string])[];
}

/**
 * Sum each sanction's `count` (default 1) per key, so several entries granting
 * the same key (or one entry granting several occurrences) combine into one
 * spendable budget. This is what turns membership-testing (one grant exempts
 * every occurrence, forever) into budget-spending (one grant exempts exactly
 * that many occurrences).
 */
function sanctionBudget(
  sanctions: readonly SanctionedSuppression[],
): Map<string, number> {
  const budget = new Map<string, number>();
  for (const sanction of sanctions) {
    const amount = sanction.count ?? 1;
    budget.set(sanction.key, (budget.get(sanction.key) ?? 0) + amount);
  }
  return budget;
}

/**
 * Filter findings against a spendable budget and the path-scoped exemptions.
 *
 * A path grant is checked FIRST and consumes nothing: it covers every
 * occurrence of one kind in one file, which is what lets a generated file be
 * exempted without anyone maintaining a count that changes on every
 * regeneration (#39). A finding it covers must also not decrement a keyed
 * budget — spending budget on an already-exempt finding would silently exhaust
 * a grant meant for elsewhere in the same file.
 *
 * Otherwise the keyed budget applies as before: a finding whose key still has
 * budget remaining is exempted and decrements that budget by one; once
 * exhausted, every further occurrence of that key is reported. `budget` is
 * mutated in place — private to one `runCommitGate` call.
 */
function spendBudget(
  findings: readonly AuditFinding[],
  budget: Map<string, number>,
  exempt: readonly SanctionedFile[] | undefined,
): AuditFinding[] {
  return findings.filter((finding) => {
    // A linear scan rather than a prebuilt Set, deliberately. The list is a
    // handful of generated files, and taking the optional array directly means
    // no `?? []` default — whose ArrayDeclaration mutant would be provably
    // equivalent (a placeholder entry matches no real finding) and would have
    // needed a sanctioned suppression to silence. Removing the default is a
    // better answer than exempting the mutant it creates.
    if (
      exempt?.some(
        (file) => file.path === finding.file && file.kind === finding.kind,
      ) === true
    ) {
      return false;
    }
    const key = findingKey(finding);
    const remaining = budget.get(key) ?? 0;
    if (remaining <= 0) {
      return true;
    }
    budget.set(key, remaining - 1);
    return false;
  });
}

function snapshotFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.pre-fix.json`);
}

function readSnapshot(file: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // Filter to strings rather than casting — consistent with the strict
    // validation in state-store, and keeps the baseline a true Set<string>.
    //
    // Equivalent mutants on this expression: the baseline is only ever probed
    // with `.has(<string key>)`, so a non-string entry that survives the filter
    // can never match; and calling `.filter` on a non-array throws straight into
    // the catch below, which returns the same empty Set.
    //
    // The Stryker restore must always follow a statement (not a return), so the
    // directive attaches and does not run to end of file; we hoist to const for this.
    // Stryker disable ConditionalExpression,MethodExpression,ArrayDeclaration
    const strings = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
    // Stryker restore ConditionalExpression,MethodExpression,ArrayDeclaration
    return new Set(strings);
  } catch {
    return new Set();
  }
}

async function workingDiff(options: StopGateOptions): Promise<string> {
  // Deliberately `git diff HEAD` (uncommitted working-tree changes), NOT the
  // baseBranch range that `verify` uses. The fixer's edits are uncommitted, so
  // this is exactly the surface the auditor must inspect. A suppression that was
  // committed in an earlier turn is already past this point — it would have been
  // audited while it was uncommitted, and the Copilot commit-gate re-checks the
  // staged diff at commit time.
  let result = await options.exec('git', ['diff', 'HEAD'], {
    cwd: options.repoRoot,
  });
  if (result.code !== 0 && result.spawnFailed !== true) {
    // Unborn branch: there is no HEAD to diff, but staged content already lives
    // in the index and must still be audited before the first commit.
    result = await options.exec('git', ['diff', '--cached'], {
      cwd: options.repoRoot,
    });
  }
  const untracked = await options.exec(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: options.repoRoot },
  );
  const addedFiles = parseFileList(untracked.stdout)
    .map((file) => untrackedFileDiff(options.repoRoot, file))
    .join('\n');
  return `${result.stdout}\n${addedFiles}`;
}

/** `git diff HEAD` omits untracked files entirely. Present each one as a
 * synthetic all-additions diff so the auditor applies its normal lexer and
 * signatures to new files too. A read failure narrows the audit input; verify's
 * independent untracked-file path still reports analyzer failures. */
function untrackedFileDiff(repoRoot: string, file: string): string {
  let content: string;
  try {
    content = readFileSync(path.join(repoRoot, file), 'utf8');
  } catch {
    return '';
  }
  const lines = content.split('\n');
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

function toViolation(finding: AuditFinding): Violation {
  return {
    ruleId: 'guardrails/added-suppression',
    file: finding.file,
    line: finding.line,
    message: `Forbidden ${finding.kind} added during the fix loop: ${finding.text}`,
    severity: 'error',
    fixable: false,
    tool: 'guardrails',
  };
}

export async function runStopGate(
  options: StopGateOptions,
): Promise<StopGateResult> {
  const { repoRoot, sessionId, baseBranch, exec, config } = options;
  const directory = stateDirectory(repoRoot);
  const session = loadSession(directory, sessionId);
  const recurrence = loadRecurrence(directory);

  const snapshotPath = snapshotFile(directory, sessionId);
  const isHadSnapshot = existsSync(snapshotPath);
  const baseline = readSnapshot(snapshotPath);

  const diff = await workingDiff(options);
  const present = auditDiff(diff);
  // No snapshot means no fix loop is open, so there is no fixer whose work
  // this could be. See the module docstring.
  const auditFindings = isHadSnapshot
    ? present.filter((finding) => !baseline.has(findingKey(finding)))
    : [];

  const verifyOptions = {
    repoRoot,
    baseBranch,
    exec,
    profile: 'stop' as const,
    ...(options.resolveBin && { resolveBin: options.resolveBin }),
    ...(options.analyzers && { analyzers: options.analyzers }),
  };
  const { violations } = await runVerify(verifyOptions);
  // Guidance rides on the violation so it reaches the fixer through the
  // manifest — the one channel every runtime reads. `runVerify`'s violations
  // are already attributed; `withPackages` is idempotent, so re-applying is a
  // no-op — this call is what attributes the audit-derived findings, which
  // carry files too.
  const combined = withGuidance(
    withPackages(
      [...violations, ...auditFindings.map((finding) => toViolation(finding))],
      loadWorkspaceResolver(repoRoot),
    ),
  );

  writeViolations(directory, sessionId, combined);
  const manifestPath = path.relative(
    repoRoot,
    manifestFile(directory, sessionId),
  );

  const decision = decideGate({
    violations: combined,
    session,
    recurrence,
    manifestPath,
    config,
    isRetry: options.isRetry,
  });

  saveSession(directory, sessionId, decision.nextSession);
  saveRecurrence(directory, decision.nextRecurrence);

  if (decision.outcome === 'delegate') {
    // Snapshot the pre-fix suppression baseline once per fix loop -- this
    // delegation is what opens it, so everything already present is what the
    // fixer inherited rather than wrote.
    if (!isHadSnapshot) {
      const keys = present.map((finding) => findingKey(finding));
      writeFileSync(snapshotPath, JSON.stringify(keys));
    }
  } else {
    // Loop ended (clean or escalate) — drop the baseline.
    rmSync(snapshotPath, { force: true });
  }

  return { decision, auditFindings };
}

/** Diff of the branch vs its merge-base with the base branch, so suppressions
 * inherited from the base branch are excluded. Falls back to the staged diff
 * when the merge-base can't be resolved (shallow clone / missing base). */
async function branchDiff(options: CommitGateOptions): Promise<string> {
  // `origin/<branch>` is the only form that resolves in a CI checkout.
  const resolved = await resolveBaseReference(
    options.exec,
    options.repoRoot,
    options.baseBranch,
  );
  const mergeBase = await options.exec(
    'git',
    ['merge-base', resolved.ref ?? options.baseBranch, 'HEAD'],
    { cwd: options.repoRoot },
  );
  const sha = mergeBase.stdout.trim();
  if (sha && mergeBase.code === 0) {
    const diff = await options.exec('git', ['diff', sha], {
      cwd: options.repoRoot,
    });
    return diff.stdout;
  }
  const staged = await options.exec('git', ['diff', '--cached'], {
    cwd: options.repoRoot,
  });
  return staged.stdout;
}

/** Shared core of `gate --mode=commit`: audits the branch's cumulative diff
 * against the merge-base with the base branch, so suppressions already on
 * the branch (inherited from the base) don't flag on every commit — only
 * ones introduced on the branch do. Also used by the `preToolUse` gate. */
/**
 * The manifest id for a commit-rung block.
 *
 * Suffixed rather than reusing the caller's session id directly: both rungs
 * write `<id>.last.json`, so sharing an id would have the commit gate clobber
 * a manifest an in-flight stop loop is still working from. The suffix keeps
 * the `.last.json` shape, so `sweepStale` collects it with everything else and
 * needs no teaching.
 *
 * `.husky/pre-commit` runs with no hook payload and therefore no session, so
 * the fallback is fixed.
 */
function commitManifestId(sessionId: string | undefined): string {
  return `${sessionId ?? 'commit'}-commit`;
}

export async function runCommitGate(
  options: CommitGateOptions,
): Promise<CommitGateResult> {
  const { violations, skippedAnalyzers } = await runVerify({
    repoRoot: options.repoRoot,
    baseBranch: options.baseBranch,
    exec: options.exec,
    profile: 'commit',
    ...(options.resolveBin && { resolveBin: options.resolveBin }),
    ...(options.analyzers && { analyzers: options.analyzers }),
    ...(options.changedScope && { changedScope: options.changedScope }),
  });
  // The commit gate audits the branch's CUMULATIVE diff and has no per-loop
  // snapshot baseline (unlike runStopGate), so a deliberately-sanctioned
  // suppression introduced on this branch would re-flag on every subsequent
  // commit — permanently wedging the branch. The allowlist is that baseline:
  // explicit, checked-in, and reviewable, in the same spirit as the commented
  // knip/fallow ignore entries. It is NOT applied to the Stop gate, whose
  // snapshot already distinguishes fixer-added suppressions from pre-existing
  // ones — so this cannot become a fixer escape hatch.
  // Equivalent mutant on the `[]` default: the budget is only probed with real
  // `file|kind|text` finding keys, and a placeholder entry's `.key` reads as
  // `undefined` (not a string), so it can never match and grants no budget.
  // Stryker disable next-line ArrayDeclaration
  const budget = sanctionBudget(options.sanctionedSuppressions ?? []);
  const findings = spendBudget(
    auditDiff(await branchDiff(options)),
    budget,
    options.sanctionedFiles,
  );
  const guided = withGuidance(violations);
  const isBlocked = hasErrors(guided) || findings.length > 0;
  if (!isBlocked) {
    // Nothing written on a pass, deliberately: a stale manifest left behind is
    // one the NEXT block could be read against.
    return { violations: guided, findings, blocked: false, skippedAnalyzers };
  }

  // Delegation for the commit rung (#49). The manifest carries the same shape
  // the stop rung writes -- violations plus the audit findings, guidance
  // attached -- so `guardrail-fixer` needs no second format to understand.
  const directory = stateDirectory(options.repoRoot);
  const manifestId = commitManifestId(options.sessionId);
  const combined = withGuidance(
    withPackages(
      [...guided, ...findings.map((finding) => toViolation(finding))],
      loadWorkspaceResolver(options.repoRoot),
    ),
  );
  writeViolations(directory, manifestId, combined);

  // Routed by the SAME loose-class rule the stop gate uses, rather than a
  // second policy: the commit-rung analyzers (knip, dependency-cruiser,
  // stryker) are loose by construction, so this resolves to the thorough fixer
  // where it matters and stays honest if that classification ever changes.
  const fixerAgent = combined.some(
    (violation) => options.config.isLoose?.(violation) === true,
  )
    ? options.config.thoroughFixer
    : options.config.fastFixer;

  return {
    violations: guided,
    findings,
    blocked: true,
    skippedAnalyzers,
    delegation: {
      manifestPath: path.relative(
        options.repoRoot,
        manifestFile(directory, manifestId),
      ),
      fixerAgent,
    },
  };
}

/**
Combine the block message and any behavioral correction for a hook reason.
*/
export function stopHookReason(decision: GateDecision): string {
  return decision.additionalContext === undefined
    ? decision.message
    : `${decision.message}\n\n${decision.additionalContext}`;
}
