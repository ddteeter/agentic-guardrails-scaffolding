---
name: boundary-validation
description: Use when a fix touches an `as` cast on data crossing a trust boundary — parsed JSON from disk, a network response, an environment variable, or external tool output — especially when the only mechanical fix for a type error there would be adding one. Covers why no lint rule reliably gates this, the runtime-validator alternative, and what's deliberately left for the adopting repo to decide.
---

# Boundary validation

A trust boundary is where data enters your program from outside its own type
system: `JSON.parse` on a file read from disk, a `fetch` response body, an
environment variable, the parsed output of another tool. At that boundary,
`as T` is a lie the compiler is asked to believe — it makes the type error go
away without checking that the value actually has the shape `T` claims. If it
doesn't, the mistake surfaces later, far from the cast, as a runtime error
about a property that "shouldn't" be undefined.

## Why this isn't a lint rule

An earlier investigation tried to make "unvalidated cast at a trust boundary"
an enforced gate, using `@typescript-eslint/no-unsafe-type-assertion` — the
one existing rule aimed at exactly this. Enabling it on this repo produced 23
findings, and almost all of them were not the thing the rule was meant to
catch. They were the **sanctioned parse-don't-validate idiom**: a narrowing
cast inside a type guard's own body, checking the fields it just asserted
(`(issue as KnipIssue).file === 'string'`), or a generic constraint (`value as T`)
that has nothing to do with a trust boundary at all. The rule cannot tell "cast
then validate" from "cast and trust" — it flags the narrowing assertion that
**is** the safe pattern along with the one that launders untyped data.

Narrowing the rule to only the syntactic `JSON.parse(x) as T` form removes
those false positives, but at the cost of the equally dangerous two-line form:
`const parsed = JSON.parse(x); const doc = parsed as T;` slips through
untouched, because the cast is no longer adjacent to the parse call the
narrower rule pattern-matches on. Tightening the rule to kill false positives
opens false negatives, because the property the rule needs — "was this value
checked before the cast" — is a dataflow question a syntactic lint cannot
answer, and no configuration of this rule closes both gaps at once. **There is
no lint gate for this concern that is both reliable and complete**, so none
ships.

## The by-construction fix: validate, don't cast

Prefer a runtime validator over a structural cast at every trust boundary:

```ts
const config = ConfigSchema.parse(JSON.parse(raw));
```

not

```ts
const config = JSON.parse(raw) as Config;
```

`.parse()` throws when the document doesn't match `ConfigSchema`, so the type
on the left is true because it was checked, not because it was asserted. This
is the positive form of the same goal the lint rule chased: a validated value
produces no cast at all, so there's nothing left to (un)reliably detect.

## The fixer's redirect

If the only mechanical way to satisfy a type error at a trust boundary is to
add a structural cast, that is not a fix — route it to a runtime validator
instead of casting or deleting the code.

## What this skill does not decide

No validator ships with guardrails-core, and none is chosen for you: picking
zod, valibot, typia, or arktype for a given repo is a judgement call made
during adoption, not a default this doc supplies — see the `adopting-guardrails`
skill's step 5.

## What stays caught

None of this loosens the diff-auditor's existing rejection of `as any`,
`as unknown as`, and `<any>`. Those aren't narrowing casts with a legitimate
reading — they're the explicit escape hatch from the type system, which is why
they're reliably detectable where a laundering `as SomeShape` is not. The
fixer remains forbidden from adding any of them, boundary or not.
