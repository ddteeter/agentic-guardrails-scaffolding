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
}

/**
Content hash, algorithm-prefixed so the committed file says what it used.
*/
export function checksum(content: string): string {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('hex')}`;
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
  const { guardrailsVersion, files } = parsed;
  if (typeof guardrailsVersion !== 'string' || !isRecord(files)) {
    return undefined;
  }
  const checked: Record<string, string> = {};
  for (const [file, value] of Object.entries(files)) {
    if (typeof value === 'string') {
      checked[file] = value;
    }
  }
  return { guardrailsVersion, files: checked };
}

export function serializeManifest(manifest: ScaffoldManifest): string {
  // `Object.entries` (rather than `Object.keys` + index access) keeps values
  // typed as `string`, not `string | undefined` — with `noUncheckedIndexedAccess`
  // an index-access guard here would be unreachable for any input that actually
  // satisfies `ScaffoldManifest`, which is exactly the kind of dead defensive
  // branch a mutation test cannot distinguish from `if (true)`.
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(manifest.files).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify(
    { guardrailsVersion: manifest.guardrailsVersion, files },
    undefined,
    2,
  )}\n`;
}
