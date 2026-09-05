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

/**
The uniform issue types mapped in this cut, and their human labels.
*/
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
    // `value !== null` leads (not `typeof value === 'object'`) so the
    // equivalent mutant below sits on its own line: Stryker's disable
    // comments match by mutator + line, and the leftmost clause of a chain
    // always shares its start line with every combined-clause mutant on that
    // chain, so a directive there would silence real coverage too (measured;
    // see guardrails.config.json).
    value !== null &&
    // Equivalent mutant: no value JSON.parse can produce is both non-object
    // and carries an array `issues` property, so this clause can never be
    // false while the one below it is true.
    // Stryker disable next-line ConditionalExpression
    typeof value === 'object' &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    (value as { issues: unknown[] }).issues.every(
      (issue) =>
        // Same reordering, same reason as above, one level down.
        issue !== null &&
        // Equivalent mutant: no value JSON.parse can produce is both
        // non-object and carries a string `file` property.
        // Stryker disable next-line ConditionalExpression
        typeof issue === 'object' &&
        typeof (issue as KnipIssue).file === 'string',
    )
  );
}

function isEntryArray(value: unknown): value is KnipEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        // Same reordering, same reason as isKnipReport above.
        entry !== null &&
        // Equivalent mutant: no value JSON.parse can produce is both
        // non-object and carries a string `name` property.
        // Stryker disable next-line ConditionalExpression
        typeof entry === 'object' &&
        typeof (entry as KnipEntry).name === 'string',
    )
  );
}

/**
Map one knip issue-type entry to a normalized violation.
*/
function toViolation(
  issueType: string,
  label: string,
  entry: KnipEntry,
  file: string,
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
    ...(typeof entry.line === 'number' && { line: entry.line }),
  };
}

/**
Expand one file's issue object into its mapped violations.
*/
function violationsForIssue(issue: KnipIssue): Violation[] {
  const violations: Violation[] = [];
  for (const [issueType, label] of Object.entries(MAPPED_ISSUE_TYPES)) {
    const entries = issue[issueType];
    if (!isEntryArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      violations.push(toViolation(issueType, label, entry, issue.file));
    }
  }
  return violations;
}

export function parseKnipJson(stdout: string, _repoRoot: string): Violation[] {
  let parsed: unknown;
  // prettier-ignore
  try {
    parsed = JSON.parse(stdout);
  }
  // Equivalent mutant: emptying the catch body leaves `parsed` undefined
  // (the try body's assignment never lands on a throw), which isKnipReport
  // rejects below — the function still returns []. `catch` is forced onto
  // its own line (prettier-ignore keeps it there) so this directive's line
  // matches only the catch block, not the try block above it: the try
  // block's own BlockStatement mutant is real (measured) — it silently
  // drops every value on ANY input, valid or not, which the happy-path
  // tests catch — so it must stay mutated.
  // Stryker disable next-line BlockStatement
  catch {
    return [];
  }
  if (!isKnipReport(parsed)) {
    return [];
  }
  return parsed.issues.flatMap((issue) => violationsForIssue(issue));
}
