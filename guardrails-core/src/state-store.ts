/**
 * Persistence layer for session tally, recurrence counter, and the violations
 * manifest. All state lives under the repo's `.claude/state/guardrails/` so
 * recurrence data is per-repo and (for teams) committable.
 *
 * Every read is defensive: missing or corrupt files degrade to an empty
 * default rather than throwing, so a mangled state file never bricks a turn.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createSession,
  type RecurrenceCounts,
  type SessionState,
} from './state.js';
import { isViolation, type Violation } from './violation.js';

export function stateDirectory(repoRoot: string): string {
  return path.join(repoRoot, '.claude', 'state', 'guardrails');
}

export function sessionFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.json`);
}

export function manifestFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.last.json`);
}

function recurrenceFile(directory: string): string {
  return path.join(directory, 'recurrence.json');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSession(
  directory: string,
  sessionId: string,
): SessionState {
  const raw = readJson(sessionFile(directory, sessionId));
  if (!isRecord(raw)) {
    return createSession();
  }
  const { attempts, ruleCounts, corrected } = raw;
  if (
    typeof attempts !== 'number' ||
    !isRecord(ruleCounts) ||
    !Array.isArray(corrected)
  ) {
    return createSession();
  }
  return {
    attempts,
    ruleCounts: ruleCounts as Record<string, number>,
    corrected: corrected as string[],
  };
}

export function saveSession(
  directory: string,
  sessionId: string,
  state: SessionState,
): void {
  writeJson(sessionFile(directory, sessionId), state);
}

export function deleteSession(directory: string, sessionId: string): void {
  rmSync(sessionFile(directory, sessionId), { force: true });
  rmSync(manifestFile(directory, sessionId), { force: true });
}

export function loadRecurrence(directory: string): RecurrenceCounts {
  const raw = readJson(recurrenceFile(directory));
  return isRecord(raw) ? (raw as RecurrenceCounts) : {};
}

export function saveRecurrence(
  directory: string,
  counts: RecurrenceCounts,
): void {
  writeJson(recurrenceFile(directory), counts);
}

export function writeViolations(
  directory: string,
  sessionId: string,
  violations: readonly Violation[],
): void {
  writeJson(manifestFile(directory, sessionId), violations);
}

export function readViolations(
  directory: string,
  sessionId: string,
): Violation[] {
  const raw = readJson(manifestFile(directory, sessionId));
  return Array.isArray(raw) ? raw.filter((entry) => isViolation(entry)) : [];
}

/**
 * Delete session tallies + manifests whose backing file is older than
 * `maxAgeMs` relative to `now`. Returns the deleted tally filenames.
 * Called at SessionStart to keep the state dir from accumulating stale runs.
 */
export function sweepStale(
  directory: string,
  maxAgeMs: number,
  now: number,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'recurrence.json') {
      continue;
    }
    const file = path.join(directory, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > maxAgeMs) {
      rmSync(file, { force: true });
      if (!name.endsWith('.last.json')) {
        deleted.push(name);
      }
    }
  }
  return deleted;
}
