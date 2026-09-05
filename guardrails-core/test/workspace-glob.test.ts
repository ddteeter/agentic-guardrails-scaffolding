import { describe, expect, it } from 'vitest';

import { parseWorkspaceGlob } from '../src/workspace-glob.js';

/**
Match helper: parse then test, failing loudly if the glob was unsupported.
*/
function isMatch(glob: string, directory: string): boolean {
  const parsed = parseWorkspaceGlob(glob);
  if (parsed === undefined) {
    throw new Error(`expected ${glob} to be supported`);
  }
  return parsed.matches(directory);
}

describe('parseWorkspaceGlob', () => {
  it('matches a single segment with *', () => {
    expect(isMatch('packages/*', 'packages/api')).toBe(true);
    // * is ONE segment: it must not reach into a nested directory.
    expect(isMatch('packages/*', 'packages/api/src')).toBe(false);
    expect(isMatch('packages/*', 'apps/api')).toBe(false);
  });

  it('matches any depth with **', () => {
    expect(isMatch('packages/**', 'packages/api')).toBe(true);
    expect(isMatch('packages/**', 'packages/group/api')).toBe(true);
    expect(isMatch('packages/**', 'apps/api')).toBe(false);
  });

  it('matches a literal path exactly', () => {
    expect(isMatch('guardrails-core', 'guardrails-core')).toBe(true);
    expect(isMatch('guardrails-core', 'guardrails-core/src')).toBe(false);
    expect(isMatch('guardrails-core', 'other')).toBe(false);
  });

  it('treats a leading ! as negation, without it being part of the pattern', () => {
    const parsed = parseWorkspaceGlob('!packages/private');
    expect(parsed?.negated).toBe(true);
    expect(parsed?.matches('packages/private')).toBe(true);
    expect(parseWorkspaceGlob('packages/*')?.negated).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    // A dot must match a dot, not any character.
    expect(isMatch('packages/a.b', 'packages/a.b')).toBe(true);
    expect(isMatch('packages/a.b', 'packages/axb')).toBe(false);
  });

  it('supports a partial-segment star', () => {
    expect(isMatch('packages/api-*', 'packages/api-core')).toBe(true);
    expect(isMatch('packages/api-*', 'packages/web-core')).toBe(false);
  });

  it('returns undefined for syntax outside the supported subset', () => {
    // Explicit non-goal: guessing is worse than declining, because the caller
    // still has a fallback that will attribute the file.
    expect(parseWorkspaceGlob('packages/{a,b}')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/[ab]')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/a?')).toBeUndefined();
    expect(parseWorkspaceGlob('packages/+(a|b)')).toBeUndefined();
  });

  it('returns undefined for an empty pattern', () => {
    expect(parseWorkspaceGlob('')).toBeUndefined();
    expect(parseWorkspaceGlob('!')).toBeUndefined();
  });

  it('ignores a trailing slash', () => {
    expect(isMatch('packages/*/', 'packages/api')).toBe(true);
  });
});
