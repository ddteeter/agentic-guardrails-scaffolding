import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSession, type FixerLease } from '../src/state.js';
import {
  appendDecision,
  baseReferenceCache,
  decisionsFile,
  deleteSession,
  leasesFile,
  loadLeases,
  loadRecurrence,
  loadSession,
  saveLeases,
  readDecisions,
  readViolations,
  recurrenceFile,
  saveRecurrence,
  saveSession,
  sessionFile,
  stateDirectory,
  sweepStale,
  writeViolations,
} from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let directory: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-'));
  directory = stateDirectory(root);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sample: Violation = {
  ruleId: 'ts/no-stub',
  file: 'src/foo.ts',
  message: 'stub',
  severity: 'error',
  fixable: false,
  tool: 'eslint',
};

describe('stateDirectory', () => {
  it('is the runtime-neutral .guardrails/state path', () => {
    expect(stateDirectory('/repo')).toBe(
      path.join('/repo', '.guardrails', 'state'),
    );
  });
});

describe('session round-trip', () => {
  it('saves and loads a session', () => {
    const state = {
      attempts: 2,
      escalated: false,
      forgivenAttempts: 0,
      ruleCounts: { 'ts/no-stub': 3 },
      corrected: [],
    };
    saveSession(directory, 'sid1', state);
    expect(loadSession(directory, 'sid1')).toEqual(state);
  });

  it('round-trips lastViolationDigest, which the stop loop reads across processes', () => {
    // Each Stop-hook fire is a FRESH CLI process, so the only channel between
    // one block and the next retry is this file. A field `saveSession` writes
    // and `loadSession` drops is a field the gate can never read -- the
    // unchanged-retry check would be dead code in production while passing
    // every in-memory unit test. Found in review of #47, where it was exactly
    // that.
    const state = {
      attempts: 1,
      escalated: false,
      forgivenAttempts: 0,
      ruleCounts: {},
      corrected: [],
      lastViolationDigest: 'src/a.ts:3:eslint/no-console',
    };
    saveSession(directory, 'sid-digest', state);

    expect(loadSession(directory, 'sid-digest')).toEqual(state);
  });

  it('loads a session written before digests were tracked', () => {
    // Backward compatibility, same shape as `escalated`: an older state file
    // has no digest, and its absence must read as "nothing to compare against"
    // rather than corrupting the session into a fresh one.
    writeFileSync(
      sessionFile(directory, 'sid-old'),
      JSON.stringify({ attempts: 2, ruleCounts: {}, corrected: [] }),
    );

    const loaded = loadSession(directory, 'sid-old');
    expect(loaded.attempts).toBe(2);
    expect(loaded.lastViolationDigest).toBeUndefined();
  });

  it('discards a non-string digest rather than trusting the file', () => {
    // Values are validated, not just shape -- the same rule the ruleCounts
    // check below states. A tampered digest of the wrong type must not reach
    // the gate's comparison.
    writeFileSync(
      sessionFile(directory, 'sid-bad'),
      JSON.stringify({
        attempts: 1,
        ruleCounts: {},
        corrected: [],
        lastViolationDigest: 42,
      }),
    );

    expect(
      loadSession(directory, 'sid-bad').lastViolationDigest,
    ).toBeUndefined();
  });

  it('round-trips the violation identities the delta is computed from', () => {
    // Same across-processes argument as the digest above, and the same failure
    // mode if it is dropped: the introduced/resolved delta (#81) would be
    // permanently empty in production while every in-memory unit test passed.
    const state = {
      attempts: 1,
      escalated: false,
      forgivenAttempts: 1,
      ruleCounts: {},
      corrected: [],
      lastViolationDigest: '["src/a.ts",3,"eslint/no-console"]',
      lastViolationKeys: ['["src/a.ts",3,"eslint/no-console"]'],
    };
    saveSession(directory, 'sid-keys', state);

    expect(loadSession(directory, 'sid-keys')).toEqual(state);
  });

  it('discards violation identities that are not a list of strings', () => {
    // Values are validated, not just shape. A tampered entry reaching the
    // delta would be counted as a violation identity that never existed, and
    // read as a resolution the fixer never made.
    writeFileSync(
      sessionFile(directory, 'sid-bad-keys'),
      JSON.stringify({
        attempts: 1,
        ruleCounts: {},
        corrected: [],
        lastViolationKeys: 'not-an-array',
      }),
    );

    expect(
      loadSession(directory, 'sid-bad-keys').lastViolationKeys,
    ).toBeUndefined();
  });

  it('keeps only the string entries of a partially corrupt identity list', () => {
    writeFileSync(
      sessionFile(directory, 'sid-mixed-keys'),
      JSON.stringify({
        attempts: 1,
        ruleCounts: {},
        corrected: [],
        lastViolationKeys: ['["src/a.ts",1,"x"]', 42],
      }),
    );

    expect(loadSession(directory, 'sid-mixed-keys').lastViolationKeys).toEqual([
      '["src/a.ts",1,"x"]',
    ]);
  });

  it('discards a non-number forgiven-attempt count', () => {
    // A string here would make `count + 1` produce `"oops1"` and silently
    // uncap the forgiveness the ceiling exists to bound.
    writeFileSync(
      sessionFile(directory, 'sid-bad-forgiven'),
      JSON.stringify({
        attempts: 1,
        ruleCounts: {},
        corrected: [],
        forgivenAttempts: 'oops',
      }),
    );

    expect(loadSession(directory, 'sid-bad-forgiven').forgivenAttempts).toBe(0);
  });

  it('loads a session written before the delta fields existed', () => {
    writeFileSync(
      sessionFile(directory, 'sid-pre-delta'),
      JSON.stringify({ attempts: 2, ruleCounts: {}, corrected: [] }),
    );

    const loaded = loadSession(directory, 'sid-pre-delta');
    expect(loaded.lastViolationKeys).toBeUndefined();
    expect(loaded.forgivenAttempts).toBe(0);
  });

  it('returns a fresh session when the file is missing', () => {
    expect(loadSession(directory, 'nope')).toEqual(createSession());
  });

  it('returns a fresh session when the file is corrupt', () => {
    saveSession(directory, 'sid1', createSession());
    writeFileSync(sessionFile(directory, 'sid1'), '{ not json');
    expect(loadSession(directory, 'sid1')).toEqual(createSession());
  });

  it('drops non-number ruleCounts values and non-string corrected entries', () => {
    // A tampered/corrupt file: `"n": "oops"` would make "oops" + 1 = "oops1".
    writeFileSync(
      sessionFile(directory, 'sid1'),
      JSON.stringify({
        attempts: 1,
        ruleCounts: { good: 2, bad: 'oops' },
        corrected: ['ok', 5, null],
      }),
    );
    expect(loadSession(directory, 'sid1')).toEqual({
      attempts: 1,
      escalated: false,
      forgivenAttempts: 0,
      ruleCounts: { good: 2 },
      corrected: ['ok'],
    });
  });

  it('preserves a real escalation flag and defaults malformed flags to false', () => {
    const file = sessionFile(directory, 'sid1');
    writeFileSync(
      file,
      JSON.stringify({
        attempts: 1,
        escalated: true,
        ruleCounts: {},
        corrected: [],
      }),
    );
    expect(loadSession(directory, 'sid1').escalated).toBe(true);
    writeFileSync(
      file,
      JSON.stringify({
        attempts: 1,
        escalated: 'true',
        ruleCounts: {},
        corrected: [],
      }),
    );
    expect(loadSession(directory, 'sid1').escalated).toBe(false);
  });

  it.each([
    null,
    [],
    { attempts: '1', ruleCounts: {}, corrected: [] },
    { attempts: 1, ruleCounts: [], corrected: [] },
    { attempts: 1, ruleCounts: {}, corrected: {} },
  ])('rejects a malformed session shape: %j', (raw) => {
    writeFileSync(sessionFile(directory, 'sid1'), JSON.stringify(raw));
    expect(loadSession(directory, 'sid1')).toEqual(createSession());
  });
});

describe('recurrence round-trip', () => {
  it('saves and loads recurrence counts', () => {
    saveRecurrence(directory, { 'ts/no-stub': 4 });
    expect(loadRecurrence(directory)).toEqual({ 'ts/no-stub': 4 });
  });

  it('returns empty counts when missing', () => {
    expect(loadRecurrence(directory)).toEqual({});
  });

  it('drops non-number values from a tampered recurrence file', () => {
    writeFileSync(
      recurrenceFile(directory),
      JSON.stringify({ good: 3, bad: 'oops' }),
    );
    expect(loadRecurrence(directory)).toEqual({ good: 3 });
  });
});

describe('violations manifest', () => {
  it('round-trips a manifest', () => {
    writeViolations(directory, 'sid1', [sample]);
    expect(readViolations(directory, 'sid1')).toEqual([sample]);
  });

  it('drops malformed entries defensively', () => {
    writeFileSync(
      path.join(directory, 'sid1.last.json'),
      JSON.stringify([sample, { ruleId: 'bad' }]),
    );
    expect(readViolations(directory, 'sid1')).toEqual([sample]);
  });

  it('returns empty when missing', () => {
    expect(readViolations(directory, 'nope')).toEqual([]);
  });
});

describe('deleteSession', () => {
  it('removes both the tally and the manifest', () => {
    saveSession(directory, 'sid1', createSession());
    writeViolations(directory, 'sid1', [sample]);
    deleteSession(directory, 'sid1');
    expect(loadSession(directory, 'sid1')).toEqual(createSession());
    expect(readViolations(directory, 'sid1')).toEqual([]);
  });
});

describe('sweepStale', () => {
  it('deletes session files older than the TTL and keeps fresh ones', () => {
    const now = 1_000_000_000_000;
    const dayMs = 86_400_000;
    saveSession(directory, 'old', createSession());
    saveSession(directory, 'fresh', createSession());
    // Age "old" to two days before `now`.
    const oldTime = new Date(now - 2 * dayMs);
    utimesSync(sessionFile(directory, 'old'), oldTime, oldTime);
    const freshTime = new Date(now - 1000);
    utimesSync(sessionFile(directory, 'fresh'), freshTime, freshTime);

    const deleted = sweepStale(directory, dayMs, now);

    expect(deleted).toEqual(['old.json']);
    expect(loadSession(directory, 'fresh')).toEqual(createSession());
  });

  it('spares recurrence.json from the TTL sweep, however stale', () => {
    // recurrence.json is the cross-session ledger, not a per-session tally --
    // it must survive the sweep regardless of age, or a team that commits it
    // (see plan.md's "Solo -> team") would find their own CI silently erasing
    // it on the next SessionStart.
    const now = 1_000_000_000_000;
    const dayMs = 86_400_000;
    saveRecurrence(directory, { 'ts/no-stub': 4 });
    const ancientTime = new Date(now - 365 * dayMs);
    utimesSync(recurrenceFile(directory), ancientTime, ancientTime);

    const deleted = sweepStale(directory, dayMs, now);

    expect(deleted).toEqual([]);
    expect(loadRecurrence(directory)).toEqual({ 'ts/no-stub': 4 });
  });

  it('removes stale manifests without reporting them as deleted sessions', () => {
    const now = 1_000_000_000_000;
    const dayMs = 86_400_000;
    writeViolations(directory, 'old', [sample]);
    const manifest = path.join(directory, 'old.last.json');
    const oldTime = new Date(now - 2 * dayMs);
    utimesSync(manifest, oldTime, oldTime);
    expect(sweepStale(directory, dayMs, now)).toEqual([]);
    expect(readViolations(directory, 'old')).toEqual([]);
  });

  it('keeps a session exactly on the TTL boundary', () => {
    const now = 1_000_000_000_000;
    const dayMs = 86_400_000;
    saveSession(directory, 'boundary', {
      ...createSession(),
      attempts: 2,
    });
    const boundaryTime = new Date(now - dayMs);
    utimesSync(sessionFile(directory, 'boundary'), boundaryTime, boundaryTime);
    expect(sweepStale(directory, dayMs, now)).toEqual([]);
    expect(loadSession(directory, 'boundary').attempts).toBe(2);
  });

  it('continues past a dangling state symlink whose metadata cannot be read', () => {
    symlinkSync(
      path.join(directory, 'missing-target'),
      path.join(directory, 'dangling.json'),
    );
    expect(sweepStale(directory, 1000, Date.now())).toEqual([]);
  });

  it('tolerates another session deleting a stale file after stat', () => {
    const now = 1_000_000_000_000;
    const file = sessionFile(directory, 'raced');
    saveSession(directory, 'raced', createSession());
    const oldTime = new Date(now - 2000);
    utimesSync(file, oldTime, oldTime);

    expect(() =>
      sweepStale(directory, 1000, now, (candidate, options) => {
        rmSync(candidate);
        rmSync(candidate, options);
      }),
    ).not.toThrow();
  });

  it('is a no-op on a missing directory', () => {
    expect(sweepStale(path.join(root, 'absent'), 1000, Date.now())).toEqual([]);
  });
});

describe('decision log', () => {
  const row = {
    at: '2026-09-01T10:00:00.000Z',
    rung: 'stop',
    session: 'sid',
    outcome: 'delegate' as const,
    fixer: 'guardrail-fixer',
    attempt: 1,
    violations: 2,
    rules: { 'stryker/survived': 2 },
    introduced: 0,
    resolved: 0,
    stalled: false,
  };

  it('appends rather than replaces, so the history accumulates', () => {
    appendDecision(directory, row);
    appendDecision(directory, { ...row, outcome: 'clean' });

    expect(readDecisions(directory).map((entry) => entry.outcome)).toEqual([
      'delegate',
      'clean',
    ]);
  });

  it('reads an empty log when nothing has been recorded', () => {
    expect(readDecisions(directory)).toEqual([]);
  });

  it('drops a malformed line instead of failing the whole report', () => {
    // A row is appended by one process and read by another; a half-written or
    // hand-edited line must not take the rest of the history with it.
    appendDecision(directory, row);
    appendFileSync(decisionsFile(directory), '{ not json\n');
    appendDecision(directory, { ...row, outcome: 'escalate' });

    expect(readDecisions(directory)).toHaveLength(2);
  });

  it('drops a well-formed line that is not a decision row', () => {
    appendFileSync(decisionsFile(directory), `${JSON.stringify({ a: 1 })}\n`);

    expect(readDecisions(directory)).toEqual([]);
  });

  it('survives the stale sweep, unlike the per-session files', () => {
    // The log is the one file in the state directory whose whole value is that
    // it outlives the sessions it describes.
    appendDecision(directory, row);
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    utimesSync(decisionsFile(directory), old, old);

    sweepStale(directory, 1000, Date.now());

    expect(readDecisions(directory)).toHaveLength(1);
  });
});

describe('fixer leases', () => {
  const lease: FixerLease = {
    owner: 'commit:sid-commit',
    manifestPath: '.guardrails/state/sid-commit.last.json',
    fixerAgent: 'guardrail-fixer',
    files: ['src/a.ts'],
    grantedAt: 1000,
    deferrals: 0,
  };

  it('round-trips what was saved', () => {
    saveLeases(directory, [lease]);
    expect(loadLeases(directory)).toEqual([lease]);
  });

  it('reads an empty list when nothing has ever claimed a file', () => {
    expect(loadLeases(directory)).toEqual([]);
  });

  it('reads an empty list from a corrupt file rather than bricking the turn', () => {
    writeFileSync(leasesFile(directory), '{ not json');
    expect(loadLeases(directory)).toEqual([]);
  });

  it('drops a malformed entry but keeps the well-formed ones', () => {
    // Several short-lived processes write this file; a half-written entry must
    // not take the live claims with it, and must not be trusted either -- a
    // lease missing its fixer would make a gate wait for nobody.
    writeFileSync(
      leasesFile(directory),
      JSON.stringify([lease, { owner: 'stop:sid' }, 'nope']),
    );
    expect(loadLeases(directory)).toEqual([lease]);
  });

  it('reads an empty list when the file is not an array', () => {
    writeFileSync(leasesFile(directory), JSON.stringify({ owner: 'stop:sid' }));
    expect(loadLeases(directory)).toEqual([]);
  });

  it('survives the stale sweep, which would report it as a swept session', () => {
    // `leases.json` is shared across sessions like `recurrence.json`, not
    // per-session like the tallies. Sweeping it would also push its name into
    // the swept-session list the caller reports.
    saveLeases(directory, [lease]);
    const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    utimesSync(leasesFile(directory), old, old);

    expect(sweepStale(directory, 1000, Date.now())).toEqual([]);
    expect(loadLeases(directory)).toEqual([lease]);
  });
});

/**
 * #104: the resolved base ref is remembered per branch so the Stop rung, which
 * runs every turn, costs at most one host call per branch per TTL.
 */
describe('baseReferenceCache', () => {
  it('round-trips an entry through the state directory', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const cache = baseReferenceCache(repoRoot);
    expect(cache.read()).toEqual({});
    cache.write('feature/child', { base: 'feature/parent', at: 42 });
    expect(baseReferenceCache(repoRoot).read()).toEqual({
      'feature/child': { base: 'feature/parent', at: 42 },
    });
  });

  it('remembers a MISS as a null base', () => {
    // A branch with no pull request must not pay a round-trip once a turn to
    // rediscover that it still has none.
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    baseReferenceCache(repoRoot).write('solo', { base: null, at: 7 });
    expect(baseReferenceCache(repoRoot).read()).toEqual({
      solo: { base: null, at: 7 },
    });
  });

  it('degrades to empty on a corrupt file rather than throwing', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const directory = path.join(repoRoot, '.guardrails', 'state');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'base-refs.json'), '{ not json');
    expect(baseReferenceCache(repoRoot).read()).toEqual({});
  });

  it.each([
    ['a non-object entry', 'not an object'],
    ['a numeric base', { base: 5, at: 1 }],
    ['a non-numeric timestamp', { base: 'main', at: 'soon' }],
    ['a missing timestamp', { base: 'main' }],
    ['an array', [{ base: 'main', at: 1 }]],
  ])('rejects %s', (_label, entry) => {
    // Each clause of the entry guard gets its own rejection: a guard that is
    // only ever shown well-formed input plus one catch-all is a guard nobody
    // has pinned.
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const directory = path.join(repoRoot, '.guardrails', 'state');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'base-refs.json'),
      JSON.stringify({ suspect: entry }),
    );
    expect(baseReferenceCache(repoRoot).read()).toEqual({});
  });

  it('keeps a null base, which is a remembered MISS and not a malformed one', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const directory = path.join(repoRoot, '.guardrails', 'state');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'base-refs.json'),
      JSON.stringify({ solo: { base: null, at: 3 } }),
    );
    expect(baseReferenceCache(repoRoot).read()).toEqual({
      solo: { base: null, at: 3 },
    });
  });

  it('preserves entries for other branches when writing one', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const cache = baseReferenceCache(repoRoot);
    cache.write('first', { base: 'main', at: 1 });
    cache.write('second', { base: 'feature/parent', at: 2 });
    expect(baseReferenceCache(repoRoot).read()).toEqual({
      first: { base: 'main', at: 1 },
      second: { base: 'feature/parent', at: 2 },
    });
  });

  it('drops individual entries that are not well formed', () => {
    // Same reasoning as the lease store: one tampered entry must not discard
    // every remembered base and send every branch back to the host.
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-'));
    const directory = path.join(repoRoot, '.guardrails', 'state');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'base-refs.json'),
      JSON.stringify({
        good: { base: 'main', at: 1 },
        bad: { base: 5, at: 'soon' },
        alsoBad: 'not an object',
      }),
    );
    expect(baseReferenceCache(repoRoot).read()).toEqual({
      good: { base: 'main', at: 1 },
    });
  });
});

describe('baseReferenceCache write containment', () => {
  it('writes nothing when the repo root is an existing FILE', () => {
    // Not the same case as a missing path, and the one an existence check
    // lets through: `mkdirSync(..., { recursive: true })` throws ENOTDIR on an
    // ancestor segment that is a file, and nothing between the memo and the
    // gate's caller catches it — so the stop rung would abort with a generic
    // error on every turn. Found in review of #104.
    const notARepo = path.join(
      mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-')),
      'a-file',
    );
    writeFileSync(notARepo, 'not a directory\n');
    expect(() => {
      baseReferenceCache(notARepo).write('feature/child', {
        base: 'main',
        at: 1,
      });
    }).not.toThrow();
    expect(baseReferenceCache(notARepo).read()).toEqual({});
  });

  it('writes nothing when the repo root is not a directory', () => {
    // The memo is an optimisation, so "could not write" is a complete answer.
    // Without this, `mkdirSync(..., { recursive: true })` fabricates the whole
    // tree from whatever string arrived as the repo root — which is exactly
    // what happened in this suite, leaving directories named after an eslint
    // JSON report in the working tree.
    const notARepo = path.join(
      mkdtempSync(path.join(tmpdir(), 'guardrails-base-ref-')),
      'no-such-root',
    );
    baseReferenceCache(notARepo).write('feature/child', {
      base: 'main',
      at: 1,
    });
    expect(existsSync(notARepo)).toBe(false);
    expect(baseReferenceCache(notARepo).read()).toEqual({});
  });
});
