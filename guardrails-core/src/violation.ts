/**
 * The normalized violation contract — the linchpin of the guardrail system.
 *
 * Every check, in every language, funnels into this one schema so that
 * rule-ID tallying is deterministic and language-agnostic. Adapters
 * (eslint, tsc, knip, pmd, pitest, ...) are responsible for mapping their
 * native output into `Violation[]`.
 */

/** A violation is either a hard failure (`error`) or advisory (`warn`). */
export type Severity = 'error' | 'warn';

export interface Violation {
  /** Stable, namespaced id, e.g. `ts/no-assertionless-test`. */
  ruleId: string;
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line, when the tool reports one. */
  line?: number;
  message: string;
  severity: Severity;
  /** `true` → belongs to the silent PostToolUse autofix class. */
  fixable: boolean;
  /** The producing tool, e.g. `eslint` | `tsc` | `knip` | `pmd`. */
  tool: string;
  /** Workspace/module id in monorepos; `undefined` in single-repo layouts. */
  package?: string;
}

const SEVERITIES = new Set<Severity>(['error', 'warn']);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.has(value as Severity);
}

/** Runtime validator — a type guard for a single violation. */
export function isViolation(value: unknown): value is Violation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.ruleId !== 'string' || v.ruleId.length === 0) {
    return false;
  }
  if (typeof v.file !== 'string' || v.file.length === 0) {
    return false;
  }
  if (typeof v.message !== 'string') {
    return false;
  }
  if (!isSeverity(v.severity)) {
    return false;
  }
  if (typeof v.fixable !== 'boolean') {
    return false;
  }
  if (typeof v.tool !== 'string') {
    return false;
  }
  if (v.line !== undefined && typeof v.line !== 'number') {
    return false;
  }
  if (v.package !== undefined && typeof v.package !== 'string') {
    return false;
  }
  return true;
}

/** `verify` exits non-zero when any error-severity violation exists. */
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
