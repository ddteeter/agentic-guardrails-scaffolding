/**
 * What the PreToolUse gate takes for a way past the git hooks. Every spelling
 * here was checked against git itself (2.43), in a throwaway repository whose
 * hooks always fail: one that is called a bypass landed a commit or a push,
 * and one that is not was stopped by the hook.
 */
import { describe, expect, it } from 'vitest';

import { hasHookBypass } from '../src/hook-bypass.js';

/**
The commands of `commands` that are NOT read as naming a bypass.
*/
function missed(commands: readonly string[]): string[] {
  return commands.filter((command) => !hasHookBypass(command));
}

/**
The commands of `commands` that ARE read as naming a bypass.
*/
function caught(commands: readonly string[]): string[] {
  return commands.filter((command) => hasHookBypass(command));
}

/**
 * `-n` is `--no-verify` for `git commit`, and git expands an alias before it
 * reads the flag. So `-n` on a subcommand git does not own may be a commit's.
 */
describe('hasHookBypass: -n on a commit reached through an alias', () => {
  it('reads -n on a subcommand that is not one of git’s own', () => {
    expect(
      missed([
        // An alias kept in the repository's config: nothing here says what
        // it stands for, so the flag is taken at its worst.
        'git ci -n -m x',
        'git ci -anm x',
        'git CI -n',
        'env git ci -n -m x',
        'git --no-pager ci -n',
        // An alias made on the command line, then used.
        'git -c alias.ci=commit ci -n -m x',
        // And commit itself, as before.
        'git commit -n -m x',
        'git commit -an',
        // `-n` is --no-verify for `git am` too.
        'git am -n 0001.patch',
      ]),
    ).toEqual([]);
  });

  it('reads an alias defined in the command as one, whatever it holds', () => {
    expect(
      missed([
        "git -c alias.ci='commit -n' ci -m x",
        'git -c ALIAS.ci=commit ci -m x',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci',
        // The price: defining an alias at all names one.
        'git config alias.co checkout',
      ]),
    ).toEqual([]);
  });

  it.each([
    'add',
    'blame',
    'cherry-pick',
    'clean',
    'fetch',
    'format-patch',
    'grep',
    'log',
    'merge',
    'mv',
    'prune',
    'pull',
    'push',
    'rebase',
    'reflog',
    'remote',
    'rev-list',
    'revert',
    'rm',
    'shortlog',
    'show',
    'stash',
    'tag',
    'whatchanged',
    'worktree',
  ])('does not read -n on `git %s`, where it means something else', (name) => {
    expect(hasHookBypass(`git ${name} -n`)).toBe(false);
    expect(hasHookBypass(`git --no-pager ${name} x -n 3`)).toBe(false);
  });

  it('does not read an alias used without -n, or an n that is not that flag', () => {
    expect(
      caught([
        'git ci -m x',
        // `-m` takes its value attached: this is the message "n".
        'git ci -mn',
        'git ci -m n',
        'git ci --no-edit',
        // `-n` belongs to the next command.
        'git ci -m x; head -n 3',
        'git ci -m x | head -n 3',
        'git ci -m x && head -n 3',
        'git ci -m x\nhead -n 3',
        // A dash that does not start a word.
        'git ci x-n',
        // Not git's subcommand at all.
        'git -n',
        'digit ci -n',
        // A word that only ends in "alias".
        'git config dealias.x y',
        'git config aliases x',
      ]),
    ).toEqual([]);
  });
});
