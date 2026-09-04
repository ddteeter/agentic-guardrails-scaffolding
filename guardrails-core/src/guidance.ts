/**
 * Attaches per-violation-class guidance to the manifest the fixer reads.
 *
 * Some violation classes need *method*, not just a rule name — a surviving
 * mutant is the standout: an agent that does not know how to triage one reaches
 * for a suppression, which is exactly what the rest of the system exists to
 * catch. Skills, instruction files and index docs are all per-surface and rely
 * on the agent going to look; the manifest is the one channel every runtime
 * already reads, so the pointer rides along on the violation itself.
 *
 * Paths are repo-relative and point at `docs/guardrails/`, the copy `init`
 * installs INTO the consumer repo -- not into
 * `node_modules/guardrails-core/guidance/`, which is where the same bytes ship
 * but not where every reader can reach them. `guidanceEntries`
 * (`scaffold/templates.ts`) writes `docs/guardrails/*.md` unconditionally for
 * exactly this reason: the Copilot cloud agent reads the DEFAULT BRANCH, where
 * `node_modules` has never been installed. A `node_modules` path is readable
 * from a local session and dead from that one, and the manifest is the channel
 * every runtime reads, so it takes the path that works everywhere.
 *
 * The adoption-time doc is the deliberate exception, and lives only in the
 * tarball: `init` never copies it, because the reader has not run `init` yet.
 */

import type { Violation } from './violation.js';

/** rule-id prefix → repo-relative guidance doc. Longest match wins. */
const GUIDANCE: readonly (readonly [string, string])[] = [
  ['stryker/', 'docs/guardrails/crushing-mutants.md'],
];

function guidanceFor(ruleId: string): string | undefined {
  return GUIDANCE.find(([prefix]) => ruleId.startsWith(prefix))?.[1];
}

/**
 * Return `violations` with a `guidance` path set where one is known. Violations
 * that already carry guidance are left alone, and unknown classes are untouched
 * (no key added) so the manifest stays terse.
 */
export function withGuidance(violations: readonly Violation[]): Violation[] {
  return violations.map((violation) => {
    if (violation.guidance !== undefined) {
      return violation;
    }
    const guidance = guidanceFor(violation.ruleId);
    return guidance === undefined ? violation : { ...violation, guidance };
  });
}
