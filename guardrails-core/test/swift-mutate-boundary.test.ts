/**
 * The boundary of the Swift mutation runner (GR-14), as this repository's
 * own dependency-cruiser config states it. The runner is built so that it
 * can be lifted out into its own project; these two rules are what keep that
 * true, so their patterns are held here against the paths they must and
 * must not match. (`npm run depcruise` is what applies them to the graph.)
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface Rule {
  name: string;
  severity: string;
  from: { path?: string; pathNot?: string };
  to: { path?: string; pathNot?: string; dependencyTypesNot?: string[] };
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const config = createRequire(import.meta.url)(
  path.join(repoRoot, '.dependency-cruiser.cjs'),
) as { forbidden: Rule[] };

function rule(name: string): Rule {
  const found = config.forbidden.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no dependency-cruiser rule named ${name}`);
  }
  return found;
}

/**
Does `pattern` (absent means "anything") match `file`?
*/
function isMatch(pattern: string | undefined, file: string): boolean {
  return pattern === undefined || new RegExp(pattern).test(file);
}

/**
Would `from` importing the in-repository module `to` break `named`?
*/
function isForbidden(named: Rule, from: string, to: string): boolean {
  return (
    isMatch(named.from.path, from) &&
    !isExcluded(named.from.pathNot, from) &&
    isMatch(named.to.path, to) &&
    !isExcluded(named.to.pathNot, to)
  );
}

/**
Does `pattern` (absent means "nothing") rule `file` out?
*/
function isExcluded(pattern: string | undefined, file: string): boolean {
  return pattern !== undefined && new RegExp(pattern).test(file);
}

const SRC = 'guardrails-core/src';

describe('swift-mutate-is-standalone', () => {
  const standalone = rule('swift-mutate-is-standalone');

  it('is an error, and lets Node built-ins through', () => {
    expect(standalone.severity).toBe('error');
    expect(standalone.to.dependencyTypesNot).toEqual(['core']);
  });

  it.each([
    [`${SRC}/swift-mutate/generate.ts`, `${SRC}/exec.ts`],
    [`${SRC}/swift-mutate/run.ts`, `${SRC}/verify/stryker-adapter.ts`],
    [`${SRC}/swift-lexer/line.ts`, `${SRC}/audit.ts`],
    [
      `${SRC}/swift-mutate/generate.ts`,
      'node_modules/typescript/lib/typescript.js',
    ],
  ])('forbids %s importing %s', (from, to) => {
    expect(isForbidden(standalone, from, to)).toBe(true);
  });

  it.each([
    [`${SRC}/swift-mutate/generate.ts`, `${SRC}/swift-mutate/operators.ts`],
    [`${SRC}/swift-mutate/generate.ts`, `${SRC}/swift-lexer/index.ts`],
    [`${SRC}/swift-lexer/line.ts`, `${SRC}/swift-lexer/atoms.ts`],
    // Not this rule's business: code outside the two directories.
    [`${SRC}/audit-swift.ts`, `${SRC}/exec.ts`],
    [`${SRC}/swift-mutated/other.ts`, `${SRC}/exec.ts`],
  ])('allows %s importing %s', (from, to) => {
    expect(isForbidden(standalone, from, to)).toBe(false);
  });
});

describe('swift-mutate-entry-points', () => {
  const entryPoints = rule('swift-mutate-entry-points');

  it('is an error', () => {
    expect(entryPoints.severity).toBe('error');
  });

  it.each([
    [`${SRC}/verify/index.ts`, `${SRC}/swift-mutate/generate.ts`],
    [`${SRC}/cli-core.ts`, `${SRC}/swift-mutate/operators.ts`],
    [`${SRC}/verify/index.ts`, `${SRC}/swift-mutate/run.test.ts`],
    [`${SRC}/verify/index.ts`, `${SRC}/swift-mutate/runner/run.ts`],
  ])('forbids %s importing %s', (from, to) => {
    expect(isForbidden(entryPoints, from, to)).toBe(true);
  });

  it.each([
    [`${SRC}/verify/index.ts`, `${SRC}/swift-mutate/run.ts`],
    [`${SRC}/verify/index.ts`, `${SRC}/swift-mutate/request.ts`],
    // The lexer is shared: the diff auditor reads Swift with it.
    [`${SRC}/audit-swift.ts`, `${SRC}/swift-lexer/index.ts`],
    // Inside the boundary, anything goes.
    [`${SRC}/swift-mutate/run.ts`, `${SRC}/swift-mutate/generate.ts`],
    [`${SRC}/swift-lexer/line.ts`, `${SRC}/swift-mutate/generate.ts`],
    // A test may reach in: it is not under src/.
    [
      'guardrails-core/test/swift-mutate.test.ts',
      `${SRC}/swift-mutate/generate.ts`,
    ],
  ])('allows %s importing %s', (from, to) => {
    expect(isForbidden(entryPoints, from, to)).toBe(false);
  });
});
