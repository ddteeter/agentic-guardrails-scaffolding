/**
 * Deterministic session tally + cross-session recurrence memory (§2.4).
 *
 * This module is split into pure state transforms (this file's exported
 * functions, fully testable without a filesystem) and a thin persistence
 * layer (see `./state-store.js`). The gate composes them.
 */

import { recurrenceKey, type Violation } from './violation.js';

/**
Per-run tally. In workspace layouts, keys are `package:ruleId`.
*/
export interface SessionState {
  /**
  Bounded fix-attempt counter for the current Stop loop.
  */
  attempts: number;
  /** The full dump has already been handed to the main agent. The next Stop
   * retry releases the turn instead of starting the fixer ladder again. */
  escalated?: boolean;
  /**
  Distinct rule-key → number of separate turns it has appeared in.
  */
  ruleCounts: Record<string, number>;
  /**
  Rule-keys already given a behavioral correction this session.
  */
  corrected: string[];
  /**
   * `violationDigest` of the violations the previous Stop block reported, or
   * absent before the first block. Read on a retry to tell "the fixer worked
   * and something changed" from "nothing changed at all" — see
   * `violationDigest` for why that distinction is worth persisting.
   */
  lastViolationDigest?: string;
}

/**
Cross-session recurrence: rule-key → number of sessions it crossed in.
*/
export type RecurrenceCounts = Record<string, number>;

export function createSession(): SessionState {
  return { attempts: 0, escalated: false, ruleCounts: {}, corrected: [] };
}

/**
 * A stable fingerprint of one turn's violations, used only to answer "is this
 * the same set of problems the last block reported?".
 *
 * Reported from a live adoption (#39): the fixer subagent runs in the
 * background, so the move the block message asks for next — try to stop again —
 * re-fires the gate while the fixer is still working. With no way to tell that
 * apart, the gate repeated its spawn instruction verbatim and an agent
 * following it literally spawned a SECOND fixer against the same manifest,
 * racing edits on the same files.
 *
 * guardrails cannot observe a subagent's lifecycle; the host owns that. But
 * "nothing changed since the last block" is observable here, and it is the
 * signal that actually matters — it covers both a fixer still running and one
 * that finished having achieved nothing.
 *
 * Sorted, so analyzer ordering is not mistaken for progress. NOT de-duplicated,
 * so resolving one of three identical findings still reads as a change. Line
 * numbers are included: a fixer editing above a violation shifts it, and that
 * is real movement rather than a stall.
 *
 * A plain joined string rather than a hash: it is compared, never transmitted,
 * and a hash would add a dependency on `node:crypto` for no benefit while making
 * a failing test unreadable.
 *
 * Each entry is `JSON.stringify`d rather than interpolated with separators.
 * Raised in review: a hand-rolled `file:line:ruleId` joined on `|` is ambiguous
 * the moment any field contains one of those characters, and while no adapter
 * emits such a path or rule-id today, "not currently exploitable" is a weaker
 * property than "unambiguous by construction" — and JSON quoting costs nothing
 * here, since the value is only ever compared to itself.
 */
export function violationDigest(violations: readonly Violation[]): string {
  return violations
    .map((violation) =>
      JSON.stringify([
        violation.file,
        violation.line ?? null,
        violation.ruleId,
      ]),
    )
    .toSorted((left, right) => left.localeCompare(right))
    .join('|');
}

/**
 * Tally the distinct rule-keys in one turn, incrementing each by one. The gate
 * calls this only when `stop_hook_active` is false, never on fixer retries.
 * Counting distinct-per-turn (not per occurrence) makes the recurrence
 * threshold measure "how many turns this rule kept coming back", not how many
 * files it touched in a single messy turn.
 */
export function recordViolations(
  state: SessionState,
  violations: readonly Violation[],
): SessionState {
  const keys = new Set(violations.map((v) => recurrenceKey(v)));
  const ruleCounts = { ...state.ruleCounts };
  for (const key of keys) {
    ruleCounts[key] = (ruleCounts[key] ?? 0) + 1;
  }
  return { ...state, ruleCounts };
}

export function incrementAttempt(state: SessionState): SessionState {
  return { ...state, attempts: state.attempts + 1 };
}

export function resetAttempts(state: SessionState): SessionState {
  return { ...state, attempts: 0 };
}

/**
 * Rule-keys that have reached `threshold` this session and have not already
 * been corrected — the classes the gate should stop hiding and inject a
 * behavioral correction for.
 */
export function newlyCrossed(state: SessionState, threshold: number): string[] {
  const corrected = new Set(state.corrected);
  return Object.entries(state.ruleCounts)
    .filter(([key, count]) => count >= threshold && !corrected.has(key))
    .map(([key]) => key);
}

export function markCorrected(
  state: SessionState,
  keys: readonly string[],
): SessionState {
  const corrected = new Set(state.corrected);
  for (const key of keys) {
    corrected.add(key);
  }
  return { ...state, corrected: [...corrected] };
}

export function bumpRecurrence(
  counts: RecurrenceCounts,
  keys: readonly string[],
): RecurrenceCounts {
  const next = { ...counts };
  for (const key of keys) {
    next[key] = (next[key] ?? 0) + 1;
  }
  return next;
}

/**
 * Rule-keys whose cross-session recurrence has reached the threshold — the
 * candidates to graduate into `CLAUDE.md` or a hard gate.
 */
export function graduationCandidates(
  counts: RecurrenceCounts,
  threshold: number,
): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count >= threshold)
    .map(([key]) => key);
}
