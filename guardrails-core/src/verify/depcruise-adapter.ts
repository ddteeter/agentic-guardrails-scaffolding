/**
 * dependency-cruiser adapter: maps `depcruise --output-type json` output into
 * `Violation[]`.
 *
 * dependency-cruiser reports rule violations under `summary.violations`, each a
 * forbidden edge `{ from, to, rule: { name, severity }, cycle? }`. Every
 * violation is `fixable: false`: dependency-cruiser has no safe autofix, and a
 * graph fix (delete the import, invert the dependency, add an exception) is a
 * judgment, never a silent autofix. Paths are emitted repo-relative already.
 */

import type { Severity, Violation } from '../violation.js';

interface DepcruiseRule {
  name: string;
  severity: string;
}

interface DepcruiseViolation {
  from: string;
  to: string;
  rule: DepcruiseRule;
  cycle?: { name: string }[];
}

function isDepcruiseReport(
  value: unknown,
): value is { summary: { violations: DepcruiseViolation[] } } {
  if (
    value === null ||
    // Equivalent mutant: proved by cases, not by a shared-shape argument
    // (this is an early-return guard, not an `&&`-chain clause). `value ===
    // null`: null → typeof null is 'object', so the surviving `value ===
    // null` half still returns false. A non-null primitive (string/number/
    // boolean): property access on it (`(5).summary`) never throws, it's
    // `undefined`, which the very next guard (`typeof summary !== 'object'`)
    // independently rejects. A genuine object/array: this clause was already
    // false unmutated. Every case ends at the same false/[] result. Reordered
    // (`value === null` leads) so the directive's line doesn't also cover
    // `value === null` — Stryker disable comments match by mutator + line,
    // and the leftmost clause of a chain always shares its start line with
    // the whole chain (measured; see guardrails.config.json).
    // Stryker disable next-line ConditionalExpression
    typeof value !== 'object'
  ) {
    return false;
  }
  const summary = (value as { summary?: unknown }).summary;
  if (typeof summary !== 'object' || summary === null) {
    return false;
  }
  const violations = (summary as { violations?: unknown }).violations;
  return (
    Array.isArray(violations) &&
    violations.every(
      (v) =>
        // `v !== null` leads (not `typeof v === 'object'`) for the same
        // line-isolation reason as above.
        v !== null &&
        // Equivalent mutant: no value JSON.parse can produce is both
        // non-object and carries string `from`/`to` and a `rule` object with
        // string `name`/`severity`.
        // Stryker disable next-line ConditionalExpression
        typeof v === 'object' &&
        typeof (v as DepcruiseViolation).from === 'string' &&
        typeof (v as DepcruiseViolation).to === 'string' &&
        typeof (v as { rule?: { name?: unknown } }).rule?.name === 'string' &&
        // Equivalent mutant: this clause only runs once the `.rule?.name`
        // check above has passed, which requires `rule` to already be a
        // real object (a nullish `rule` makes `rule?.name` evaluate to
        // `undefined`, never `=== 'string'`). So by the time this
        // short-circuited `&&` reaches `.rule?.severity`, `rule` is
        // guaranteed non-nullish — property access on it can never throw,
        // `?.` or not. (Contrast `.rule?.name` itself, two lines up: nothing
        // gates that access, so `rule` can still be undefined there, which
        // is exactly why the analogous mutant on `.rule?.name` is real, not
        // equivalent — see the "no rule object at all" test.)
        // Stryker disable next-line OptionalChaining
        typeof (v as { rule?: { severity?: unknown } }).rule?.severity ===
          'string',
    )
  );
}

/**
dependency-cruiser `error → error`; `warn`/`info → warn`; anything else skipped.
*/
function toSeverity(severity: string): Severity | undefined {
  if (severity === 'error') {
    return 'error';
  }
  if (severity === 'warn' || severity === 'info') {
    return 'warn';
  }
  return undefined;
}

function toMessage(violation: DepcruiseViolation): string {
  if (Array.isArray(violation.cycle)) {
    const path = violation.cycle.map((module) => module.name).join(' → ');
    return `Circular dependency: ${path}`;
  }
  return `${violation.rule.name}: ${violation.from} → ${violation.to}`;
}

function toViolation(violation: DepcruiseViolation): Violation | undefined {
  const severity = toSeverity(violation.rule.severity);
  if (severity === undefined) {
    return undefined;
  }
  return {
    ruleId: `dependency-cruiser/${violation.rule.name}`,
    file: violation.from,
    message: toMessage(violation),
    severity,
    fixable: false,
    tool: 'dependency-cruiser',
  };
}

export function parseDepcruiseJson(
  stdout: string,
  _repoRoot: string,
): Violation[] {
  let parsed: unknown;
  // prettier-ignore
  try {
    parsed = JSON.parse(stdout);
  }
  // Equivalent mutant: emptying the catch body leaves `parsed` undefined
  // (the try body's assignment never lands on a throw), which
  // isDepcruiseReport rejects below — the function still returns []. `catch`
  // is forced onto its own line (prettier-ignore keeps it there) so this
  // directive's line matches only the catch block, not the try block above
  // it: the try block's own BlockStatement mutant is real (measured) — it
  // silently drops every value on ANY input, valid or not, which the
  // happy-path tests catch — so it must stay mutated.
  // Stryker disable next-line BlockStatement
  catch {
    return [];
  }
  if (!isDepcruiseReport(parsed)) {
    return [];
  }
  return parsed.summary.violations
    .map((violation) => toViolation(violation))
    .filter((violation): violation is Violation => violation !== undefined);
}
