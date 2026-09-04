---
name: crushing-mutants
description: Use when verify reports `stryker/survived` or `stryker/no-coverage` violations, or when working through mutants from a mutation-testing run. Covers triaging the list, writing tests that actually kill mutants, recognising vacuous assertions, proving a mutant equivalent, and the approval flow for the rare exemption.
---

# Crushing mutants

A surviving mutant means **a test executes that line but does not assert its
behaviour**. Every other check in the pack inspects your _code_; this one
inspects your _tests_. Coverage cannot find these — the line ran. `expect-expect`
cannot — there was an assertion. It was just the wrong one.

Your job is to make the test observe the behaviour, not to make the report empty.

## Two rule ids, two different remedies

| Rule id               | What it means                                          | What to do                                                                                  |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `stryker/survived`    | A test **runs** the line but asserts nothing about it. | Strengthen an existing test so it observes the behaviour.                                   |
| `stryker/no-coverage` | **No test runs the line at all.**                      | Write a test that exercises it — then re-run, because survivors hide inside uncovered code. |

`no-coverage` is the **stricter** failure of the two, not the milder one. Stryker
does not execute these mutants (no covering test could fail them), so it reports
them by status rather than by outcome.

Do not treat a `no-coverage` mutant as equivalent. Equivalence is an argument
about behaviour under a test that _runs_ the code; you cannot make it about code
nothing has ever executed. Cover it first, then classify whatever survives.

Expect that to surface new work: covering a `no-coverage` region routinely turns
up genuine survivors that were invisible while the region was uncovered. That is
the point, not a setback.

## The loop

1. **Scope the run to the file you are working on.** A whole-repo run is minutes;
   one file is seconds. `npx stryker run --mutate '<path>' --reporters json`,
   then read `reports/mutation/mutation.json`.
2. **Classify every survivor** as killable or equivalent (below). Most are
   killable. Expect roughly **1 in 5** to be equivalent — if you are proving
   equivalence far more often than that, you are giving up too early.
3. **Kill the killable ones**, re-run, repeat until zero.
4. **Only then** consider an exemption for what is left.

Delete `reports/` and `.stryker-tmp/` when you are done.

## Is it killable or equivalent?

**Killable**: some input distinguishes the mutant from the original. Find that
input; write the test.

**Equivalent**: _no possible input_ distinguishes them, so no test can exist. The
bar is a proof, not a failure to think of one. If you cannot state the argument
in one or two sentences, it is not equivalent — you have not found the input yet.

Families that recur (all genuinely equivalent):

- **A redundant guard half.** `typeof x === 'object' &&` in front of a check that
  already rejects primitives; `typeof x === 'number' &&` in front of
  `Number.isFinite` (which does not coerce). The second half does the work.
- **A catch that falls through to the same result.** Emptying `catch { return [] }`
  leaves the variable undefined, which the next guard rejects, returning `[]`
  anyway.
- **State reset immediately after.** Skipping a branch that adjusts a counter,
  when the next iteration unconditionally reassigns it.
- **Optional chaining behind a type guard.** `re.test(s)` on the line above
  guarantees `re.exec(s)` is non-null, so `?.` can never short-circuit — and it
  usually cannot be deleted either, because the type is `T | null`.
- **A placeholder in a container that is only probed by exact key.** Replacing
  `[]` with junk changes nothing if every lookup uses a real key.

## The trap: assertions that pass for the wrong reason

This is the most common reason a mutant survives a test that _looks_ thorough.

**Guards that fail open.** If a parser returns `[]` for malformed input, then
`expect(parse(garbage)).toEqual([])` passes even when the guard is entirely
broken — because the _happy path also produces `[]`_ for that input. The mutant
survives because your assertion cannot tell the two apart.

> **Pair the bad input with a good one.** Put a valid item alongside the malformed
> one and assert `[]`. Now a wrongly-_accepting_ guard emits the valid item and
> the assertion fails. That single change killed 37 survivors in one adapter.

**Filters that swallow the evidence.** `expect(result.filter(r => r.tool === 'x'))
.toEqual([])` passes when a mutant returns junk that has no `.tool` — the filter
drops it. Assert the shape too: `expect(result.every(r => Object.hasOwn(r, 'ruleId')))`.

**Fixtures too fresh, too small, too tidy.** A TTL test whose "recent" fixture is
milliseconds old passes under a mutant that shrinks the TTL to milliseconds. Give
fixtures a realistic magnitude: a day old, two spaces, a multi-digit number, a
path with an interior segment that looks like the prefix you strip.

**Always include a positive control.** For every "this must NOT be flagged" test,
add a sibling "this MUST be flagged". A whole suite of negative assertions passes
trivially if the code under test never fires at all.

## Writing the killing test

Read the mutant's `replacement` — it tells you exactly what to defeat.

- **Anchors (`^`, `$`) removed** → an input that matches in the middle but not at
  the end: `a.ts.bak` for `/\.tsx?$/`, `run-bash` for `/^bash$/`.
- **`\s+` → `\s`** → two spaces. `foo as  any`.
- **`&&` → `||`, or a clause → `true`** → an input that violates _exactly one_
  clause, so the guard's verdict hinges on the mutated one.
- **A method call dropped** (`.trim()`, `.filter(...)`) → input where that call
  matters: trailing whitespace, a mixed-type array.
- **An argv or options object emptied** → assert the exact argv and `cwd`.
- **A `return []` replaced with junk** → assert the elements' shape, not just
  emptiness.

## When it really is equivalent

1. **Write the argument down at the site**, as a comment, in terms of what makes
   the two indistinguishable. The next reader must be able to check your proof.
2. **Use a mutator-scoped directive**, never a blanket one:
   `// Stryker disable next-line ConditionalExpression` — not `disable next-line`.
   A blanket disable silently discards the real coverage on that line.

   But scoped is **not** precise. Directives match by **mutator name and line**,
   not by sub-expression, so on a compound condition every clause shares a start
   line with the whole chain and one directive silences all of them. Measured on
   a real file: suppressing 4 equivalent mutants silenced 19, taking 15
   genuinely-killed ones as collateral. **The remedy is to reorder the `&&`/`||`
   chain so the equivalent clause is not leftmost**, putting it on its own line.
   Check the reorder preserves short-circuit safety — it does when the null check
   still precedes every property access, since `typeof` never dereferences.

3. **Placement is fussy.** `disable next-line` only attaches to a comment that
   leads a statement. It will not attach from the end of a previous block (above
   a `} else if`, or above a `} catch {`). Use a
   `// Stryker disable X` … `// Stryker restore X` range there, or restructure so
   the directive has a statement to lead.

   A **`restore` only binds if a statement follows it.** One placed after a
   `return` never attaches, and its `disable` then silently runs to **end of
   file**. That exact bug hid 21 mutants across four functions in one file while
   the report read zero survivors. Prefer `disable next-line` over a range; where
   a range is unavoidable, put the `restore` before a real statement. Prettier
   also collapses a `}` / `catch {` pair and relocates a comment placed there,
   defeating the directive — such sites need `// prettier-ignore`.

4. **Verify the directive took effect, and measure its collateral.** Re-run and
   confirm the mutant moved to `Ignored` rather than staying `Survived` — a
   directive that silently failed to attach is easy to miss. Then check what
   _else_ moved: record per-file `Ignored` and `Killed` before and after.
   `Ignored` must rise by exactly the number you intended, and `Killed` must not
   drop. Losing real coverage to silence an equivalent mutant is a worse trade
   than leaving the mutant.

## Exemptions need a human

A `// Stryker disable` directive is a gate-weakening suppression, and the
diff-auditor treats it as one. It requires an entry in
`guardrails.config.json`'s `sanctionedSuppressions`.

**You do not add that entry.** Ask the developer, with:

- the exact `file|kind|text` key,
- the equivalence argument, or what you tried and why it cannot work,
- what stops being checked once it is granted.

**Nothing downstream will catch a self-grant for you.** `sanctions-check`
prints every newly-added key and exits 0 — by design, since the human reviewing
the change is the control, and a check that failed on every legitimate approval
would deadlock the very review that constitutes it. Where that review is a pull
request, merging it is the approval; in a `solo` repo there may be no pull
request at all. Either way the ask is the whole control, not a formality on top
of one: it catches a _wrong_ exemption now, while you still have the context to
explain it and the developer can still say "no — fix the code instead."

## Do not

- **Do not weaken a test to kill a mutant.** Loosening an assertion until the
  mutant dies inverts the entire exercise.
- **Do not delete the mutated code** because nothing covers it. That is the
  no-deletion rule; flag it instead.
- **Do not chase `NoCoverage` mutants here.** They mean no test runs that line at
  all — a coverage gap, not a hollow assertion.
- **Do not raise thresholds or widen `excludedMutations`** to make a run pass.
  Noise is controlled by scoping the run, never by tolerating survivors.
