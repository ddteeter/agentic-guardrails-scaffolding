/**
 * What the PreToolUse gate takes for a way past the git hooks. Every spelling
 * here was checked against git itself (2.43), in a throwaway repository whose
 * hooks always fail: one that is called a bypass landed a commit or a push,
 * and one that is not was stopped by the hook.
 */
import { describe, expect, it } from 'vitest';

import {
  hasHookBypass,
  isAssembledBypass,
  isBypassOutOfReach,
} from '../src/hook-bypass.js';

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

  it('finds the subcommand behind a global option that takes a separate value', () => {
    expect(
      caught([
        // `x` and `.` are values, and the subcommand after them owns its -n.
        'git --namespace x log -n 3',
        'git --work-tree . push -n',
        'git --git-dir .git fetch -n',
        'git --config-env a.b=C show -n 1',
      ]),
    ).toEqual([]);
    expect(
      missed([
        'git --namespace x commit -n',
        'git --work-tree . commit -n',
        'git --git-dir .git ci -n',
      ]),
    ).toEqual([]);
  });

  it('finds the subcommand behind every global option git lets take a separate value', () => {
    // `--attr-source <tree>` takes its value as the next word too. Read as
    // a flag, the value was taken for the subcommand, and a value that
    // happens to be a subcommand `-n` is harmless on hid the commit behind
    // it. `--super-prefix` did the same on older gits.
    expect(
      missed([
        'git --attr-source rm commit -n -m x',
        'env git --attr-source rm ci -n',
        'git --attr-source push --namespace log commit -an',
        'git --super-prefix rm commit -n',
      ]),
    ).toEqual([]);
    expect(
      caught([
        'git --attr-source commit rm -n x',
        'git --super-prefix ci push -n',
      ]),
    ).toEqual([]);
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

/**
 * The scan for `-n` stops at the first separator, so that the `-n` of the
 * NEXT command is not taken for this one's. A separator inside a quoted
 * message is not one, and stopping there hid the flag written after it.
 */
describe('hasHookBypass: -n after a separator that is inside quotes', () => {
  it('reads -n written after a quoted ; | or &', () => {
    expect(
      missed([
        "env git commit -m 'a;b' -n",
        'git commit -m "a|b" -n',
        "git commit -m 'a & b' -n",
        'git ci -m "x; y" -an',
        `git commit -m 'one' -m "two; three" -n`,
        "git commit -m 'a\nb' -n",
      ]),
    ).toEqual([]);
  });

  it('reads -n written after a separator escaped with a backslash', () => {
    // `a\;b` is one word to the shell: the backslash makes the `;` a
    // character. The scan stopped at it all the same.
    expect(
      missed([
        String.raw`env git commit -m a\;b -n`,
        String.raw`git ci -m a\|b -n`,
        String.raw`git commit -m a\&b -n`,
        String.raw`git commit -m a\;b\|c -m "d; e" -n`,
      ]),
    ).toEqual([]);
  });

  it('still stops at a separator that is one', () => {
    expect(
      caught([
        "git ci -m 'a;b' ; head -n 3",
        'git ci -m "a|b" | head -n 3',
        "git ci -m 'a' && tail -n 1 f",
      ]),
    ).toEqual([]);
  });

  it('still reads -n where the quotes do not pair up', () => {
    // An open quote drops the rest of what the second reading sees, so the
    // first reading, of the text as written, has to stand on its own.
    expect(missed(["git commit -n -m 'unclosed"])).toEqual([]);
  });
});

/**
 * `core.hooksPath` does not have to be in the command. It can be in a config
 * file the command points git at, and then the text names no bypass at all:
 * the gate's own question to git ("which pre-push hook will run?") is asked
 * without the command's environment and gets the ordinary answer.
 */
describe('hasHookBypass: a config file the command points git at', () => {
  it('reads a variable that names git a config file, or moves its home', () => {
    expect(
      missed([
        'GIT_CONFIG_GLOBAL=/tmp/other.gitconfig git push',
        'GIT_CONFIG_SYSTEM=/tmp/other.gitconfig git commit -m x',
        'HOME=/tmp/elsewhere git push',
        'XDG_CONFIG_HOME=/tmp/elsewhere git push',
        'env HOME=/tmp/elsewhere git push',
        'export GIT_CONFIG_GLOBAL=/tmp/other.gitconfig; git push',
        'HOME= git push',
      ]),
    ).toEqual([]);
  });

  it('reads an include, in any letter case, by any route', () => {
    expect(
      missed([
        'git -c include.path=/tmp/other.gitconfig push',
        'git -c INCLUDE.PATH=/tmp/other.gitconfig push',
        'git -c includeIf.gitdir:/r/.path=/tmp/other.gitconfig commit -m x',
        'git -c includeif.onbranch:main.path=/tmp/x push',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/x git push',
        // The price: writing an include into the config names one too.
        'git config --global include.path ~/.gitconfig.local',
      ]),
    ).toEqual([]);
  });

  it('does not read a variable or a word that only resembles those', () => {
    expect(
      caught([
        'cd $HOME && git status',
        'echo "$HOME" && git push',
        'MYHOME=/tmp/x git push',
        'GIT_CONFIG_NOSYSTEM=1 git push',
        'GIT_CONFIG_GLOBALS=/tmp/x git push',
        'git log --grep=include',
        'git log --grep=includes.',
        'git push origin HOME',
      ]),
    ).toEqual([]);
  });
});

/**
 * A bypassing write the gate cannot place is gated over THIS repository
 * unless the command says it moves; then nobody can say where it lands, and
 * it is refused. So every way a command can move has to be known as one.
 */
describe('isBypassOutOfReach: a wrapper or an interpreter that changes directory', () => {
  it('knows a wrapper that is told where to run', () => {
    for (const command of [
      'env --chdir=/other git push --no-verify',
      'env --chdir /other git push --no-verify',
      'env -C /other git push --no-verify',
      'sudo --chdir /other git push --no-verify',
      'sudo -D /other git push --no-verify',
    ]) {
      expect(isBypassOutOfReach(command), command).toBe(true);
    }
  });

  it('knows an interpreter that changes directory itself', () => {
    for (const command of [
      `python3 -c "import os; os.chdir('/other'); os.system('git push --no-verify')"`,
      `node -e "process.chdir('/other'); run('git push --no-verify')"`,
      `ruby -e "Dir.chdir('/other') { system('git push --no-verify') }"`,
    ]) {
      expect(isBypassOutOfReach(command), command).toBe(true);
    }
  });

  it('does not take a wrapper that moves nothing for one that does', () => {
    for (const command of [
      'env git push --no-verify',
      'sudo git push --no-verify',
      'sudo -u me git push --no-verify',
      // A dash that does not start a word, and a lower-case flag.
      'env git push --no-verify x-D',
      'env -d git push --no-verify',
    ]) {
      expect(isBypassOutOfReach(command), command).toBe(false);
    }
  });
});

/**
 * The shell removes quotes and backslashes before git sees a word, so a
 * bypass can be written in pieces that no pattern over the text finds. A
 * command that names one only once those characters are taken out is not
 * gated: it is refused, since nothing honest is written that way.
 */
describe('isAssembledBypass: a bypass spelled through quotes or backslashes', () => {
  it('finds a flag or a key that only reads as one with the quotes removed', () => {
    for (const command of [
      'git commit --n"o-verify" -m x',
      "git commit --no-'verify' -m x",
      'git push "--no"-verify',
      "git commit -'n' -m x",
      String.raw`git commit --no-\verify -m x`,
      String.raw`git commit -\n -m x`,
      'git -c core.hooks"Path"=/dev/null commit -m x',
      String.raw`git -c core.hooks\Path=/dev/null push`,
      'git -c al"ias".ci=commit ci -m x',
      'GIT_CONFIG_GLO"BAL"=/tmp/x git push',
      "git -c inc'lude'.path=/tmp/x push",
    ]) {
      expect(isAssembledBypass(command), command).toBe(true);
    }
  });

  it('finds the word git put together the same way, beside a bypass', () => {
    for (const command of [
      "g''it commit --no-verify -m x",
      String.raw`gi\t push --no-verify`,
      'g"i"t -c core.hookspath=/dev/null commit -m x',
      'gi\\\nt commit --no-verify -m x',
    ]) {
      expect(isAssembledBypass(command), JSON.stringify(command)).toBe(true);
    }
  });

  it('is not what a bypass written plainly is: that one is gated, not refused', () => {
    for (const command of [
      'git commit --no-verify -m x',
      'git commit "--no-verify" -m x',
      'git commit -n -m "x"',
      'git \\\n commit --no-verify -m x',
      'git -c core.hooksPath=/dev/null push',
    ]) {
      expect(isAssembledBypass(command), JSON.stringify(command)).toBe(false);
    }
  });

  it('is not an ordinary command that happens to have quotes in it', () => {
    for (const command of [
      `git commit -m "it's fine"`,
      `git commit -m 'n'`,
      `git commit -m "-"`,
      `git log --format='%an' -n 3`,
      String.raw`echo "a" 'b' \c`,
      // No git: nothing to bypass.
      'echo --n"o-verify"',
      `npm run release -- --no-'verify'`,
    ]) {
      expect(isAssembledBypass(command), command).toBe(false);
    }
  });

  it('refuses a commit whose whole message is a quoted flag: the price', () => {
    // With the quotes gone this is `-m -n`, and nothing here models which
    // word is a value. A message that is a bare flag is rare enough to pay.
    expect(isAssembledBypass("git commit -m '-n'")).toBe(true);
  });
});
