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
import type { RepoFacts } from './detect.js';
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
 * so they never produce `drift`.
 */
const SHARED_PATHS: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  '.github/copilot-instructions.md',
  '.gitignore',
  'package.json',
]);

function classifyFile(path: string): FileClass {
  if (SEED_ONCE_PATHS.has(path)) {
    return 'seed-once';
  }
  if (SHARED_PATHS.has(path)) {
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
    reason: `${path} is shared; merging in guardrails' entries`,
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

  return { actions, warnings };
}
