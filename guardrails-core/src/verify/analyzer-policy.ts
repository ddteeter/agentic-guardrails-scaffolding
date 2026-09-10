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

import { isRecord } from './report-shape.js';

/**
How a repo has opted into one analyzer. Absent from config means `auto`.
*/
export type AnalyzerMode = 'off' | 'auto' | 'required';

/**
 * The cadence rungs, cheapest first. An analyzer declares the LOWEST rung it
 * runs at, and every rung above it runs it too — a floor, never an equality
 * test, so `verify` (ci) can never check less than a local gate does.
 *
 * `push` sits between `commit` and `ci` and was added for #61. Before it,
 * `runCommitGate` hardcoded the `commit` profile and `gate --mode=push`
 * differed from `--mode=commit` only in diff scope, so "run this at push but
 * not at commit" could not be said at all. Nothing in the built-in table sits
 * above `commit`; the rung exists for consumers to move an analyzer ONTO.
 *
 * Declared here rather than in `verify/index.ts` so `config.ts` can parse a
 * rung without importing the orchestrator — the module graph has a no-circular
 * rule, and `verify/index.ts` already depends on this file.
 */
export type Rung = 'stop' | 'commit' | 'push' | 'ci';

export const RUNG_ORDER: Record<Rung, number> = {
  stop: 0,
  commit: 1,
  push: 2,
  ci: 3,
};

export function isRung(value: unknown): value is Rung {
  return RUNG_NAMES.has(value);
}

/**
 * Typed `ReadonlySet<unknown>` rather than `ReadonlySet<string>`, so `isRung`
 * can hand it an `unknown` directly.
 *
 * That is what removes the `typeof value === 'string' &&` half `isRung` would
 * otherwise need to satisfy the compiler — a half that is redundant at RUNTIME,
 * because `Set.prototype.has` compares with SameValueZero and never coerces, so
 * a non-string can never match a string member. A redundant guard is a provably
 * equivalent mutant: nothing can distinguish it from `true &&`. Widening the
 * set's type deletes the mutant instead of suppressing it, which costs a
 * sanction nobody has to justify later.
 */
const RUNG_NAMES: ReadonlySet<unknown> = new Set<unknown>(
  Object.keys(RUNG_ORDER),
);

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
 * Analyzers whose UNLISTED default is not `auto`, and why each one is here.
 *
 * `auto` — run it if its binary resolves — is right for a tool that is useful
 * the moment it is installed. It is wrong for one whose precision depends on
 * an ignore list only the adopting repo can write.
 *
 * - **`dupes`** (`fallow dupes`): a clone detector's noise sources are
 *   inherently repo-specific — generated files, ORM schema DSLs, framework
 *   boilerplate — so an unconfigured run reports rhyming code rather than
 *   duplication worth fixing. Defaulting it to `auto` would also put it in
 *   `silentlySkippedAnalyzers` for every existing consumer, nagging them to
 *   install a tool they never asked for. Opting in is the adopter's decision.
 *
 * A table rather than a field on verify's `ANALYZERS` entries, deliberately:
 * the mode is consulted from three places (`selectAnalyzers`,
 * `silentlySkippedAnalyzers`, and the scaffolder's `isAnalyzerAsked`), and a
 * field would have had to be mirrored into `SeedOnceAnalyzer` and kept in sync
 * by hand. Here, every caller inherits it with no signature change.
 */
const DEFAULT_MODES: Readonly<Record<string, AnalyzerMode>> = {
  dupes: 'off',
};

/**
 * The configured mode for `tool`. An unlisted analyzer falls back to its entry
 * in `DEFAULT_MODES`, and to `auto` when it has none. An explicit setting
 * always wins, so a repo can still say `"dupes": "required"`.
 */
export function analyzerMode(
  analyzers: Readonly<Record<string, AnalyzerMode>>,
  tool: string,
): AnalyzerMode {
  return analyzers[tool] ?? DEFAULT_MODES[tool] ?? 'auto';
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

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
