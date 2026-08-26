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
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const files = (value as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null) {
    return false;
  }
  return Object.values(files).every(
    (file) =>
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
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return [];
  }
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
