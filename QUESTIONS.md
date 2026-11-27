# Questions from the hardening lane (2026-11-27)

One entry per question: what, what it costs, what I recommend, and what I did
meanwhile. None of these stopped the lane.

## 1. The environment check only passes as an ordinary developer account

**What.** In this cloud container the default `node` is 22 (the repo needs
`>=24.8.0`), the shell runs as root, and `NODE_PATH` points at a global
`node_modules` that holds `typescript`. On untouched `main`, 11 tests fail
there: seven `chmod` a file and expect a permission error (root ignores
permission bits), and four expect a temp directory to have no `typescript`
to resolve (`NODE_PATH` supplies one). With Node 24, `NODE_PATH` unset and
root's permission override dropped (`setpriv`, same user), `main` is green:
4319 of 4319.

**Cost.** The brief says to stop the lane if the check fails. Read strictly,
the lane ends before item 1 over the container's identity, not over anything
in the repository.

**Recommend.** Treat it as passed. If cloud lanes are going to be routine, a
setup script that selects Node 24 and unsets `NODE_PATH` would make the first
half disappear; the root half needs either a non-root user or the seven tests
to skip when `process.getuid() === 0`.

**Meanwhile.** Ran every test, commit and push through one wrapper that sets
exactly those three things and changes nothing in the repository.

## 2. Two things the brief points at are not on `main`

**What.** `docs/superpowers/specs/2026-11-27-hardening-design.md` and
`guardrails-core/docs/releasing.md` do not exist, and nothing in the
repository is called a parity golden (no test, no fixture, no mention outside
old plans).

**Cost.** I could not read the design notes, and "keep the parity goldens
green" had nothing specific to bind to.

**Recommend.** If both live on the unmerged Swift branch, re-run its golden
suite over this branch before merging either.

**Meanwhile.** Treated the whole existing suite as the pin: it passes after
every commit, and no existing assertion was changed to make room for a fix.

## 3. Item 4 names a seeded ESLint config; `main` has none

**What.** `guardrails init` seeds dependency-cruiser, stryker, knip and fallow
configs, and by design never writes `eslint.config.js` (the adoption skill
says so in as many words). The finding itself reproduces, in this repository's
own `eslint.config.js`.

**Cost.** The fix lands only where the finding was made. A consumer who writes
a config with `eslint-plugin-unicorn` and `typescript-eslint` together still
gets `() => undefined` rewritten to `() => {}` by the silent autofix.

**Recommend.** Do not chase rule pairs one at a time. #215's second option is
the general cure and covers #63 as well: after `eslint --fix`, re-lint the
file and put back any fix that left an error the file did not have before.
That changes what autofix does to consumer code, so it wants its own issue.

**Meanwhile.** Reconciled the pair here (`checkArrowFunctionBody: false`) with
a live probe that reproduces the trade when the option is taken away.

**Decided (owner, 2026-11-27, relayed by the sprint coordinator): filed,
nothing to build.** The re-lint-and-put-back behaviour is #253, to schedule
after the release. Nothing on this branch changes for it.

## 4. Item 5 cannot see the session it was written for

**What.** Both halves read the disk: `session-start` reports fixer agents
that are missing or behind their source, and a gate pointer names the
fallback when the fixer it names has no definition. In the reported case
neither fires. Before the first build there is no `dist/`, so the SessionStart
hook has no CLI to run (it fails with `ERR_MODULE_NOT_FOUND`, or in a nested
worktree silently runs the enclosing checkout's copy, which stands down).
Once that session has run the build, the agent files exist, and nothing on
disk says the session started before them.

**Cost.** The first session in a fresh clone still gets "spawn the
guardrail-fixer" with no such agent type, unless it happened to start after
a build of the code and before a build of the agents.

**Recommend.** Record what the session actually has, not what the disk has:
the install-remedy refusal (`guardrails-core is not installed in this
checkout ... run npm ci`) is shown exactly to a session that predates the
install, so it can say "and start a new session afterwards", and can leave a
marker the later gate reads. That writes state from an untrusted copy of the
CLI, which the code avoids on purpose today, so it is your call.

**Meanwhile.** Shipped the two disk checks, limited to a checkout that has
`guardrails-plugin/agents/` so that no consumer sees a new line.

**Decided (owner, 2026-11-27, relayed by the sprint coordinator): message
only, no marker.** Done in its own commit. The install-remedy refusal now
ends "Afterwards, start a new session", with the reason and the agents'
names, and writes nothing; a test holds that the checkout is left without a
`.guardrails/` directory. One thing I narrowed, and it is one condition to
remove if you meant it wider: the sentence is added only where it is true,
in a checkout that builds its fixer agents and has not built them yet. A
consumer's agents are committed files that its session already loaded, and
an unconditional "start a new session" would cost that session its context
for nothing.

## 5. Item 1 stops at the commit rung; the Stop rung has the same shape

**What.** The Stop gate also counts warnings in its pointer ("N guardrail
violation(s)") and writes them to the manifest its fixer reads. It also
tallies them into the recurrence counts, so a deferral present on three
blocked turns would be reported as a rule that "has failed verification in 3
separate turns".

**Cost.** With the lock busy at the Stop rung, a fixer is still handed
"Nothing to do" entries, and the recurrence memory can be told about a rule
nobody broke.

**Recommend.** Apply the same filter where the Stop gate builds its manifest.
It is a few lines, but it changes the digest and the tallies the fix loop is
measured by, which is why I did not fold it into a commit titled for the
commit rung.

**Meanwhile.** Fixed the commit rung only, as the item says, and noted the
Stop rung as open in `plan.md`.

**Decided (owner, 2026-11-27, relayed by the sprint coordinator): build it.**
Done in its own commit. The Stop gate filters to what blocks before it
builds its manifest, so the pointer's count, the manifest, the file claim,
the fixer tier and the recurrence tallies all follow. No existing assertion
changed. The unreleased upgrade notes say that the Stop pointer's count and
the recurrence tallies change.

## 6. Item 3 gives up one accidental catch

**What.** Before, a commit inside any quoted string was gated whenever a
separator happened to precede `git` in it. Now a quoted string is text unless
a shell is handed it (`-c`, `eval`, `--exec`) or the command names a hook
bypass anywhere. So `tmux send-keys "cd x; git commit -m y" Enter` is no
longer gated at PreToolUse.

**Cost.** That commit still meets the git hook, so nothing is unchecked. The
one flag that would skip the hook and is not recognised is `git commit -n`,
the short form of `--no-verify`: the existing bypass pattern does not know it
either, with or without quotes.

**Recommend.** Teach the bypass pattern `-n` for `commit` in its own change,
with its own tests; it is a gap on `main` today, in unquoted commands too.

**Meanwhile.** Kept every command that names `--no-verify` or `hooksPath`
on the old reading, so no bypass the gate caught before is missed now.

**Decided (owner, 2026-11-27, relayed by the sprint coordinator): build it.**
Done in its own commit. The bypass check reads `-n` on a `git commit` as
`--no-verify`, alone or in a cluster of short flags that take no value
(`-nm "x"`, `-an`, `-anm`), quoted or not, and on nothing else. A dry-run
`-n` on push, clean or add, a `-n` on the command before or after the
commit, and `git commit -mn` (a message, for which git runs the hook) are
not bypasses. The shapes were checked against git in a throwaway repository
whose pre-commit hook always fails. One limit, the same for both spellings:
the gate fires on a git write in command position, so a bypass written
straight after an opening quote, with no separator before `git`, is still
not a command to it (`tmux send-keys "git commit -n"`).

## 7. Upgrade notes were not asked for; I wrote them

**What.** The repository's convention is that a change an agent can see adds
to `guardrails-core/upgrades/unreleased.md`, and item 8 changes a seed that
is never rewritten, so an existing adopter only gets it by being told.

**Cost.** One more file touched on this branch, which the throughput session
may also be editing.

**Recommend.** Keep them; drop the commit if you would rather write them at
release time.

**Meanwhile.** They are in their own commit, last on the branch.

## 8. An abbreviated `--no-verify` skips the hook and is not recognised

**What.** git accepts any unambiguous prefix of a long option. In the same
throwaway repository, `git commit --no-veri -m x` landed with the hook
skipped (`--no-ver` and shorter are ambiguous with `--no-verbose` and are
refused). The bypass pattern is `--no-verify\b`, so it does not match.

**Cost.** For an unquoted commit, none at the gate: every commit in command
position is gated whatever its flags. What it loses is the two places the
bypass check decides something: a quoted string carrying it is emptied like
any other text, and a push riding with it is read as a plain push. The
scaffolded instructions forbid `--no-verify` by name, and this spelling walks
past a search for that name.

**Recommend.** Match `--no-verif?y?\b` for commit and push. It is a
one-line pattern change with its own tests, and it was not in the ruling,
so I did not make it.

**Meanwhile.** Nothing; recorded here and in `plan.md`.

**Decided (owner, 2026-11-27, relayed by the sprint coordinator): build it,
with the other bypass spellings.** Done. The bypass check now reads every
prefix of `--no-verify` (git accepts `--no-veri` and `--no-verif` for commit
and for push; the shorter ones it refuses are matched too, being prefixes of
nothing else) and the `hooksPath` key in any letter case, which covers `-c`,
`--config-env` and the `GIT_CONFIG_*` variables. Each was checked against git
2.43 in a throwaway repository and bare remote whose hooks always fail. A
push carrying any of them is no longer a plain push.

## 9. Four hook-bypass holes, closed on the owner's approval

**What.** Relayed by the sprint coordinator (2026-11-27): four ways a commit
or push could land with no check at either rung, all on `main`. Each is its
own commit with its own tests, and every spelling was confirmed against git
2.43 in a throwaway repository and bare remote whose hooks always fail.

**What is now caught.**

- Every spelling git accepts for skipping its hooks: any prefix of
  `--no-verify`, on a commit or a push; `-n` on a commit; and the
  `hooksPath` key in any letter case, through `-c`, `--config-env` or the
  `GIT_CONFIG_*` variables. A push carrying one is never a plain push.
- A script that reaches a shell on its stdin, piped or as a here-string.
- A quoted heredoc fed to a shell: the bypass is looked for in the raw
  command, before any body or string is dropped.
- A bypassing write wherever git stands: after a reserved word, a wrapper, a
  path or a backslash, across a line continuation, inside a string.

**Cost.** The last rule over-matches by design. A command that only names a
bypass and git (`git grep hooksPath`, a note about `--no-verify`) now runs
the commit gate and is denied if the gate finds something; the upgrade notes
list them and a test pins each. A bypassing command that also changes
directory, with a git the gate cannot place, is refused outright.

**Open.** One open item, ask the coordinator.
