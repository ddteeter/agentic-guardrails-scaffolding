# Design: a clone-detection analyzer (`dupes`, on fallow)

**Issue:** [#40](https://github.com/ddteeter/agentic-guardrails-scaffolding/issues/40)
(scoped to the syntactic half; the semantic half is [#41](https://github.com/ddteeter/agentic-guardrails-scaffolding/issues/41)).

## 1. The gap

`eslint-plugin-sonarjs` ships `sonarjs/no-identical-functions`, which reads as
copy-paste coverage and is not: **ESLint is per-file.** A rule receives one
file's AST at a time and holds no cross-file state, so identical functions in
two files are invisible to it. Verified both directions in #40 — two copies in
one file error; the same two copies in two files are silent.

Nothing else in the pack covers it. knip finds dead code, dependency-cruiser
finds cycles, stryker finds untested behaviour. Cross-file duplication has no
analyzer.

## 2. Tool choice: `fallow dupes`

#40 opened on jscpd and its own follow-up research moved off it. Confirmed and
extended here by measurement against this repository:

- **`fallow` is already a devDependency** (`3.0.0`), driving `check:graph`.
  Adding this analyzer adds no dependency to _this_ repo, and one already worth
  having to a consumer's.
- **MIT**, and `fallow/code-duplication` is `"license": "free"` in fallow's
  published `issue-registry.json` — not behind its paid-feature license.
- **Stable, versioned JSON envelope** (`schema_version: 7`) with
  `clone_groups[].instances[]` carrying `file` / `start_line` / `end_line`,
  plus `token_count`, `line_count` and a `fingerprint`. That maps onto
  `Violation[]` without inventing a shape.
- **Fast**: 22 ms of analysis, ~1.2 s wall, on this repo.
- `--ignore-imports` (on by default), `--min-occurrences` and `--skip-local`
  already suppress the noise classes the jscpd measurement had to hand-tune
  away.

jscpd would add a new dependency plus the v4/v5 tokenizer trap #40 documents
(`--mode strict` is a no-op on TS in v5, because the oxc lexer emits no
whitespace tokens). fallow adds neither.

Note for the seed: fallow 3.0 spells the near-duplicate mode `--mode semantic`.
There is no `--near` flag in this version.

## 3. Diff scoping — measured, then reimplemented in-adapter

#40's requirement: a clone detector needs the **whole tree** to find a pair, but
must only **report** pairs where at least one side is in the diff — otherwise
every commit re-reports pre-existing clones.

fallow implements exactly that in `--changed-since`. Measured on a purpose-built
fixture (two files sharing a `requireUserId` body):

| working tree            | reported                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| clean                   | nothing                                                                  |
| only `b.ts` dirty       | the group, **with both instances** — including the unchanged `a.ts` side |
| an unrelated file dirty | nothing                                                                  |

So discovery is whole-tree and reporting is gated on "at least one instance in
the changed set", which is the semantics we want, confirmed rather than assumed.

**We nonetheless do the filtering in the adapter, not with `--changed-since`.**
Three reasons:

1. `verify` already owns the change set, and it has two of them —
   `changedScope: 'staged'` at the pre-commit rung, `'branch'` everywhere else.
   `--changed-since <ref>` can only express the branch one, so at the commit
   rung it would report clones the commit does not touch.
2. `--changed-since` makes fallow re-derive the base with its own rules, which
   can disagree with `resolveBaseReference`'s `baseBranch` → `origin/baseBranch`
   fallback. One source of truth for "what changed" is worth more than one
   saved array filter.
3. It keeps the invocation config-agnostic and layout-generic, and keeps the
   scoping rule unit-testable without a git repository.

The adapter therefore takes the changed-file set and keeps a clone group when
**any** of its instances is in that set — then emits a violation for **every**
instance of a kept group, unchanged sides included. A fixer that is shown only
the changed half of a clone pair cannot dedupe it.

## 4. No duplication threshold

fallow's `--threshold` fails a run when `stats.duplication_percentage` exceeds
it, and #40 suggests wiring that to the `warn`/`block` model. **Rejected**, on a
measurement: under a scoped run that percentage is computed over the scoped file
set, not the project. On the two-file fixture above it reads 71.4%. It is not a
project metric under any diff-scoped invocation, so it cannot gate one.

One violation per clone instance instead — which is also what the manifest, the
recurrence tally and the fixer all want.

## 5. Shape

|              |                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| analyzer key | `dupes` (fallow's own subcommand name)                                                                                       |
| provider     | `fallow`                                                                                                                     |
| `minRung`    | `commit` — whole-tree discovery, so it sits beside knip / dependency-cruiser / stryker rather than on the per-turn Stop gate |
| `scope`      | `changed-files` — triggered by a TS change, discovered whole-tree, exactly like `tsc`                                        |
| ruleId       | `fallow/code-duplication` (fallow's own `rule_id`)                                                                           |
| severity     | `error`                                                                                                                      |
| `fixable`    | `false` — deduplication is a judgment, never a silent autofix                                                                |
| default mode | **`off`**                                                                                                                    |

**Invocation:** `fallow dupes --format json --quiet`, from `repoRoot`, with no
`--config`, no `--mode`, no `--min-tokens`. Config-agnostic and layout-generic
like `runKnip` and `runDepcruise`: the adopter's own `.fallowrc.jsonc` owns
every tuning knob, and a flag here would silently override the file they were
told to edit.

**Not wrapped in `withExitCodeCheck`.** `fallow dupes` exits 0 on a tree it has
just reported clones for (no `--fail-on-issues`), so its exit code carries no
findings signal — the same reason `runNpmPeers` is unwrapped. The parsed report
is the only signal; a spawn failure is caught by the existing
`trackSpawnFailures` / `analyzer-missing` machinery.

### 5.1 Why default `off`, and how

The other five analyzers are useful out of the box. This one is not: its
precision depends on an ignore list that is inherently repo-specific — generated
files, ORM schema DSLs, framework boilerplate — so an unconfigured run is noise,
and #40 asks for `off` on exactly that ground.

Implemented as a one-line table in `analyzer-policy.ts`:

```ts
const DEFAULT_MODES: Readonly<Record<string, AnalyzerMode>> = { dupes: 'off' };
// analyzers[tool] ?? DEFAULT_MODES[tool] ?? 'auto'
```

Every existing caller inherits it with no signature churn — `selectAnalyzers`
skips it, `silentlySkippedAnalyzers` (which filters on `=== 'auto'`) never
nags a consumer to install fallow, and `isAnalyzerAsked` declines to seed a
`.fallowrc.jsonc` for an analyzer nobody enabled. A new field on the `Analyzer`
table would have had to be mirrored into `SeedOnceAnalyzer` and kept in sync by
hand; this is one table in the module that already owns the opt-in decision.

## 6. Seed

`.fallowrc.jsonc` joins the SEED-ONCE class, seeded only when `dupes` is
explicitly enabled. `.jsonc` because fallow accepts comments there and the seed
is mostly commentary, matching `.dependency-cruiser.cjs`.

`hasConfig` probes all four filenames fallow accepts — `.fallowrc.json`,
`.fallowrc.jsonc`, `fallow.toml`, `.fallow.toml` — not just the one we write.
A second config would be silently ignored by fallow, the same failure the
dependency-cruiser probe already guards against.

Seeded `duplicates` block: `mode: "semantic"` (the near-duplicate mode, which
catches the renamed-variable clones exact matching misses), and fallow's own
`minTokens` / `minLines` / `minOccurrences` defaults written out explicitly so
the adopter can see what to tune. No `threshold` — see §4.

## 7. Loose classification

`fallow/` joins `LOOSE_PREFIXES` beside `knip/` and `dependency-cruiser/`.
Duplication is textbook loose class: a _green_ fix (delete one copy; extract
into the wrong shape) is easily far from a _good_ one, so it routes to the
thorough fixer from attempt 1 rather than letting the bottom tier find the
cheapest green path.

## 8. Drift guards

Both halves of CLAUDE.md's rule apply.

- **Id existence** (`test/drift/registry.test.ts`): assert
  `fallow/code-duplication` still exists in fallow's published
  `issue-registry.json`. Same shape as the knip issue-type probe.
- **Runner integrity** (`test/drift/dupes-runner.test.ts`): real fallow, over a
  fixture with a _known_ cross-file clone, through the real adapter, asserting
  the clone comes back. This is the `stryker-runner.test.ts` shape, and it
  exists for the same reason: a detector that still runs, still exits 0, and
  still reports — wrongly — is a failure mode neither an id check nor a unit
  test can see.

## 9. Known limits, stated

- **The changed-file set is TypeScript-only.** `changedTypeScriptFiles` filters
  on `isTypeScriptFile`, so a clone living entirely in `.js` / `.mjs` is
  detected by fallow and dropped by the scoping filter. It surfaces as soon as
  a `.ts` instance of the same group changes. Widening the shared change set
  would pull `.mjs` into stryker's mutation target too, which is a different
  decision.
- **One checkout.** Clones in sibling branches are invisible, as they are to
  every single-checkout tool.
- **Syntactic only.** The semantic class — one fact re-expressed in a different
  shape — is #41.
