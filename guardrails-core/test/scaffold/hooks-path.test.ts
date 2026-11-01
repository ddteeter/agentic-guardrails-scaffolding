/**
 * The `core.hooksPath` non-overwrite rule, tested where it is decided rather
 * than at each of the three call sites that read it (`plan.ts`, `init.ts`,
 * `cli-core.ts`'s `install-hooks`). Those have their own tests for the
 * behaviour they add; this one pins the rule itself.
 */
import { describe, expect, it } from 'vitest';

import {
  foreignHooksPath,
  foreignHooksPathWarning,
  HOOKS_DIRECTORY,
  HOOKS_SCRIPT_PATH,
  PUSH_HOOK_SCRIPT_PATH,
} from '../../src/scaffold/hooks-path.js';

describe('foreignHooksPath', () => {
  it('reports nothing in the way when git has no core.hooksPath', () => {
    expect(foreignHooksPath(undefined)).toBeUndefined();
  });

  it('reports nothing in the way when it already points at .githooks', () => {
    expect(foreignHooksPath(HOOKS_DIRECTORY)).toBeUndefined();
  });

  it('returns the value itself when it points somewhere else, so the warning can name it', () => {
    expect(foreignHooksPath('.husky/_')).toBe('.husky/_');
  });

  it('treats any other directory as foreign, not just husky', () => {
    expect(foreignHooksPath('scripts/git-hooks')).toBe('scripts/git-hooks');
  });
});

describe('foreignHooksPathWarning', () => {
  const warning = foreignHooksPathWarning('.husky/_');

  it('names the value that is already configured', () => {
    expect(warning).toContain('.husky/_');
  });

  it('names the hook that is therefore not active', () => {
    expect(warning).toContain(HOOKS_SCRIPT_PATH);
  });

  it('names the pre-push hook too, which is inert for the same reason', () => {
    expect(warning).toContain(PUSH_HOOK_SCRIPT_PATH);
  });

  it('says to chain each hook script, as lines that can be pasted', () => {
    expect(warning).toContain(`sh ${HOOKS_SCRIPT_PATH}`);
    expect(warning).toContain(`sh ${PUSH_HOOK_SCRIPT_PATH}`);
    expect(warning).toContain('pre-commit hook');
    expect(warning).toContain('pre-push hook');
  });

  it('does not suggest the bare gate line, which drops the push lock', () => {
    // Chaining `gate --mode=push` directly is how this repo's own husky
    // pre-push ran the gate unserialized: the lock lives in the script.
    expect(warning).not.toContain('gate --mode=');
  });
});
