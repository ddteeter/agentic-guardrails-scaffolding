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
  /** The escalation pointer has already been handed to the main agent. The
   * next Stop retry releases the turn instead of starting the fixer ladder
   * again. */
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
  /**
   * `violationKeys` of the same violations — the IDENTITIES behind the digest
   * above, not merely its fingerprint (#81).
   *
   * The digest answers "did anything change?" and nothing finer, so a fixer
   * that resolves three violations and introduces four reads as progress. Both
   * observed escalations in a live adoption were exactly that: an attempt spent
   * cleaning up after the previous attempt, charged to the budget as if the
   * violation were hard. Keeping the identities lets the gate compute which
   * findings are NEW since the manifest the fixer was given — see
   * `violationDelta`.
   *
   * Stored alongside the digest rather than replacing it. The digest is one
   * string and is what state written before this field carries, so the
   * unchanged-retry check keeps working across an upgrade; and it cannot be
   * split back into keys, because the JSON quoting that makes each key
   * unambiguous does not make the `|` join unambiguous.
   *
   * NOT cleared when a fix loop ends. `resetAttempts` clears the counters but
   * leaves these identities standing, so a session that went clean still
   * carries the last block's set. That is safe because of an invariant held
   * one level up rather than here: the delta is only computed on a RETRY
   * (`attemptDelta` gates on `isRetry`), and the first Stop of any later turn
   * is never a retry, so it overwrites this field on its own delegate before
   * any retry can read it. If that gate ever moves, this field has to be
   * cleared alongside the counters.
   */
  lastViolationKeys?: readonly string[];
  /**
   * How many attempts in the current fix loop were forgiven rather than
   * charged — a fixer's own regression is not evidence that the violation is
   * hard (#81).
   *
   * Persisted, and therefore bounded, deliberately: forgiveness with no ceiling
   * is a fixer that can regress differently forever without ever reaching
   * escalation. `isStalled` only catches a regression that repeats ITSELF
   * (identical manifest); this counter is what terminates the changing-but-
   * always-worse ladder. Cleared by `resetAttempts`, so each loop gets its own
   * allowance.
   */
  forgivenAttempts?: number;
}

/**
Cross-session recurrence: rule-key → number of sessions it crossed in.
*/
export type RecurrenceCounts = Record<string, number>;

export function createSession(): SessionState {
  return {
    attempts: 0,
    escalated: false,
    forgivenAttempts: 0,
    ruleCounts: {},
    corrected: [],
  };
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
  return violationKeys(violations).join('|');
}

/**
 * The identity of one violation — file, line, rule — as a single string.
 *
 * `JSON.stringify` of a tuple rather than an interpolated `file:line:ruleId`
 * for the reason `violationDigest` records: a hand-rolled join is ambiguous the
 * moment a field contains the separator, and quoting costs nothing for a value
 * that is only ever compared with another of its own kind.
 */
export function violationKey(violation: Violation): string {
  return JSON.stringify([
    violation.file,
    violation.line ?? null,
    violation.ruleId,
  ]);
}

/**
 * Every violation's identity, sorted — the list the digest is the join of.
 *
 * One definition of identity serving both: the digest answers "did anything
 * change?", the key list answers "what exactly changed?", and deriving the
 * first from the second is what stops the two from drifting apart.
 *
 * NOT de-duplicated, for the same reason the digest is not: three identical
 * findings are three pieces of work, and resolving one of them is progress.
 */
export function violationKeys(violations: readonly Violation[]): string[] {
  return violations
    .map((violation) => violationKey(violation))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
What one fix attempt actually did to the violation set (#81).
*/
export interface ViolationDelta {
  /** Identities present now that were not in the manifest the fixer was given
   * — i.e. findings that attempt created. */
  introduced: string[];
  /**
  Identities that were in that manifest and are now gone.
  */
  resolved: string[];
}

function tally(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function surplus(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): string[] {
  const extra: string[] = [];
  for (const [key, count] of left) {
    const difference = count - (right.get(key) ?? 0);
    extra.push(...Array.from({ length: Math.max(difference, 0) }, () => key));
  }
  return extra;
}

/**
 * Compare the violation identities from the previous block with the current
 * ones, as MULTISETS.
 *
 * Multisets, not sets: "three identical findings became one" is two
 * resolutions, and a membership test would call it no change at all — the same
 * distinction `violationKeys` preserves by not de-duplicating.
 */
export function violationDelta(
  previous: readonly string[],
  current: readonly string[],
): ViolationDelta {
  const before = tally(previous);
  const after = tally(current);
  return {
    introduced: surplus(after, before),
    resolved: surplus(before, after),
  };
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
  return { ...state, attempts: 0, forgivenAttempts: 0 };
}

/**
 * Record an attempt that was NOT charged to the budget — a fixer whose edits
 * introduced findings its own manifest did not contain has not proved the
 * violation hard, only that it failed to start (#81).
 *
 * The count is what keeps the forgiveness bounded; the gate refuses to forgive
 * past a ceiling, so a fixer that regresses differently every time still walks
 * the ladder to escalation.
 */
export function forgiveAttempt(state: SessionState): SessionState {
  return { ...state, forgivenAttempts: (state.forgivenAttempts ?? 0) + 1 };
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
