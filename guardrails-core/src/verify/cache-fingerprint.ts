/**
 * What stryker's incremental cache was measured UNDER, written beside it as
 * `reports/stryker-incremental.fingerprint.json` (#156, the critique on deps).
 *
 * The cache rewriter (`incremental-cache.ts`) decides which verdicts survive
 * a change to the tests. It cannot see a change to the machinery that produced
 * them: a stryker upgrade can change mutators or ids, a config edit can change
 * the runner, and a dependency bump can change what the code under test does
 * at all. Any of the three discards the whole cache, and a sidecar that is
 * missing, unreadable or malformed counts as a change.
 *
 * Each part holds only what can change a verdict (#177). It used to hash the
 * whole config and every lockfile, so a `mutate` entry for another module or
 * a formatter bump threw away every seed. Now `options` leaves out the config
 * keys that cannot change how a mutant is judged, and `dependencies` is the
 * installed versions of the packages that run the code and its tests
 * (`verdict-dependencies.ts`), or the lockfiles where those cannot be read.
 *
 * Pure: the caller reads the inputs (installed stryker's manifest, the config
 * text it already holds, the pinned versions or the lockfiles) and this only
 * hashes and compares them.
 */

import { createHash } from 'node:crypto';

import { isRecord } from '../is-record.js';
import { parseJsonText } from '../json-file.js';

/**
 * Field names differ from the pre-#177 `config` and `lockfile`, so a sidecar
 * written by an older guardrails reads as no fingerprint (a cold run) rather
 * than as one measured the new way.
 */
export interface CacheFingerprint {
  readonly stryker: string;
  /**
  sha256 of `verdictOptions(config)`.
  */
  readonly options: string;
  /**
  sha256 of the pinned versions, or of every lockfile present.
  */
  readonly dependencies: string;
}

/**
The fingerprint's fields, in the order a difference names them.
*/
export type FingerprintField = keyof CacheFingerprint;

const FIELDS: readonly FingerprintField[] = [
  'stryker',
  'options',
  'dependencies',
];

export interface Lockfile {
  readonly name: string;
  readonly contents: string;
}

/**
 * What the dependency part is measured from: `name@version` for every package
 * that runs the code or its tests, or -- where those cannot be read -- the
 * lockfiles that exist, in a fixed order.
 */
export type DependencyEvidence =
  | { readonly pins: readonly string[] }
  | { readonly lockfiles: readonly Lockfile[] };

export interface FingerprintInputs {
  /**
  The installed `@stryker-mutator/core` version; `undefined` if unread.
  */
  readonly strykerVersion: string | undefined;
  readonly config: string;
  readonly dependencies: DependencyEvidence;
}

/**
 * Config keys that cannot change how a mutant is judged (#177). A denylist on
 * purpose: a key this does not know -- a new stryker option, a plugin's block
 * -- still counts, so being wrong costs a cold run, never a wrong verdict.
 *
 * `mutate` is here because it chooses WHICH files are mutated, never how a
 * mutant in them is judged, and the gate intersects it with the change set
 * itself. The rest are output, scheduling and bookkeeping.
 */
const NO_VERDICT_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'mutate',
  'reporters',
  'htmlReporter',
  'jsonReporter',
  'clearTextReporter',
  'dashboard',
  'eventReporter',
  'thresholds',
  'concurrency',
  'logLevel',
  'fileLogLevel',
  'allowConsoleColors',
  'tempDirName',
  'cleanTempDir',
  'incremental',
  'incrementalFile',
  'force',
  'dryRunOnly',
]);

/**
`value` with every object's keys sorted, at any depth; arrays keep order.
*/
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortedKeys(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

/**
 * The part of a stryker config that can change a verdict, as stable text:
 * the config without `NO_VERDICT_KEYS`, its keys sorted. A config that is not
 * a JSON object is returned whole -- every change to it counts, as before.
 */
export function verdictOptions(config: string): string {
  const { parsed } = parseJsonText(config);
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return config;
  }
  const kept = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !NO_VERDICT_KEYS.has(key)),
  );
  return JSON.stringify(sortedKeys(kept));
}

/**
 * The lockfiles a fingerprint reads, in the order it reads them. Each is
 * hashed WITH its name, so switching package manager is a change even when no
 * version moved.
 */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The evidence as one text. JSON rather than a delimiter join, so no name or
 * contents can make two different sets serialize alike, and tagged, so pins
 * and lockfiles can never collide. Pins are sorted: the order they were found
 * in is the walk's, not the checkout's.
 */
function dependencyText(evidence: DependencyEvidence): string {
  if ('pins' in evidence) {
    return JSON.stringify([
      'pins',
      evidence.pins.toSorted((left, right) => left.localeCompare(right)),
    ]);
  }
  return JSON.stringify([
    'lockfiles',
    evidence.lockfiles.map(({ name, contents }) => [name, contents]),
  ]);
}

/**
 * The fingerprint for these inputs, or `undefined` when the stryker version is
 * unknown — an unknown version cannot be compared, so no cache may be kept
 * under it.
 */
export function computeFingerprint(
  inputs: FingerprintInputs,
): CacheFingerprint | undefined {
  if (inputs.strykerVersion === undefined || inputs.strykerVersion === '') {
    return undefined;
  }
  return {
    stryker: inputs.strykerVersion,
    options: sha256(verdictOptions(inputs.config)),
    dependencies: sha256(dependencyText(inputs.dependencies)),
  };
}

export function serializeFingerprint(fingerprint: CacheFingerprint): string {
  return `${JSON.stringify(fingerprint, undefined, 2)}\n`;
}

/**
 * The fingerprint in a sidecar's text, or `undefined` unless it holds all
 * three fields as strings.
 */
export function parseFingerprint(
  sidecarJson: string,
): CacheFingerprint | undefined {
  const { parsed } = parseJsonText(sidecarJson);
  if (
    !isRecord(parsed) ||
    typeof parsed.stryker !== 'string' ||
    typeof parsed.options !== 'string' ||
    typeof parsed.dependencies !== 'string'
  ) {
    return undefined;
  }
  return {
    stryker: parsed.stryker,
    options: parsed.options,
    dependencies: parsed.dependencies,
  };
}

/**
The fields on which `a` and `b` disagree, in field order.
*/
export function fingerprintDifference(
  a: CacheFingerprint,
  b: CacheFingerprint,
): FingerprintField[] {
  return FIELDS.filter((field) => a[field] !== b[field]);
}

/**
Do `a` and `b` agree on all three fields?
*/
export function isFingerprintEqual(
  a: CacheFingerprint,
  b: CacheFingerprint,
): boolean {
  return fingerprintDifference(a, b).length === 0;
}

/**
 * Was the cache beside `sidecarJson` written under `current`? Anything short
 * of three equal fields answers no.
 */
export function isSameFingerprint(
  sidecarJson: string,
  current: CacheFingerprint | undefined,
): boolean {
  const recorded = parseFingerprint(sidecarJson);
  return (
    current !== undefined &&
    recorded !== undefined &&
    isFingerprintEqual(recorded, current)
  );
}

/**
The `version` of a package manifest, or `undefined`.
*/
export function strykerVersionFrom(manifestJson: string): string | undefined {
  const { parsed } = parseJsonText(manifestJson);
  return isRecord(parsed) && typeof parsed.version === 'string'
    ? parsed.version
    : undefined;
}
