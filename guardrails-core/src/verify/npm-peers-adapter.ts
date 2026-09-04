/**
 * npm peer-range adapter: maps `npm ls --json --all` into `Violation[]`.
 *
 * npm already knows every package's peer ranges and which installed versions
 * violate them, so this ASKS npm rather than carrying a table of supported
 * analyzer versions. That is deliberate: a hardcoded version table is the
 * "hardcoded third-party knowledge rots silently" failure this repo's guidance
 * warns about, it would need editing every time the ecosystem moved, and it
 * would need a `semver` dependency in a package that has none.
 *
 * Why this exists when npm validates peers at INSTALL time: that check is
 * bypassed by `--legacy-peer-deps` and `--force` -- exactly what a stuck agent
 * reaches for -- and by workspace hoisting. Those leave a graph that installs
 * cleanly and misbehaves later. The greenfield case that motivated it:
 * `npm i -D typescript` installs a major no released typescript-eslint accepts
 * (`typescript-eslint@8` declares `typescript: ">=4.8.4 <6.1.0"`).
 */
import path from 'node:path';

import type { Violation } from '../violation.js';

/** The fields this adapter reads from one node of npm's dependency tree.
 *  `path` comes from `--long` and is what keeps a linked dependency from
 *  dragging another project's graph into this repo's report. */
interface NpmLsNode {
  version?: unknown;
  invalid?: unknown;
  path?: unknown;
  dependencies?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function peerViolation(
  name: string,
  version: string,
  ranges: string,
): Violation {
  return {
    ruleId: 'guardrails/peer-range-violation',
    file: 'package.json',
    message:
      `${name}@${version} violates a peer range required by another installed ` +
      `package: ${ranges}. Pin ${name} inside that range, or upgrade the ` +
      `package that requires it. A graph only reaches this state by being ` +
      `installed past npm's own peer check (--legacy-peer-deps, --force) or ` +
      `by workspace hoisting, so it will not fail again at install time.`,
    severity: 'error',
    fixable: false,
    tool: 'npm',
  };
}

/**
 * Walk the tree, collecting `invalid` nodes keyed by package name so the same
 * violation reached by several paths is reported once -- npm repeats it per
 * path, and one real fixture produced a dozen copies of a single finding.
 *
 * `missing` is deliberately not reported: an absent peer is frequently
 * legitimate (optional peers), while `invalid` means the package IS installed
 * at a version that violates a range. That keeps this a low-false-positive
 * signal rather than a second opinion on the whole dependency graph.
 */
export function parseNpmLsJson(stdout: string, repoRoot: string): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Deliberately empty: leaving `parsed` undefined lets the guard below
    // reject it, so malformed JSON and "parsed, but not a tree" share ONE
    // exit. A `return []` here would be a second path to the same answer --
    // untestable by construction, since no input could tell the two apart.
  }
  if (!isRecord(parsed)) {
    return [];
  }

  const root = path.resolve(repoRoot);
  /**
   * Is this package physically installed inside the repo?
   *
   * A `file:` dependency or `npm link` puts a SYMLINK in `node_modules`, and
   * `npm ls --all` walks through it into the target's own tree -- so the
   * report can carry violations belonging to an entirely different project,
   * attributed to this one. Measured in CI: the tarball smoke fixture installs
   * TypeScript by local path, and the check reported seven findings from the
   * development repo's graph, including nonsense like "chai violates a range
   * required by node_modules/typescript".
   *
   * A node with no `path` is skipped rather than trusted: this is a diagnostic,
   * and a finding we cannot locate is one we cannot vouch for.
   */
  const isInsideRepo = (nodePath: unknown): boolean =>
    typeof nodePath === 'string' &&
    path.resolve(nodePath).startsWith(`${root}${path.sep}`);

  const found = new Map<string, Violation>();
  const visit = (node: Record<string, unknown>): void => {
    const { dependencies } = node as NpmLsNode;
    if (!isRecord(dependencies)) {
      return;
    }
    for (const [name, child] of Object.entries(dependencies)) {
      if (!isRecord(child)) {
        continue;
      }
      const { invalid, version, path: nodePath } = child as NpmLsNode;
      if (
        typeof invalid === 'string' &&
        invalid.length > 0 &&
        isInsideRepo(nodePath)
      ) {
        const installed = typeof version === 'string' ? version : 'unknown';
        // Keyed by name AND version, not name alone. npm's tree can hold two
        // different versions of one package at different paths -- the shape a
        // hoisting conflict takes, which is exactly what this analyzer is for
        // -- and each is a distinct finding with its own remedy. Keying on the
        // name would report the first and silently drop the rest.
        //
        // The `invalid` text is deliberately NOT part of the key: npm
        // accumulates requirers as it walks, so the same physical package
        // reports progressively longer strings at deeper paths (measured), and
        // keying on it would restore the duplicate-per-path noise this map
        // exists to remove.
        found.set(
          `${name}@${installed}`,
          peerViolation(name, installed, invalid),
        );
      }
      visit(child);
    }
  };
  visit(parsed);
  return [...found.values()];
}
