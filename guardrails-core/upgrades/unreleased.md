---
version: unreleased
supersedes:
  - search: 'nosession-commit'
    because: 'if it tells agents to delete `.guardrails/state/nosession-commit.last.json` when a commit is refused for a fixer that is "already working", a commit gate run from a git hook no longer claims the files it names, so that refusal no longer happens and the file should be left alone'
  - search: '.stryker-tmp'
    because: 'if it tells agents to remove `.stryker-tmp/` before committing because dependency-cruiser reports the copied files, add the sandbox to the `exclude` in `.dependency-cruiser.cjs` instead (see "What to wire")'
---

# Unreleased — what changed for an agent

## Behaviour that changed

- **A blocked commit counts, and hands a fixer, only what blocks.** The
  commit-gate pointer (`N violation(s), M added suppression(s)`) counts
  error-severity violations, and the manifest it names holds those and the
  added suppressions. Warnings are still printed by `gate --mode=commit`, and
  are in neither the count nor the manifest. Before, seven "Nothing to do"
  mutation deferrals beside two errors read as nine violations to fix.
- **The Stop gate does the same, and its counts change.** The Stop pointer's
  `N guardrail violation(s)` now counts error-severity violations and added
  suppressions only, and the manifest it names (`<session>.last.json`) holds
  only those. A warning no longer picks the fixer's tier, is no longer part
  of the files a fixer is said to hold, and is no longer tallied in the
  recurrence counts: `ruleCounts` in the session state, and through it
  `.guardrails/state/recurrence.json` and the "has failed verification in N
  separate turns" note, count a rule only on a turn where it blocked. The
  `violations` and `rules` fields of a Stop row in the decision log shrink the
  same way, so a `guardrails report` taken across this version compares
  rows counted two ways. Whether a turn is blocked is unchanged: a turn with
  only warnings ended before and ends now.
- **A blocked pointer counts the warnings it set aside.** Warnings are in
  neither the manifest nor the count, and a blocked PreToolUse or Stop
  prints nothing but its pointer, so an advisory raised on a blocked
  iteration was seen by nobody. The pointer now ends
  `N warning(s) did not block and are not in the manifest: <rule> ×n, …`.
- **A commit rung that deferred mutation testing says what to do (#229).**
  When the mutation lock is busy and the commit rung defers, its output and
  the PreToolUse deny now say how many files were deferred and to run
  `guardrails gate --mode=push` in the background before reporting done. The
  deferral is still a warning and still does not block.
- **The PreToolUse commit gate ignores a git write inside a string that is
  only data.** `ps aux | grep -E "eslint|tsc|git commit"` no longer runs the
  commit gate. That is all that changed: a string is set aside only where
  every program on the line can do nothing with its strings but read them
  (`grep`, `egrep`, `fgrep`, `echo`, `printf`, `cat`, `head`, `tail`, `wc`,
  `uniq`, `cut`, `tr`, `ls`, `ps`, `pgrep`, `cd`, `pwd`, `true`, `false`,
  `tee`, each by its plain name), and the line has no heredoc, no `$` or
  backtick outside single quotes, no comment and no unclosed string, and
  the tool running it is `bash` (PowerShell quotes differently). Every
  other command is read exactly as it was before, strings and all: a script
  piped to a shell, `sh -c`, `eval`, a variable, `git rebase -x`, `node -e`,
  a string typed into another program.
- **A hook bypass is recognised in every spelling git accepts.** The
  PreToolUse gate leans on the git hooks for any git write it does not
  recognise, so a command that skips them is the one thing it must see.
  It now reads as a bypass:
  - any prefix of `--no-verify` that git accepts, on a commit or a push;
  - `-n` on `git commit`, alone or in a cluster (`-nm "x"`, `-an`), also
    after a quoted or escaped `;`, `|` or `&` in the same command, and on any
    subcommand `-n` is not known to mean something else for, since git
    expands an alias before it reads the flag;
  - an alias defined in the command (`-c alias.x=...`);
  - the `hooksPath` key in any letter case, through `-c`, `--config-env` or
    the `GIT_CONFIG_*` variables;
  - a config file the command points git at: `GIT_CONFIG_GLOBAL`,
    `GIT_CONFIG_SYSTEM`, `HOME` or `XDG_CONFIG_HOME` set for the command, or
    an `include.path` / `includeIf` key.

  `-n` on `git push`, `clean`, `add`, `log`, `fetch` and twenty more of
  git's own subcommands is not a bypass, and neither is `git commit -mn`,
  which is a message. A push that names a bypass is never left to the
  pre-push hook it skips.

- **A bypassing write is gated wherever git stands in the command.** A
  command that names a bypass and has the word `git` in it is gated whatever
  its shape: after a reserved word, a wrapper, a path or a backslash, across
  a line continuation, inside a string, a heredoc or a script piped to a
  shell. The bypass is looked for in the raw command, before any heredoc
  body or string is set aside.
- **That rule gates some commands that write nothing.** It does not model
  the shell, so these now run the commit gate over the staged files, and are
  denied if it finds something: `git grep hooksPath`,
  `git config --get core.hooksPath`, `git log --grep=--no-verify`,
  `gh pr create --body "never run git commit --no-verify"`,
  `echo "git commit -n"`, `grep -n hookspath .git/config`,
  `git config alias.co checkout`, `git config --global include.path <file>`,
  any git command run with `HOME=` set, and a heredoc or a script that
  writes text naming both a bypass and git. A command that names a bypass
  and no git (`grep -rn hooksPath src`) is not gated. To read or search for
  these words without the gate, use a tool that is not a shell command, or
  put the text in a file first.
- **A bypassing write the gate cannot place is refused if the command also
  moves.** Where git stands out of the gate's reading (behind a wrapper, in
  a string, a heredoc or a substitution) and the command also says `cd`,
  `pushd`, `popd`, `chdir`, `cwd`, `execdir`, `--directory`, `-C`, `-D`,
  `--git-dir`, `--work-tree`, `GIT_DIR` or `GIT_WORK_TREE`, or gives tmux a
  start directory, the repository it writes to cannot be known,
  so it is denied instead of being checked against the wrong one. This also
  denies `cd packages && git commit --no-verify -m "about git"`: the word in
  the message counts as a git the gate did not place.
- **A bypass spelled through quotes or backslashes is refused.** A shell
  command that names a bypass and git only once its quotes and backslashes
  are taken out is denied outright, with a message that says why. A commit
  whose whole message is a quoted flag (`-m '-n'`) is refused by the same
  rule.
- **More git writes are seen in command position.** A write behind a global
  option that takes a separate value (`--namespace`, `--git-dir`,
  `--work-tree`, `--config-env`, `--attr-source`), a script
  put together from adjacent quoted pieces, and a quoted heredoc fed to a
  shell (`bash <<'EOF'`) are gated like any other commit or push.
- **What this gate does not stop.** It reads the text of a command, so it
  cannot see what the shell builds or what a file holds. These are limits,
  not oversights:
  - a bypass word, or the word `git`, built by shell expansion: a variable,
    a command substitution, an escape sequence, a brace expansion;
  - git plumbing that transfers objects without running the pre-push hook;
  - a script run from a file, or a package script, that commits or pushes;
  - what an earlier command left behind. The gate reads one command at a
    time. An alias or a hooks path stored in the repository's config by a
    command that passed, in a tree that was clean when it ran, is not in
    the text of the command that later uses it.

  The git hooks still run for a script in a file that names no bypass, and
  CI runs on every push. Instructions that forbid a bypass should say so in
  words, not rely on this gate to catch every way of writing one.

- **A duplication pointer says who extracts.** When a manifest holds
  `fallow/code-duplication` findings, a pointer that says to spawn a fixer
  adds that extraction into a NEW module is the main agent's to do. The
  fixer's scope is unchanged: it may edit only the files the manifest names.
- **A commit gate run from a git hook claims no files (#216).** It has no
  session and spawns no fixer, so it no longer leaves a lease that made the
  session's next commit wait for one.
- **The "not installed in this checkout" refusal can say to start a new
  session.** Only in a checkout whose install also builds its fixer agents
  (one with `guardrails-plugin/agents/`), and only while they are unbuilt: a
  session that began before that install did not load them. Elsewhere the
  refusal is unchanged.
- **A CLI that resolved from outside the repository says what to do.** Where
  the checkout has no guardrails-core: `npm ci`. Where it has one the command
  did not reach: `npm rebuild guardrails-core`, or `node <path>`.

## Instructions this supersedes

- **Deleting a state file to get a commit through.** If an instruction says
  to remove `.guardrails/state/nosession-commit.last.json` (or `leases.json`)
  when the gate says a fixer is already working, drop it.
- **Removing `.stryker-tmp/` before a commit**, where the reason was
  dependency-cruiser. Exclude it in the config instead.

## What to wire

`guardrails init` seeds `.dependency-cruiser.cjs` once and never rewrites it,
so a config seeded before this release still cruises a leftover stryker
sandbox (#55). Add `\\.stryker-tmp` to its `exclude`:

```js
exclude: {
  path: '(^|/)(dist|build|coverage|node_modules|\\.stryker-tmp)/|^\\.claude/worktrees/',
},
```

Nothing else.
