/**
 * The committed scaffold manifest (`.guardrails/scaffold.json`).
 *
 * `guardrails init` writes a set of files into a consumer repo, and a re-run
 * has to tell three cases apart: a file it wrote that nobody touched (safe to
 * upgrade), a file the consumer edited (leave alone, report drift), and a file
 * it has never written (create). A checksum per file is what separates them.
 *
 * Serialization is deterministic — sorted keys, no timestamp — so the committed
 * file stays out of every diff and a CI drift-check can work on it.
 *
 * It lives BESIDE `.guardrails/state/`, not inside it: state is gitignored and
 * swept on a TTL, and this must be committed.
 */
import { createHash } from 'node:crypto';

import { isRecord } from './record.js';

export const MANIFEST_PATH = '.guardrails/scaffold.json';

export interface ScaffoldManifest {
  readonly guardrailsVersion: string;
  readonly files: Readonly<Record<string, string>>;
  /**
   * Path -> `fingerprint` of the content written, beside its exact checksum.
   * Absent in manifests written before 0.12.0; those fall back to the bundled
   * legacy table (see `modificationOf`).
   */
  readonly fingerprints?: Readonly<Record<string, string>>;
}

/**
Content hash, algorithm-prefixed so the committed file says what it used.
*/
export function checksum(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Content hash over the words alone: lowercased, with everything that is not
 * a Unicode letter or digit removed. Formatters rewrite whitespace, wrapping,
 * quote characters, optional punctuation and markdown markers, but not words,
 * so a file a consumer's formatter reformatted after `init` wrote it keeps
 * the fingerprint of what was written. Whichever formatter the repo runs.
 *
 * It errs both ways, deliberately. A formatter that changes a letter or digit
 * (renumbering a list) makes a reformat read as an edit, which is the old,
 * safe behaviour. An edit that changes only punctuation reads as unmodified
 * and is overwritten on upgrade, which owned files' do-not-edit contract
 * accepts.
 */
export function fingerprint(content: string): string {
  const words = content.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '');
  return `words-${checksum(words)}`;
}

/**
 * How an owned file on disk relates to what `init` recorded writing there:
 * byte-identical, the same words under a consumer's formatter, or edited.
 *
 * The recorded fingerprint is the manifest's own when it has one. A manifest
 * written before fingerprints existed falls back to `legacyFingerprints`,
 * the bundled table mapping every checksum a release ever wrote to that
 * content's fingerprint. Going through the recorded checksum keeps the proof
 * specific to this repo: the file is a reformat of what was written HERE, not
 * merely of something some release shipped. A path the manifest does not
 * record is always `edited`. Words alone never vouch for a file.
 */
export function modificationOf(
  path: string,
  onDisk: string,
  manifest: ScaffoldManifest | undefined,
  legacyFingerprints: Readonly<Record<string, string>>,
): 'unmodified' | 'reformatted' | 'edited' {
  if (manifest === undefined) {
    return 'edited';
  }
  const recorded = manifest.files[path];
  if (recorded === undefined) {
    return 'edited';
  }
  if (recorded === checksum(onDisk)) {
    return 'unmodified';
  }
  const recordedFingerprint =
    manifest.fingerprints?.[path] ?? legacyFingerprints[recorded];
  return recordedFingerprint === fingerprint(onDisk) ? 'reformatted' : 'edited';
}

/**
`modificationOf`, for callers that only need to know whether it is safe to
upgrade the file.
*/
export function isUnmodified(
  path: string,
  onDisk: string,
  manifest: ScaffoldManifest | undefined,
  legacyFingerprints: Readonly<Record<string, string>>,
): boolean {
  return (
    modificationOf(path, onDisk, manifest, legacyFingerprints) !== 'edited'
  );
}

/**
 * Parse a manifest defensively. Anything malformed yields `undefined` (treat the
 * repo as unscaffolded); an individual entry with a non-string checksum is
 * dropped, which makes that file read as untracked — so `init` reports drift
 * rather than silently overwriting a consumer's edit. Both directions fail
 * toward not touching the consumer's files.
 */
export function parseManifest(parsed: unknown): ScaffoldManifest | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { guardrailsVersion, files, fingerprints } = parsed;
  if (typeof guardrailsVersion !== 'string' || !isRecord(files)) {
    return undefined;
  }
  const checked = stringEntries(files);
  const checkedFingerprints = isRecord(fingerprints)
    ? stringEntries(fingerprints)
    : {};
  return Object.keys(checkedFingerprints).length === 0
    ? { guardrailsVersion, files: checked }
    : { guardrailsVersion, files: checked, fingerprints: checkedFingerprints };
}

/**
The string-valued entries of `record`; anything else is dropped.
*/
function stringEntries(
  record: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const checked: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      checked[key] = value;
    }
  }
  return checked;
}

function sortedByKey(
  record: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function serializeManifest(manifest: ScaffoldManifest): string {
  // `Object.entries` (rather than `Object.keys` + index access) keeps values
  // typed as `string`, not `string | undefined` — with `noUncheckedIndexedAccess`
  // an index-access guard here would be unreachable for any input that actually
  // satisfies `ScaffoldManifest`, which is exactly the kind of dead defensive
  // branch a mutation test cannot distinguish from `if (true)`.
  const files = sortedByKey(manifest.files);
  const fingerprints = sortedByKey(manifest.fingerprints ?? {});
  // An empty map is left out so a manifest from before fingerprints existed
  // re-serializes byte-for-byte until something is actually written.
  const body =
    Object.keys(fingerprints).length === 0
      ? { guardrailsVersion: manifest.guardrailsVersion, files }
      : { guardrailsVersion: manifest.guardrailsVersion, files, fingerprints };
  return `${JSON.stringify(body, undefined, 2)}\n`;
}
