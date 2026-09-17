/**
 * Persistence layer for session tally, recurrence counter, and the violations
 * manifest. All state lives under the repo's `.guardrails/state/` so
 * recurrence data is per-repo and (for teams) committable.
 *
 * Every read is defensive: missing or corrupt files degrade to an empty
 * default rather than throwing, so a mangled state file never bricks a turn.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { type DecisionRecord, isDecisionRecord } from './decision-log.js';
import {
  createSession,
  type RecurrenceCounts,
  type SessionState,
} from './state.js';
import { isViolation, type Violation } from './violation.js';

export function stateDirectory(repoRoot: string): string {
  return path.join(repoRoot, '.guardrails', 'state');
}

export function sessionFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.json`);
}

export function manifestFile(directory: string, sessionId: string): string {
  return path.join(directory, `${sessionId}.last.json`);
}

export function recurrenceFile(directory: string): string {
  return path.join(directory, 'recurrence.json');
}

function readJson(file: string): unknown {
  // prettier-ignore
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  // Emptying this catch reaches the function's implicit undefined return, the
  // same value returned explicitly here.
  // Stryker disable next-line BlockStatement
  catch {
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

/**
Keep only the entries whose value is a number — drops tampered/corrupt ones.
*/
function numberRecord(raw: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number') {
      result[key] = value;
    }
  }
  return result;
}

export function loadSession(
  directory: string,
  sessionId: string,
): SessionState {
  const raw = readJson(sessionFile(directory, sessionId));
  if (!isRecord(raw)) {
    return createSession();
  }
  const {
    attempts,
    escalated,
    forgivenAttempts,
    ruleCounts,
    corrected,
    lastViolationDigest,
    lastViolationKeys,
  } = raw;
  if (
    typeof attempts !== 'number' ||
    !isRecord(ruleCounts) ||
    !Array.isArray(corrected)
  ) {
    return createSession();
  }
  // Validate values, not just shape: a tampered/corrupt file with a string
  // count would make `"oops" + 1 = "oops1"` and silently break tallying.
  return {
    attempts,
    // Backward-compatible with state written before terminal escalation was
    // tracked: an absent flag means no escalation is armed.
    escalated: typeof escalated === 'boolean' ? escalated : false,
    ruleCounts: numberRecord(ruleCounts),
    corrected: corrected.filter((entry) => typeof entry === 'string'),
    // Spread rather than an unconditional key so an absent digest stays ABSENT
    // rather than becoming an explicit `undefined` — `loadSession`'s result is
    // compared with `toEqual` against a session that never had the field, and
    // more importantly the gate's `=== digest` check must not treat "no
    // previous block" as a value.
    //
    // Validated as a string for the same reason `ruleCounts` validates its
    // numbers: this file is on disk and a wrong type here would reach the
    // gate's comparison. This field is why the unchanged-retry check works at
    // all — every Stop-hook fire is a fresh CLI process, so this file is the
    // only channel between one block and the next retry. It was omitted from
    // this whitelist when the field was added, which made the check dead code
    // in production while every in-memory unit test passed (found in review of
    // #47).
    ...(typeof lastViolationDigest === 'string' && { lastViolationDigest }),
    // Conditionally spread for the same reason as the digest: an absent list
    // means "no previous block to compare against", which `violationDelta`
    // must be able to tell apart from an empty one. Entries are filtered to
    // strings the way `corrected` is -- a tampered non-string reaching the
    // delta would read as an identity that never existed, i.e. a resolution
    // the fixer never made.
    ...(Array.isArray(lastViolationKeys) && {
      lastViolationKeys: lastViolationKeys.filter(
        (entry) => typeof entry === 'string',
      ),
    }),
    // Defaulted, not conditionally spread: unlike the two fields above, zero
    // and absent mean the same thing here -- no attempt in this loop has been
    // forgiven yet -- so state written before the ceiling existed reads
    // correctly as a full allowance.
    forgivenAttempts:
      typeof forgivenAttempts === 'number' ? forgivenAttempts : 0,
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
  return isRecord(raw) ? numberRecord(raw) : {};
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
 * The durable decision log (#83).
 *
 * `.jsonl`, not `.json`, for two reasons that both matter here: appending one
 * line is atomic enough for a file several processes write to and nobody reads
 * concurrently, and the extension keeps it out of `sweepStale`, which collects
 * every `*.json` in this directory that is not the recurrence counter. The log
 * exists precisely to outlive the sessions it describes, so being swept would
 * defeat it.
 *
 * Gitignored with the rest of `state/*`: it is one repo's own measurements, not
 * a shared artifact, and it grows by roughly one short line per gate firing.
 */
export function decisionsFile(directory: string): string {
  return path.join(directory, 'decisions.jsonl');
}

export function appendDecision(directory: string, entry: DecisionRecord): void {
  mkdirSync(directory, { recursive: true });
  appendFileSync(decisionsFile(directory), `${JSON.stringify(entry)}\n`);
}

/**
 * Every well-formed row, oldest first.
 *
 * Defensive line by line rather than for the file as a whole: one row is
 * written by a process that may be killed mid-write, and losing the entire
 * history to a single truncated line would make the log less trustworthy than
 * no log at all.
 *
 * There is deliberately no separate "skip blank lines" guard: `JSON.parse` on
 * an empty or whitespace-only line always throws, which the catch below
 * already handles by leaving `parsed` undefined -- the guard below rejects
 * that the same way it rejects any other malformed line, so a dedicated
 * early-continue would be a second path to the one answer, untestable by
 * construction (the pattern `verify/npm-peers-adapter.ts` also uses).
 */
export function readDecisions(directory: string): DecisionRecord[] {
  let text: string;
  try {
    text = readFileSync(decisionsFile(directory), 'utf8');
  } catch {
    return [];
  }
  const rows: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Deliberately empty: leaving `parsed` undefined lets the guard below
      // reject it, so a blank line and malformed JSON share ONE exit.
    }
    if (isDecisionRecord(parsed)) {
      rows.push(parsed);
    }
  }
  return rows;
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
  removeFile: (file: string, options: { force: true }) => void = (
    file,
    options,
  ) => {
    rmSync(file, options);
  },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const deleted: string[] = [];
  for (const name of entries) {
    if (name === 'recurrence.json' || !name.endsWith('.json')) {
      continue;
    }
    const file = path.join(directory, name);
    let mtimeMs: number;
    // prettier-ignore
    try {
      mtimeMs = statSync(file).mtimeMs;
    }
    // Emptying this catch leaves mtimeMs undefined; the age comparison is then
    // false and skips the entry, exactly as this explicit continue does.
    // Stryker disable next-line BlockStatement
    catch {
      continue;
    }
    if (now - mtimeMs > maxAgeMs) {
      // Another session can sweep the same entry after our stat. `force`
      // makes that ordinary race an idempotent delete rather than an ENOENT
      // that bricks SessionStart.
      removeFile(file, { force: true });
      if (!name.endsWith('.last.json')) {
        deleted.push(name);
      }
    }
  }
  return deleted;
}
