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

export function parseTscOutput(
  stdout: string,
  repoRoot: string,
  packageId?: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const line of stdout.split('\n')) {
    const match = DIAGNOSTIC.exec(line);
    if (!match) {
      continue;
    }
    const [, rawFile, lineNumber, code, message] = match;
    const file =
      rawFile !== undefined && path.isAbsolute(rawFile)
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
      ...(packageId === undefined ? {} : { package: packageId }),
    });
  }
  return violations;
}
