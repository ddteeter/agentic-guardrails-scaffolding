import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSession } from '../src/state.js';
import {
  deleteSession,
  loadRecurrence,
  loadSession,
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
      ruleCounts: { 'ts/no-stub': 3 },
      corrected: [],
    };
    saveSession(directory, 'sid1', state);
    expect(loadSession(directory, 'sid1')).toEqual(state);
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
      ruleCounts: { good: 2 },
      corrected: ['ok'],
    });
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

  it('is a no-op on a missing directory', () => {
    expect(sweepStale(path.join(root, 'absent'), 1000, Date.now())).toEqual([]);
  });
});
