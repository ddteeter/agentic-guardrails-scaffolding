/**
 * Loose-rule classification (§2.3). A "loose" rule is one where a check only
 * loosely pins the fix — a *green* result is easily far from a *good* one — so
 * it must route to the thorough fixer from attempt 1 rather than let the bottom
 * tier find the cheapest green path. This is a **safety** mechanism, so the
 * default classification of well-known tool rules ships in core (generic
 * knowledge, not house policy); a repo extends it via `looseRules` in
 * `guardrails.config.json`.
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
Plugin/tool prefixes whose rules are loose as a family.
*/
const LOOSE_PREFIXES = [
  'boundaries/',
  'stryker/',
  'knip/',
  'dependency-cruiser/',
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
