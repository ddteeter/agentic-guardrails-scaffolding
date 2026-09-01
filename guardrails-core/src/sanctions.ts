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

import { auditSource, findingKey } from './audit.js';
import type { SanctionedSuppression } from './config.js';
import type { Violation } from './violation.js';

/** A sanction's occurrence budget: the declared `count`, defaulting to 1. */
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
  /** Total occurrence budget now granted for this key (all entries summed). */
  count: number;
  /** `reason` text of every entry granting this key, in config order. */
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

/** One key whose declared budget no longer matches the source. */
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
/** Sum each key's declared budget (default 1) across every entry granting it. */
function declaredTotals(
  sanctions: readonly SanctionedSuppression[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const sanction of sanctions) {
    totals.set(
      sanction.key,
      (totals.get(sanction.key) ?? 0) + (sanction.count ?? 1),
    );
  }
  return totals;
}

/** Group keys by the file they name, so each file is read and audited once. */
function groupKeysByFile(keys: Iterable<string>): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const key of keys) {
    const file = key.split('|')[0] ?? '';
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

/** Occurrences of each suppression key actually present in one file. */
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

export function sanctionCountDrift(
  sanctions: readonly SanctionedSuppression[],
  readSource: (file: string) => string | undefined,
): SanctionCountDrift[] {
  const declared = declaredTotals(sanctions);
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
