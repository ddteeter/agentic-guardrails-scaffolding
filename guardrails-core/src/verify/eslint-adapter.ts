/**
 * ESLint adapter: maps `eslint --format json` output into `Violation[]`.
 *
 * A message is `fixable` (belongs to the silent PostToolUse autofix class)
 * when ESLint attached a `fix` to it. Parse errors (null ruleId) map to a
 * stable synthetic rule id so they still tally deterministically.
 */

import path from 'node:path';

import type { Violation } from '../violation.js';

interface RawEslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  fix?: unknown;
}

interface RawEslintResult {
  filePath: string;
  messages: RawEslintMessage[];
}

function isResultArray(value: unknown): value is RawEslintResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RawEslintResult).filePath === 'string' &&
        Array.isArray((r as RawEslintResult).messages),
    )
  );
}

export function parseEslintJson(
  stdout: string,
  repoRoot: string,
  packageId?: string,
): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!isResultArray(parsed)) {
    return [];
  }

  const violations: Violation[] = [];
  for (const result of parsed) {
    const file = path.relative(repoRoot, result.filePath);
    for (const message of result.messages) {
      const violation: Violation = {
        ruleId: message.ruleId ?? 'eslint/parse-error',
        file,
        message: message.message,
        severity: message.severity === 2 ? 'error' : 'warn',
        fixable: message.fix !== undefined,
        tool: 'eslint',
        ...(message.line === undefined ? {} : { line: message.line }),
        ...(packageId === undefined ? {} : { package: packageId }),
      };
      violations.push(violation);
    }
  }
  return violations;
}
