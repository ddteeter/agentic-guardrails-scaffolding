import { describe, expect, it } from 'vitest';

import {
  type DecisionRecord,
  formatDecisionReport,
  isDecisionRecord,
  summarizeDecisions,
} from '../src/decision-log.js';

function record(partial: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    at: '2026-09-01T10:00:00.000Z',
    rung: 'stop',
    session: 'sid',
    outcome: 'delegate',
    attempt: 1,
    violations: 3,
    rules: { 'stryker/survived': 3 },
    introduced: 0,
    resolved: 0,
    stalled: false,
    ...partial,
  };
}

describe('isDecisionRecord', () => {
  it('accepts a well-formed row', () => {
    expect(isDecisionRecord(record())).toBe(true);
  });

  it('rejects a row whose outcome is not one the gate produces', () => {
    // The log is append-only and read back later, so a hand-edited or
    // half-written line must not reach the report as a phantom outcome.
    expect(isDecisionRecord({ ...record(), outcome: 'whatever' })).toBe(false);
  });

  it('rejects a row missing a count the report divides by', () => {
    const { violations: _violations, ...rest } = record();
    expect(isDecisionRecord(rest)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isDecisionRecord('delegate')).toBe(false);
    expect(isDecisionRecord(null)).toBe(false);
  });

  it('accepts a row with no fixer, which clean and escalate rows have', () => {
    expect(isDecisionRecord(record({ outcome: 'clean' }))).toBe(true);
  });

  it('rejects a fixer that is present but not a string', () => {
    expect(isDecisionRecord({ ...record(), fixer: 7 })).toBe(false);
  });

  it('rejects a rule tally whose counts are not numbers', () => {
    expect(isDecisionRecord({ ...record(), rules: { a: 'lots' } })).toBe(false);
  });

  it('rejects an array even when it carries every field a valid row has', () => {
    // The array guard is the only thing `isRecord` checks that a downstream
    // `typeof`/`Set.has` chain could not also catch on its own -- pairing a
    // fully-valid payload with the one shape that guard alone excludes is
    // what makes the assertion fail if that guard silently became `true`.
    const arrayShaped: unknown = Object.assign([], record());
    expect(isDecisionRecord(arrayShaped)).toBe(false);
  });

  it('rejects a row whose "at" instant is not a string', () => {
    expect(isDecisionRecord({ ...record(), at: 1234 })).toBe(false);
  });

  it('rejects a row whose rung is not a string', () => {
    expect(isDecisionRecord({ ...record(), rung: 1234 })).toBe(false);
  });

  it('rejects a row whose session is not a string', () => {
    expect(isDecisionRecord({ ...record(), session: 1234 })).toBe(false);
  });

  it('rejects a row whose attempt is not a number', () => {
    expect(isDecisionRecord({ ...record(), attempt: '1' })).toBe(false);
  });

  it('rejects a row whose introduced count is not a number', () => {
    expect(isDecisionRecord({ ...record(), introduced: '0' })).toBe(false);
  });

  it('rejects a row whose resolved count is not a number', () => {
    expect(isDecisionRecord({ ...record(), resolved: '0' })).toBe(false);
  });

  it('rejects a row whose stalled flag is not a boolean', () => {
    expect(isDecisionRecord({ ...record(), stalled: 'false' })).toBe(false);
  });
});

describe('summarizeDecisions', () => {
  it('reports the delegation share of blocking decisions', () => {
    // The headline number (#83): of the decisions that blocked, how many were
    // handed to a fixer rather than to the main agent.
    const summary = summarizeDecisions([
      record({ outcome: 'delegate' }),
      record({ outcome: 'delegate' }),
      record({ outcome: 'delegate' }),
      record({ outcome: 'escalate' }),
      record({ outcome: 'clean' }),
    ]);
    const [stop] = summary.rungs;
    expect(stop?.blocking).toBe(4);
    expect(stop?.delegate).toBe(3);
    expect(stop?.escalate).toBe(1);
    expect(stop?.delegationShare).toBe(0.75);
    expect(stop?.clean).toBe(1);
  });

  it('leaves the share unknown rather than zero when nothing blocked', () => {
    // 0/0 is not 0%. A log of clean turns says nothing about delegation, and
    // reporting 0% would read as "the fixer never handled anything".
    const summary = summarizeDecisions([record({ outcome: 'clean' })]);
    expect(summary.rungs[0]?.delegationShare).toBeUndefined();
  });

  it('separates escalations that followed a fixer regression', () => {
    const summary = summarizeDecisions([
      record({ outcome: 'escalate', introduced: 4, resolved: 0 }),
      record({ outcome: 'escalate', introduced: 0, resolved: 0 }),
    ]);
    expect(summary.rungs[0]?.regressionEscalations).toBe(1);
  });

  it('does not count a delegation as a regression escalation, even with introduced violations', () => {
    // `regressionEscalations` means "escalated AND the previous attempt
    // regressed" -- a delegate row with a regression is a different signal
    // (the fixer tier routing), and must not inflate this count.
    const summary = summarizeDecisions([
      record({ outcome: 'delegate', introduced: 4 }),
    ]);
    expect(summary.rungs[0]?.regressionEscalations).toBe(0);
  });

  it('counts zero-progress attempts from the unchanged manifest', () => {
    const summary = summarizeDecisions([
      record({ stalled: true }),
      record({ stalled: false }),
    ]);
    expect(summary.rungs[0]?.zeroProgress).toBe(1);
  });

  it('groups by rung, so the commit gate is not mixed into the stop ladder', () => {
    const summary = summarizeDecisions([
      record({ rung: 'stop' }),
      record({ rung: 'commit' }),
      record({ rung: 'commit' }),
    ]);
    expect(summary.rungs.map((rung) => [rung.rung, rung.total])).toEqual([
      ['commit', 2],
      ['stop', 1],
    ]);
  });

  it('tallies rules across every rung, most frequent first', () => {
    const summary = summarizeDecisions([
      record({ rules: { 'a/one': 1, 'b/two': 5 } }),
      record({ rung: 'commit', rules: { 'a/one': 2 } }),
    ]);
    expect(summary.rules).toEqual([
      ['b/two', 5],
      ['a/one', 3],
    ]);
  });

  it('breaks a tie between equally frequent rules alphabetically', () => {
    // Both rules fire once; without an explicit tie-break the comparator
    // returns 0 for the pair and a stable sort would leave them in Map
    // insertion order (`z/last` first, since that is the key order below).
    const summary = summarizeDecisions([
      record({ rules: { 'z/last': 1, 'a/first': 1 } }),
    ]);
    expect(summary.rules).toEqual([
      ['a/first', 1],
      ['z/last', 1],
    ]);
  });

  it('counts distinct sessions and the span the log covers', () => {
    const summary = summarizeDecisions([
      record({ session: 'one', at: '2026-09-02T10:00:00.000Z' }),
      record({ session: 'two', at: '2026-09-01T10:00:00.000Z' }),
      record({ session: 'one', at: '2026-09-03T10:00:00.000Z' }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.sessions).toBe(2);
    expect(summary.first).toBe('2026-09-01T10:00:00.000Z');
    expect(summary.last).toBe('2026-09-03T10:00:00.000Z');
  });

  it('summarizes an empty log without inventing a span', () => {
    const summary = summarizeDecisions([]);
    expect(summary.total).toBe(0);
    expect(summary.rungs).toEqual([]);
    expect(summary.first).toBeUndefined();
    expect(summary.last).toBeUndefined();
  });
});

describe('formatDecisionReport', () => {
  it('says the log is empty rather than printing an empty table', () => {
    const text = formatDecisionReport(summarizeDecisions([]));
    expect(text).toContain('no gate decisions recorded');
  });

  it('prints the share as a percentage alongside the raw counts', () => {
    const text = formatDecisionReport(
      summarizeDecisions([
        record({ outcome: 'delegate' }),
        record({ outcome: 'delegate' }),
        record({ outcome: 'delegate' }),
        record({ outcome: 'escalate', introduced: 2 }),
      ]),
    );
    expect(text).toContain('delegation share');
    expect(text).toContain('75%');
    expect(text).toContain('delegate 3');
    expect(text).toContain('escalate 1');
    expect(text).toContain('1 of 1');
  });

  it('says the share is unknown when nothing blocked', () => {
    const text = formatDecisionReport(
      summarizeDecisions([record({ outcome: 'clean' })]),
    );
    expect(text).toContain('delegation share');
    expect(text).toContain('n/a');
  });

  it('lists the rules behind the decisions', () => {
    const text = formatDecisionReport(
      summarizeDecisions([record({ rules: { 'stryker/survived': 7 } })]),
    );
    expect(text).toContain('stryker/survived');
    expect(text).toContain('7');
  });

  it('stops listing rules after the top 10, even when more rules fired', () => {
    // The log accumulates across every session in the repo, so an unbounded
    // list would grow forever; MAX_REPORTED_RULES caps it at the ten most
    // frequent, ranked by the descending counts below.
    const rules: Record<string, number> = Object.fromEntries(
      Array.from({ length: 11 }, (_, index): [string, number] => [
        `rule-${index}`,
        11 - index,
      ]),
    );
    const text = formatDecisionReport(summarizeDecisions([record({ rules })]));
    expect(text).toContain('rule-0');
    expect(text).not.toContain('rule-10');
  });
});
