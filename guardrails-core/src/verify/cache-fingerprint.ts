/**
 * What stryker's incremental cache was measured UNDER, written beside it as
 * `reports/stryker-incremental.fingerprint.json` (#156, the critique on deps).
 *
 * The cache rewriter (`incremental-cache.ts`) decides which verdicts survive
 * a change to the tests. It cannot see a change to the machinery that produced
 * them: a stryker upgrade can change mutators or ids, a config edit can change
 * the runner or the mutate set, and a dependency bump can change what the code
 * under test does at all. Any of the three discards the whole cache, and a
 * sidecar that is missing, unreadable or malformed counts as a change.
 *
 * Pure: the caller reads the inputs (installed stryker's manifest, the config
 * text it already holds, whichever lockfiles exist) and this only hashes and
 * compares them.
 */

import { createHash } from 'node:crypto';

import { isRecord } from '../is-record.js';
import { parseJsonText } from '../json-file.js';

export interface CacheFingerprint {
  readonly stryker: string;
  /**
  sha256 of the stryker config text.
  */
  readonly config: string;
  /**
  sha256 over every lockfile present, each with its name.
  */
  readonly lockfile: string;
}

export interface Lockfile {
  readonly name: string;
  readonly contents: string;
}

export interface FingerprintInputs {
  /**
  The installed `@stryker-mutator/core` version; `undefined` if unread.
  */
  readonly strykerVersion: string | undefined;
  readonly config: string;
  /**
  The lockfiles that exist, in a fixed order.
  */
  readonly lockfiles: readonly Lockfile[];
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
  // JSON rather than a delimiter join: no file name or contents can make two
  // different lockfile sets serialize alike.
  const lockfiles = JSON.stringify(
    inputs.lockfiles.map(({ name, contents }) => [name, contents]),
  );
  return {
    stryker: inputs.strykerVersion,
    config: sha256(inputs.config),
    lockfile: sha256(lockfiles),
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
    typeof parsed.config !== 'string' ||
    typeof parsed.lockfile !== 'string'
  ) {
    return undefined;
  }
  return {
    stryker: parsed.stryker,
    config: parsed.config,
    lockfile: parsed.lockfile,
  };
}

/**
Do `a` and `b` agree on all three fields?
*/
export function isFingerprintEqual(
  a: CacheFingerprint,
  b: CacheFingerprint,
): boolean {
  return (
    a.stryker === b.stryker &&
    a.config === b.config &&
    a.lockfile === b.lockfile
  );
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
