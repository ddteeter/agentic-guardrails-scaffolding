/**
 * What takes a git write out of reach of its hooks, as the PreToolUse gate
 * reads a shell command for it.
 *
 * Two rungs check a commit or a push: the git hook, and this gate in front
 * of the tool call. The gate leans on the hook -- a git write it does not
 * recognise "still meets the pre-commit hook" -- so a command that SKIPS the
 * hook is the one thing it must never fail to see. Everything here answers
 * that one question about a command's text, and is wrong in one direction on
 * purpose: it would rather gate a harmless command that only mentions a
 * bypass than model a shell well enough to tell the two apart.
 */
import { placedGitCommands } from './command-target.js';
import { withoutQuotedText } from './foreground-wait.js';

/**
 * git's global options: a flag token, or an option plus its separate value.
 *
 * The value alternative requires a NON-`-` first character, and that is what
 * keeps the run linear. Without it the two alternatives can tile the same token
 * sequence two ways -- `-c -c` as one flag-plus-value, or as two flags -- so a
 * run of k flags has Fibonacci(k) equivalent partitions, every one of which a
 * failing overall match must exhaust. That is the textbook `(a|aa)*`
 * catastrophic-backtracking shape, and it was real here: measured 5.69s at 40
 * tokens and 51s at 64, on `input.command` from the Bash PreToolUse hook --
 * the agent's highest-frequency tool, so a long enough command would have hung
 * the session. With the constraint, a token beginning `-` can only be read as
 * a flag and a token that does not can only be a value: exactly one parse.
 *
 * `sonarjs/regex-complexity` cannot see this. Assembling the pattern from
 * `String.raw` fragments -- done to get the literal under the complexity
 * ceiling -- also takes it out of static analysis, which is how this shipped
 * past a lint that had caught the same class before. `cli-core.test.ts` pins
 * the property by TIMING instead: the guarantee is "no exponential path
 * exists", which no example input can assert on its own.
 */
/**
 * The global options that take their value as the NEXT word, the same ones
 * `command-target.ts` knows. `-c` and `-C` were the only two read this way,
 * so `git --namespace x commit` had `x` taken for its subcommand and the
 * commit behind it was not seen, even in command position.
 *
 * Every one git has had, checked against git and not only its usage line,
 * which prints most of them with an `=`: `--attr-source` takes a tree as its
 * next word, and `--super-prefix` took a path until git dropped it. A value
 * read as the subcommand is worse than a miss when it happens to be one `-n`
 * is harmless on, because that is what clears the command.
 */
const SEPARATE_VALUE_OPTIONS =
  '(?:-[cC]|--namespace|--config-env|--git-dir|--work-tree|--attr-source|--super-prefix)';
export const GIT_GLOBAL_OPTIONS = String.raw`(?:[ \t]+(?:${SEPARATE_VALUE_OPTIONS}[ \t]+[^-\s][^ \t]*|-[^ \t]+))*`;

/**
 * What takes a write out of reach of its git hook: the flag that skips it, or
 * a hooks path chosen for the one command. A push carrying either is gated
 * here, whatever the hook says.
 *
 * Spelled the way GIT reads them, not the way the manual prints them. A long
 * option may be cut to any unambiguous prefix, so `--no-veri` and
 * `--no-verif` skip the hooks exactly as `--no-verify` does; the shorter
 * prefixes are refused as ambiguous today and are prefixes of nothing else,
 * so they are here too. A config key is case-insensitive, and reaches git
 * through `-c`, `--config-env` and the `GIT_CONFIG_*` variables, every one of
 * which names the key. Each checked against git, in a repository whose hooks
 * always fail. Before this the pattern was `--no-verify` and `hooksPath`,
 * exactly so, and a `git push --no-verif` was a plain push, left to the hook
 * it skips.
 */
const NO_VERIFY = /--no-(?:verify|verif|veri|ver|ve|v)(?!\w)/;
const HOOKS_PATH = /hookspath/i;

/**
 * git's own subcommands on which `-n` is known to mean something else: a dry
 * run (`push`, `clean`, `add`, `rm`, `mv`, `prune`), a count (`log`, `show`),
 * no tags (`fetch`), no diffstat (`merge`, `pull`, `rebase`), no commit
 * (`cherry-pick`, `revert`), and so on.
 *
 * A list of where `-n` is SAFE, not of where it is a bypass, because the
 * second list cannot be written: git expands an alias before it reads a
 * flag, so `git ci -n` is `git commit -n` in a repository that says so, and
 * nothing in the command does. A subcommand that is not here -- `commit`,
 * `am`, an alias, one git has yet to add -- has its `-n` taken at its worst.
 */
const N_MEANS_SOMETHING_ELSE = new Set([
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
]);

/**
 * One git command: its subcommand, and the rest of it up to the first
 * separator. The option run is greedy, so the word captured is the first one
 * that is not a global option or its value.
 */
const GIT_COMMAND = new RegExp(
  `\\bgit${GIT_GLOBAL_OPTIONS}[ \t]+([A-Za-z][\\w-]*)([^\n;&|]*)`,
  'g',
);

/**
 * `-n`, alone or in a cluster of short flags that take no value. The letters
 * allowed before the `n` are commit's (`-a`, `-e`, `-i`, `-o`, `-p`, `-q`,
 * `-s`, `-v`, `-z`), so `-an` and `-anm "x"` are bypasses and `-mn` is not:
 * that is `-m` with the message "n", and git runs the hook for it. Checked
 * against git, not its manual.
 */
const SHORT_NO_VERIFY = /[ \t]-[aeiopqsvz]*n/;

/**
 * `-n` as the short form of `--no-verify`: on `git commit`, and on any
 * subcommand it is not known to mean something else for.
 *
 * Tied to the one command it is written on, because `-n` is something else
 * nearly everywhere (`head -n`), so the scan stops at the first separator.
 * Wrong in the direction a bypass check may be wrong in: a commit message
 * that holds ` -n` reads as a bypass.
 */
function hasShortNoVerify(text: string): boolean {
  return text
    .matchAll(GIT_COMMAND)
    .some(
      ([, subcommand = '', rest = '']) =>
        !N_MEANS_SOMETHING_ELSE.has(subcommand) && SHORT_NO_VERIFY.test(rest),
    );
}

/**
 * An alias defined where the command can see it: `-c alias.x=...`, or the
 * same key through `GIT_CONFIG_*`. What it stands for is the command's to
 * say, in a string this does not parse, so defining one at all counts.
 */
const DEFINES_AN_ALIAS = /\balias\./i;

/**
 * A config file the command points git at: by a variable that names one
 * (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`), by moving the directory git
 * looks for one in (`HOME`, `XDG_CONFIG_HOME`), or by an `include` key.
 *
 * `core.hooksPath` can be in that file, and then the command's text names no
 * bypass at all. The gate cannot read the file -- it may not exist yet -- and
 * its own question to git about which hook will run is asked without the
 * command's environment. So pointing git at another config is itself taken
 * for a way past the hooks. Variables are matched as assignments and by
 * their exact names; a config key is case-insensitive to git, so here too.
 */
const NAMES_A_CONFIG_FILE =
  /\b(?:GIT_CONFIG_(?:GLOBAL|SYSTEM)|(?:XDG_CONFIG_)?HOME)=/;
const INCLUDES_A_CONFIG_FILE = /\binclude(?:if)?\./i;

/**
 * Does this command name a way past the git hooks, anywhere in it?
 *
 * Asked of the raw command, with its line continuations joined: the shell
 * joins them before git sees anything, so `git \<newline> commit -n` is one
 * command to it.
 */
export function hasHookBypass(command: string): boolean {
  const text = command.replaceAll('\\\n', '');
  // The scan for `-n` stops at a separator, and a separator escaped with a
  // backslash is not one: `a\;b` is a single word to the shell. Those are
  // taken out first, so the scan runs on to the flag written after them.
  const scanned = text.replaceAll(/\\[;&|]/g, '');
  return (
    NO_VERIFY.test(text) ||
    HOOKS_PATH.test(text) ||
    DEFINES_AN_ALIAS.test(text) ||
    NAMES_A_CONFIG_FILE.test(text) ||
    INCLUDES_A_CONFIG_FILE.test(text) ||
    hasShortNoVerify(scanned) ||
    // And again with the strings emptied: `-m 'a;b' -n` has a separator in
    // its message that is not one, and the scan above stops at it. Both
    // readings, because this one drops whatever follows an unclosed quote.
    hasShortNoVerify(withoutQuotedText(scanned))
  );
}

/**
The word `git`, wherever it stands: after a wrapper, a path, a backslash.
*/
const GIT_ANYWHERE = /\bgit\b/;

/**
 * Does this command name a hook bypass and run git AT ALL?
 *
 * The gate fires on a git write in command position, and a write that is not
 * there -- `if git commit ...`, `env git push`, `/usr/bin/git ...`, a string
 * handed to another program -- was an accepted miss, "because the git hooks
 * still run". With a bypass on it they do not: each such write landed with no
 * check at either rung.
 *
 * So this over-matches on purpose and models no shell: a bypass named, and
 * the word `git`. `git grep hooksPath` is gated by it, and so is a note that
 * mentions `--no-verify`; that is the price, and it is pinned by a test. The
 * other direction is the one that cannot be afforded.
 */
export function isBypassingGit(command: string): boolean {
  return hasHookBypass(command) && GIT_ANYWHERE.test(command);
}

/**
 * Does this command name a bypass and git ONLY once its quotes and
 * backslashes are taken out?
 *
 * The shell removes those before git sees a word, so a flag, a config key or
 * `git` itself can be written in pieces no pattern over the text will find.
 * Taking the characters out and asking again finds the pieces, and what it
 * finds is not gated but refused: gating would mean trusting a reading of a
 * command built to be misread, and nothing honest is written that way.
 *
 * Quotes and backslashes only. A word put together by the shell's own
 * expansions -- a variable, a substitution, an escape sequence -- is beyond
 * any reading of the text, and is the stated limit of this gate.
 */
export function isAssembledBypass(command: string): boolean {
  return (
    !isBypassingGit(command) &&
    isBypassingGit(command.replaceAll(/\\\n|['"\\]/g, ''))
  );
}

/**
 * What moves a command, or git itself, off the directory the shell starts in:
 * the shell's own `cd`, git's `-C` and its location options and variables, a
 * wrapper told where to run (`env --chdir`, `env -C`, `sudo --chdir`,
 * `sudo -D`), and an interpreter that changes directory itself, which every
 * one of them spells with `chdir`.
 */
const MOVES =
  /\b(?:cd|pushd|popd)\b|chdir|\s-[CD]|--git-dir|--work-tree|GIT_DIR|GIT_WORK_TREE/;

/**
 * Is this a bypassing command whose repository cannot be known?
 *
 * Gating is worth something only over the repository the write lands in, and
 * `commandTarget` resolves that for the git commands it can PLACE. A git it
 * cannot place -- more `git` words in the text than commands it read -- runs
 * wherever the wrapper, string or script around it takes it. If the command
 * also says anything that moves, checking this repository would be a pass
 * for a push into another one; so it is refused instead.
 */
export function isBypassOutOfReach(command: string): boolean {
  return (
    isBypassingGit(command) &&
    MOVES.test(command) &&
    command.matchAll(/\bgit\b/g).toArray().length > placedGitCommands(command)
  );
}
