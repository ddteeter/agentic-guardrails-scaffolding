/**
 * The durable record of what each gate decision actually did, and the report
 * over it (#83).
 *
 * The terse-pointer design exists to move violation work off the main agent and
 * onto a cheap, scope-locked one; nothing in the loop reported whether it does.
 * Producing that answer for one adoption took parsing ~92 MB of agent
 * transcripts with ad-hoc scripts — not something an adopter can do, and not
 * something this repo could do on itself as a routine check. `decideGate`
 * already computes the fact on every firing (`outcome`, `fixerAgent`, the
 * attempt, the delta) and then throws it away.
 *
 * Two of the most useful findings in that audit are only visible in aggregate —
 * the zero-edit rate, and that escalations correlate with fixer regressions
 * rather than with violation difficulty. Neither is visible from inside one
 * session, which is the only vantage point the loop otherwise has.
 *
 * This module is the pure half: the row shape, its validator, and the summary.
 * Appending and reading live in `./state-store.js` with the rest of the
 * persistence, and the caller — not `decideGate` — writes the row, so the
 * decision engine stays a pure function.
 */

import type { GateLogEntry, GateOutcome } from './gate-decision.js';
import { isRecord } from './is-record.js';

// Typed `ReadonlySet<unknown>` rather than `ReadonlySet<GateOutcome>`: the
// membership check below (`Set.has`, SameValueZero, never coerces) already
// rejects every non-member on its own, so a `typeof value.outcome ===
// 'string'` guard in front of it could never change the answer — the
// annotation still catches a typo in the literal array without that
// redundant runtime check. See docs/guardrails/crushing-mutants.md's
// "redundant guard the COMPILER wanted" family.
const OUTCOMES: ReadonlySet<unknown> = new Set<GateOutcome>([
  'clean',
  'delegate',
  'escalate',
  'release',
]);

/**
 * One gate decision, as one line of `.guardrails/state/decisions.jsonl`.
 *
 * The gate's own row (`GateLogEntry`) plus the three facts only the caller
 * knows: when it fired, which rung fired it, and for which session. Extending
 * rather than restating is what stops the log's shape from drifting away from
 * the decision's.
 */
export interface DecisionRecord extends GateLogEntry {
  /**
  ISO-8601 instant the decision was made.
  */
  at: string;
  /**
   * Which gate fired — `stop`, `commit`, `push`, `ci`. A string rather than a
   * union of the rungs that write today, because a row already on disk must
   * keep parsing when a new rung starts writing.
   */
  rung: string;
  /**
   * The session the decision belongs to. Carried so a later reader can group a
   * fix loop's firings together; the report uses it to count how many sessions
   * the log covers.
   */
  session: string;
}

function isNumberRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every((count) => typeof count === 'number')
  );
}

/**
 * Runtime validator for one logged row.
 *
 * The log is append-only and read back by a different process, possibly after a
 * partial write or a hand edit, so a malformed line must be dropped rather than
 * counted — a phantom outcome would show up in the report as delegation that
 * never happened.
 */
export function isDecisionRecord(value: unknown): value is DecisionRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.at === 'string' &&
    typeof value.rung === 'string' &&
    typeof value.session === 'string' &&
    OUTCOMES.has(value.outcome) &&
    (value.fixer === undefined || typeof value.fixer === 'string') &&
    typeof value.attempt === 'number' &&
    typeof value.violations === 'number' &&
    isNumberRecord(value.rules) &&
    typeof value.introduced === 'number' &&
    typeof value.resolved === 'number' &&
    typeof value.stalled === 'boolean'
  );
}

/**
One rung's share of the log. Rungs are summarized separately because the commit
gate has no attempt ladder and never escalates, so mixing it into the stop
rung's counts would flatter the delegation share.
*/
interface RungSummary {
  rung: string;
  total: number;
  clean: number;
  delegate: number;
  escalate: number;
  release: number;
  /**
  `delegate + escalate` — the decisions that actually stopped the agent.
  */
  blocking: number;
  /**
   * `delegate / blocking`, or `undefined` when nothing blocked. Not zero: 0/0
   * is unknown, and printing 0% would read as "a fixer never handled anything".
   */
  delegationShare: number | undefined;
  /**
  Escalations that followed an attempt which introduced violations of its own.
  */
  regressionEscalations: number;
  /**
  Firings whose manifest was unchanged since the previous block.
  */
  zeroProgress: number;
}

export interface DecisionSummary {
  total: number;
  sessions: number;
  /**
  The span the log covers, or `undefined` when it is empty.
  */
  first: string | undefined;
  last: string | undefined;
  /**
  Sorted by rung name, so the report's output is stable.
  */
  rungs: RungSummary[];
  /**
  Rule-id → total occurrences across every rung, most frequent first.
  */
  rules: [string, number][];
}

function emptyRung(rung: string): RungSummary {
  return {
    rung,
    total: 0,
    clean: 0,
    delegate: 0,
    escalate: 0,
    release: 0,
    blocking: 0,
    delegationShare: undefined,
    regressionEscalations: 0,
    zeroProgress: 0,
  };
}

function accumulate(rung: RungSummary, entry: DecisionRecord): void {
  rung.total += 1;
  rung[entry.outcome] += 1;
  if (entry.stalled) {
    rung.zeroProgress += 1;
  }
  if (entry.outcome === 'escalate' && entry.introduced > 0) {
    rung.regressionEscalations += 1;
  }
}

function finish(rung: RungSummary): RungSummary {
  const blocking = rung.delegate + rung.escalate;
  return {
    ...rung,
    blocking,
    delegationShare: blocking === 0 ? undefined : rung.delegate / blocking,
  };
}

function ruleTotals(records: readonly DecisionRecord[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const entry of records) {
    for (const [ruleId, count] of Object.entries(entry.rules)) {
      totals.set(ruleId, (totals.get(ruleId) ?? 0) + count);
    }
  }
  return [...totals].toSorted((left, right) => {
    const byCount = right[1] - left[1];
    return byCount === 0 ? left[0].localeCompare(right[0]) : byCount;
  });
}

/**
 * Aggregate the log into the numbers the report prints.
 *
 * Pure over the rows, so the report is testable without a state directory and
 * an adopter can compute the same numbers from the same file.
 */
export function summarizeDecisions(
  records: readonly DecisionRecord[],
): DecisionSummary {
  const rungs = new Map<string, RungSummary>();
  const sessions = new Set<string>();
  const instants: string[] = [];
  for (const entry of records) {
    const rung = rungs.get(entry.rung) ?? emptyRung(entry.rung);
    accumulate(rung, entry);
    rungs.set(entry.rung, rung);
    sessions.add(entry.session);
    instants.push(entry.at);
  }
  // ISO-8601 instants sort lexicographically, so no date parsing is needed to
  // find the span — and a malformed instant cannot become an Invalid Date.
  const ordered = instants.toSorted((left, right) => left.localeCompare(right));
  return {
    total: records.length,
    sessions: sessions.size,
    first: ordered.at(0),
    last: ordered.at(-1),
    rungs: rungs
      .values()
      .map((rung) => finish(rung))
      .toArray()
      .toSorted((left, right) => left.rung.localeCompare(right.rung)),
    rules: ruleTotals(records),
  };
}

/**
How many rules the report names before it stops. The log accumulates across
every session in the repo, so the tail is long and uninformative.
*/
const MAX_REPORTED_RULES = 10;

function percent(share: number | undefined): string {
  return share === undefined ? 'n/a' : `${Math.round(share * 100)}%`;
}

function rungLines(rung: RungSummary): string[] {
  return [
    `${rung.rung} rung — ${rung.total} decision(s)`,
    `  blocking            ${rung.blocking}  ` +
      `(delegate ${rung.delegate}, escalate ${rung.escalate})`,
    `  delegation share    ${percent(rung.delegationShare)}  ` +
      `(blocking decisions a fixer handled without reaching the main agent)`,
    `  after a regression  ${rung.regressionEscalations} of ${rung.escalate} ` +
      `escalation(s) followed an attempt that introduced its own violations`,
    `  zero progress       ${rung.zeroProgress}  ` +
      `(manifest unchanged since the previous block)`,
    `  clean               ${rung.clean}  (released ${rung.release})`,
  ];
}

/**
Render the summary for `guardrails report`.
*/
export function formatDecisionReport(summary: DecisionSummary): string {
  if (summary.total === 0) {
    return 'guardrails: no gate decisions recorded yet.\n';
  }
  const rules = summary.rules
    .slice(0, MAX_REPORTED_RULES)
    .map(([ruleId, count]) => `  ${ruleId}  ${count}`);
  return [
    `guardrails decision log — ${summary.total} decision(s) across ` +
      `${summary.sessions} session(s), ${summary.first} .. ${summary.last}`,
    '',
    ...summary.rungs.flatMap((rung) => [...rungLines(rung), '']),
    'most frequent rules',
    ...rules,
    '',
  ].join('\n');
}
