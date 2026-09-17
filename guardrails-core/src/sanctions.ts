/**
 * Sanction approval (§ "self-sanction"). `sanctionedSuppressions` is the one
 * escape hatch from the diff-auditor, so GRANTING one must not be something the
 * agent can do for itself. The check compares each key's TOTAL granted count
 * against the branch's merge-base: a key absent from the base entirely, or one
 * whose total count increased, is a new grant this branch introduces.
 *
 * It is deliberately enforced in **CI**, and deliberately never fails on a new
 * grant — the PR is where a human actually signs off, so merging the PR *is*
 * the approval, and a required check that failed on every legitimate approval
 * would deadlock the very merge that constitutes it. The check can only fail
 * on a MALFORMED entry (see `config.ts`'s `SanctionParseResult`); a new grant
 * is printed prominently instead, for the reviewer to see, and passes. The
 * gate itself (`runCommitGate` in `gate.ts`) is what enforces reality: an
 * occurrence beyond the declared `count` still blocks the commit regardless of
 * what this check says.
 *
 * An `approvedBy` provenance field was built and then removed on purpose. Local
 * git identity is writable by whatever is running — and is frequently a bot or a
 * placeholder (this repo's own worktree reads `Test <test@example.com>`), so the
 * field recorded a name that proved nothing and looked like a guarantee. The
 * `reason` text plus PR review carry the whole load instead.
 *
 * Comparing key TOTALS rather than diff lines also keeps the check precise:
 * reformatting the file, editing a `reason`, splitting one entry into several
 * that still sum to the same count, or REMOVING a grant are all legitimate
 * edits that must not read as a new grant.
 */

import { type AuditFinding, auditSource, findingKey } from './audit.js';
import type { SanctionedFile, SanctionedSuppression } from './config.js';
import type { Violation } from './violation.js';

/**
A sanction's occurrence budget: the declared `count`, defaulting to 1.
*/
function effectiveCount(sanction: SanctionedSuppression): number {
  return sanction.count ?? 1;
}

/** Sum every entry's effective count per key — several entries granting the
 * same key combine into one total, mirroring the gate's own budget math. */
function totalsByKey(
  sanctions: readonly SanctionedSuppression[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const sanction of sanctions) {
    totals.set(
      sanction.key,
      (totals.get(sanction.key) ?? 0) + effectiveCount(sanction),
    );
  }
  return totals;
}

/** One newly-approved exemption: a key absent from the base config, or a key
 * whose total granted count increased on this branch. */
export interface SanctionGrant {
  key: string;
  /**
  Total occurrence budget now granted for this key (all entries summed).
  */
  count: number;
  /**
  `reason` text of every entry granting this key, in config order.
  */
  reasons: readonly string[];
}

/**
 * Grants present in `head` that are new relative to `base`: a key whose total
 * count in `head` exceeds its total in `base` (zero when the key is absent
 * from `base` entirely).
 */
export function newlySanctioned(
  base: readonly SanctionedSuppression[],
  head: readonly SanctionedSuppression[],
): SanctionGrant[] {
  const baseTotals = totalsByKey(base);
  const headTotals = totalsByKey(head);
  const seenKeys = new Set<string>();
  const grants: SanctionGrant[] = [];
  for (const sanction of head) {
    if (seenKeys.has(sanction.key)) {
      continue;
    }
    seenKeys.add(sanction.key);
    const headCount = headTotals.get(sanction.key) ?? 0;
    const baseCount = baseTotals.get(sanction.key) ?? 0;
    if (headCount > baseCount) {
      grants.push({
        key: sanction.key,
        count: headCount,
        reasons: head
          .filter((entry) => entry.key === sanction.key)
          .map((entry) => entry.reason),
      });
    }
  }
  return grants;
}

/**
 * Identity of a path grant for the new-grant diff: the `(path, kind)` pair.
 *
 * Held in its own namespace rather than synthesised into a `path|kind|*` key
 * spliced into `totalsByKey`. A real finding's trimmed text could in principle
 * be `*`, and two grant namespaces that can collide is exactly the kind of
 * quiet aliasing an escape hatch must not have.
 */
function fileGrantKey(file: SanctionedFile): string {
  return `${file.path}|${file.kind}`;
}

/**
 * Path grants this branch introduces — a `(path, kind)` pair absent from the
 * base config.
 *
 * Reported for the same reason keyed grants are, and with more force: a path
 * grant covers every occurrence of its kind in its file, forever, with no count
 * bounding it. Review is its only safeguard (#39), so it must never land
 * silently.
 *
 * Rewording a `reason` is NOT a new grant — the same rule the keyed check
 * applies by comparing totals rather than text. Removing one is not either:
 * narrowing an exemption never needs approval.
 */
export function newlySanctionedFiles(
  base: readonly SanctionedFile[],
  head: readonly SanctionedFile[],
): SanctionedFile[] {
  const known = new Set(base.map((file) => fileGrantKey(file)));
  const seen = new Set<string>();
  const grants: SanctionedFile[] = [];
  for (const file of head) {
    const key = fileGrantKey(file);
    if (known.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    grants.push(file);
  }
  return grants;
}

/** Render newly-granted exemptions as report lines for the CI sanctions-check
 * to print — informational, never a blocking `Violation`: the human review
 * that approves a grant IS the pull-request merge, not this check. */
export function formatGrantReport(grants: readonly SanctionGrant[]): string[] {
  return grants.map(
    (grant) =>
      `  - ${grant.key} (count: ${grant.count}): ${grant.reasons.join('; ')}`,
  );
}

/** Map malformed `sanctionedSuppressions` entries in the head config to
 * blocking violations — the ONLY failure mode of the CI sanctions check. */
export function toMalformedViolations(
  malformed: readonly string[],
  configPath: string,
): Violation[] {
  return malformed.map((message) => ({
    ruleId: 'guardrails/malformed-sanction',
    file: configPath,
    message: `Malformed sanctionedSuppressions ${message}.`,
    severity: 'error' as const,
    fixable: false,
    tool: 'guardrails',
  }));
}

/**
One key whose declared budget no longer matches the source.
*/
export interface SanctionCountDrift {
  key: string;
  declared: number;
  actual: number;
}

/**
 * Compare each sanctioned key's declared budget against the occurrences that
 * actually exist in the source.
 *
 * `count` is hand-entered, and nothing re-checks it once written. A refactor
 * that deletes a suppressed call site without touching the policy file leaves
 * the budget over-provisioned: not exploitable (it cannot let a NEW suppression
 * through -- the gate still spends per occurrence) but it silently shrinks how
 * much the auditor is watching, which is the whole thing this hatch is supposed
 * to make visible.
 *
 * Occurrences are counted with `auditSource`, i.e. the auditor's own lexer and
 * signature table, so this can never disagree with the gate about what counts.
 * Reimplementing the match here would itself be a drift risk -- and a directive
 * that is a strict prefix of a wider one (`...ConditionalExpression` inside
 * `...ConditionalExpression,BlockStatement`) is exactly where naive substring
 * counting would go wrong.
 *
 * A file that cannot be read counts as zero occurrences, which is the deleted-
 * file case and should be reported, not skipped.
 */
/**
Group keys by the file they name, so each file is read and audited once.
*/
function groupKeysByFile(keys: Iterable<string>): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const key of keys) {
    const file = key.split('|', 1)[0] ?? '';
    const existing = byFile.get(file);
    // Push into the existing list rather than rebuilding from a `?? []`
    // default: the default-array form yields an equivalent mutant, this shape
    // does not.
    if (existing === undefined) {
      byFile.set(file, [key]);
    } else {
      existing.push(key);
    }
  }
  return byFile;
}

/**
Occurrences of each suppression key actually present in one file.
*/
function actualCounts(
  file: string,
  source: string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (source === undefined) {
    return counts;
  }
  for (const finding of auditSource(file, source)) {
    const key = findingKey(finding);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * `sanctionedFiles` grants are deliberately absent from this check.
 *
 * A path grant carries no count, so there is no number to drift — and that
 * absence IS the feature (#39): making an adopter re-derive a generated file's
 * occurrence count on every regeneration was the churn this whole grant form
 * exists to remove. Keyed grants in the same file keep their exact-count
 * discipline. Path grants are simply never passed in — an unread parameter
 * taken only to look explicit would carry an unkillable mutant on its default,
 * which is a worse way to document a decision than this sentence.
 */
export function sanctionCountDrift(
  sanctions: readonly SanctionedSuppression[],
  readSource: (file: string) => string | undefined,
): SanctionCountDrift[] {
  // `totalsByKey` is the same sum the new-grant diff uses; the drift check
  // and the approval report must agree on what a key is worth.
  const declared = totalsByKey(sanctions);
  const drift: SanctionCountDrift[] = [];
  for (const [file, keys] of groupKeysByFile(declared.keys())) {
    const actual = actualCounts(file, readSource(file));
    for (const key of keys) {
      const expected = declared.get(key) ?? 0;
      const found = actual.get(key) ?? 0;
      if (found !== expected) {
        drift.push({ key, declared: expected, actual: found });
      }
    }
  }
  return drift;
}

/**
 * PLACEMENT, not just count (#79).
 *
 * `count` proves a granted suppression still EXISTS. It proves nothing about
 * what the suppression still covers, and a Stryker directive's scope is set by
 * where it sits rather than by what it says. Both drifts happen without the
 * author touching the line: the formatter wraps the statement a `disable
 * next-line` names, or a later edit moves the statement a `restore` was
 * leading.
 *
 * The two directions are not equally dangerous:
 *
 * - DETACHED (the directive stops applying) fails CLOSED — the mutant comes
 *   back and the gate blocks. Confusing, not unsafe.
 * - OVER-EXTENDED (a `restore` that never binds) fails OPEN — the `disable`
 *   runs to END OF FILE and every mutant after it is silently ignored while
 *   the mutation score reads clean. The case `guidance/crushing-mutants.md`
 *   cites hid 21 mutants across four functions at a green score.
 *
 * So this checks the fail-open shape. It is deliberately the two MECHANICAL
 * rules, not a Stryker-semantics reimplementation:
 *
 *   1. a region `disable` (anything but `disable next-line`) must have a later
 *      `restore` in the same file that covers its mutators;
 *   2. a `restore` must be followed by something that can carry a statement.
 *
 * Directives are recovered with `auditSource` — the auditor's own lexer and
 * signature table — for the same reason `sanctionCountDrift` uses it: a second
 * parser here could disagree with the gate about what a directive even is. Only
 * files named by a `mutation-suppress` KEY are read; a file whose Stryker
 * directives are covered by a whole-file `sanctionedFiles` grant names no key,
 * so a deliberate file-scoped disable is never read and never reported.
 */
type SanctionPlacementProblem = 'unclosed-disable' | 'unbound-restore';

export interface SanctionPlacementIssue {
  file: string;
  /**
  1-indexed line of the misplaced directive.
  */
  line: number;
  /**
  The directive line, trimmed — the same text its sanction key carries.
  */
  text: string;
  problem: SanctionPlacementProblem;
  /**
  What the misplacement actually costs, in the reviewer's terms.
  */
  detail: string;
}

/**
One Stryker directive, recovered from a `mutation-suppress` finding.
*/
interface StrykerDirective {
  line: number;
  text: string;
  isDisable: boolean;
  isNextLine: boolean;
  /**
  Mutator names the directive lists; `['all']` for the blanket form.
  */
  mutators: readonly string[];
}

const STRYKER = 'Stryker';
const DISABLE = 'disable';
const NEXT_LINE = 'next-line';
const ALL_MUTATORS = 'all';

/**
 * Split a directive line into words, on BOTH commas and spaces, dropping the
 * empties that irregular spacing (`A,  B`) leaves behind.
 *
 * Tokenised rather than matched with a regex, and that is a mutation-gate
 * decision rather than a style one. Every regex spelling of this grammar
 * carried a provably EQUIVALENT `\s+` → `\s` mutant: the mutator-list
 * character class has to admit whitespace (mutators may be written `A, B`),
 * and once it does, whatever whitespace a narrowed quantifier fails to consume
 * is simply absorbed by the class and trimmed away again — no input can tell
 * the two apart. A mutant avoided costs nothing, where a mutant suppressed
 * costs a sanction that has to be justified forever (the same reasoning as
 * `CommitGateOptions.sessionId` in gate.ts).
 */
function directiveWords(text: string): string[] {
  return text
    .split(',')
    .flatMap((part) => part.split(' '))
    .filter((word) => word.length > 0);
}

/**
 * Read one directive out of a `mutation-suppress` finding.
 *
 * TOTAL, deliberately: the auditor's own signature (`^Stryker\s+(?:disable|
 * restore)\b` against a comment's content) is what produced this finding, so
 * the word after `Stryker` is always `disable` or `restore`. A defensive
 * "unparseable" branch here would be unreachable by construction, i.e. an
 * equivalent mutant with a guard wrapped around it.
 *
 * `next-line` stays IN `mutators` rather than being sliced out. Stripping it
 * would be unobservable — a `next-line` directive's mutator list is never
 * consulted, since only region disables are matched against a `restore` — and
 * an unobservable statement is an equivalent mutant waiting to happen.
 */
function parseDirective(finding: AuditFinding): StrykerDirective {
  const words = directiveWords(finding.text);
  const [action, ...mutators] = words.slice(words.indexOf(STRYKER) + 1);
  return {
    line: finding.line,
    text: finding.text,
    isDisable: action === DISABLE,
    isNextLine: mutators.includes(NEXT_LINE),
    mutators,
  };
}

/**
 * Every Stryker directive in one file, in source order.
 *
 * A comment naming NO mutator (`// Stryker disable`, with no list and no
 * `all`) is dropped. The auditor's signature stops at `disable`/`restore`, but
 * stryker's own parser requires a mutator list, so such a comment silences
 * nothing — reporting it as a region running to end of file would be a
 * blocking false positive about a directive that is already inert.
 */
function directivesIn(file: string, source: string): StrykerDirective[] {
  return auditSource(file, source)
    .filter((finding) => finding.kind === 'mutation-suppress')
    .map((finding) => parseDirective(finding))
    .filter((directive) => directive.mutators.length > 0);
}

/**
 * Does `restore` close `disable`? `restore all` closes anything; otherwise the
 * restore must name every mutator the disable named — a narrower restore leaves
 * the remainder disabled to end of file, which is the fail-open in miniature.
 */
function isClosedBy(
  disable: StrykerDirective,
  restore: StrykerDirective,
): boolean {
  return (
    restore.mutators.includes(ALL_MUTATORS) ||
    disable.mutators.every((mutator) => restore.mutators.includes(mutator))
  );
}

/**
Files a `mutation-suppress` grant names, in config order, each once.
*/
function mutationSuppressFiles(
  sanctions: readonly SanctionedSuppression[],
): string[] {
  const files: string[] = [];
  for (const sanction of sanctions) {
    // `split` always returns at least one element, so `file` can never
    // actually be `undefined` at runtime -- only its TYPE says so, because
    // `noUncheckedIndexedAccess` cannot see that guarantee. The default
    // removes the type uncertainty without adding a runtime check a mutation
    // test could never distinguish from `if (true)` (see plan.ts's identical
    // comment on `noUncheckedIndexedAccess` equivalent mutants).
    const [file = '', kind] = sanction.key.split('|', 2);
    if (kind !== 'mutation-suppress' || files.includes(file)) {
      continue;
    }
    files.push(file);
  }
  return files;
}

function unclosedDisables(
  file: string,
  directives: readonly StrykerDirective[],
  lineCount: number,
): SanctionPlacementIssue[] {
  const issues: SanctionPlacementIssue[] = [];
  for (const [index, directive] of directives.entries()) {
    if (!directive.isDisable || directive.isNextLine) {
      continue;
    }
    const isClosed = directives
      .slice(index + 1)
      .some((later) => !later.isDisable && isClosedBy(directive, later));
    if (!isClosed) {
      issues.push({
        file,
        line: directive.line,
        text: directive.text,
        problem: 'unclosed-disable',
        detail: `covers lines ${directive.line}-${lineCount}, to end of file`,
      });
    }
  }
  return issues;
}

/**
 * A line that cannot be the statement a directive binds to: blank, or a
 * comment. Comments are SKIPPED rather than treated as the binding target —
 * Stryker attaches a directive to the next node, and an explanatory comment
 * between a restore and its statement does not break that.
 */
function isSkippableLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  );
}

/**
 * Block/paren closers and clause continuations — none of which is a statement,
 * so a directive sitting immediately before one attaches to nothing.
 */
const BINDS_TO_NOTHING = /^(?:[)\]}]|else\b|catch\b|finally\b)/;

/**
The next line that could carry a statement, after the 1-indexed `line`.
*/
function nextCodeLine(
  lines: readonly string[],
  line: number,
): string | undefined {
  // `slice` + `find` rather than a manual index loop: `readonly string[]`
  // elements are never sparse, so `find` needs no `candidate !== undefined`
  // guard the way an indexed loop would under `noUncheckedIndexedAccess` --
  // removing the manual bound removes the equivalent mutant that guard would
  // otherwise carry, rather than suppressing it.
  const candidate = lines.slice(line).find((entry) => !isSkippableLine(entry));
  return candidate === undefined ? undefined : candidate.trim();
}

const RUNS_TO_EOF =
  'so this restore attaches to nothing and its disable runs to end of file';

function unboundRestores(
  file: string,
  directives: readonly StrykerDirective[],
  lines: readonly string[],
): SanctionPlacementIssue[] {
  const issues: SanctionPlacementIssue[] = [];
  for (const directive of directives) {
    if (directive.isDisable) {
      continue;
    }
    const next = nextCodeLine(lines, directive.line);
    if (next !== undefined && !BINDS_TO_NOTHING.test(next)) {
      continue;
    }
    issues.push({
      file,
      line: directive.line,
      text: directive.text,
      problem: 'unbound-restore',
      detail:
        next === undefined
          ? `nothing follows it before end of file, ${RUNS_TO_EOF}`
          : `the next code line is \`${next}\`, ${RUNS_TO_EOF}`,
    });
  }
  return issues;
}

/**
 * Misplaced Stryker directives among the granted `mutation-suppress` entries.
 *
 * A file that cannot be read yields nothing: a deleted file is already
 * `sanctionCountDrift`'s finding, and reporting it twice would make one defect
 * read as two.
 */
export function sanctionPlacementIssues(
  sanctions: readonly SanctionedSuppression[],
  readSource: (file: string) => string | undefined,
): SanctionPlacementIssue[] {
  const issues: SanctionPlacementIssue[] = [];
  for (const file of mutationSuppressFiles(sanctions)) {
    const source = readSource(file);
    if (source === undefined) {
      continue;
    }
    const lines = source.split('\n');
    const directives = directivesIn(file, source);
    issues.push(
      ...unclosedDisables(file, directives, lines.length),
      ...unboundRestores(file, directives, lines),
    );
  }
  return issues;
}
