/**
 * fallow adapter: maps `fallow dupes --format json` and `fallow health
 * --complexity --format json` output into `Violation[]`. The complexity half is
 * documented at its own section below; this header covers dupes.
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

/*
 * ---------------------------------------------------------------------------
 * `fallow health --complexity --format json`
 * ---------------------------------------------------------------------------
 *
 * Function-level complexity against the adopter's own fallow thresholds
 * (`max_cyclomatic_threshold` / `max_cognitive_threshold`). This exists
 * because `sonarjs/cognitive-complexity` at the same limit counts differently:
 * in #122 a commit took `runCommitGate` to cognitive 16, every commit gate
 * passed, and only the pre-push `fallow health` failed — a full push cycle
 * lost to a check that could have run at commit.
 *
 * Only the cyclomatic and cognitive halves are reported. CRAP needs FRESH
 * coverage, which the commit rung does not have (fallow estimates it, or reads
 * a stale `coverage-final.json`), so a `crap`-only finding is dropped and the
 * `*_crap` values report just their complexity part. CRAP stays a pre-push / CI
 * concern.
 *
 * Diff scoping is the same file-level rule as dupes: a finding is kept when its
 * `path` is in the changed set. A touched file's pre-existing over-limit
 * function is therefore reported too, exactly as ESLint does at commit.
 */

/** `exceeded` → rule id, verbatim from fallow's `issue-registry.json` and
 *  pinned by the drift guard. A Map, not an object literal, so an `exceeded`
 *  value that happens to be a prototype key (`constructor`) cannot resolve. */
const COMPLEXITY_RULE_IDS: ReadonlyMap<string, string> = new Map([
  ['cyclomatic', 'fallow/high-cyclomatic-complexity'],
  ['cyclomatic_crap', 'fallow/high-cyclomatic-complexity'],
  ['cognitive', 'fallow/high-cognitive-complexity'],
  ['cognitive_crap', 'fallow/high-cognitive-complexity'],
  ['both', 'fallow/high-complexity'],
  ['all', 'fallow/high-complexity'],
]);

interface HealthFinding {
  path: string;
  name: string;
  line: number;
  cyclomatic: number;
  cognitive: number;
  exceeded: string;
}

interface HealthThresholds {
  max_cyclomatic_threshold: number;
  max_cognitive_threshold: number;
}

interface HealthReport {
  findings: unknown[];
  summary: HealthThresholds;
}

const FINDING_STRING_FIELDS = ['path', 'name', 'exceeded'] as const;
const FINDING_NUMBER_FIELDS = ['line', 'cyclomatic', 'cognitive'] as const;

/**
 * The finding guard checks its fields as two lists rather than six inline
 * clauses, for a mutation-testing reason. Inline, `typeof path === 'string'`
 * and `typeof exceeded === 'string'` are EQUIVALENT mutants: a non-string
 * `path` fails the changed-set lookup and a non-string `exceeded` fails the
 * rule-id lookup, so removing either check changes nothing observable. As
 * list entries they share one predicate with `name`, whose check nothing
 * downstream repeats — so every mutant here is killable and none needs a
 * sanctioned exemption.
 */
function isHealthFinding(value: unknown): value is HealthFinding {
  return (
    isRecord(value) &&
    FINDING_STRING_FIELDS.every((field) => typeof value[field] === 'string') &&
    FINDING_NUMBER_FIELDS.every((field) => typeof value[field] === 'number')
  );
}

/**
 * The thresholds are part of the report's shape, not decoration: the message
 * states them, and a report without them is not one this adapter knows how to
 * read. Rejecting it makes the runner report analyzer-failed on a schema
 * change rather than read it as a clean tree.
 */
function isHealthReport(value: unknown): value is HealthReport {
  return (
    isRecord(value) &&
    Array.isArray(value.findings) &&
    isRecord(value.summary) &&
    typeof value.summary.max_cyclomatic_threshold === 'number' &&
    typeof value.summary.max_cognitive_threshold === 'number'
  );
}

function toComplexityViolation(
  finding: HealthFinding,
  ruleId: string,
  thresholds: HealthThresholds,
): Violation {
  return {
    ruleId,
    file: finding.path,
    line: finding.line,
    message:
      `\`${finding.name}\` is over the complexity threshold: cyclomatic ` +
      `${finding.cyclomatic} (limit ${thresholds.max_cyclomatic_threshold}), ` +
      `cognitive ${finding.cognitive} (limit ` +
      `${thresholds.max_cognitive_threshold}). Extract helper functions to ` +
      `split it; do not suppress it with a fallow-ignore comment.`,
    severity: 'error',
    fixable: false,
    tool: 'complexity',
  };
}

/**
 * Parse a `fallow health --complexity --format json` report, keeping only
 * cyclomatic/cognitive findings in `changedFiles`.
 *
 * `isReport` says whether stdout was a health report at all, independent of
 * whether anything survived the filter. fallow exits 1 whenever it has ANY
 * finding — including CRAP-only and out-of-diff ones this drops — so the
 * runner needs "it parsed" rather than "it produced violations" to tell a
 * finding-bearing run from a crash.
 */
export function parseFallowHealthJson(
  stdout: string,
  changedFiles: readonly string[],
): { violations: Violation[]; isReport: boolean } {
  const { parsed } = parseJsonText(stdout);
  if (!isHealthReport(parsed)) {
    return { violations: [], isReport: false };
  }
  const changed = new Set(changedFiles);
  const violations = parsed.findings
    .filter((finding) => isHealthFinding(finding))
    .filter((finding) => changed.has(finding.path))
    .flatMap((finding) => {
      const ruleId = COMPLEXITY_RULE_IDS.get(finding.exceeded);
      return ruleId === undefined
        ? []
        : [toComplexityViolation(finding, ruleId, parsed.summary)];
    });
  return { violations, isReport: true };
}
