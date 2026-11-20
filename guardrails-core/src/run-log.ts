/**
 * The machine-wide log of gate and ship runs (#176): one JSON line per run,
 * beside the gate lock, so every checkout on the machine writes to one file
 * and `guardrails stats` can read a whole wave's timings back.
 *
 * Writing never throws: a gate or a ship must not fail over its own
 * bookkeeping, so `appendRun` answers an error for the caller to print.
 * Reading is defensive line by line, as the decision log's is: a writer may
 * be killed mid-line, and one bad line must not cost the history.
 */
import { appendFileSync } from 'node:fs';
import { freemem, loadavg } from 'node:os';

import { isRecord } from './is-record.js';
import { parseJsonText } from './json-file.js';

export interface MachineSample {
  load1: number;
  freeMb: number;
}

interface MachinePart {
  cores: number;
  /**
  Stryker's configured `concurrency`, or `default`.
  */
  concurrency: string;
  start: MachineSample;
  end: MachineSample;
}

interface LockPart {
  queuedMs: number;
  heldMs: number;
  /**
  Who held the lock when this run arrived; absent when it was free.
  */
  holderOnArrival?: string | undefined;
  /**
  Runs waiting ahead of this one when it arrived.
  */
  depthOnArrival: number;
}

interface CachePart {
  local: string;
  seed: string;
  /**
  Why the local cache was discarded or the seed refused.
  */
  why?: string | undefined;
}

interface StrykerPart {
  /**
  Changed files in mutation scope.
  */
  files: number;
  cache?: CachePart | undefined;
  dryRunMs?: number | undefined;
  mutatingMs?: number | undefined;
  mutants?: number | undefined;
  reused?: number | undefined;
  timeouts?: number | undefined;
  survivors?: number | undefined;
  noCoverage?: number | undefined;
  /**
  Whether stryker's JSON report could be read for the counts.
  */
  report: 'read' | 'missing';
}

interface RowBase {
  v: 1;
  repo: string;
  branch?: string | undefined;
  /**
  The ship that ran this gate, or this ship's own id.
  */
  ship?: string | undefined;
  startedAt: string;
  finishedAt: string;
  machine?: MachinePart | undefined;
}

export interface GateRow extends RowBase {
  kind: 'gate';
  rung: string;
  outcome: string;
  lock?: LockPart | undefined;
  stryker?: StrykerPart | undefined;
}

export interface ShipRow extends RowBase {
  kind: 'ship';
  pr: number | null;
  state: string;
  /**
  `git push`'s wall time, the pre-push gate included.
  */
  pushMs: number;
  gateMs?: number | undefined;
  /**
  From the pull request found to its checks settled.
  */
  ciMs?: number | undefined;
}

export type RunRow = GateRow | ShipRow;

/**
The slice of `node:os` a machine sample reads.
*/
interface MachineSeams {
  loadavg: () => number[];
  freemem: () => number;
}

const BYTES_PER_MB = 1024 * 1024;

/**
The machine's 1-minute load average and free memory, now.
*/
const NODE_OS: MachineSeams = { loadavg, freemem };

export function sampleMachine(seams: MachineSeams = NODE_OS): MachineSample {
  const [load1 = 0] = seams.loadavg();
  return {
    load1: Math.round(load1 * 100) / 100,
    freeMb: Math.round(seams.freemem() / BYTES_PER_MB),
  };
}

/**
Stryker's configured `concurrency` as text, or `default` when it sets none.
*/
export function concurrencyOf(strykerConfig: string): string {
  const { parsed } = parseJsonText(strykerConfig);
  const value = isRecord(parsed) ? parsed.concurrency : undefined;
  return typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : 'default';
}

/**
Where the run log for `lockPath` lives: beside the lock.
*/
export function runLogPath(lockPath: string): string {
  return `${lockPath}.runs.jsonl`;
}

/**
 * Append `row` as one line, or answer why it could not be. One `appendFile`
 * call writes the whole line with `O_APPEND`, so rows from concurrent gates
 * do not interleave on a local filesystem.
 */
export function appendRun(file: string, row: RunRow): string | undefined {
  try {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Fields = Record<string, unknown>;

function isFiniteNumber(value: unknown): value is number {
  // `Number.isFinite` does not coerce, so it is false for every non-number.
  return Number.isFinite(value);
}

function numberOf(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return isFiniteNumber(value) ? value : undefined;
}

function stringOf(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

type FieldKind = 'number' | 'string';

/**
What `required` reads, per field: `number` for a finite number, `string`.
*/
type Required<Spec extends Record<string, FieldKind>> = {
  [Key in keyof Spec]: Spec[Key] extends 'number' ? number : string;
};

/**
 * The fields `spec` names, each of its kind, or `undefined` when `value` is
 * not an object or any of them is missing or of another kind. The one place
 * a row's required fields are checked.
 */
function required<Spec extends Record<string, FieldKind>>(
  value: unknown,
  spec: Spec,
): Required<Spec> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const read: Fields = {};
  for (const [key, kind] of Object.entries(spec)) {
    const field =
      kind === 'number' ? numberOf(value, key) : stringOf(value, key);
    if (field === undefined) {
      return undefined;
    }
    read[key] = field;
  }
  // Every key of `spec` was read above as the kind it names.
  return read as Required<Spec>;
}

/**
An optional string field of `value`, when `value` is an object.
*/
function optionalString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? stringOf(value, key) : undefined;
}

function sampleOf(value: unknown): MachineSample | undefined {
  return required(value, { load1: 'number', freeMb: 'number' });
}

function machineOf(value: unknown): MachinePart | undefined {
  const fields = required(value, { cores: 'number', concurrency: 'string' });
  if (fields === undefined || !isRecord(value)) {
    return undefined;
  }
  const start = sampleOf(value.start);
  const end = sampleOf(value.end);
  return start === undefined || end === undefined
    ? undefined
    : { ...fields, start, end };
}

function lockOf(value: unknown): LockPart | undefined {
  const fields = required(value, {
    queuedMs: 'number',
    heldMs: 'number',
    depthOnArrival: 'number',
  });
  return (
    fields && {
      ...fields,
      holderOnArrival: optionalString(value, 'holderOnArrival'),
    }
  );
}

function cacheOf(value: unknown): CachePart | undefined {
  const fields = required(value, { local: 'string', seed: 'string' });
  return fields && { ...fields, why: optionalString(value, 'why') };
}

const STRYKER_COUNTS = [
  'dryRunMs',
  'mutatingMs',
  'mutants',
  'reused',
  'timeouts',
  'survivors',
  'noCoverage',
] as const;

function strykerOf(value: unknown): StrykerPart | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const files = numberOf(value, 'files');
  const { report } = value;
  if (files === undefined || (report !== 'read' && report !== 'missing')) {
    return undefined;
  }
  return {
    files,
    cache: cacheOf(value.cache),
    ...Object.fromEntries(
      STRYKER_COUNTS.map((key) => [key, numberOf(value, key)]),
    ),
    report,
  };
}

/**
 * The fields every row has, or `undefined` when one is missing. Optional
 * parts that are malformed are dropped, not the row.
 */
function baseOf(fields: Fields): RowBase | undefined {
  const repo = stringOf(fields, 'repo');
  const startedAt = stringOf(fields, 'startedAt');
  const finishedAt = stringOf(fields, 'finishedAt');
  if (
    repo === undefined ||
    startedAt === undefined ||
    finishedAt === undefined ||
    fields.v !== 1
  ) {
    return undefined;
  }
  return {
    v: 1,
    repo,
    branch: stringOf(fields, 'branch'),
    ship: stringOf(fields, 'ship'),
    startedAt,
    finishedAt,
    machine: machineOf(fields.machine),
  };
}

function gateOf(fields: Fields, base: RowBase): GateRow | undefined {
  const rung = stringOf(fields, 'rung');
  const outcome = stringOf(fields, 'outcome');
  return rung === undefined || outcome === undefined
    ? undefined
    : {
        ...base,
        kind: 'gate',
        rung,
        outcome,
        lock: lockOf(fields.lock),
        stryker: strykerOf(fields.stryker),
      };
}

function shipOf(fields: Fields, base: RowBase): ShipRow | undefined {
  const state = stringOf(fields, 'state');
  const pushMs = numberOf(fields, 'pushMs');
  const pr = numberOf(fields, 'pr') ?? null;
  return state === undefined || pushMs === undefined
    ? undefined
    : {
        ...base,
        kind: 'ship',
        pr,
        state,
        pushMs,
        gateMs: numberOf(fields, 'gateMs'),
        ciMs: numberOf(fields, 'ciMs'),
      };
}

function rowOf(line: string): RunRow | undefined {
  const { parsed } = parseJsonText(line);
  if (!isRecord(parsed)) {
    return undefined;
  }
  const base = baseOf(parsed);
  if (base === undefined) {
    return undefined;
  }
  if (parsed.kind === 'gate') {
    return gateOf(parsed, base);
  }
  return parsed.kind === 'ship' ? shipOf(parsed, base) : undefined;
}

/**
Every well-formed row in the log's text, oldest first.
*/
export function parseRuns(text: string): RunRow[] {
  return text.split('\n').flatMap((line) => {
    const row = rowOf(line);
    return row === undefined ? [] : [withoutUndefined(row) as RunRow];
  });
}

/**
`value` without its undefined fields, at any depth, as JSON would leave it.
*/
function withoutUndefined(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, withoutUndefined(field)]),
  );
}
