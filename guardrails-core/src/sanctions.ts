/**
 * Sanction approval (§ "self-sanction"). `sanctionedSuppressions` is the one
 * escape hatch from the diff-auditor, so GRANTING one must not be something the
 * agent can do for itself. The check compares the sanction KEY SET against the
 * branch's merge-base: any key present on the branch but absent from the base is
 * a newly-requested exemption.
 *
 * It is deliberately enforced in **CI, not at the commit gate**. The PR is where
 * a human actually signs off, so merging the PR *is* the approval. Locally the
 * agent may add an entry and commit; it cannot merge.
 *
 * An `approvedBy` provenance field was built and then removed on purpose. Local
 * git identity is writable by whatever is running — and is frequently a bot or a
 * placeholder (this repo's own worktree reads `Test <test@example.com>`), so the
 * field recorded a name that proved nothing and looked like a guarantee. The
 * `reason` text plus PR review carry the whole load instead.
 *
 * Comparing keys rather than diff lines also keeps the check precise:
 * reformatting the file, editing a `reason`, or REMOVING an entry are all
 * legitimate edits that must not trip it.
 */

import type { SanctionedSuppression } from './config.js';
import type { Violation } from './violation.js';

/** Keys present in `head` but not in `base` — the exemptions this branch adds. */
export function newlySanctioned(
  base: readonly SanctionedSuppression[],
  head: readonly SanctionedSuppression[],
): SanctionedSuppression[] {
  const known = new Set(base.map((sanction) => sanction.key));
  return head.filter((sanction) => !known.has(sanction.key));
}

/** Map newly-requested exemptions to blocking violations for the CI report. */
export function toSanctionViolations(
  added: readonly SanctionedSuppression[],
  configPath: string,
): Violation[] {
  return added.map((sanction) => ({
    ruleId: 'guardrails/self-sanction',
    file: configPath,
    message:
      `New diff-auditor exemption requested: ${sanction.key} — ` +
      `reason: "${sanction.reason}". A human must approve this by reviewing ` +
      `and merging the pull request; it cannot be self-granted.`,
    severity: 'error' as const,
    fixable: false,
    tool: 'guardrails',
  }));
}
