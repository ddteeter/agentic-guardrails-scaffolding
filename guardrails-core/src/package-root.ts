/**
 * Where guardrails-core itself is installed.
 *
 * `guardrails init` writes a template tree into a CONSUMER's repository, so the
 * templates must resolve against the installed package — a consumer has no
 * `templates/` or `guidance/` of their own, and `process.cwd()` is their repo,
 * not ours.
 *
 * The `'..'` is a property of THIS FILE'S LOCATION, which is why it lives here
 * alone rather than inside `scaffold/`: `src/` (what vitest runs) and `dist/`
 * (what tsup emits — every entry and every shared chunk lands directly in
 * `dist/`, never nested) are each exactly one level below the package root, so
 * one `'..'` is correct in both. A module two levels down would need `'../..'`
 * from source and `'..'` from the bundle, which cannot both be written. Both
 * ends are pinned by tests: `test/scaffold/templates.test.ts` from source, and
 * (from Task 9 onward) `scripts/smoke-tarball.mjs` from a packed, installed
 * tarball.
 */
import path from 'node:path';

import { readJsonFile } from './json-file.js';

export function packageRoot(): string {
  return path.join(import.meta.dirname, '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure decision `packageVersion` delegates to, split out specifically so it
 * has its own direct test: `packageVersion` always reads the REAL installed
 * package.json, which can't be corrupted just to exercise the fallback
 * branches (missing, malformed, non-string version) below.
 */
export function extractVersion(parsed: unknown): string {
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    return '';
  }
  return parsed.version;
}

/**
 * The version of guardrails-core actually running, read from its own
 * package.json rather than hardcoded -- this is what `init --apply` stamps
 * into the scaffold manifest's `guardrailsVersion` (spec §6.5).
 *
 * Falls back to `''` on a missing or malformed package.json rather than
 * throwing: `packageRoot()` always points at guardrails-core's own install,
 * never the consumer's, so there is no second file this could plausibly read
 * instead -- and a `guardrails init` that could otherwise succeed must not be
 * taken down by this one enrichment failing.
 */
export function packageVersion(): string {
  const manifestPath = path.join(packageRoot(), 'package.json');
  return extractVersion(readJsonFile(manifestPath).parsed);
}
