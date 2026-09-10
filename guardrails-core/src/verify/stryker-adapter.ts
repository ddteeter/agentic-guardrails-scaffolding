/**
 * stryker adapter: maps a `mutation-testing-elements` report into `Violation[]`.
 *
 * Emits one violation per **failing** mutant whose file is in the changed-file
 * set, in two classes:
 *
 * - `Survived` — a test executes the line but does not assert its behavior.
 * - `NoCoverage` — no test executes the line at all. Stryker does not run these
 *   (no covering test could fail), so they are reported by status rather than
 *   by outcome. This is the STRICTER failure of the two, and it was previously
 *   discarded here on the stated grounds that a coverage gate would catch it.
 *   No such gate exists in this project or in a consumer repo: `NoCoverage`
 *   went unreported by everything. It is reported here because mutation already
 *   locates it per-line and diff-scoped, which a coverage percentage — an
 *   aggregate that permits any individual line to be uncovered — does not.
 *
 * `Killed`/`Timeout` are good; `Ignored`/`Pending`/`CompileError`/`RuntimeError`
 * are non-signal. Every violation is `fixable: false`: the fix is a judgment
 * (write a covering test, strengthen an existing one, or exclude an equivalent
 * mutant), never a silent autofix. The two classes carry distinct rule ids
 * because their remedies differ, and the fixer routes on rule id.
 * Stryker emits repo-relative paths already, matching the git-diff file list.
 */

import type { Violation } from '../violation.js';

interface StrykerMutant {
  status: string;
  mutatorName: string;
  location: { start: { line: number } };
  /** Test ids stryker determined cover this mutant. Absent in reports from
   *  runners that provide no per-test data. */
  coveredBy?: string[];
  /** How many tests actually EXECUTED during this mutant's run. The field that
   *  separates "the tests ran and none failed" from "no test ran at all". */
  testsCompleted?: number;
  /** What the mutant substituted for the original code. Optional in the
   *  schema — a runner may omit it. See `mutationDetail`. */
  replacement?: unknown;
}

/** How much of a mutant's replacement reaches the message. A BlockStatement
 *  mutant's replacement can be a whole function body, and the manifest is the
 *  fixer's context budget — one mutant must not consume it. */
const REPLACEMENT_CHARS = 80;

/**
 * The mutation itself, rendered for the message — or `''` when the report does
 * not say.
 *
 * Reported from a real adoption (#49): the fixer that resolves a surviving
 * mutant has Read/Edit/Write and cannot run stryker, so it writes assertions
 * BLIND. In that session it reported eight mutants addressed and several were
 * still alive on the re-run.
 *
 * Stryker's report already carries what each mutant replaced the code with,
 * and this adapter parsed the field and threw it away. Carrying it through
 * turns "assert something about this line" into "assert the thing that
 * distinguishes it from this value" — at no cost to the scope-lock, which is
 * the alternative that was considered and rejected: letting the fixer execute
 * things would weaken the one property that makes "never trust the fixer"
 * enforceable.
 *
 * Validated as a string rather than trusted: this is JSON off disk, like every
 * other field here. Newlines are collapsed because violations render one per
 * line in both the manifest and the gate's dump.
 */
function mutationDetail(replacement: unknown): string {
  if (typeof replacement !== 'string' || replacement.trim() === '') {
    return '';
  }
  const flattened = replacement.replaceAll(/\s+/g, ' ').trim();
  const shown =
    flattened.length > REPLACEMENT_CHARS
      ? `${flattened.slice(0, REPLACEMENT_CHARS)}…`
      : flattened;
  // Leading `. ` because neither `FAILURES` reason ends in punctuation: without
  // it the message reads "...does not assert its behavior It replaced...".
  return `. It replaced the code with \`${shown}\`.`;
}

interface StrykerFile {
  mutants: StrykerMutant[];
}

function isMutant(value: unknown): value is StrykerMutant {
  // Equivalent mutant: dropping the `typeof value !== 'object'` half lets a
  // primitive through, but the field checks below reject it anyway
  // (`'str'.status` is undefined). Kept as an explicit precondition.
  // Stryker disable next-line ConditionalExpression
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const mutant = value as Record<string, unknown>;
  const start = (mutant.location as { start?: { line?: unknown } } | undefined)
    ?.start;
  return (
    typeof mutant.status === 'string' &&
    typeof mutant.mutatorName === 'string' &&
    typeof start?.line === 'number'
  );
}

function isReport(
  value: unknown,
): value is { files: Record<string, StrykerFile> } {
  // Equivalent mutant: as in isMutant, a primitive that slips past this half is
  // rejected below — `(5).files` is undefined, which fails the `files` check.
  // Stryker disable next-line ConditionalExpression
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const files = (value as { files?: unknown }).files;
  // Equivalent mutant: a non-object `files` (e.g. the string "nope") still fails
  // the per-entry `.every` below, so dropping this half changes no outcome.
  // Stryker disable next-line ConditionalExpression
  if (typeof files !== 'object' || files === null) {
    return false;
  }
  return Object.values(files).every(
    // Equivalent mutant on `typeof file === 'object'`: no JSON primitive can
    // carry an array `mutants` property, so the Array.isArray check below
    // rejects every value this half would have caught.
    (file) =>
      // Stryker disable next-line ConditionalExpression
      typeof file === 'object' &&
      file !== null &&
      Array.isArray((file as StrykerFile).mutants) &&
      (file as StrykerFile).mutants.every((mutant) => isMutant(mutant)),
  );
}

/**
Mutant status → (rule id, message tail). Absent status = not a failure.
*/
const FAILING_STATUSES: Record<string, { ruleId: string; reason: string }> = {
  Survived: {
    ruleId: 'stryker/survived',
    reason:
      'survived — a test executes this line but does not assert its behavior',
  },
  NoCoverage: {
    ruleId: 'stryker/no-coverage',
    reason: 'was never executed — no test covers this line',
  },
};

function failureViolation(
  file: string,
  mutant: StrykerMutant,
  failure: { ruleId: string; reason: string },
): Violation {
  return {
    ruleId: failure.ruleId,
    file,
    line: mutant.location.start.line,
    message:
      `${mutant.mutatorName} mutant ${failure.reason}` +
      mutationDetail(mutant.replacement),
    severity: 'error',
    fixable: false,
    tool: 'stryker',
  };
}

/**
 * Does this payload parse as a stryker mutation report?
 *
 * `parseStrykerJson` answers "[] findings" for a malformed payload and for a
 * genuinely empty report alike, which is the right shape for its caller but
 * cannot distinguish "the run completed and found nothing" from "this file is
 * not a report". `runStryker` needs exactly that distinction to tell a
 * completed-but-non-zero run (a `break` threshold) from a crash.
 */
export function isStrykerReportJson(reportJson: string): boolean {
  return parseReport(reportJson) !== undefined;
}

/**
 * The one place this module turns a payload into a report, shared by all three
 * public entry points.
 *
 * Shared rather than repeated because the `try`/`catch` carries a sanctioned
 * equivalent-mutant directive: emptying either block leaves `parsed`
 * undefined, which `isReport` rejects anyway, so no test can tell the
 * difference. One copy is one sanctioned line; a second copy would have been a
 * second, for no new behaviour.
 */
function parseReport(
  reportJson: string,
): { files: Record<string, StrykerFile> } | undefined {
  let parsed: unknown;
  // A range directive is used because `disable next-line` only attaches to a
  // statement-LEADING comment, and a `} catch {` line has none.
  // Stryker disable BlockStatement
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return undefined;
  }
  // Stryker restore BlockStatement
  if (!isReport(parsed)) {
    return undefined;
  }
  return parsed;
}

export function parseStrykerJson(
  reportJson: string,
  changedFiles: readonly string[],
): Violation[] {
  const parsed = parseReport(reportJson);
  if (parsed === undefined) {
    return [];
  }
  const changed = new Set(changedFiles);
  const violations: Violation[] = [];
  for (const [file, fileResult] of Object.entries(parsed.files)) {
    if (!changed.has(file)) {
      continue;
    }
    for (const mutant of fileResult.mutants) {
      const failure = FAILING_STATUSES[mutant.status];
      if (failure !== undefined) {
        violations.push(failureViolation(file, mutant, failure));
      }
    }
  }
  return violations;
}

/**
 * Is this mutant's `Survived` verdict unsupported by any test execution?
 *
 * Written as three separate answers rather than one `&&` chain on purpose. Each
 * clause rules out a different, individually-tested shape, and stryker's
 * per-test coverage attributes a sequence of early returns to the tests that
 * actually reach each one — a three-clause condition on one line gets
 * attributed as a unit, which is how a mutant on its middle clause survives
 * against tests that do kill it.
 */
function isUnrunSurvivor(mutant: StrykerMutant): boolean {
  if (mutant.status !== 'Survived') {
    return false;
  }
  const covering = mutant.coveredBy?.length ?? 0;
  if (covering === 0) {
    return false;
  }
  return (mutant.testsCompleted ?? 0) === 0;
}

/**
 * How many mutants in the changed set were reported `Survived` without a single
 * covering test having run?
 *
 * A `Survived` verdict means "every covering test executed and none failed". If
 * `coveredBy` is non-empty and `testsCompleted` is zero, the second half never
 * happened: the runner returned an unexamined default, and the verdict is not
 * evidence of anything. `@stryker-mutator/vitest-runner` does exactly this on
 * vitest 5 (stryker-js#6210 — the per-test name filter stopped matching, so
 * every mutant run executes nothing), and has three more open bugs in the same
 * family. Upstream proposes the same invariant for itself in #6146.
 *
 * `NoCoverage` is deliberately excluded: running no tests is what that status
 * MEANS, and it is reported on its own merits by `parseStrykerJson`.
 *
 * A missing `testsCompleted` counts as unrun. Every runner that reports a
 * `Survived` mutant it actually exercised emits the field; treating its absence
 * as "probably fine" would fail open on precisely the malformed report this
 * guard exists to catch.
 */
export function unrunSurvivedMutants(
  reportJson: string,
  changedFiles: readonly string[],
): number {
  const parsed = parseReport(reportJson);
  if (parsed === undefined) {
    return 0;
  }
  const changed = new Set(changedFiles);
  let count = 0;
  for (const [file, fileResult] of Object.entries(parsed.files)) {
    if (!changed.has(file)) {
      continue;
    }
    count += fileResult.mutants.filter((mutant) =>
      isUnrunSurvivor(mutant),
    ).length;
  }
  return count;
}

/**
 * May stryker's incremental cache from a previous run be kept for this one?
 *
 * `--incremental` is only worth anything if the cache it reads survives from
 * the previous run, and `runStryker` used to delete that file immediately
 * before passing the flag — so every gate run was a cold one and the flag's
 * only effect was writing a file the next run deleted (#59). Deleting was not a
 * stray line: an unconditionally kept cache is genuinely unsafe here, in two
 * ways this predicate is the guard against. The fix is to make the deletion
 * conditional rather than to drop either half.
 *
 * Reuse is granted only on evidence in the cache itself, never on what the
 * consumer's config claims:
 *
 * 1. **Scope.** Every file in the cache must be one this run mutates. Stryker
 *    folds cached verdicts for out-of-scope files back into the report it
 *    writes (`incremental-differ`'s "old mutants that didn't run this time
 *    around aren't forgotten" branch), so a cache written for some other
 *    `--mutate` set carries results this run never checked. Subset, not
 *    equality: a run whose scope has GROWN reuses what it can and mutates the
 *    rest cold, which is the whole point.
 * 2. **Per-test coverage.** At least one mutant must name a covering test.
 *    A cache with no `coveredBy` anywhere was written by a runner that reports
 *    no per-test data, and stryker's `mutantCanBeReused` then returns `true`
 *    before examining anything — a `Survived` verdict is reused however the
 *    tests changed, so the fixer's new test can never clear the mutant and the
 *    loop can never go green. Measured against stryker 10: under the `command`
 *    runner (the one `STRYKER_SEED` ships) a strengthened test left the
 *    survivor standing, 14 of 14 mutants reused.
 *
 * Rule 2 is only HALF of the coverage question, and both halves are needed.
 * It looks at the cache, so it establishes only that the run which WROTE the
 * file had per-test data; `hasCoverage` is read from the run about to consume
 * it. The other half — will THIS run be able to tell — is
 * `canReportPerTestCoverage`, which decides from the config this run will use
 * and which the caller checks first. A repo that switches runners fails only
 * the second; a repo that has always been coverage-blind fails only the first.
 *
 * Neither rule keys on `coverageAnalysis`, which was measured not to
 * discriminate: the vitest runner writes `coveredBy` and re-runs the survivor
 * under `off` and `all` just as under `perTest`.
 *
 * A cache that is missing, unparseable, or not a report reads as `''` and is
 * rejected by the same path — fail toward the cold run, as everywhere else in
 * this module.
 *
 * What this does NOT promise is that a reused verdict is more trustworthy than
 * the cold run it replaces: a cache written by a hand-run
 * `npx stryker run --mutate <one file>` can satisfy both rules, and the vitest
 * runner's `related` test selection makes such a run over-report survivors
 * (plan.md, "Cache poisoning"). It answers only what it can: this cache is
 * about this run's files, and stryker's own invalidation rules have the
 * coverage data they need to run.
 */
export function canReuseIncrementalCache(
  cacheJson: string,
  mutateFiles: readonly string[],
): boolean {
  const parsed = parseReport(cacheJson);
  if (parsed === undefined) {
    return false;
  }
  const mutated = new Set(mutateFiles);
  const entries = Object.entries(parsed.files);
  if (entries.some(([file]) => !mutated.has(file))) {
    return false;
  }
  return entries.some(([, fileResult]) =>
    fileResult.mutants.some((mutant) => (mutant.coveredBy?.length ?? 0) > 0),
  );
}
