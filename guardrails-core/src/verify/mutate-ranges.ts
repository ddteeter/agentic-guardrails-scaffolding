/**
 * Line-range mutation (#155): mutate the lines a change touched, not every
 * line of every file it touched.
 *
 * Measured in a consumer, one branch that lightly edited 42 files had a push
 * gate 1h40m into stryker with an ETA near ten hours, nearly all of it spent
 * on mutants on lines the branch never touched. Stryker accepts
 * `--mutate file:a-b`, several per file, so the hunks of the branch's diff
 * are what this hands it.
 *
 * Three pieces, each pure apart from `changedLineRanges`:
 *
 * 1. `parseDiffHunks` reads `git diff --unified=0` into per-file ranges.
 * 2. `planFileRanges` pads them, merges them, and decides whether ranges are
 *    worth it for that file at all (`mutationScope.wholeFileAbove`).
 * 3. `isLocationInRanges` is the same inclusion rule stryker's instrumenter
 *    applies, so the verdict can drop what stryker folds back from its cache
 *    but did not test this run (drift test 0.3).
 *
 * Every unknown widens: a file with no hunks, a quoted path, an unreadable
 * file or a failed `git diff` all mutate the whole file, which is exactly what
 * the gate did before this module existed. Ranges never REMOVE a file from
 * the run, so the pre-push lock probe, which asks `strykerScope` whether
 * anything will be mutated, cannot disagree with the run about it.
 *
 * Stryker mutates a node only when the node lies wholly inside a range, so
 * padding alone left a mutant spanning the change — a `BlockStatement`
 * emptying the function a one-line edit sits in — untested at the gate. With
 * `mutationScope.enclosing` (#196, `enclosing-spans.ts`) each hunk is widened
 * to the function or top-level statement around it, and each ranged file
 * takes in the declarations of the exports the diff's removed lines named.
 *
 * KNOWN GAP: a node larger than the enclosing function (a class body), an
 * edit changing a verdict in another function or file, and an orphaned
 * export in a file with no hunks are still not tested at the gate. CI's
 * whole-scope mutation run is the backstop for those.
 */

import path from 'node:path';

import type { Exec, ExecResult } from '../exec.js';
import { type Typescript, loadTypescriptParser } from '../typescript-loader.js';
import { enclosingSpans, orphanedExportSpans } from './enclosing-spans.js';
import { resolveDiffBase } from './git.js';
import type { LineRange } from './line-range.js';

export type { LineRange } from './line-range.js';

/**
`RepoConfig.mutationScope`: how far line-range mutation narrows a run.
*/
export interface MutationScopeSettings {
  /**
  Mutate changed line ranges. `false` mutates every changed file whole.
  */
  lines: boolean;
  /**
  Lines added on each side of a hunk, so a mutant across its edge is caught.
  */
  padding: number;
  /**
  Above this share of a file's lines, mutate the file whole.
  */
  wholeFileAbove: number;
  /**
  Widen each hunk to the function (or top-level statement) around it, and
  take in the declarations of the exports the change may have orphaned
  (#196). `false` keeps ranges to the padded hunks alone.
  */
  enclosing: boolean;
}

/**
 * Wide on purpose. Five lines of padding takes in most statements that cross
 * a hunk edge, and above 40% of a file the ranges save too little to be worth
 * the mutants on their edges that they miss.
 */
export const DEFAULT_MUTATION_SCOPE: MutationScopeSettings = {
  lines: true,
  padding: 5,
  wholeFileAbove: 0.4,
  enclosing: true,
};

/**
`@@ -a,b +c,d @@`. A missing count means 1.
*/
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const NEW_FILE_HEADER = '+++ ';
const ADDED_SINCE_BASE = '--- /dev/null';
const DESTINATION_PREFIX = 'b/';
/**
`\ No newline at end of file`, which sits inside a hunk without counting.
*/
const NO_NEWLINE_MARKER = '\\';

function hunkCount(text: string | undefined): number {
  return text === undefined ? 1 : Number(text);
}

/**
 * The new-side lines of one hunk. A pure deletion (`+c,0`) has none, so it
 * becomes the line before the cut (`c`) and the one after it: the code that
 * read whatever was deleted.
 */
function hunkRange(start: number, count: number): LineRange {
  if (count === 0) {
    return { start: Math.max(start, 1), end: start + 1 };
  }
  return { start, end: start + count - 1 };
}

/**
 * The repo-relative path on a `+++` line, or `undefined` for a deleted file
 * or a path git quoted. A quoted path is escaped (`"b/src/\303\251.ts"`) the
 * same way in `--name-only` output, and decoding one is not worth it here:
 * left out, the file is simply mutated whole.
 *
 * git ends the name with a tab when it holds a space, so a patch tool can tell
 * where it stops.
 */
function destinationPath(line: string): string | undefined {
  const field = line.slice(NEW_FILE_HEADER.length);
  const name = field.endsWith('\t') ? field.slice(0, -1) : field;
  if (!name.startsWith(DESTINATION_PREFIX)) {
    return undefined;
  }
  return name.slice(DESTINATION_PREFIX.length);
}

/**
 * The file a header line leaves the walk in. A `+++` line names it, unless
 * the `---` line before it says the file is new since the base. A `diff` line
 * starts a section that may have no `+++` at all (a binary or mode-only
 * change), so it forgets the last one.
 */
function fileAfterHeader(
  line: string,
  previous: string | undefined,
  current: string | undefined,
): string | undefined {
  if (line.startsWith(NEW_FILE_HEADER)) {
    return previous === ADDED_SINCE_BASE ? undefined : destinationPath(line);
  }
  return line.startsWith('diff ') ? undefined : current;
}

function addRange(
  ranges: Map<string, LineRange[]>,
  file: string,
  range: LineRange,
): void {
  const found = ranges.get(file) ?? [];
  found.push(range);
  ranges.set(file, found);
}

/**
What a walk over a diff reports: each hunk of a named file, each removed line.
*/
interface DiffVisitor {
  hunk?: (file: string, range: LineRange) => void;
  removed?: (line: string) => void;
}

/**
 * Walks `git diff --unified=0` output. A hunk's body is skipped by its
 * header's counts, so a removed `-- x` or an added `++ b/y` line of code,
 * which reads as `--- x` and `+++ b/y`, is never taken for a header.
 */
function walkDiff(diff: string, visitor: DiffVisitor): void {
  let file: string | undefined;
  let previous: string | undefined;
  let bodyLeft = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (bodyLeft > 0 && !line.startsWith(NO_NEWLINE_MARKER)) {
      bodyLeft -= 1;
      if (line.startsWith('-')) {
        visitor.removed?.(line.slice(1));
      }
    } else {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk === null) {
        file = fileAfterHeader(line, previous, file);
      } else {
        bodyLeft = visitHunk(hunk, file, visitor);
      }
    }
    previous = line;
  }
}

/**
Reports one hunk header's range, and answers how many body lines follow it.
*/
function visitHunk(
  hunk: RegExpExecArray,
  file: string | undefined,
  visitor: DiffVisitor,
): number {
  const added = hunkCount(hunk[3]);
  if (file !== undefined) {
    visitor.hunk?.(file, hunkRange(Number(hunk[2]), added));
  }
  return hunkCount(hunk[1]) + added;
}

/**
 * Per-file changed line ranges, from `git diff --unified=0` output.
 *
 * Files added since the base are left out, and so are deleted files, binary
 * files and quoted paths: a file with no entry is mutated whole. Hunks are
 * returned as git printed them; `planFileRanges` pads and merges them.
 */
export function parseDiffHunks(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  walkDiff(diff, {
    hunk: (file, range) => {
      addRange(ranges, file, range);
    },
  });
  return ranges;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Every identifier-shaped token on a removed line of `diff`, deleted files
 * included. A deliberate superset — words in strings and comments count — of
 * the names a change stopped using, so `orphanedExportSpans` can find the
 * exports whose callers it removed.
 */
export function removedIdentifiers(diff: string): Set<string> {
  const names = new Set<string>();
  walkDiff(diff, {
    removed: (line) => {
      for (const [name] of line.matchAll(IDENTIFIER)) {
        names.add(name);
      }
    },
  });
  return names;
}

/**
 * How many lines `text` has, the way an editor numbers them: a trailing
 * newline ends the last line rather than starting another.
 */
export function countLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
Clamped to the file, sorted by start, with touching ranges merged.
*/
function clampAndMerge(
  ranges: readonly LineRange[],
  lineCount: number,
): LineRange[] {
  const clamped = ranges
    .map((range) => {
      const start = clamp(range.start, 1, lineCount);
      return { start, end: clamp(range.end, start, lineCount) };
    })
    .toSorted((first, second) => first.start - second.start);
  const merged: LineRange[] = [];
  for (const range of clamped) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * The ranges to mutate in one file, or `undefined` to mutate it whole: each
 * hunk padded by `settings.padding`, joined by `spans` (the code around the
 * hunks, `enclosingSpans`), which are taken unpadded.
 *
 * Whole when ranges are off, when there are no hunks to go on, when the
 * file's length is unknown, and when the padded ranges cover more than
 * `wholeFileAbove` of it: a small file with one edit gains nothing from a
 * range and still loses the mutants across its edges.
 */
export function planFileRanges(
  ranges: readonly LineRange[],
  lineCount: number,
  settings: MutationScopeSettings,
  spans: readonly LineRange[] = [],
): LineRange[] | undefined {
  // A file of unknown length (0) needs no test of its own: every range
  // clamps to one line of it, and a share of 1/0 is above any threshold.
  if (!settings.lines || ranges.length === 0) {
    return undefined;
  }
  const padded = ranges.map((range) => ({
    start: range.start - settings.padding,
    end: range.end + settings.padding,
  }));
  const merged = clampAndMerge([...padded, ...spans], lineCount);
  const covered = merged.reduce(
    (total, range) => total + range.end - range.start + 1,
    0,
  );
  return covered / lineCount > settings.wholeFileAbove ? undefined : merged;
}

/**
 * The ranged files of a run, each with its planned ranges. A file of `files`
 * missing from the result is mutated whole.
 */
export function planMutateRanges(
  files: readonly string[],
  hunks: ReadonlyMap<string, readonly LineRange[]>,
  lineCount: (file: string) => number,
  settings: MutationScopeSettings,
  spansOf: (file: string) => readonly LineRange[] = () => [],
): Map<string, LineRange[]> {
  const plan = new Map<string, LineRange[]>();
  for (const file of files) {
    const planned = planFileRanges(
      hunks.get(file) ?? [],
      lineCount(file),
      settings,
      spansOf(file),
    );
    if (planned !== undefined) {
      plan.set(file, planned);
    }
  }
  return plan;
}

/**
 * The `--mutate` entries for `files`: `file:a-b` for each planned range, or
 * the bare file. Every file yields at least one entry.
 */
export function mutateEntries(
  files: readonly string[],
  plan: ReadonlyMap<string, readonly LineRange[]>,
): string[] {
  return files.flatMap((file) => {
    const ranges = plan.get(file);
    if (ranges === undefined) {
      return [file];
    }
    return ranges.map((range) => `${file}:${range.start}-${range.end}`);
  });
}

/**
 * Does a mutant's span lie wholly inside one of `ranges`?
 *
 * Stryker's own rule (`locationIncluded` in its babel transformer), with a
 * line-only range meaning column 0 to the end of the line, as stryker's CLI
 * reads it. A mutant that only overlaps a range was not tested this run, so a
 * verdict for it in the report is one stryker folded back from its cache.
 */
export function isLocationInRanges(
  location: LineRange,
  ranges: readonly LineRange[],
): boolean {
  return ranges.some(
    (range) => location.start >= range.start && location.end <= range.end,
  );
}

/**
Which diff a run's ranges come from: the branch against its base, or the index.
*/
interface DiffScope {
  baseBranch: string;
  changedScope?: 'branch' | 'staged' | undefined;
}

/**
`git diff` flags that keep its output parseable whatever the user's config.
*/
const PARSEABLE_DIFF = [
  '--unified=0',
  '--no-color',
  '--no-ext-diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  // The changed-file list's own filter (ACM), so both see the same files,
  // plus deletions: a deleted file plans no ranges, but its removed lines
  // name the exports it stopped calling.
  '--diff-filter=ACMD',
];

/**
 * A diff that did not answer. A spawn failure needs no clause of its own:
 * `spawnExec` reports one with exit code 1.
 */
function didDiffFail(result: ExecResult): boolean {
  return result.signal !== undefined || result.code !== 0;
}

/**
 * The `git diff --unified=0` of every tracked file, the same diff the
 * changed-file list comes from: the working tree against the base branch (or
 * its `origin/` form), or the index alone for a staged run. Empty when the
 * diff fails or the base does not resolve: the changed-file list reports
 * those failures already, and this must not report them twice.
 */
async function changedDiff(
  exec: Exec,
  repoRoot: string,
  scope: DiffScope,
): Promise<string> {
  let target: string[] = ['--cached'];
  if (scope.changedScope !== 'staged') {
    const base = await resolveDiffBase(exec, repoRoot, scope.baseBranch);
    if (base.ref === undefined) {
      return '';
    }
    target = [base.ref];
  }
  const result = await exec('git', ['diff', ...PARSEABLE_DIFF, ...target], {
    cwd: repoRoot,
  });
  return didDiffFail(result) ? '' : result.stdout;
}

/**
 * The changed line ranges of every tracked file, from `changedDiff`.
 *
 * Untracked files are not in a diff, so they have no entry and are mutated
 * whole, as new files should be. A diff that fails, or a base that does not
 * resolve, answers no ranges at all: every file whole.
 */
export async function changedLineRanges(
  exec: Exec,
  repoRoot: string,
  scope: DiffScope,
): Promise<Map<string, LineRange[]>> {
  return parseDiffHunks(await changedDiff(exec, repoRoot, scope));
}

/**
The text of the file at `filePath`, or `undefined` when it cannot be read.
*/
async function textOf(
  readFile: (filePath: string) => Promise<string>,
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath);
  } catch {
    // Unread, it has no length, and `planFileRanges` mutates it whole.
    return undefined;
  }
}

/**
 * Where `planRunRanges` reads from. `loadTypescript` defaults to the repo's
 * own `typescript`; `warn` defaults to saying nothing.
 */
interface RunRangeSources {
  exec: Exec;
  repoRoot: string;
  readFile: (filePath: string) => Promise<string>;
  loadTypescript?: (() => Typescript | undefined) | undefined;
  warn?: ((line: string) => void) | undefined;
}

/**
 * The parser `settings.enclosing` asks for, or `undefined` when it is off or
 * the repo has no `typescript`. Only the second is worth a warning, and only
 * when some file has ranges it would have widened.
 */
function enclosingParser(
  sources: RunRangeSources,
  settings: MutationScopeSettings,
  hasRanges: boolean,
): Typescript | undefined {
  if (!hasRanges || !settings.enclosing) {
    return undefined;
  }
  const load =
    sources.loadTypescript ?? (() => loadTypescriptParser(sources.repoRoot));
  const ts = load();
  if (ts === undefined) {
    sources.warn?.(
      'guardrails: typescript could not be loaded from this repo, so changed-line mutation ranges are padded hunks only (mutationScope.enclosing); install typescript to widen them to whole functions.',
    );
  }
  return ts;
}

/**
 * The line ranges one stryker run mutates: the diff's hunks, planned file by
 * file with `planFileRanges`. Off when `settings.lines` is, without asking
 * git. A file that cannot be read has no length and is mutated whole.
 *
 * With `settings.enclosing`, each hunk is widened to the code around it
 * (`enclosingSpans`) and each ranged file takes in the declarations of the
 * exports the diff's removed lines named (`orphanedExportSpans`). Neither
 * ever adds a file: an export in a file outside `files`, or in one with no
 * hunks, is not followed.
 */
export async function planRunRanges(
  sources: RunRangeSources,
  scope: DiffScope,
  files: readonly string[],
  settings: MutationScopeSettings,
): Promise<Map<string, LineRange[]>> {
  if (!settings.lines) {
    return new Map();
  }
  const diff = await changedDiff(sources.exec, sources.repoRoot, scope);
  const hunks = parseDiffHunks(diff);
  const ranged = files.filter((file) => hunks.has(file));
  const texts = new Map(
    await Promise.all(
      ranged.map(async (file): Promise<[string, string | undefined]> => [
        file,
        await textOf(sources.readFile, path.join(sources.repoRoot, file)),
      ]),
    ),
  );
  const ts = enclosingParser(sources, settings, ranged.length > 0);
  const removed =
    ts === undefined ? new Set<string>() : removedIdentifiers(diff);
  const spansOf = (file: string): LineRange[] => {
    const text = texts.get(file);
    if (ts === undefined || text === undefined) {
      return [];
    }
    return [
      ...(enclosingSpans(ts, file, text, hunks.get(file) ?? []) ?? []),
      ...orphanedExportSpans(ts, file, text, removed),
    ];
  };
  return planMutateRanges(
    files,
    hunks,
    (file) => countLines(texts.get(file) ?? ''),
    settings,
    spansOf,
  );
}
