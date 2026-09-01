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

  it('says what to do about it, as a command that can be pasted', () => {
    expect(warning).toContain('gate --mode=commit');
    expect(warning).toContain('pre-commit hook');
  });
});
