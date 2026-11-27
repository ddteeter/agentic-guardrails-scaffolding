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

/**
 * git's global options: a flag token, or `-c`/`-C` plus its separate value.
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
export const GIT_GLOBAL_OPTIONS = String.raw`(?:[ \t]+(?:-[cC][ \t]+[^-\s][^ \t]*|-[^ \t]+))*`;

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
 * `git commit -n`: the short form of `--no-verify`, which the long forms did
 * not cover.
 *
 * Tied to `commit`, and to the one command it is written on, because `-n` is
 * something else nearly everywhere: a dry run for `git push`, `git clean` and
 * `git add`, a count for `git log` and `head`. So the scan starts at a `git
 * ... commit` and stops at the first separator.
 *
 * The letters allowed before the `n` are commit's short flags that take no
 * value (`-a`, `-e`, `-i`, `-o`, `-p`, `-q`, `-s`, `-v`, `-z`), so `-an` and
 * `-anm "x"` are bypasses and `-mn` is not: that is `-m` with the message
 * "n", and git runs the hook for it. Checked against git, not its manual.
 *
 * Wrong in the direction a bypass check may be wrong in: a commit message
 * that holds ` -n` reads as a bypass, which costs the old, wider reading of
 * that one command and nothing else.
 */
const COMMIT_NO_VERIFY = new RegExp(
  `git${GIT_GLOBAL_OPTIONS}[ \t]+commit\\b[^\n;&|]*[ \t]-[aeiopqsvz]*n`,
);

/**
 * Does this command name a way past the git hooks, anywhere in it?
 *
 * Asked of the raw command, with its line continuations joined: the shell
 * joins them before git sees anything, so `git \<newline> commit -n` is one
 * command to it.
 */
export function hasHookBypass(command: string): boolean {
  const text = command.replaceAll('\\\n', '');
  return (
    NO_VERIFY.test(text) || HOOKS_PATH.test(text) || COMMIT_NO_VERIFY.test(text)
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
What moves a command, or git itself, off the directory the shell starts in.
*/
const MOVES =
  /\b(?:cd|pushd|popd)\b|\s-C|--git-dir|--work-tree|GIT_DIR|GIT_WORK_TREE/;

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
