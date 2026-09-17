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
  forgiveAttempt,
  violationDelta,
  violationDigest,
  violationFiles,
  violationKeys,
  findLeaseOverlap,
  isFixerLease,
  pruneLeases,
  withDeferral,
  withLease,
  withoutLease,
  type FixerLease,
  LEASE_TTL_MS,
  MAX_LEASE_DEFERRALS,
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
      forgivenAttempts: 0,
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

describe('violationDigest: separator safety', () => {
  it('does not confuse two violations whose fields contain the separators', () => {
    // Raised in review of #47. A hand-rolled `file:line:ruleId` joined on `|`
    // collides the moment a field carries one of those characters. No adapter
    // emits such a path or rule-id today, but "unambiguous by construction" is
    // a stronger property than "not currently exploitable", and JSON quoting
    // costs nothing for a value only ever compared with itself.
    const colonInFile = v({ ruleId: 'a/one', file: 'weird:1:a/two', line: 3 });
    const plainFile = v({ ruleId: 'a/one', file: 'weird', line: 1 });

    expect(violationDigest([colonInFile])).not.toBe(
      violationDigest([plainFile]),
    );
  });

  it('distinguishes a missing line from a line that is present', () => {
    expect(violationDigest([v({ ruleId: 'a/one', file: 'a.ts' })])).not.toBe(
      violationDigest([v({ ruleId: 'a/one', file: 'a.ts', line: 1 })]),
    );
  });
});

describe('violationKeys', () => {
  it('is the digest, split — one entry per violation, sorted', () => {
    const violations = [
      v({ ruleId: 'b/two', file: 'src/b.ts', line: 2 }),
      v({ ruleId: 'a/one', file: 'src/a.ts', line: 1 }),
    ];
    // One definition of identity, used two ways: the digest answers "did
    // anything change?", the key list answers "what exactly changed?". They
    // must not be able to disagree.
    expect(violationKeys(violations).join('|')).toBe(
      violationDigest(violations),
    );
    expect(violationKeys(violations)).toHaveLength(2);
  });

  it('keeps duplicates, so resolving one of two identical findings shows', () => {
    const twice = [v({ ruleId: 'a/one' }), v({ ruleId: 'a/one' })];
    expect(violationKeys(twice)).toHaveLength(2);
  });
});

describe('violationDelta', () => {
  it('reports nothing introduced or resolved when the set is unchanged', () => {
    const keys = violationKeys([v({ ruleId: 'a/one', file: 'src/a.ts' })]);
    expect(violationDelta(keys, keys)).toEqual({
      introduced: [],
      resolved: [],
    });
  });

  it('separates what the attempt added from what it removed', () => {
    const before = violationKeys([
      v({ ruleId: 'a/one', file: 'src/a.ts' }),
      v({ ruleId: 'b/two', file: 'src/b.ts' }),
    ]);
    const after = violationKeys([
      v({ ruleId: 'a/one', file: 'src/a.ts' }),
      v({ ruleId: 'c/three', file: 'src/c.ts' }),
    ]);
    const delta = violationDelta(before, after);
    expect(delta.introduced).toEqual(
      violationKeys([v({ ruleId: 'c/three', file: 'src/c.ts' })]),
    );
    expect(delta.resolved).toEqual(
      violationKeys([v({ ruleId: 'b/two', file: 'src/b.ts' })]),
    );
  });

  it('counts multiplicity, not membership', () => {
    // Three identical findings became one: two were resolved, and a
    // set-based delta would report none.
    const one = v({ ruleId: 'a/one', file: 'src/a.ts', line: 3 });
    const delta = violationDelta(
      violationKeys([one, one, one]),
      violationKeys([one]),
    );
    expect(delta.resolved).toHaveLength(2);
    expect(delta.introduced).toEqual([]);
  });
});

describe('forgiveAttempt', () => {
  it('counts a forgiven attempt without spending the budget', () => {
    const forgiven = forgiveAttempt(incrementAttempt(createSession()));
    expect(forgiven.attempts).toBe(1);
    expect(forgiven.forgivenAttempts).toBe(1);
  });

  it('is cleared by resetAttempts, so each fix loop gets its own allowance', () => {
    const forgiven = forgiveAttempt(createSession());
    expect(resetAttempts(forgiven).forgivenAttempts).toBe(0);
  });

  it('accumulates across repeated forgiven attempts in the same fix loop', () => {
    // A non-zero starting count is the case that distinguishes `?? 0`
    // (carry the existing count forward) from a mutant that discards it
    // whenever the count is already truthy -- from 0 both read the same.
    const forgiven = forgiveAttempt(forgiveAttempt(createSession()));
    expect(forgiven.forgivenAttempts).toBe(2);
  });
});

describe('violationFiles', () => {
  it('is the sorted, de-duplicated set of files the violations name', () => {
    expect(
      violationFiles([
        v({ ruleId: 'a', file: 'src/b.ts' }),
        v({ ruleId: 'b', file: 'src/a.ts' }),
        v({ ruleId: 'c', file: 'src/b.ts' }),
      ]),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('drops violations naming no file, which claim nothing', () => {
    expect(
      violationFiles([v({ ruleId: 'a' }), { ...v({ ruleId: 'b' }), file: '' }]),
    ).toEqual(['src/foo.ts']);
  });
});

function lease(partial: Partial<FixerLease> = {}): FixerLease {
  return {
    owner: 'commit:sid-commit',
    manifestPath: '.guardrails/state/sid-commit.last.json',
    fixerAgent: 'guardrail-fixer',
    files: ['src/a.ts', 'src/b.ts'],
    grantedAt: 1000,
    deferrals: 0,
    ...partial,
  };
}

describe('isFixerLease', () => {
  it('accepts a well-formed lease', () => {
    expect(isFixerLease(lease())).toBe(true);
  });

  it.each([
    ['a non-record', 'nope'],
    ['a non-string owner', { ...lease(), owner: 1 }],
    ['an absent manifestPath', { ...lease(), manifestPath: undefined }],
    ['a null fixerAgent', { ...lease(), fixerAgent: null }],
    ['a non-array file set', { ...lease(), files: 'src/a.ts' }],
    ['a non-string file entry', { ...lease(), files: ['src/a.ts', 7] }],
    ['a non-numeric grantedAt', { ...lease(), grantedAt: '1000' }],
    ['a non-numeric deferrals', { ...lease(), deferrals: '0' }],
  ])('rejects %s', (_label, value) => {
    expect(isFixerLease(value)).toBe(false);
  });
});

describe('findLeaseOverlap', () => {
  const now = 1000;

  it('finds nothing when no lease is held', () => {
    expect(findLeaseOverlap([], 'stop:sid', ['src/a.ts'], now)).toBeUndefined();
  });

  it('finds nothing in the observing gate own lease', () => {
    // The same-manifest case is already covered by the unchanged-digest
    // guard; a lease must never make a gate wait for its own fixer.
    expect(
      findLeaseOverlap(
        [lease({ owner: 'stop:sid' })],
        'stop:sid',
        ['src/a.ts'],
        now,
      ),
    ).toBeUndefined();
  });

  it('finds nothing when the file sets are disjoint', () => {
    expect(
      findLeaseOverlap([lease()], 'stop:sid', ['src/z.ts'], now),
    ).toBeUndefined();
  });

  it('reports the sorted intersection with the holder manifest and fixer', () => {
    const overlap = findLeaseOverlap(
      [lease({ fixerAgent: 'guardrail-fixer-thorough' })],
      'stop:sid',
      ['src/b.ts', 'src/a.ts', 'src/z.ts'],
      now,
    );
    expect(overlap).toEqual({
      owner: 'commit:sid-commit',
      manifestPath: '.guardrails/state/sid-commit.last.json',
      fixerAgent: 'guardrail-fixer-thorough',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('ignores a lease older than the TTL, so a dead fixer cannot deadlock the loop', () => {
    // Pinned to the literal, not the constant: every assertion below is written
    // in terms of LEASE_TTL_MS, so an arithmetic mutant that shrinks the TTL to
    // milliseconds would survive all of them without this line.
    expect(LEASE_TTL_MS).toBe(30 * 60 * 1000);
    expect(
      findLeaseOverlap(
        [lease({ grantedAt: 0 })],
        'stop:sid',
        ['src/a.ts'],
        LEASE_TTL_MS + 1,
      ),
    ).toBeUndefined();
  });

  it('ignores a lease already waited on, so the wait is one round trip', () => {
    // The literal 1 rather than the constant, deliberately: asserting with
    // `MAX_LEASE_DEFERRALS` would pass for any ceiling, which is exactly the
    // mutant this has to kill.
    expect(MAX_LEASE_DEFERRALS).toBe(1);
    expect(
      findLeaseOverlap(
        [lease({ deferrals: 1 })],
        'stop:sid',
        ['src/a.ts'],
        now,
      ),
    ).toBeUndefined();
  });

  it('picks the lease with the largest intersection', () => {
    const overlap = findLeaseOverlap(
      [
        lease({
          owner: 'commit:one',
          manifestPath: 'one.json',
          files: ['src/a.ts'],
        }),
        lease({
          owner: 'commit:two',
          manifestPath: 'two.json',
          files: ['src/a.ts', 'src/b.ts'],
        }),
      ],
      'stop:sid',
      ['src/a.ts', 'src/b.ts'],
      now,
    );
    expect(overlap?.manifestPath).toBe('two.json');
  });

  it('breaks ties on the manifest path, so the message is deterministic', () => {
    const overlap = findLeaseOverlap(
      [
        lease({
          owner: 'commit:two',
          manifestPath: 'two.json',
          files: ['src/a.ts'],
        }),
        lease({
          owner: 'commit:one',
          manifestPath: 'one.json',
          files: ['src/a.ts'],
        }),
      ],
      'stop:sid',
      ['src/a.ts'],
      now,
    );
    expect(overlap?.manifestPath).toBe('one.json');
  });
});

describe('lease transforms', () => {
  it('pruneLeases drops expired entries and keeps live ones', () => {
    const live = lease({ owner: 'commit:live', grantedAt: LEASE_TTL_MS });
    // Exactly the TTL old, which pins the boundary: a lease that has reached
    // its age is expired, so `>=` cannot be relaxed to `>` unnoticed.
    const dead = lease({ owner: 'commit:dead', grantedAt: 1 });
    expect(pruneLeases([live, dead], LEASE_TTL_MS + 1)).toEqual([live]);
  });

  it('withLease replaces the owner entry rather than appending a second', () => {
    const other = lease({ owner: 'stop:other' });
    const next = withLease([lease(), other], lease({ grantedAt: 9000 }));
    expect(next).toHaveLength(2);
    expect(
      next.find((entry) => entry.owner === 'commit:sid-commit')?.grantedAt,
    ).toBe(9000);
    expect(next).toContainEqual(other);
  });

  it('withLease appends when the owner holds nothing yet', () => {
    const other = lease({ owner: 'stop:other' });
    expect(withLease([other], lease())).toEqual([other, lease()]);
  });

  it('withoutLease drops only the named owner entry', () => {
    const other = lease({ owner: 'stop:other' });
    expect(withoutLease([lease(), other], 'commit:sid-commit')).toEqual([
      other,
    ]);
  });

  it('withDeferral counts the wait against the lease that was waited on', () => {
    const other = lease({ owner: 'stop:other' });
    const next = withDeferral([lease(), other], 'commit:sid-commit');
    expect(
      next.find((entry) => entry.owner === 'commit:sid-commit')?.deferrals,
    ).toBe(1);
    expect(next.find((entry) => entry.owner === 'stop:other')?.deferrals).toBe(
      0,
    );
  });
});
