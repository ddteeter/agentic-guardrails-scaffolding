/**
 * Fixer scope-lock (§2.3). The fixer must touch only the files named in the
 * violations manifest. This turns "touch only listed files" into a hard
 * PreToolUse gate rather than a prompt request: the fixer's Edit/Write hook
 * calls `guardrails scope-check`, which denies any write to a path absent from
 * the manifest.
 *
 * Files are collected across every active manifest (union), so the check holds
 * regardless of whether a subagent's hook payload carries the main session id.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { readViolations } from './state-store.js';

export function collectManifestFiles(directory: string): Set<string> {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return new Set();
  }
  const files = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.last.json')) {
      continue;
    }
    const sessionId = name.slice(0, -'.last.json'.length);
    for (const violation of readViolations(directory, sessionId)) {
      files.add(path.normalize(violation.file));
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
  const relative = path.relative(repoRoot, path.resolve(repoRoot, candidate));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
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
