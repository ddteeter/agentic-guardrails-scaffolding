/**
 * SHARED-class mergers -- spec §6.4 SHARED.
 *
 * `planScaffold` decides that a SHARED path (`.claude/settings.json`,
 * `.gitignore`, `package.json`'s `prepare` script,
 * `.github/copilot-instructions.md`, `AGENTS.md`) always gets `merge`, never `drift`: the
 * consumer owns the file, and guardrails only ever touches its own entries in
 * it. The functions below ARE that touch. Every one is pure -- no I/O, no
 * filesystem -- so the sharpest edge in the whole piece (a wrong merge here
 * either silently disables the guardrail loop or clobbers a consumer's own
 * hooks) is provable by fast unit tests instead of filesystem fixtures.
 */
import { isRecord } from './record.js';

/**
 * Markers that identify guardrails-owned hook entries, wherever they nest
 * inside one. The command form has changed once (old path-based form to new
 * package-name form); entries from each form are owned by guardrails and must
 * be replaced on merge, not kept as "foreign" entries beside the new form.
 * This list exists because the command form changed once and consumers upgrade
 * across that change: a consumer with old-form entries must see them replaced
 * by the new form, not duplicated.
 */
const GUARDRAILS_HOOK_MARKERS = [
  "import('guardrails-core/cli')", // current form (package resolution)
  'guardrails-core/dist/cli.mjs', // legacy form (path-based)
] as const;

/** The desired shape of the template's hooks block, trusted as-authored: it
 * ships with guardrails-core itself and is never consumer-supplied, so unlike
 * `current` below it gets no runtime validation -- see `hook-io.ts`'s
 * `RawHookPayload` for the same "guarded once at the true boundary, cast
 * afterward" convention. */
interface HooksTemplate {
  readonly hooks: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * Wraps the parse result rather than returning `unknown | undefined` directly,
 * and is exported so it has its own direct test -- the same reasoning as
 * `json-file.ts`'s `readJsonFile`. A bare `undefined` return would make the
 * catch block's mutant equivalent from any *caller's* point of view (`{}`'s
 * `.parsed` reads back `undefined` too, same as `{ parsed: undefined }`'s);
 * only a test against this function's own return value (`toHaveProperty`,
 * which `{}` fails and `{ parsed: undefined }` passes) makes that mutant
 * observable, so it's provable instead of exempted from the gate.
 */
export interface ParsedJson {
  readonly parsed: unknown;
}

export function parseConsumerJson(text: string): ParsedJson {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { parsed: undefined };
  }
}

/**
 * A whole matcher-group entry (`{ matcher?, hooks: [...] }`) is "ours" if any
 * command anywhere inside it mentions our CLI. Checking the entry as a single
 * opaque blob -- rather than modelling `hooks[].command` field by field --
 * means this merger never needs to understand a shape it didn't author, and
 * still correctly drops a stale guardrails entry of any past template version.
 */
function isGuardrailsEntry(entry: unknown): boolean {
  const serialized = JSON.stringify(entry);
  return GUARDRAILS_HOOK_MARKERS.some((marker) => serialized.includes(marker));
}

/** One hook event: keep every consumer entry that is not ours, then append
 * the template's entries for that event. Filter-then-append is what makes a
 * re-run idempotent instead of duplicating -- see the module's own test for
 * "replaces a stale guardrails hook rather than duplicating it". */
function mergeHookEvent(
  consumerEntries: unknown,
  templateEntries: readonly unknown[],
): unknown[] {
  const ownEntries = Array.isArray(consumerEntries) ? consumerEntries : [];
  const keptEntries = ownEntries.filter((entry) => !isGuardrailsEntry(entry));
  return [...keptEntries, ...templateEntries];
}

/** Merges every templated event into the consumer's `hooks` object, leaving
 * any event the consumer defined that guardrails doesn't template untouched. */
function mergeHooksObject(
  consumerHooks: unknown,
  templateHooks: Readonly<Record<string, readonly unknown[]>>,
): Record<string, unknown> {
  const consumerHooksRecord = isRecord(consumerHooks)
    ? consumerHooks
    : undefined;
  const merged: Record<string, unknown> = { ...consumerHooksRecord };
  for (const [event, templateEntries] of Object.entries(templateHooks)) {
    merged[event] = mergeHookEvent(
      consumerHooksRecord?.[event],
      templateEntries,
    );
  }
  return merged;
}

function serializeSettings(settings: Record<string, unknown>): string {
  return `${JSON.stringify(settings, undefined, 2)}\n`;
}

/**
 * Merges guardrails' own hook entries into `.claude/settings.json`, by hook
 * event, without disturbing anything else in the file.
 *
 * Fails closed on unparseable consumer JSON: `current` comes back byte-for-
 * byte unchanged, so the caller can report the problem rather than this
 * function guessing and destroying a file it cannot read.
 */
export function mergeClaudeSettings(
  current: string | undefined,
  hooksBlock: string,
): string {
  const template = JSON.parse(hooksBlock) as HooksTemplate;

  if (current === undefined) {
    return serializeSettings({
      hooks: mergeHooksObject(undefined, template.hooks),
    });
  }

  const consumer = parseConsumerJson(current).parsed;
  if (!isRecord(consumer)) {
    return current;
  }

  return serializeSettings({
    ...consumer,
    hooks: mergeHooksObject(consumer.hooks, template.hooks),
  });
}

/**
 * Replaces the text between `startMarker` and `endMarker` with `block`
 * (which already carries its own markers), or appends `block` when the
 * markers aren't both present -- ported from the marker-splice logic in
 * `scripts/sync-agents.mjs`'s Copilot-instructions merge, so this file and
 * that script don't grow two dialects of the same idea.
 */
function replaceMarkedBlock(
  existing: string,
  startMarker: string,
  endMarker: string,
  block: string,
): string {
  const startAt = existing.indexOf(startMarker);
  const endAt = existing.indexOf(endMarker);
  if (startAt === -1 || endAt === -1) {
    return existing.trim() === ''
      ? `${block}\n`
      : `${existing.trimEnd()}\n\n${block}\n`;
  }
  return `${existing.slice(0, startAt)}${block}${existing.slice(endAt + endMarker.length)}`;
}

const GITIGNORE_START = '# --- guardrails:start ---';
const GITIGNORE_END = '# --- guardrails:end ---';

// Deliberately NOT `.claude/agents` or `.claude/skills`: this repo ignores
// those because it REGENERATES them on every build (see
// `scripts/sync-agents.mjs`). A consumer has no build step, so those
// directories are the only copy of the fixer agents/skills that will ever
// exist in their repo -- ignoring them would silently disable the Copilot
// cloud agent and leave every teammate without fixers.
const GITIGNORE_BLOCK = [
  GITIGNORE_START,
  // `.guardrails/state/*` (contents), not `.guardrails/state/` (the
  // directory): git never re-includes a path whose PARENT directory is
  // excluded, so a bare directory-ignore would make the negation below a
  // no-op. Wildcarding only the contents leaves the directory itself
  // un-excluded, so git still walks in and the negation takes effect --
  // plan.md's "Solo -> team" needs exactly this: recurrence.json is the one
  // state file a team commits, and every *other* file directly under
  // `.guardrails/state/` (session tallies, violation manifests) stays
  // ignored, matching `sweepStale`'s own `recurrence.json` exemption in
  // `state-store.ts`.
  '.guardrails/state/*',
  '!.guardrails/state/recurrence.json',
  // `reports/mutation/` and `.stryker-tmp/` are generated by guardrails' own
  // `verify` running stryker inside the consumer's repo (spec §6.4) -- without
  // them, a consumer's first mutation run leaves untracked noise they never
  // asked for.
  'reports/mutation/',
  // Stryker's `incrementalFile` default, which is NOT under reports/mutation/.
  // Measured on a greenfield adoption: without it the repo's first
  // `git add -A` commits a mutation-result cache that churns on every run.
  // `runStryker` deletes this file before each run, so guardrails' own gate is
  // unaffected either way -- what this prevents is the committed artifact, and
  // stale verdicts for anyone running `npx stryker run` by hand.
  'reports/stryker-incremental.json',
  '.stryker-tmp/',
  // A git worktree checked out inside the repo is untracked but NOT ignored,
  // so knip -- which does respect .gitignore -- walks into it and reports a
  // whole second checkout of this repository as dead code in this one. Claude
  // Code creates worktrees here by default, so the recommended workflow
  // produces the broken state. dependency-cruiser does not read .gitignore at
  // all; it is handled by the seeded config's `exclude` instead.
  '.claude/worktrees/',
  GITIGNORE_END,
].join('\n');

/**
 * The one entry guardrails seeds OUTSIDE its own block, and only when there is
 * no consumer content to preserve.
 *
 * Scoping the marker block to guardrails' own generated paths is right for the
 * merge case -- a repo with a `.gitignore` already ignores its dependencies.
 * On a greenfield repo there is no such file, so that block becomes the WHOLE
 * `.gitignore` and `node_modules/` is untracked-but-not-ignored: the same
 * failure class as a nested worktree, and measured just as loudly. `git
 * ls-files --others` returned 12,699 paths, 12,669 of them installed
 * dependencies; they reached eslint, which walked up from one into
 * `node_modules/fast-uri/eslint.config.js` and died, so the gate reported
 * `guardrails/analyzer-failed` for eslint on every turn instead of linting.
 *
 * Written above the markers rather than inside them, because it is not
 * guardrails' entry to own: a later `init` marker-replaces the block and leaves
 * this line where it is, and a consumer who removes it is not fought on the
 * next run. `changedFiles` filters dependency paths independently
 * (`isDependencyPath`), so the gate stays correct either way -- this seed is
 * what keeps the repo's own `git status` honest.
 */
const GITIGNORE_SEED = 'node_modules/';

/** Merges guardrails' own `.gitignore` entries into a marker-delimited block,
 * leaving every other line in the file exactly where the consumer put it. */
export function mergeGitignore(current: string | undefined): string {
  // Authoring the whole file -- an absent file and a whitespace-only one are
  // the same case, and `replaceMarkedBlock` already treats them alike.
  const isAuthoring = current === undefined || current.trim() === '';
  return replaceMarkedBlock(
    isAuthoring ? GITIGNORE_SEED : current,
    GITIGNORE_START,
    GITIGNORE_END,
    GITIGNORE_BLOCK,
  );
}

const OUR_PREPARE_COMMAND = 'guardrails-core install-hooks';

/**
 * The command earlier versions wrote, back when the bin was named
 * `guardrails`. It no longer resolves -- a real, unrelated package owns that
 * name on npm, which is why the bin is named after this package instead -- and
 * npm treats a failed `prepare` as a failed install, so a repo still carrying
 * it cannot run `npm install` or `npm ci` at all (`sh: guardrails: command not
 * found`, exit 127). Migrating it is not cosmetic: appending the current
 * command beside it would leave the broken half in the `&&` chain and the
 * install would still fail.
 *
 * Matched as a command rather than a substring, so a consumer's own
 * `my-guardrails install-hooks` keeps its name.
 */
const LEGACY_PREPARE_COMMAND = /(?<![\w-])guardrails install-hooks/g;

/**
 * Appends our hook-installer to `package.json`'s `prepare` script rather than
 * replacing it: a consumer running husky (or anything else) via `prepare`
 * must not lose it. Idempotent by construction -- an already-wired script
 * already contains the command and is returned unchanged.
 */
export function mergePrepareScript(current: string | undefined): string {
  if (current === undefined) {
    return OUR_PREPARE_COMMAND;
  }
  // Function replacement, not the string: a `$`-sequence in the replacement is
  // a substitution pattern to `replaceAll`, and this value is a command line we
  // do not control the future shape of.
  const migrated = current.replaceAll(
    LEGACY_PREPARE_COMMAND,
    () => OUR_PREPARE_COMMAND,
  );
  if (migrated.includes(OUR_PREPARE_COMMAND)) {
    return migrated;
  }
  return `${migrated} && ${OUR_PREPARE_COMMAND}`;
}

// Exported so templates.ts's buildDesiredFiles can build the DESIRED block
// with these same literal markers, rather than restating them -- see that
// module's copilotInstructionsBlock. Two independently-typed marker strings
// would risk drifting apart silently: replaceMarkedBlock would just append
// instead of splice, with no error.
export const COPILOT_SKILLS_START = '<!-- guardrails:skills:start -->';
export const COPILOT_SKILLS_END = '<!-- guardrails:skills:end -->';
export const AGENTS_GUARDRAILS_START = '<!-- guardrails:instructions:start -->';
export const AGENTS_GUARDRAILS_END = '<!-- guardrails:instructions:end -->';

/**
 * Merges the guardrails skills index into `.github/copilot-instructions.md`,
 * replacing only the marked block so hand-written prose around it survives.
 * `block` is the caller's fully-assembled replacement, markers included --
 * the same shape `scripts/sync-agents.mjs` builds for this repo's own file.
 */
export function mergeCopilotInstructions(
  current: string | undefined,
  block: string,
): string {
  return replaceMarkedBlock(
    current ?? '',
    COPILOT_SKILLS_START,
    COPILOT_SKILLS_END,
    block,
  );
}

/**
Merges the portable guardrails index into the repository's AGENTS.md.
*/
export function mergeAgentsInstructions(
  current: string | undefined,
  block: string,
): string {
  return replaceMarkedBlock(
    current ?? '',
    AGENTS_GUARDRAILS_START,
    AGENTS_GUARDRAILS_END,
    block,
  );
}

/** Builds the `scripts.prepare`-merged object, without serialising it --
 *  split out so the caller can compare it against `parsed` BEFORE deciding
 *  whether serialising is even necessary. */
function withMergedPrepare(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {};
  const preparedScript =
    typeof scripts.prepare === 'string' ? scripts.prepare : undefined;
  return {
    ...parsed,
    scripts: { ...scripts, prepare: mergePrepareScript(preparedScript) },
  };
}

function serializePackageJson(merged: Record<string, unknown>): string {
  return `${JSON.stringify(merged, undefined, 2)}\n`;
}

/**
 * `mergePrepareScript` merges one script string; `package.json` is shared as
 * a whole file, so this is the JSON-shaped wrapper around it -- reading the
 * current `scripts.prepare`, merging it, and writing the rest of the file
 * back untouched. Fails closed on unparseable JSON, matching every other
 * SHARED merger: the file comes back exactly as it was.
 *
 * Returns `current` unchanged (not a fresh re-serialisation) when `merged`
 * deep-equals `parsed` -- this is what keeps a consumer whose own formatter
 * disagrees with ours (4-space, tabs) from being reformatted by every
 * `init --apply`, reformatted back by their own formatter, and rewritten
 * again next run, forever. Comparing via `JSON.stringify` (rather than a
 * recursive deep-equal) is sound here specifically because `merged` is built
 * by SPREADING `parsed`: object-spread never reorders an already-present key,
 * so whenever `mergePrepareScript` leaves `scripts.prepare` byte-identical,
 * `merged`'s key order matches `parsed`'s exactly and the two compact-JSON
 * strings coincide; any actual change (a new `scripts` key, a rewritten
 * `prepare`) changes a value, which changes that string too. The comparison
 * lives HERE rather than in a shared helper because it is only ever
 * meaningful once `current` is known to be a real string: a from-scratch
 * create (`current === undefined`) starts from `{}`, which can never already
 * contain our entry, so there is no no-op case to check for there.
 */
export function mergePackageJsonScripts(current: string | undefined): string {
  if (current === undefined) {
    return serializePackageJson(withMergedPrepare({}));
  }
  const parsed = parseConsumerJson(current).parsed;
  if (!isRecord(parsed)) {
    return current;
  }
  const merged = withMergedPrepare(parsed);
  return JSON.stringify(merged) === JSON.stringify(parsed)
    ? current
    : serializePackageJson(merged);
}

/**
 * The result of routing a SHARED path through its merger. `parseFailed` is
 * what lets a caller (`apply.ts`) tell "already up to date" apart from "could
 * not be parsed, so left unchanged" -- both produce `content === current`,
 * but only the second is something a consumer needs to hear about. Only the
 * two JSON-based mergers (`.claude/settings.json`, `package.json`) can ever
 * fail to parse; the two text-splicing mergers (`.gitignore`, Copilot
 * instructions) never do, so `parseFailed` is always `false` for them --
 * re-parsing their output as JSON would spuriously "fail" on every genuinely
 * up-to-date run, which is exactly the false alarm this type exists to avoid.
 */
export interface SharedMergeResult {
  readonly content: string;
  readonly parseFailed: boolean;
}

type SharedMerger = (
  current: string | undefined,
  desiredContent: string,
) => SharedMergeResult;

/**
 * Wraps a JSON-based merger: `current` failing to parse as a JSON record
 * means the merger hit its own fail-closed branch. This is computed directly
 * from `current` alone, not from `content === current` -- every JSON-based
 * merger's own contract already guarantees the two coincide (a fail-closed
 * merge always returns `current` unchanged, by construction), so re-checking
 * it here would only add a clause that's always true whenever it matters: a
 * `content === current` comparison can only be true when `current` is
 * itself a string, since `content` always is one, which makes a further
 * `current !== undefined` alongside it a dead check with no observable
 * effect a test could point to.
 */
function jsonMerger(
  merge: (current: string | undefined, desiredContent: string) => string,
): SharedMerger {
  return (current, desiredContent) => ({
    content: merge(current, desiredContent),
    parseFailed:
      current !== undefined && !isRecord(parseConsumerJson(current).parsed),
  });
}

/** Wraps a text-splicing merger, which never fails to parse -- there is no
 * such thing as malformed `.gitignore` or Markdown. */
function textMerger(
  merge: (current: string | undefined, desiredContent: string) => string,
): SharedMerger {
  return (current, desiredContent) => ({
    content: merge(current, desiredContent),
    parseFailed: false,
  });
}

/**
 * The operational definition of "SHARED": a path is shared precisely because
 * a merger here knows how to touch only guardrails' own part of it. `plan.ts`
 * classifies a path as `shared` by asking `isSharedPath`, and `apply.ts`
 * looks up its merger here by the same key -- one literal table, so the two
 * concerns (which paths are shared, and how each one merges) cannot drift
 * apart the way two independently maintained lists could.
 */
export const SHARED_MERGERS = {
  'AGENTS.md': textMerger(mergeAgentsInstructions),
  '.claude/settings.json': jsonMerger(mergeClaudeSettings),
  '.codex/hooks.json': jsonMerger(mergeClaudeSettings),
  '.github/copilot-instructions.md': textMerger(mergeCopilotInstructions),
  '.gitignore': textMerger((current: string | undefined) =>
    mergeGitignore(current),
  ),
  'package.json': jsonMerger((current: string | undefined) =>
    mergePackageJsonScripts(current),
  ),
} as const satisfies Record<string, SharedMerger>;

export type SharedPath = keyof typeof SHARED_MERGERS;

export function isSharedPath(candidate: string): candidate is SharedPath {
  return Object.hasOwn(SHARED_MERGERS, candidate);
}
