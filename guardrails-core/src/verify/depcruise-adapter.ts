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
  if (typeof value !== 'object' || value === null) {
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
        typeof v === 'object' &&
        v !== null &&
        typeof (v as DepcruiseViolation).from === 'string' &&
        typeof (v as DepcruiseViolation).to === 'string' &&
        typeof (v as { rule?: { name?: unknown } }).rule?.name === 'string' &&
        typeof (v as { rule?: { severity?: unknown } }).rule?.severity ===
          'string',
    )
  );
}

/** dependency-cruiser `error → error`; `warn`/`info → warn`; anything else skipped. */
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

function toViolation(
  violation: DepcruiseViolation,
  packageId?: string,
): Violation | undefined {
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
    ...(packageId === undefined ? {} : { package: packageId }),
  };
}

export function parseDepcruiseJson(
  stdout: string,
  _repoRoot: string,
  packageId?: string,
): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isDepcruiseReport(parsed)) {
    return [];
  }
  return parsed.summary.violations
    .map((violation) => toViolation(violation, packageId))
    .filter((violation): violation is Violation => violation !== undefined);
}
