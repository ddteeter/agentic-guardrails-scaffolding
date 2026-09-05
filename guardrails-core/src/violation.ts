/**
 * The normalized violation contract — the linchpin of the guardrail system.
 *
 * Every check, in every language, funnels into this one schema so that
 * rule-ID tallying is deterministic and language-agnostic. Adapters
 * (eslint, tsc, knip, pmd, pitest, ...) are responsible for mapping their
 * native output into `Violation[]`.
 */

/**
A violation is either a hard failure (`error`) or advisory (`warn`).
*/
export type Severity = 'error' | 'warn';

export interface Violation {
  /**
  Stable, namespaced id, e.g. `ts/no-assertionless-test`.
  */
  ruleId: string;
  /**
  Repo-relative path.
  */
  file: string;
  /**
  1-indexed line, when the tool reports one.
  */
  line?: number;
  message: string;
  severity: Severity;
  /**
  `true` → belongs to the silent PostToolUse autofix class.
  */
  fixable: boolean;
  /**
  The producing tool, e.g. `eslint` | `tsc` | `knip` | `pmd`.
  */
  tool: string;
  /**
  Workspace/module id in monorepos; `undefined` in single-repo layouts.
  */
  package?: string;
  /**
   * Repo-relative path to guidance for this violation class, when one exists.
   * Carried ON the violation so it survives into the manifest the fixer reads —
   * that is the only channel every runtime shares. Instruction files, skills and
   * index docs are all per-surface and cooperative; this is neither.
   */
  guidance?: string;
}

const SEVERITIES = new Set<Severity>(['error', 'warn']);

function isSeverity(value: unknown): value is Severity {
  // Equivalent mutant on the typeof half: SEVERITIES holds only the strings
  // 'error' and 'warn', so `has(x)` can only be true when x IS a string.
  // Stryker disable next-line ConditionalExpression
  return typeof value === 'string' && SEVERITIES.has(value as Severity);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** The always-present string fields. `ruleId`/`file` must also be non-empty —
 *  an empty id would collapse distinct rules into one recurrence bucket. */
function hasRequiredFields(v: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(v.ruleId) &&
    isNonEmptyString(v.file) &&
    typeof v.message === 'string' &&
    typeof v.tool === 'string' &&
    typeof v.fixable === 'boolean' &&
    isSeverity(v.severity)
  );
}

/**
Optional fields: absent is fine, present-but-wrongly-typed is not.
*/
function hasValidOptionalFields(v: Record<string, unknown>): boolean {
  return (
    (v.line === undefined || typeof v.line === 'number') &&
    (v.package === undefined || typeof v.package === 'string') &&
    (v.guidance === undefined || typeof v.guidance === 'string')
  );
}

/**
Runtime validator — a type guard for a single violation.
*/
export function isViolation(value: unknown): value is Violation {
  // Equivalent mutant on the typeof half: `value === null` still catches null,
  // and a primitive that slips past is rejected field-by-field below
  // ('str'.ruleId is undefined).
  // Stryker disable next-line ConditionalExpression
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return hasRequiredFields(v) && hasValidOptionalFields(v);
}

/**
`verify` exits non-zero when any error-severity violation exists.
*/
export function hasErrors(violations: readonly Violation[]): boolean {
  return violations.some((v) => v.severity === 'error');
}

/**
 * Recurrence memory keys on `package:ruleId` in workspace layouts so a
 * recurring mistake in one package isn't diluted across the repo; on the
 * bare `ruleId` in single-repo layouts.
 */
export function recurrenceKey(violation: Violation): string {
  return violation.package === undefined
    ? violation.ruleId
    : `${violation.package}:${violation.ruleId}`;
}
