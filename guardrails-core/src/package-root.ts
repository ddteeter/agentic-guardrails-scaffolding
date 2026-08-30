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
 * `scripts/smoke-tarball.mjs` from a packed, installed tarball.
 */
import path from 'node:path';

export function packageRoot(): string {
  return path.join(import.meta.dirname, '..');
}
