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
 * Paths are repo-relative and emitted by `scripts/sync-agents.mjs` from the
 * plugin's skills, so the doc a consumer repo has on disk matches this table.
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
