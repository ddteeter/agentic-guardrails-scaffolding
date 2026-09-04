/**
 * The pure core of `guardrails init`: decides what to do with each file
 * guardrails wants to scaffold, without ever touching a filesystem.
 *
 * `detect()` reads the world and `applyScaffold()` (a later piece) writes to
 * it; this module sits between them and does neither. Both the desired
 * content and the on-disk content are handed in as plain data, which is what
 * lets the whole decision table (spec §6.4) be proven by fast unit tests
 * instead of filesystem integration tests -- this repo gates mutation testing
 * at zero tolerance on changed production files, and `init` is exactly the
 * string-and-path-heavy shape that produces hundreds of mutants. If a rule in
 * here ever needs to read a file, that need belongs in `detect()` instead.
 */
import { analyzerMode } from '../verify/analyzer-policy.js';
import { installableAnalyzerProviders } from '../verify/index.js';
import { effectiveAnalyzers, type RepoFacts } from './detect.js';
import { foreignHooksPath, foreignHooksPathWarning } from './hooks-path.js';
import { isSharedPath } from './merge.js';
import { checksum, type ScaffoldManifest } from './manifest.js';

export type FileClass = 'owned' | 'shared' | 'seed-once';

export type ActionKind =
  | 'create' // absent -> write it
  | 'update' // owned, matches its recorded checksum -> rewrite
  | 'drift' // owned, edited by the consumer -> leave alone, report
  | 'merge' // shared -> merge guardrails' entries into their file
  | 'unchanged'; // already correct, nothing to do

export interface PlannedAction {
  readonly path: string; // repo-relative, POSIX separators
  readonly fileClass: FileClass;
  readonly kind: ActionKind;
  readonly reason: string; // one line, shown by --plan
}

export interface ScaffoldDecisions {
  readonly analyzers: Readonly<Record<string, 'off' | 'auto' | 'required'>>;
  readonly enforcement: 'warn' | 'block';
  readonly distribution: 'solo' | 'team';
  readonly force: boolean;
}

export interface ScaffoldPlan {
  readonly actions: readonly PlannedAction[];
  readonly warnings: readonly string[];
}

export interface PlanInput {
  readonly facts: RepoFacts;
  readonly decisions: ScaffoldDecisions;
  /** Repo-relative path -> the content init would write. */
  readonly desired: Readonly<Record<string, string>>;
  /** Repo-relative path -> the content on disk, absent when the file is missing. */
  readonly current: Readonly<Record<string, string>>;
}

/**
 * Paths guardrails seeds once and never rewrites again -- spec §6.4 SEED-ONCE.
 * `guardrails.config.json` holds the consumer's policy and their sanctioned
 * suppressions; losing it would be the worst thing this command could do, so
 * it is never overwritten, not even with `--force`.
 */
const SEED_ONCE_PATHS: ReadonlySet<string> = new Set([
  'guardrails.config.json',
  '.dependency-cruiser.cjs',
  'stryker.conf.json',
]);

/**
 * Paths where init merges only its own entries, leaving the rest of the file
 * untouched -- spec §6.4 SHARED. The consumer is expected to own these files,
 * so they never produce `drift`. `isSharedPath` (from `merge.ts`) is the
 * single source of truth for this set: a path is shared precisely because a
 * merger there knows how to touch only guardrails' own part of it, so
 * classification and merging are read off the same table instead of two
 * lists that could drift apart.
 */
function classifyFile(path: string): FileClass {
  if (SEED_ONCE_PATHS.has(path)) {
    return 'seed-once';
  }
  if (isSharedPath(path)) {
    return 'shared';
  }
  return 'owned';
}

interface FileDecision {
  readonly kind: ActionKind;
  readonly reason: string;
  /** Set only for `drift`: the warning text a consumer must see. */
  readonly warning?: string;
}

/**
 * OWNED: unmodified -> rewritten on upgrade; modified -> left alone and
 * reported as drift; `--force` overwrites. Identical-to-desired is checked
 * before the manifest checksum so a file that happens to already be correct
 * never reports drift or update, regardless of manifest state.
 */
function decideOwned(
  path: string,
  desiredContent: string,
  currentContent: string | undefined,
  manifest: ScaffoldManifest | undefined,
  force: boolean,
): FileDecision {
  if (currentContent === undefined) {
    return {
      kind: 'create',
      reason: `${path} does not exist yet; creating it`,
    };
  }
  if (currentContent === desiredContent) {
    return {
      kind: 'unchanged',
      reason: `${path} already matches the current template`,
    };
  }
  // No `recordedChecksum !== undefined` guard: `undefined === checksum(...)`
  // is always false in JavaScript, so the guard would be a dead branch a
  // mutation test cannot distinguish from `if (true)` -- see the module
  // comment on `noUncheckedIndexedAccess` equivalent mutants.
  const recordedChecksum = manifest?.files[path];
  if (recordedChecksum === checksum(currentContent)) {
    return {
      kind: 'update',
      reason: `${path} is unmodified since it was scaffolded; upgrading it`,
    };
  }
  if (force) {
    return {
      kind: 'update',
      reason: `${path} was edited, but --force overwrites it`,
    };
  }
  return {
    kind: 'drift',
    reason: `${path} was edited after scaffolding; leaving it alone`,
    warning: `${path} has drifted from what guardrails scaffolded and was left alone (rerun with --force to overwrite)`,
  };
}

/**
 * `package.json` gets its own reason text because `mergePackageJsonScripts`
 * re-serialises the whole file via `JSON.stringify` whenever anything
 * actually changed (see `merge.ts`'s `mergePackageJsonScripts`) -- a
 * consumer whose formatter disagrees with ours (4-space, tabs) needs `--plan`
 * to say a merge here can change formatting, not just add guardrails'
 * entries, or the reformat reads as `--plan` lying about what a merge does.
 */
function sharedMergeReason(path: string): string {
  return path === 'package.json'
    ? `${path} is shared; merging in guardrails' entries and re-serialising ` +
        `the file (formatting may change)`
    : `${path} is shared; merging in guardrails' entries`;
}

/**
 * SHARED: absent -> create; present -> merge, always. Never `drift` -- the
 * consumer owns these files, and merging touches only guardrails' own
 * entries, so `--force` changes nothing about this decision.
 */
function decideShared(
  path: string,
  currentContent: string | undefined,
): FileDecision {
  if (currentContent === undefined) {
    return {
      kind: 'create',
      reason: `${path} does not exist yet; creating it`,
    };
  }
  return {
    kind: 'merge',
    reason: sharedMergeReason(path),
  };
}

/**
 * SEED-ONCE: absent -> create; present -> unchanged, always, even with
 * `--force`. `guardrails.config.json` holds the consumer's policy and their
 * sanctioned suppressions.
 */
function decideSeedOnce(
  path: string,
  currentContent: string | undefined,
): FileDecision {
  if (currentContent === undefined) {
    return { kind: 'create', reason: `${path} does not exist yet; seeding it` };
  }
  return {
    kind: 'unchanged',
    reason: `${path} is seed-once and is never overwritten`,
  };
}

function decideFile(
  path: string,
  fileClass: FileClass,
  desiredContent: string,
  currentContent: string | undefined,
  manifest: ScaffoldManifest | undefined,
  force: boolean,
): FileDecision {
  if (fileClass === 'seed-once') {
    return decideSeedOnce(path, currentContent);
  }
  if (fileClass === 'shared') {
    return decideShared(path, currentContent);
  }
  return decideOwned(path, desiredContent, currentContent, manifest, force);
}

export function planScaffold(input: PlanInput): ScaffoldPlan {
  // `Object.entries` (rather than `Object.keys` + index access) keeps
  // `desiredContent` typed as `string`, not `string | undefined` -- with
  // `noUncheckedIndexedAccess` an index-access guard here would be
  // unreachable for any input that actually satisfies `PlanInput`, which is
  // exactly the kind of dead defensive branch a mutation test cannot
  // distinguish from `if (true)`.
  const sortedEntries = Object.entries(input.desired).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const actions: PlannedAction[] = [];
  const warnings: string[] = [];

  for (const [path, desiredContent] of sortedEntries) {
    const fileClass = classifyFile(path);
    const currentContent = input.current[path];
    const decision = decideFile(
      path,
      fileClass,
      desiredContent,
      currentContent,
      input.facts.manifest,
      input.decisions.force,
    );
    actions.push({
      path,
      fileClass,
      kind: decision.kind,
      reason: decision.reason,
    });
    if (decision.warning !== undefined) {
      warnings.push(decision.warning);
    }
  }

  // Not a per-file decision, so it is not an action: `core.hooksPath` lives in
  // git config, not in the tree. It belongs in the PLAN all the same -- a
  // consumer whose existing hooks mean our gate will not fire has to learn
  // that from `--plan`, before `--apply`, not from a gate that never runs.
  // `printApply` re-emits `plan.warnings`, so stating it once covers both.
  const existingHooksPath = foreignHooksPath(input.facts.hooksPath);
  if (existingHooksPath !== undefined) {
    warnings.push(foreignHooksPathWarning(existingHooksPath));
  }

  const silent = silentlySkippedAnalyzers(input);
  if (silent.length > 0) {
    warnings.push(silentSkipWarning(silent));
  }

  return { actions, warnings };
}

/**
 * Analyzers that are enabled but whose provider package the repo does not
 * declare -- so `decideAnalyzer('auto', false)` will run-and-never-report them,
 * and `verify` will print `clean (0 violations)` having checked nothing.
 *
 * `required` is excluded because it is precisely the fix: a missing binary is
 * then a blocking `guardrails/analyzer-missing`, which can never read as clean.
 * `off` is excluded because the consumer said so. Only analyzers with an
 * installable provider are considered -- `npm-peers` shells out to `npm`, which
 * no repo declares and nobody should be told to install.
 */
function silentlySkippedAnalyzers(
  input: PlanInput,
): readonly (readonly [string, string])[] {
  return Object.entries(installableAnalyzerProviders()).filter(
    ([tool, provider]) =>
      analyzerMode(
        effectiveAnalyzers(input.facts, input.decisions.analyzers),
        tool,
      ) === 'auto' && !input.facts.declaredProviders.has(provider),
  );
}

/**
 * Says the thing a silent skip cannot say for itself. The failure this exists
 * for looks like success: a first adoption on a repo that never installed
 * eslint gets a green `verify` and a gate that checks almost nothing, which is
 * worse than no gate because it teaches everyone to trust it.
 *
 * Names both halves -- the tool a consumer configures and the package they
 * install -- and both fixes, since either is legitimate: install it, or say
 * `required` and let the absence block.
 */
function silentSkipWarning(
  silent: readonly (readonly [string, string])[],
): string {
  const named = silent
    .map(([tool, provider]) => `${tool} (needs ${provider})`)
    .join(', ');
  return (
    `these analyzers are enabled but their provider package is not in ` +
    `package.json, so each is skipped and verify reports clean without ` +
    `running it: ${named}. Install the ones you want, or set them ` +
    `"required" in guardrails.config.json so a missing one blocks instead.`
  );
}
