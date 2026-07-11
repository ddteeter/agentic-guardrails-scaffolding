/**
 * TypeScript adapter: maps `tsc --noEmit --pretty false` output into
 * `Violation[]`. Type errors are never mechanically fixable (`fixable: false`)
 * and always `error` severity. The TS error code (e.g. `TS2322`) is the stable
 * rule id.
 */

import path from 'node:path';

import type { Violation } from '../violation.js';

// e.g. `src/foo.ts(12,5): error TS2322: Type '...' is not assignable ...`
const DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/;

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
