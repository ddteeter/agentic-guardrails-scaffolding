/**
 * Per-analyzer opt-in policy (Phase E piece 1). `ANALYZERS` is a fixed table,
 * so without this every consumer runs the whole TypeScript pack — and since
 * Phase C piece 5 an analyzer that cannot be started is an error-severity
 * violation, a repo that does not install knip, dependency-cruiser AND Stryker
 * is permanently blocked. That severity is right (a guard that silently did not
 * run is worse than no guard); what was missing is a way to say "I did not ask
 * for that one".
 *
 * The rule in one sentence: OFF if the config says off; otherwise it runs if it
 * is there, and a missing binary is an error only if it was asked for — in
 * `analyzers` or in the repo's own `package.json`.
 *
 * Pure functions in their own module, deliberately: the decision is the part
 * worth proving, and proving it should not require spawning anything.
 */

/**
How a repo has opted into one analyzer. Absent from config means `auto`.
*/
export type AnalyzerMode = 'off' | 'auto' | 'required';

export interface AnalyzerDecision {
  /**
  Spawn the analyzer at all.
  */
  run: boolean;
  /**
   * When the spawn fails, report `guardrails/analyzer-missing` rather than
   * treating the absence as a deliberate opt-out.
   */
  reportMissing: boolean;
}

/**
 * The truth table from the design doc §3.3. `isProviderDeclared` is whether the
 * analyzer's npm package is named in the consumer's own `package.json`: a
 * declared-but-unresolvable tool is a broken install, not an opt-out, and must
 * never read as a clean gate. That distinction is what makes
 * installed-means-enabled safe as a default.
 */
export function decideAnalyzer(
  mode: AnalyzerMode,
  isProviderDeclared: boolean,
): AnalyzerDecision {
  if (mode === 'off') {
    return { run: false, reportMissing: false };
  }
  if (mode === 'required') {
    return { run: true, reportMissing: true };
  }
  return { run: true, reportMissing: isProviderDeclared };
}

/**
The configured mode for `tool`, defaulting to `auto` when unlisted.
*/
export function analyzerMode(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
  tool: string,
): AnalyzerMode {
  return analyzers[tool] ?? 'auto';
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every package name a `package.json` declares, across all four dependency
 * fields. Takes the already-parsed manifest rather than a path so it stays
 * pure; the caller owns the read. A malformed manifest yields an empty set,
 * which degrades to "nothing was asked for" — the conservative direction, since
 * the alternative would invent a demand the repo never made.
 */
export function declaredProviders(manifest: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  if (!isRecord(manifest)) {
    return names;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (!isRecord(section)) {
      continue;
    }
    for (const name of Object.keys(section)) {
      names.add(name);
    }
  }
  return names;
}
