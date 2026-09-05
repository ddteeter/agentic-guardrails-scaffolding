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

/** Mutant status → (rule id, message tail). Absent status = not a failure. */
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
    message: `${mutant.mutatorName} mutant ${failure.reason}`,
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    // Deliberately empty. Not-JSON-at-all and parsed-but-wrong-shape are the
    // same answer, and `isReport(undefined)` below already gives it — an
    // explicit `return false` here would be an equivalent mutant no test could
    // ever kill.
  }
  return isReport(parsed);
}

export function parseStrykerJson(
  reportJson: string,
  changedFiles: readonly string[],
): Violation[] {
  let parsed: unknown;
  // Equivalent mutants: emptying either block leaves `parsed` undefined, which
  // `isReport` rejects below — the function still returns []. A range directive
  // is used because `disable next-line` only attaches to a statement-LEADING
  // comment, and a `} catch {` line has none.
  // Stryker disable BlockStatement
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return [];
  }
  // Stryker restore BlockStatement
  if (!isReport(parsed)) {
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
