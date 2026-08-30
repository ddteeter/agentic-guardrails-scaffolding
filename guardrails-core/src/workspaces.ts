/**
 * Which package owns a file, in a monorepo.
 *
 * `Violation.package` and `recurrenceKey`'s `package:ruleId` form have existed
 * since Phase A with nothing to set them, so a rule recurring in one package was
 * diluted across the whole repo. Attribution is per-FILE, which is why it lives
 * here rather than as a single id threaded into each adapter.
 *
 * Both modes are one walk: ancestors of the file, deepest first, stopping at
 * `repoRoot`. Declared mode additionally gates each candidate on the root
 * `workspaces` globs; fallback mode takes the first ancestor with a
 * `package.json`. Everything degrades to `undefined` rather than throwing —
 * attribution is an enrichment and must never fail a gate that would pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseWorkspaceGlob, type ParsedGlob } from './workspace-glob.js';
import type { Violation } from './violation.js';

export type PackageResolver = (file: string) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The declared patterns: npm/yarn's array form, or yarn's `{ packages: [] }`. */
function declaredPatterns(manifest: unknown): unknown[] {
  if (!isRecord(manifest)) {
    return [];
  }
  const declared = manifest.workspaces;
  if (Array.isArray(declared)) {
    return declared;
  }
  if (isRecord(declared) && Array.isArray(declared.packages)) {
    return declared.packages;
  }
  return [];
}

function readWorkspaceGlobs(repoRoot: string): ParsedGlob[] {
  let manifest: unknown;
  // Equivalent mutant: `manifest` is declared but never assigned before the
  // try block runs, so if JSON.parse/readFileSync throws, the assignment on
  // the next line never completes and `manifest` stays `undefined`. Emptying
  // the catch block instead of returning `[]` still falls through to
  // `declaredPatterns(undefined)`, which returns `[]` anyway (`isRecord`
  // rejects `undefined`) — the two paths are unobservably different. A range
  // directive is used because `disable next-line` only attaches to a
  // statement-LEADING comment, and a `} catch {` line has none.
  // Stryker disable BlockStatement
  try {
    manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
  } catch {
    return [];
  }
  // Stryker restore BlockStatement
  const parsed: ParsedGlob[] = [];
  for (const pattern of declaredPatterns(manifest)) {
    if (typeof pattern !== 'string') {
      continue;
    }
    const glob = parseWorkspaceGlob(pattern);
    if (glob !== undefined) {
      parsed.push(glob);
    }
  }
  return parsed;
}

/** Repo-relative ancestor directories of `file`, deepest first, excluding the
 *  root itself. Empty when the path escapes `repoRoot`.
 *
 * Both guards below drop a check that is redundant with `path.dirname('.') ===
 * '.'`, not merely hard to observe: `relative === ''` is the only string with
 * `length === 0`, and `path.dirname('')` is also `'.'` — so `relative.length
 * === 0` never distinguishes an outcome the `while` loop's own entry
 * condition doesn't already produce on its own. Likewise, `current === '.'`
 * is one specific case of `current === path.dirname(current)` (since
 * `path.dirname('.') === '.'`), so the fixed-point check alone subsumes it
 * for every possible string, not just the ones this function can reach.
 * Dropped rather than suppressed: a mutation-testing directive here would
 * necessarily also silence the *other*, genuinely-load-bearing mutants
 * Stryker generates for the same compound condition (Stryker's ignore
 * comments match by mutator name and line only, not by sub-expression). */
function ancestorDirectories(repoRoot: string, file: string): string[] {
  const relative = path.relative(repoRoot, path.resolve(repoRoot, file));
  if (relative.startsWith('..')) {
    // Equivalent mutants on this array literal: this branch only runs when
    // the guard above is true, and `ancestorDirectories` is never exported —
    // its return value is only ever probed by the resolver's own
    // `existsSync` check on each entry. A bogus placeholder entry here is
    // observationally identical to `[]` unless a real directory happens to
    // exist with that exact name, which the paired directive on the
    // accumulator below addresses the same way.
    // Stryker disable next-line ArrayDeclaration
    return [];
  }
  // Equivalent mutant on this array literal, same argument as the one above:
  // seeding the accumulator with a bogus placeholder entry is only
  // observable through the resolver's `existsSync` check downstream, and no
  // real repo has a directory literally named after Stryker's placeholder.
  // Stryker disable next-line ArrayDeclaration
  const directories: string[] = [];
  let current = path.dirname(relative);
  while (current !== path.dirname(current)) {
    directories.push(current.split(path.sep).join('/'));
    current = path.dirname(current);
  }
  return directories;
}

function isDeclaredMember(globs: ParsedGlob[], directory: string): boolean {
  const included = globs.some(
    (glob) => !glob.negated && glob.matches(directory),
  );
  const excluded = globs.some(
    (glob) => glob.negated && glob.matches(directory),
  );
  return included && !excluded;
}

export function loadWorkspaceResolver(repoRoot: string): PackageResolver {
  const globs = readWorkspaceGlobs(repoRoot);
  return (file) => {
    for (const directory of ancestorDirectories(repoRoot, file)) {
      if (globs.length > 0 && !isDeclaredMember(globs, directory)) {
        continue;
      }
      if (existsSync(path.join(repoRoot, directory, 'package.json'))) {
        return directory;
      }
    }
  };
}

/**
 * Return `violations` with `package` set where an owning package is known.
 * Mirrors `withGuidance`: preserve-existing, add no key when there is nothing to
 * add, and therefore idempotent — safe to apply in both `runVerify` and the gate.
 */
export function withPackages(
  violations: readonly Violation[],
  resolve: PackageResolver,
): Violation[] {
  return violations.map((violation) => {
    if (violation.package !== undefined) {
      return violation;
    }
    const owner = resolve(violation.file);
    return owner === undefined ? violation : { ...violation, package: owner };
  });
}
