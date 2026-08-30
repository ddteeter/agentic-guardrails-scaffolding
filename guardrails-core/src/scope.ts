/**
 * Fixer scope-lock (§2.3). The fixer must touch only the files named in the
 * violations manifest. This turns "touch only listed files" into a hard
 * PreToolUse gate rather than a prompt request: the fixer's Edit/Write hook
 * calls `guardrails scope-check`, which denies any write to a path absent from
 * the manifest.
 *
 * Files are collected across every active manifest (union), so the check holds
 * regardless of whether a subagent's hook payload carries the main session id —
 * minus `DENIED_FILE_NAMES`, the policy/manifest files no violation may ever
 * make editable.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile } from './json-file.js';
import { isViolation, type Violation } from './violation.js';

/**
 * Files the fixer may never edit, whatever a manifest names — matched on the
 * basename, so a workspace member's `packages/a/package.json` is denied exactly
 * like the root one.
 *
 * Two violations point at a policy/manifest file rather than at code:
 * `guardrails/analyzer-missing` (`package.json`) and
 * `guardrails/analyzer-unknown` (`guardrails.config.json`). Without this
 * denylist, handing a fixer either one would make that file editable, and the
 * diff-auditor would not catch the abuse — it scans code for suppression
 * syntax, and these are data edits. Deleting a provider from `devDependencies`
 * flips its analyzer from `auto`+declared to `auto`+undeclared, so the missing
 * error vanishes and `verify` reads green with the guard silently not running;
 * `guardrails.config.json` holds `sanctionedSuppressions`, `maxAttempts`,
 * `analyzers` and `enforcement`, so a fixer could grant itself an exemption or
 * switch a gate off.
 *
 * Nothing legitimate is lost: the fixer's job is to fix code, and no honest fix
 * to either violation is an edit to these files — installing a dependency is
 * not something the fixer can do at all (it has no Bash). The correct outcome
 * is that it edits nothing and the attempt escalates to the main agent.
 */
const DENIED_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'guardrails.config.json',
]);

function isDeniedFile(normalizedPath: string): boolean {
  return DENIED_FILE_NAMES.has(path.basename(normalizedPath));
}

const MANIFEST_SUFFIX = '.last.json';

/**
 * The violations recorded in ONE manifest, read by that manifest's own path.
 * Reading the entry the loop inspected — rather than rebuilding a path from a
 * session id sliced back out of its name — is what makes the suffix filter
 * load-bearing: a stray `notes.json` dropped in the state directory is skipped
 * because it is skipped, not because the rebuilt path happened not to exist.
 * A missing, malformed, or non-array file yields nothing, so a corrupt manifest
 * narrows the fixer's scope rather than widening it.
 */
function readManifest(file: string): Violation[] {
  const { parsed } = readJsonFile(file);
  return Array.isArray(parsed)
    ? parsed.filter((entry) => isViolation(entry))
    : [];
}

export function collectManifestFiles(directory: string): Set<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return new Set();
  }
  const files = new Set<string>();
  for (const name of entries) {
    // Only `<session>.last.json` files are manifests. The same directory holds
    // session tallies (`<session>.json`) and `recurrence.json`, and a consumer
    // may leave anything else there; reading one of those as a manifest would
    // let an unrelated JSON array widen the fixer's allowlist.
    if (!name.endsWith(MANIFEST_SUFFIX)) {
      continue;
    }
    for (const violation of readManifest(path.join(directory, name))) {
      const file = path.normalize(violation.file);
      if (isDeniedFile(file)) {
        continue;
      }
      files.add(file);
    }
  }
  return files;
}

/**
 * Read-scope guard (Finding 3 from the dogfooding proof): is `candidate` inside
 * the repo? The fixer may read anything *within* the repo (the manifest, the
 * files it edits, even `node_modules` rule sources — that in-repo exploration is
 * how the thorough tier diagnoses subtle rules), but never *outside* it (e.g.
 * the user's `~/.claude` project memory).
 */
export function isWithinRepo(repoRoot: string, candidate: string): boolean {
  // `path.relative(root, root)` is '', which already satisfies both clauses
  // below — it starts with neither '..' nor a root — so an explicit
  // `relative === ''` disjunct would be dead weight no test could distinguish.
  const relative = path.relative(repoRoot, path.resolve(repoRoot, candidate));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isPathAllowed(
  files: ReadonlySet<string>,
  repoRoot: string,
  candidate: string,
): boolean {
  const relative = path.isAbsolute(candidate)
    ? path.relative(repoRoot, candidate)
    : candidate;
  return files.has(path.normalize(relative));
}
