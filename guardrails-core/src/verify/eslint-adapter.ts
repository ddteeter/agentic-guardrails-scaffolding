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
        // `r !== null` leads (not `typeof r === 'object'`) so the equivalent
        // mutant below sits on its own line: Stryker's disable comments match
        // by mutator + line, and the leftmost clause of a chain always shares
        // its start line with every combined-clause mutant on that chain, so
        // a directive there would silence real coverage too (measured; see
        // guardrails.config.json).
        r !== null &&
        // Equivalent mutant: no value JSON.parse can produce is both
        // non-object and carries a string `filePath` / array `messages`, so
        // this clause can never be false while the two below it are true.
        // Stryker disable next-line ConditionalExpression
        typeof r === 'object' &&
        typeof (r as RawEslintResult).filePath === 'string' &&
        Array.isArray((r as RawEslintResult).messages),
    )
  );
}

export function parseEslintJson(stdout: string, repoRoot: string): Violation[] {
  let parsed: unknown;
  // prettier-ignore
  try {
    parsed = JSON.parse(stdout);
  }
  // Stryker disable next-line BlockStatement
  catch {
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
      };
      violations.push(violation);
    }
  }
  return violations;
}
