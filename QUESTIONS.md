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

**What.** `docs/superpowers/specs/2026-11-27-hardening-design.md` does not
exist, and nothing in the repository is called a parity golden (no test, no
fixture, no mention outside old plans).

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
