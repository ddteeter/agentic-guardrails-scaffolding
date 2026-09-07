import { describe, expect, it } from 'vitest';

import {
  bumpRecurrence,
  createSession,
  graduationCandidates,
  incrementAttempt,
  markCorrected,
  newlyCrossed,
  recordViolations,
  resetAttempts,
  violationDigest,
} from '../src/state.js';
import type { Violation } from '../src/violation.js';

function v(partial: Partial<Violation> & Pick<Violation, 'ruleId'>): Violation {
  return {
    file: 'src/foo.ts',
    message: 'boom',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
    ...partial,
  };
}

describe('createSession', () => {
  it('starts with zero attempts and empty tallies', () => {
    expect(createSession()).toEqual({
      attempts: 0,
      escalated: false,
      ruleCounts: {},
      corrected: [],
    });
  });
});

describe('recordViolations', () => {
  it('counts each distinct rule-key once per call (not per occurrence)', () => {
    // Same ruleId on two files within one verify → counts as one recurrence.
    const state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub', file: 'a.ts' }),
      v({ ruleId: 'ts/no-stub', file: 'b.ts' }),
    ]);
    expect(state.ruleCounts).toEqual({ 'ts/no-stub': 1 });
  });

  it('accumulates across successive calls (attempts/turns)', () => {
    let state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub' }),
    ]);
    state = recordViolations(state, [v({ ruleId: 'ts/no-stub' })]);
    state = recordViolations(state, [v({ ruleId: 'ts/dead-export' })]);
    expect(state.ruleCounts).toEqual({ 'ts/no-stub': 2, 'ts/dead-export': 1 });
  });

  it('keys on package:ruleId in a workspace layout', () => {
    const state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub', package: 'packages/api' }),
    ]);
    expect(state.ruleCounts).toEqual({ 'packages/api:ts/no-stub': 1 });
  });

  it('does not mutate the input state', () => {
    const start = createSession();
    recordViolations(start, [v({ ruleId: 'ts/no-stub' })]);
    expect(start.ruleCounts).toEqual({});
  });
});

describe('attempt counter', () => {
  it('increments and resets', () => {
    const bumped = incrementAttempt(incrementAttempt(createSession()));
    expect(bumped.attempts).toBe(2);
    expect(resetAttempts(bumped).attempts).toBe(0);
  });
});

describe('newlyCrossed', () => {
  it('returns rule-keys whose count reached the threshold', () => {
    let state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub' }),
    ]);
    state = recordViolations(state, [v({ ruleId: 'ts/no-stub' })]);
    state = recordViolations(state, [v({ ruleId: 'ts/no-stub' })]);
    expect(newlyCrossed(state, 3)).toEqual(['ts/no-stub']);
  });

  it('excludes keys already corrected this session', () => {
    let state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub' }),
    ]);
    state = recordViolations(state, [v({ ruleId: 'ts/no-stub' })]);
    state = recordViolations(state, [v({ ruleId: 'ts/no-stub' })]);
    state = markCorrected(state, ['ts/no-stub']);
    expect(newlyCrossed(state, 3)).toEqual([]);
  });

  it('excludes keys below the threshold', () => {
    const state = recordViolations(createSession(), [
      v({ ruleId: 'ts/no-stub' }),
    ]);
    expect(newlyCrossed(state, 3)).toEqual([]);
  });
});

describe('markCorrected', () => {
  it('appends keys without duplicating', () => {
    const state = markCorrected(markCorrected(createSession(), ['a']), [
      'a',
      'b',
    ]);
    expect(state.corrected).toEqual(['a', 'b']);
  });
});

describe('recurrence counter', () => {
  it('increments cross-session counts for each key', () => {
    const counts = bumpRecurrence({ 'ts/no-stub': 2 }, [
      'ts/no-stub',
      'ts/dead-export',
    ]);
    expect(counts).toEqual({ 'ts/no-stub': 3, 'ts/dead-export': 1 });
  });

  it('does not mutate the input counts', () => {
    const start = { 'ts/no-stub': 2 };
    bumpRecurrence(start, ['ts/no-stub']);
    expect(start).toEqual({ 'ts/no-stub': 2 });
  });

  it('surfaces graduation candidates at or above the threshold', () => {
    const counts = { 'ts/no-stub': 3, 'ts/dead-export': 1, 'ts/any-cast': 5 };
    expect(
      graduationCandidates(counts, 3).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(['ts/any-cast', 'ts/no-stub']);
  });
});

describe('violationDigest', () => {
  it('is stable regardless of the order violations arrive in', () => {
    // The digest answers one question -- "is this the same set of problems as
    // last time?" -- and analyzer order is not part of that. eslint and tsc
    // run serially, but a changed-file set can reorder their findings between
    // attempts without anything actually being fixed.
    const a = v({ ruleId: 'a/one', file: 'a.ts', line: 1 });
    const b = v({ ruleId: 'a/one', file: 'b.ts', line: 9 });

    expect(violationDigest([a, b])).toBe(violationDigest([b, a]));
  });

  it('changes when a violation is resolved', () => {
    const a = v({ ruleId: 'a/one', file: 'a.ts', line: 1 });
    const b = v({ ruleId: 'a/one', file: 'b.ts', line: 9 });

    expect(violationDigest([a, b])).not.toBe(violationDigest([a]));
  });

  it('changes when a violation moves to another line', () => {
    // A fixer that edits above a violation shifts its line. That IS progress
    // worth distinguishing from "nothing happened".
    expect(violationDigest([v({ ruleId: 'a/one', line: 1 })])).not.toBe(
      violationDigest([v({ ruleId: 'a/one', line: 2 })]),
    );
  });

  it('changes when the rule changes at the same location', () => {
    expect(violationDigest([v({ ruleId: 'a/one' })])).not.toBe(
      violationDigest([v({ ruleId: 'a/two' })]),
    );
  });

  it('distinguishes two findings of one rule from one', () => {
    // Duplicates must not collapse: fixing one of three identical findings is
    // progress, and a set-based digest would report it as no change.
    const one = v({ ruleId: 'a/one', file: 'a.ts', line: 3 });
    expect(violationDigest([one, one])).not.toBe(violationDigest([one]));
  });

  it('is empty for no violations', () => {
    expect(violationDigest([])).toBe('');
  });
});
