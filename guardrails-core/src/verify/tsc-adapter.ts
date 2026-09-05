/**
 * TypeScript adapter: maps `tsc --noEmit --pretty false` output into
 * `Violation[]`. Type errors are never mechanically fixable (`fixable: false`)
 * and always `error` severity. The TS error code (e.g. `TS2322`) is the stable
 * rule id.
 *
 * On parsing fragility (tsc has no JSON diagnostics mode): we pin the format
 * with `--pretty false`, whose one-line `file(line,col): error TSxxxx: msg`
 * shape has been stable across TS 3–5. We match only that shape, so unrelated
 * lines — the trailing `Found N errors` summary and indented related-info
 * ("'x' is declared here.") continuation lines — are skipped rather than
 * mis-parsed. If this ever proves brittle, the robust (heavier) alternative is
 * the TypeScript compiler API (`ts.getPreEmitDiagnostics`), which couples us to
 * the repo's TS version and is deferred until a real break demands it.
 */

import path from 'node:path';

import type { Violation } from '../violation.js';

// e.g. `src/foo.ts(12,5): error TS2322: Type '...' is not assignable ...`
// Greedy leading group so the match anchors on the FINAL `(line,col): error`,
// not a `(1,2)`-shaped segment inside the path itself.
const DIAGNOSTIC = /^(.+)\((\d+),\d+\): error (TS\d+): (.+)$/;

export function parseTscOutput(stdout: string, repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const line of stdout.split('\n')) {
    const match = DIAGNOSTIC.exec(line);
    if (!match) {
      continue;
    }
    const [, rawFile, lineNumber, code, message] = match;
    // Bound to a name, and broken across lines, so two constraints can hold at
    // once. `unicorn/prefer-simple-condition-first` wants the cheap
    // `rawFile !== undefined` test to lead; Stryker's disable comments match by
    // mutator + LINE, and the leftmost clause of an `&&` chain shares its start
    // line with the whole chain (measured; see guardrails.config.json) — so
    // leading with it inside the condition would put the directive on a line
    // carrying both clauses and suppress the killable `path.isAbsolute` mutant
    // too. Starting the expression on its own line gives each clause a line.
    const isAbsoluteDiagnosticPath =
      // Equivalent mutant: `rawFile` is `match[1]`, the DIAGNOSTIC regex's
      // first capture group. That group is mandatory (`(.+)`, not optional
      // and not behind an alternation), so whenever `match` is non-null,
      // `rawFile` is already guaranteed to be a defined string — no input can
      // make `rawFile === undefined` while `match` still succeeds.
      // Stryker disable next-line ConditionalExpression
      rawFile !== undefined && path.isAbsolute(rawFile);
    const file = isAbsoluteDiagnosticPath
      ? path.relative(repoRoot, rawFile)
      : (rawFile ?? '');
    violations.push({
      ruleId: code ?? 'tsc/unknown',
      file,
      line: Number(lineNumber),
      message: message ?? '',
      severity: 'error',
      fixable: false,
      tool: 'tsc',
    });
  }
  return violations;
}
