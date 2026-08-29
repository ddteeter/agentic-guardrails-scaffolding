/**
 * stryker adapter: maps a `mutation-testing-elements` report into `Violation[]`.
 *
 * Emits one violation per **Survived** mutant whose file is in the changed-file
 * set — a surviving mutant in changed code means a test executes the line but
 * doesn't assert its behavior. `Killed`/`Timeout` are good; `NoCoverage` is left
 * to the coverage gate; `Ignored`/`Pending`/`CompileError`/`RuntimeError` are
 * non-signal. Every violation is `fixable: false`: the fix is a judgment
 * (strengthen a test, or exclude an equivalent mutant), never a silent autofix.
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

function survivorViolation(
  file: string,
  mutant: StrykerMutant,
  packageId?: string,
): Violation {
  return {
    ruleId: 'stryker/survived',
    file,
    line: mutant.location.start.line,
    message: `${mutant.mutatorName} mutant survived — a test executes this line but does not assert its behavior`,
    severity: 'error',
    fixable: false,
    tool: 'stryker',
    ...(packageId === undefined ? {} : { package: packageId }),
  };
}

export function parseStrykerJson(
  reportJson: string,
  changedFiles: readonly string[],
  packageId?: string,
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
      if (mutant.status === 'Survived') {
        violations.push(survivorViolation(file, mutant, packageId));
      }
    }
  }
  return violations;
}
