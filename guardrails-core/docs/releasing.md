# Releasing guardrails-core

A release is cut by a `chore(release): cut X.Y.Z` commit and a tag. This file
holds the part of the procedure that proves a release changes no verdict an
existing consumer gets.

## The goldens (every build)

`guardrails-core/test/parity.test.ts` runs every fixture under
`test/fixtures/parity/` through `gate --mode=commit`, `gate --mode=push`,
`gate --mode=ci` and `verify` with the real analyzers, and compares the exit
code, the printed lines and the violations manifest with the golden under
`test/parity/goldens/`.

**No change may edit a golden as a side effect.** A golden changes in exactly
two kinds of commit:

1. **A behaviour change**, in its own owner-approved pull request whose
   description names the change and shows the golden diff.
2. **A tool upgrade** that rewords an analyzer's own message. Such a commit
   changes `package-lock.json` and nothing under `guardrails-core/src/`.
   (Whether this second kind stands is an open question for the owner; until
   it is answered, treat it like the first.)

To re-record: `PARITY_RECORD=1 npx vitest run guardrails-core/test/parity.test.ts`.
`PARITY_ONLY=<fixture>` limits a run to one fixture. Review the diff of
`test/parity/goldens/` before committing it.

## Consumer parity (before each tag)

The goldens are small repositories written for the purpose. A real consumer
exercises combinations they do not, so before a tag the candidate is compared
with the previous release on a consumer, at one pinned commit:

1. Pack the candidate: `npm pack --workspace guardrails-core` in this
   repository. Keep the previous release's tarball beside it (from the
   registry, or `npm pack guardrails-core@<previous>`).
2. In a clean checkout of the consumer at the pinned commit, on a branch that
   has a real diff against its base branch, install the **previous** tarball
   and run each rung, keeping the output:

   ```sh
   for mode in commit push ci; do
     node node_modules/guardrails-core/dist/cli.mjs gate --mode=$mode \
       > "before.$mode.out" 2> "before.$mode.err"
     echo "$?" > "before.$mode.code"
     cp -R .guardrails/state "before.$mode.state"
     git clean -fdxq .guardrails reports
   done
   node node_modules/guardrails-core/dist/cli.mjs verify \
     > before.verify.out 2> before.verify.err
   echo "$?" > before.verify.code
   ```

   The clean between rungs matters: the push rung remembers a tree that
   passed, and a blocked gate leaves a manifest behind.

3. Install the **candidate** tarball in the same checkout, at the same commit
   with the same diff, and repeat with `after.` in place of `before.`.
4. Normalise both sets the same way: replace the checkout's absolute path
   with `<root>`. Nothing else.
5. `diff -r` the two sets. **The diff must be empty.** A difference is either
   a behaviour change the release notes must name (and a golden should have
   caught: add a fixture for it) or a defect.

Record the consumer, the commit, both versions and the result in the release
pull request.

## Upgrade notes

A consumer-visible change gets a line in `upgrades/unreleased.md`; cutting a
release renames that file to `<version>.md`. A release that changes no
verdict still says so, in one line, so an agent reading the notes between two
pins is told there is nothing to do.
