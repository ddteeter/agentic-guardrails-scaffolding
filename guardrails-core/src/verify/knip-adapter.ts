/**
 * knip adapter: maps `knip --reporter json` output into `Violation[]`.
 *
 * knip reports whole-graph dead code grouped by file. Each issue object carries
 * a fixed set of issue-type keys; this adapter maps the nine uniform
 * `{ name, line?, col? }`-shaped types. The four nested/non-uniform types
 * (`duplicates`, `enumMembers`, `namespaceMembers`, `catalog`) are intentionally
 * not mapped in this first cut — a documented follow-up.
 *
 * Every knip violation is `fixable: false`: knip's own `--fix` DELETES code, and
 * dead-code removal is a maybe-live judgment, never a silent autofix. knip emits
 * repo-relative paths already, so no `path.relative` is applied.
 */

import type { Violation } from '../violation.js';

/** The uniform issue types mapped in this cut, and their human labels. */
const MAPPED_ISSUE_TYPES: Record<string, string> = {
  files: 'file',
  exports: 'export',
  types: 'type',
  dependencies: 'dependency',
  devDependencies: 'devDependency',
  optionalPeerDependencies: 'optional peer dependency',
  unlisted: 'unlisted dependency',
  unresolved: 'unresolved import',
  binaries: 'unlisted binary',
};

interface KnipEntry {
  name: string;
  line?: number;
}

interface KnipIssue {
  file: string;
  [issueType: string]: unknown;
}

function isKnipReport(value: unknown): value is { issues: KnipIssue[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    (value as { issues: unknown[] }).issues.every(
      (issue) =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof (issue as KnipIssue).file === 'string',
    )
  );
}

function isEntryArray(value: unknown): value is KnipEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as KnipEntry).name === 'string',
    )
  );
}

/** Map one knip issue-type entry to a normalized violation. */
function toViolation(
  issueType: string,
  label: string,
  entry: KnipEntry,
  file: string,
  packageId?: string,
): Violation {
  const message =
    issueType === 'files' ? 'Unused file' : `Unused ${label}: ${entry.name}`;
  return {
    ruleId: `knip/${issueType}`,
    file,
    message,
    severity: 'error',
    fixable: false,
    tool: 'knip',
    ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
    ...(packageId === undefined ? {} : { package: packageId }),
  };
}

/** Expand one file's issue object into its mapped violations. */
function violationsForIssue(issue: KnipIssue, packageId?: string): Violation[] {
  const violations: Violation[] = [];
  for (const [issueType, label] of Object.entries(MAPPED_ISSUE_TYPES)) {
    const entries = issue[issueType];
    if (!isEntryArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      violations.push(
        toViolation(issueType, label, entry, issue.file, packageId),
      );
    }
  }
  return violations;
}

export function parseKnipJson(
  stdout: string,
  _repoRoot: string,
  packageId?: string,
): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isKnipReport(parsed)) {
    return [];
  }
  return parsed.issues.flatMap((issue) => violationsForIssue(issue, packageId));
}
