/**
 * fallow adapter: maps `fallow dupes --format json` output into `Violation[]`.
 *
 * fallow reports duplication as CLONE GROUPS — a set of two or more locations
 * sharing a normalized token sequence. That is the shape the whole analyzer
 * exists for: `eslint-plugin-sonarjs` ships `sonarjs/no-identical-functions`,
 * which reads as copy-paste coverage and is not, because ESLint is per-file. A
 * rule receives one file's AST at a time and holds no cross-file state, so two
 * identical functions in two files are invisible to it (measured both
 * directions — see issue #40).
 *
 * ## Diff scoping, and why it happens here
 *
 * A clone detector needs the WHOLE tree to find a pair, but must only REPORT
 * pairs where at least one side is in the diff — otherwise every commit
 * re-reports every pre-existing clone, which is the problem `--mode=commit`
 * already solves for the other analyzers.
 *
 * fallow implements exactly that in `--changed-since`, and it was measured
 * doing so. We nonetheless scope here rather than pass the flag, for three
 * reasons recorded in the design doc:
 *
 * 1. `verify` has TWO change sets — `changedScope: 'staged'` at the pre-commit
 *    rung, `'branch'` everywhere else. `--changed-since <ref>` can only express
 *    the branch one, so at the commit rung it would report clones the commit
 *    does not touch.
 * 2. The flag makes fallow re-derive the base with its own rules, which can
 *    disagree with `resolveBaseReference`'s `baseBranch` → `origin/baseBranch`
 *    fallback. One source of truth for "what changed" beats one saved filter.
 * 3. It keeps the scoping rule unit-testable without a git repository, and the
 *    invocation config-agnostic (see `runDupes`).
 *
 * A kept group emits a violation for EVERY instance, unchanged sides included.
 * A fixer shown only the changed half of a clone pair has no way to dedupe it.
 *
 * ## What is deliberately not read
 *
 * `stats.duplication_percentage` — fallow's own `--threshold` gate reads it,
 * and it is tempting to wire that to the `warn`/`block` model. It is not a
 * project metric under a diff-scoped run: measured at 71.4% on a two-file
 * fixture, because the denominator is the scoped file set. One violation per
 * clone instance is what the manifest, the recurrence tally and the fixer all
 * want anyway.
 *
 * Every violation is `fixable: false`: deduplication is a judgment — extract
 * when the behaviour should evolve together, leave it when the similarity is
 * accidental — never a silent autofix. fallow emits repo-relative POSIX paths
 * already, so no `path.relative` is applied.
 */

import { parseJsonText } from '../json-file.js';
import { isRecord } from './report-shape.js';
import type { Violation } from '../violation.js';

/** fallow's own rule id for a clone group, verbatim from its published
 *  `issue-registry.json`. Pinned by the drift guard in
 *  `test/drift/registry.test.ts` so an upstream rename fails the build rather
 *  than silently routing findings nowhere. */
const RULE_ID = 'fallow/code-duplication';

/** How many sibling locations one violation's message names before it stops.
 *  A clone group is normally 2–4 sites; a runaway group (a generated file
 *  matching itself dozens of times) must not become the whole manifest. */
const MAX_SIBLINGS_NAMED = 8;

interface CloneInstance {
  file: string;
  start_line: number;
}

interface CloneGroup {
  instances: CloneInstance[];
  line_count?: number;
}

function isCloneInstance(value: unknown): value is CloneInstance {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.start_line === 'number'
  );
}

/**
 * A group is usable only when EVERY instance parses. A partially-read group
 * would silently under-report the sites a fixer needs — the failure mode that
 * matters most here, since the whole value of a clone finding is knowing all
 * of its locations.
 */
function isCloneGroup(value: unknown): value is CloneGroup {
  return (
    isRecord(value) &&
    Array.isArray(value.instances) &&
    value.instances.every((instance) => isCloneInstance(instance))
  );
}

function isDupesReport(value: unknown): value is { clone_groups: unknown[] } {
  return isRecord(value) && Array.isArray(value.clone_groups);
}

function locationOf(instance: CloneInstance): string {
  return `${instance.file}:${instance.start_line}`;
}

/**
 * One violation per instance, each naming the OTHER sites in its group. The
 * message carries the decision criterion rather than an instruction, because
 * the right answer is genuinely "extract" or "leave it" depending on whether
 * the two copies should evolve together — and a fixer told only to deduplicate
 * will always deduplicate.
 */
function toViolations(group: CloneGroup): Violation[] {
  // `line_count` is documented but not depended on: a report that drops it
  // still yields an actionable violation, just without the size.
  const size =
    typeof group.line_count === 'number' ? ` (${group.line_count} lines)` : '';
  return group.instances.map((instance, position) => {
    // Sibling selection is BY INDEX, not by object identity. Two instances of
    // the same group can legitimately carry identical field values (the same
    // fragment at the same line of two files is not possible, but a defensive
    // identity filter would silently drop a real site if upstream ever
    // deduplicated its own objects), and an index is the one thing guaranteed
    // to distinguish "this instance" from "an equal one".
    const siblings = group.instances
      .filter((_, other) => other !== position)
      .slice(0, MAX_SIBLINGS_NAMED)
      .map((other) => locationOf(other))
      .join(', ');
    return {
      ruleId: RULE_ID,
      file: instance.file,
      line: instance.start_line,
      message:
        `Duplicated code${size}, also at ${siblings}. Extract the shared ` +
        `logic when the duplicated behaviour should evolve together; leave it ` +
        `duplicated when the similarity is accidental and likely to diverge.`,
      severity: 'error',
      fixable: false,
      tool: 'dupes',
    } satisfies Violation;
  });
}

/**
 * Parse a `fallow dupes --format json` report, keeping only clone groups with
 * at least one instance in `changedFiles`.
 *
 * `changedFiles` are repo-relative POSIX paths, matching what fallow emits, so
 * membership is a plain set lookup rather than a path comparison.
 */
export function parseFallowDupesJson(
  stdout: string,
  changedFiles: readonly string[],
): Violation[] {
  const { parsed } = parseJsonText(stdout);
  if (!isDupesReport(parsed)) {
    return [];
  }
  const changed = new Set(changedFiles);
  return parsed.clone_groups
    .filter((group) => isCloneGroup(group))
    .filter((group) =>
      group.instances.some((instance) => changed.has(instance.file)),
    )
    .flatMap((group) => toViolations(group));
}
