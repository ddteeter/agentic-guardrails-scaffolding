/**
 * Which suppressions a proposed edit would ADD (#77).
 *
 * The fixer contract says a violation the fixer cannot honestly fix is
 * reported, never suppressed. In the field fixers kept writing the suppression
 * anyway -- `fallow-ignore-next-line` under a prompt that said "Do not add
 * suppressions", `// Stryker disable` on a mutant they could not kill -- and
 * the diff-auditor only caught it at the NEXT gate, one full rework cycle
 * later. The scope-lock sees the edit before it lands, so this is where the
 * honest route and the effective route can be made the same route.
 *
 * Counted with the auditor's own lexer (`auditSource`), so "a suppression"
 * means exactly what the gate will later flag, and as a multiset per file by
 * `kind|text`: an Edit's replacement text routinely carries a directive it did
 * not touch, and that is not an addition, but a second copy of one is.
 */

import { type AuditFinding, auditSource } from './audit.js';

/**
One proposed change to a file, as text before and after.
*/
export interface ProposedEdit {
  file: string;
  before: string;
  after: string;
}

function tally(findings: readonly AuditFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const key = `${finding.kind}|${finding.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function addedSuppressions(
  edits: readonly ProposedEdit[],
): AuditFinding[] {
  const added: AuditFinding[] = [];
  for (const edit of edits) {
    const remaining = tally(auditSource(edit.file, edit.before));
    for (const finding of auditSource(edit.file, edit.after)) {
      const key = `${finding.kind}|${finding.text}`;
      const carried = remaining.get(key) ?? 0;
      if (carried > 0) {
        remaining.set(key, carried - 1);
      } else {
        added.push(finding);
      }
    }
  }
  return added;
}
