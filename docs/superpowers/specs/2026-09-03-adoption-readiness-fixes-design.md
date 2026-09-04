# Adoption-readiness fixes — Design

Findings from a greenfield-adoption audit run against `f25ba66`: a fresh repo
was created, the real tarball installed into it, and the whole loop driven —
`init --plan`/`--apply`, `verify`, `autofix`, the Stop-gate ladder, the
diff-auditor, and a real blocked `git commit`. The machinery held up. What did
not was the ground the machinery stands on: the analyzers' notion of what
belongs to the repo, and the day-0 experience of an agent that has never seen
this tool.

This spec covers the correctness bugs and the cheap adoption wins. The analyzer
version preflight (`guardrails/analyzer-unsupported`) is deliberately **split
into a follow-up spec** — it is a new violation class with a hardcoded
third-party version table and a drift-guard, and it does not belong in a PR
whose other five items are small.

## 0. TL;DR

- **Nested git worktrees poison the whole-graph analyzers.** In the main
  checkout `verify` reports **559 violations, every one of them phantom**, and
  `gate --mode=commit` exits 1 — every commit blocked. Fixed in three layers:
  a shipped default, a generic runtime filter, and an adoption-time question.
- **A failed analyzer reports only stderr line 1**, which for the most likely
  first-adoption failure is the word `Oops!`. The diagnosis is on line 5 and is
  thrown away.
- **The tarball smoke test runs greenfield with `eslint=off`**, so the eslint
  path — the reason the tool exists — has never been exercised from a real
  install.
- **Nothing points a new agent at the adoption guidance.** It ships in the
  tarball and is excluded from everything `init` writes, by design; the gap is
  that no output ever names it.
- **`plan.md`'s Phase E status stops at piece 4**, though 5 and 6 shipped.

## 1. Nested worktrees (the blocking bug)

### What happens

A git worktree checked out inside the repository root is untracked but **not
ignored**. The whole-graph analyzers walk into it and report its contents as
part of the repo. In this repo, with eight worktrees under `.claude/worktrees/`:

```
verify              → 559 violations, all knip/*, all under .claude/worktrees/
                      (zero real findings)
gate --mode=commit  → exit 1
depcruise           → 671 of 792 modules cruised are worktree copies (85% waste)
```

The blast radius is not uniform, and the difference matters for the fix:

| Analyzer           | Affected?  | Why                                                 |
| ------------------ | ---------- | --------------------------------------------------- |
| knip               | **Yes**    | whole-graph; walks the tree                         |
| dependency-cruiser | **Latent** | cruises them, but `no-circular` alone finds nothing |
| eslint             | No         | diff-scoped — worktree files are never "changed"    |
| tsc                | No         | scoped by `tsconfig` `include`                      |
| stryker            | No         | diff-scoped to changed production files             |

dependency-cruiser is the one to worry about. It is silent **today** only
because the seeded config ships a single `no-circular` rule. `adopting-guardrails`
step 5 explicitly instructs the adopter to add layer rules — and the moment they
do, every rule fires once per worktree copy.

### Why this is an adoption bug, not a local annoyance

Claude Code's worktree tool creates worktrees under `.claude/worktrees/` by
default, and this project's own guidance prompts for a worktree whenever a plan
of reasonable size is executed. So the recommended workflow produces the broken
state. CI is unaffected (fresh checkout, no worktrees), which is precisely what
makes it dangerous: it is invisible to the backstop and lands entirely on the
developer's main working copy, where the commit gate runs. A first adopter
following the documented workflow gets a gate that blocks every commit on
findings nobody wrote — the "dirty baseline trains you to ignore the gate"
failure `docs/adoption.md` already warns about, arriving through a door that
document does not cover.

### The fix, in three layers

The layers are not redundant; they fail in different ways and cover for each
other.

**Layer 1 — shipped defaults (efficiency + the common case).**
`.claude/worktrees/` is added to `merge.ts`'s `GITIGNORE_BLOCK` and to
`DEPENDENCY_CRUISER_SEED`'s `exclude` pattern. Because `mergeGitignore` replaces
a _marked block_ rather than appending, already-scaffolded repos pick this up on
their next `init --apply` with no migration. knip respects `.gitignore` — a
measured fact, not an assumption: gitignoring the directory takes knip from 559
issues to 0. dependency-cruiser does not read `.gitignore` at all, which is why
it needs the separate seed change.

`DEPENDENCY_CRUISER_SEED` is SEED-ONCE, so this only helps repos scaffolded
after the change. That is acceptable — it is a performance fix there, and
layer 2 covers correctness for everyone.

Two dogfooding caveats apply to **this** repo specifically, and neither is
covered by the change above:

- This repo's `.gitignore` predates `init` and carries **no
  `guardrails:start`/`end` markers**, so `mergeGitignore` has nothing to
  replace and the new entry will not appear here automatically. It is added by
  hand, as a separate step.
- This repo's `.dependency-cruiser.cjs` is likewise its own file, not the seed,
  and needs the same `exclude` entry applied directly.

Both are exactly the kind of drift between "what we ship" and "what we run on
ourselves" that dogfooding exists to surface, and both are one-line changes.

**Layer 2 — generic runtime filter (correctness, unconditional).**
`nestedWorktreePaths(exec, repoRoot)` in `verify/git.ts` parses
`git worktree list --porcelain` and keeps only paths strictly under `repoRoot`.
`verify` drops any violation whose file resolves inside one.

This layer exists because layers 1 and 3 can both be wrong. A consumer can put
worktrees somewhere other than the default, can edit the seeded config, or can
answer the adoption question badly. This is a **safety** mechanism in the same
class as `loose-rules.ts`: its correctness must not depend on anyone's
configuration being right. It is also the only layer that helps a repo already
scaffolded and already broken.

Degradation is deliberately asymmetric. This filter _removes_ violations, so the
safe failure is to remove none: if `git worktree list` cannot run, the filter is
a no-op and the gate behaves exactly as it does today. There is no fail-open
risk to weigh, because filtering nothing is the strict behavior.

Path comparison is by resolved path with a separator-terminated prefix test, so
a sibling directory named `.claude/worktrees-old` is never mistaken for a child
of `.claude/worktrees`.

**Layer 3 — adoption-time guidance (this-repo specifics).**
Nested worktrees are one instance of a general failure: whole-graph analyzers
scan things that are physically in the repo but not part of its graph. Vendored
and `third_party` trees, generated output, and large fixture directories all
behave the same way. `adopting-guardrails` step 4 gains a fork phrased as
concretely as that section already demands:

> "This repo has `.claude/worktrees/` and a `test/fixtures/` tree — knip and
> dependency-cruiser are whole-graph and will scan both. Confirm the exclude
> set before I enable them."

Step 7's exit criterion gains the corresponding note: a first `verify` that
reports a _large_ number of findings usually means the analyzer scope is wrong,
not that the code is bad — check what is being scanned before fixing anything.

## 2. Analyzer failure diagnostics

`analyzerFailedViolation` keeps the first line of stderr. For the single most
likely first-adoption failure — eslint with no flat config — that line is:

```
Oops! Something went wrong! :(
```

The actionable sentence, `ESLint couldn't find an eslint.config.* file.`, is on
line 5. An unattended agent is handed the banner and nothing else.

The fix keeps the **first 5 meaningful lines, capped at 500 characters**: blank
lines dropped, the remainder joined with `; ` so the violation stays one line,
and the cap truncating with an ellipsis so a runaway stack trace cannot flood
the manifest. Five is chosen against the actual failure — eslint's diagnosis
sits on meaningful line 3 (`Oops!`, `ESLint: <version>`, then the sentence), and
five leaves headroom without turning a crash into a wall of text. The banner is
kept rather than pattern-matched away: recognising decorative first lines per
tool is exactly the hardcoded third-party knowledge this repo's guidance warns
rots silently. The regression test uses the real
eslint-10 and eslint-9 stderr text as fixtures, asserting the diagnosis survives
— not merely that more than one line is kept, which a trivial change would also
satisfy.

This is scoped to _presentation_. Whether a failed analyzer blocks is unchanged;
it already fails closed, correctly.

## 3. Smoke-test coverage

`scripts/smoke-tarball.mjs` proves the tarball installs and that a solution-style
tsconfig fails closed — but it runs `init --apply` with `eslint=off`. The eslint
adapter, the diff-scoping that feeds it, and the autofix path are the core of the
per-turn loop and have never been exercised from a real install.

A second leg is added: a minimal flat config (no plugin stack — the goal is to
prove the _path_, not to re-test the ecosystem), a file with a deliberate
violation, and an assertion that `verify` reports it with the expected rule id.
Keeping the config plugin-free also keeps the smoke test fast and free of the
peer-dependency minefield that item W2 will address separately.

## 4. Bootstrap pointer

`adopting-guardrails` is excluded from every path `init` writes, deliberately —
a document explaining how to adopt cannot be delivered by adoption. It ships at
`node_modules/guardrails-core/guidance/adopting-guardrails.md` and is readable
the moment the tarball lands.

The gap is narrow: **no output ever names it.** A greenfield agent has to
already know the file exists to read it. So `init` prints a pointer to it — on
`--plan` and on `--apply`, which is exactly when an agent is deciding what to
do — and the README install section names it too.

This is the cheap half of the distribution problem. Making the plugin itself
installable (a marketplace entry, publishing) stays with Phase E piece 7, where
it belongs alongside the release.

## 5. `plan.md` accuracy

The Phase E status section records pieces 1–4. Pieces 5 (`adopting-guardrails`)
and 6 (CI template, `docs/adoption.md`, team-flip verification) shipped without
being written down; piece 7 is genuinely outstanding. The section is corrected,
and the findings above are recorded under "Roadmap: fixer-loop hardening" per
this repo's standing instruction that a loop misbehaviour is a finding to
capture, not a nuisance to route around.

## 6. What this spec deliberately does not do

- **The analyzer version preflight.** A greenfield `npm i -D typescript eslint`
  today installs TS 7.0.2 and ESLint 10; `typescript-eslint@8` peer-caps
  TypeScript below 6.1, so the strict stack cannot be installed at all, and
  `guardrails-core`'s own `typescript: ">=5"` / `eslint: ">=9"` peer ranges
  claim support that does not exist. The fix — evidence-based ranges plus a
  `guardrails/analyzer-unsupported` violation and a drift-guard over the version
  table — is a separate spec.
- **Plugin distribution.** Phase E piece 7.
- **The npx bin rename.** In flight as PR #24.

## 7. Testing

TDD throughout; one logical commit per item.

- `nestedWorktreePaths` — unit tests over `git worktree list --porcelain`
  fixtures through the existing `Exec` seam: nested vs. sibling vs. external
  worktrees, the prefix-boundary case, and the git-unavailable no-op.
- The violation filter — an integration test asserting a violation inside a
  nested worktree is dropped while one outside it survives.
- Layer 1 — assertions that the gitignore block and the depcruise seed carry the
  entry, alongside the existing template tests.
- Diagnostics — real eslint stderr fixtures, asserting the diagnostic sentence
  survives.
- Smoke test — the new eslint leg is itself the test.

The end-to-end proof is the main checkout: `verify` there must go from 559
violations to 0 without any change to `knip.json`, and `gate --mode=commit` must
exit 0.
