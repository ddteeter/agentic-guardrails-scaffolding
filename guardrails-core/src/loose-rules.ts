/**
 * Loose-rule classification (§2.3). A "loose" rule is one where a check only
 * loosely pins the fix — a *green* result is easily far from a *good* one — so
 * it must route to the thorough fixer from attempt 1 rather than let the bottom
 * tier find the cheapest green path. This is a **safety** mechanism, so the
 * default classification of well-known tool rules ships in core (generic
 * knowledge, not house policy); a repo extends it via `looseRules` in
 * `guardrails.config.json`.
 *
 * The classification asks one question of a rule, and it is not "which
 * analyzer produced this": it is **can the obvious mechanical fix be wrong?**
 * The analyzer-category sets below (test integrity, architecture, mutation,
 * dead code, duplication) are the cases where the answer is usually yes, but
 * they are a proxy, not the question --
 * `BEHAVIOUR_CHANGING_FIX_RULE_NAMES` holds the members that the proxy misses.
 *
 * Surfaced by the dogfooding live proof: `vitest/expect-expect` /
 * `sonarjs/no-trivial-assertions` ran at the fast tier, which added a trivial
 * (constant-folded) assertion that tripped the next rule and churned until
 * escalation. These are textbook loose rules.
 */

/**
Rule *names* (the segment after the last `/`) that are loose in any plugin.
*/
const LOOSE_RULE_NAMES = new Set([
  'expect-expect',
  'no-trivial-assertions',
  'assertions-in-tests',
  'no-assertionless-test',
  'no-restricted-imports',
]);

/**
 * Rule *names* whose obvious mechanical fix is a **behaviour change**.
 *
 * The classes above are named for what the analyzer CHECKS (test integrity,
 * architecture, mutation, dead code). This one is named for what the FIX does,
 * because that is the property routing actually turns on: a plain style rule
 * can still be a rule where the cheapest green edit silently changes what the
 * code accepts at runtime, and the analyzer's category says nothing about it.
 *
 * Measured member: `unicorn/no-null`. The bottom tier rewrote a nullable
 * column's guard `x == null` (null AND undefined) to `x === undefined` (one of
 * them), which satisfies the rule, passes lint, and leaves the guard
 * unreachable for exactly the value it existed to catch. The thorough tier,
 * handed the same rule on the same line, wrote `typeof x !== 'number'` --
 * green, and also correct.
 *
 * The other two share the shape: both fire on what the CHECKER believes the
 * type to be, and their mechanical fix (delete the condition; rewrite
 * `x === false` to `!x`) is only equivalent while that belief holds. At a
 * trust boundary -- parsed JSON, a database row, an env var -- the declared
 * type is an assertion rather than a fact, and the "unnecessary" check being
 * deleted is the one thing standing between a lie and a runtime error. (See
 * the `boundary-validation` guidance for why no lint rule can tell the two
 * apart.)
 *
 * Deliberately NOT here: `unicorn/no-await-expression-member`. Its obvious fix
 * -- bind the awaited value to a local, then read the member -- preserves
 * behaviour except when the member access sits in a conditionally-evaluated
 * subexpression (`a && (await b()).c`), where hoisting makes the await
 * unconditional; and its shipped autofix only rewrites the declarator form
 * into destructuring, which cannot change behaviour at all. Loose-classing
 * costs a more expensive model on EVERY occurrence, and this is a frequent
 * rule with a rare failure. Revisit it if one is ever measured.
 */
const BEHAVIOUR_CHANGING_FIX_RULE_NAMES = new Set([
  'no-null',
  'no-unnecessary-condition',
  'no-unnecessary-boolean-literal-compare',
]);

/**
Plugin/tool prefixes whose rules are loose as a family.
*/
const LOOSE_PREFIXES = [
  'boundaries/',
  'stryker/',
  'knip/',
  'dependency-cruiser/',
  // Duplication. "Delete one copy" and "extract into the wrong shape" are both
  // green and both wrong; whether two sites should be unified depends on
  // whether their behaviour must evolve together, which is judgment the fast
  // tier does not spend.
  'fallow/',
];

/**
Cross-cutting patterns (e.g. Java tools embed the tool name in the id).
*/
const LOOSE_PATTERNS = [/archunit/i, /\bpitest\b/i, /\bdescartes\b/i];

/**
 * The bare rule name: `no-console` from `eslint/no-console`, and `TS2322`
 * unchanged.
 *
 * Branchless on purpose. The guard this replaced (`slash === -1 ? ruleId :
 * ...`) had an unkillable mutant in it: `lastIndexOf` answers -1 when there is
 * no slash, and `slice(-1 + 1)` is `slice(0)`, which is the whole string -- so
 * removing the guard changes no output for any input. Deleting the branch is
 * the honest fix; a suppression would have been recording that we could not
 * tell the difference.
 */
function ruleName(ruleId: string): string {
  return ruleId.slice(ruleId.lastIndexOf('/') + 1);
}

/**
The generic, ships-in-core default: is this a known loose-class rule?
*/
export function isBuiltinLoose(ruleId: string): boolean {
  return (
    LOOSE_RULE_NAMES.has(ruleName(ruleId)) ||
    BEHAVIOUR_CHANGING_FIX_RULE_NAMES.has(ruleName(ruleId)) ||
    LOOSE_PREFIXES.some((prefix) => ruleId.startsWith(prefix)) ||
    LOOSE_PATTERNS.some((pattern) => pattern.test(ruleId))
  );
}

/**
 * Build the gate's `isLoose` predicate: the built-in default OR-ed with the
 * repo's own exact rule-ids from `looseRules`.
 */
export function makeIsLoose(
  repoLooseRules: readonly string[],
): (violation: { ruleId: string }) => boolean {
  const repo = new Set(repoLooseRules);
  return (violation) =>
    isBuiltinLoose(violation.ruleId) || repo.has(violation.ruleId);
}
