/**
 * Per-repo policy (`guardrails.config.json`, §3.3/§10.3). Records the choices
 * that let the solo→team transition be a config flip, not a rewrite. Every
 * field has a safe default so a missing or partial file still yields a working
 * config; unknown or wrongly-typed values are ignored defensively.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { auditKinds, type AuditKind } from './audit.js';
import type { GateConfig } from './gate-decision.js';
import { makeIsLoose } from './loose-rules.js';
import type { AnalyzerMode } from './verify/analyzer-policy.js';

/**
One reviewed diff-auditor exemption: the finding key plus why it is allowed.
*/
export interface SanctionedSuppression {
  /**
  Exact `file|kind|text` finding key this exempts.
  */
  key: string;
  /**
  Human-readable justification; blank or missing drops the entry.
  */
  reason: string;
  /**
  How many occurrences of this exact finding the grant covers. Defaults to 1.
  */
  count?: number;
}

/**
 * One reviewed exemption covering a whole FILE and one suppression kind, for
 * generated code (#39). Deliberately narrower in config surface than
 * `SanctionedSuppression` and broader in effect:
 *
 * - no `count`, because a generated file's occurrence count changes on every
 *   regeneration and `sanctionCountDrift` would fail the build each time. That
 *   churn is the defect this exists to remove.
 * - no suppression TEXT, because a generator that changes its cast shape
 *   across versions would silently invalidate a text-pinned grant.
 * - an exact `path`, never a glob: a glob can start covering a hand-written
 *   file added later, widening the grant with nobody re-reviewing it.
 *
 * Its only safeguard is review, which is why `reason` matters more here than on
 * a keyed grant, not less.
 */
export interface SanctionedFile {
  /**
  Exact repo-relative, POSIX-separated path, as `AuditFinding.file` carries it.
  */
  path: string;
  /**
  The single suppression kind this file is exempt from.
  */
  kind: AuditKind;
  /**
  Why the file's suppressions are unavoidable; blank or missing drops the entry.
  */
  reason: string;
}

/**
 * Outcome of parsing a `sanctionedSuppressions` array: the entries that
 * validated, and a human-readable reason for each that did not. Splitting the
 * result (rather than silently dropping malformed entries, as the gate's
 * `valid`-only consumers must) lets the CI sanctions check surface mistakes
 * instead of hiding them.
 */
export interface SanctionParseResult {
  valid: SanctionedSuppression[];
  /**
  Path-scoped grants (`sanctionedFiles`), kept apart from the keyed ones.
  */
  files: SanctionedFile[];
  malformed: string[];
}

export interface RepoConfig {
  baseBranch: string;
  maxAttempts: number;
  recurThreshold: number;
  graduationThreshold: number;
  fastFixer: string;
  thoroughFixer: string;
  /**
   * Exact rule-ids to treat as loose (route to the thorough fixer from attempt
   * 1), *extending* the built-in default classification in `loose-rules.ts`.
   * For house rules the built-in set doesn't know about.
   */
  looseRules: string[];
  /**
   * Per-analyzer opt-in (Phase E piece 1). Keyed by the analyzer's `tool` name
   * (`eslint`, `tsc`, `knip`, `dependency-cruiser`, `stryker`). An unlisted
   * analyzer is `auto`: it runs if its binary resolves, and a failure to
   * resolve is an error only when the repo's own `package.json` declares the
   * provider. `required` restores the unconditional hard error; `off` skips it
   * entirely. Empty by default. See `verify/analyzer-policy.ts`.
   */
  analyzers: Record<string, AnalyzerMode>;
  /**
   * Reviewed, checked-in escape hatch for the diff-auditor: exact
   * `file|kind|text` keys of suppressions a human has deliberately sanctioned
   * (e.g. a mutation-exclusion around a hand-written lexer). ONLY the commit
   * gate consults it — the Stop gate has a tighter, per-fix-loop snapshot
   * baseline, so a fixer still cannot add one mid-loop. Empty by default.
   *
   * Every entry carries a written `reason`: a bare key is unreviewable, and a
   * reviewer cannot tell a proven-equivalent mutant from "the agent got stuck".
   * Entries missing a key, a non-blank reason, or (when present) a positive
   * integer `count` are DROPPED — failing closed, so a malformed or unjustified
   * exemption simply does not apply. The gate spends `count` as a budget (one
   * grant exempts exactly that many occurrences of the finding, not every
   * occurrence in the file) — see `runCommitGate` in `gate.ts`. Adding an entry,
   * or raising an existing one's `count`, is a new grant that a human approves
   * by merging the pull request (`guardrails sanctions-check`); it cannot be
   * self-granted.
   */
  sanctionedSuppressions: SanctionedSuppression[];
  /**
   * Path-scoped exemptions for generated files (#39). Unlike
   * `sanctionedSuppressions` these carry no occurrence budget — a generated
   * file's count changes on every regeneration, and making the adopter track it
   * was the defect. Broader in effect and narrower in config surface; see
   * `SanctionedFile`. Empty by default.
   */
  sanctionedFiles: SanctionedFile[];
  distribution: 'solo' | 'team';
  /**
   * Consumed by exactly two commands in `cli-core.ts`: `gateCommitCommand`
   * (`gate --mode=commit`, run by `.husky/pre-commit`) and
   * `gatePreToolUseCommand` (`gate --mode=pretooluse`, the Copilot commit/push
   * gate). It governs whether a *failing gate on those two surfaces* blocks
   * (`block` → non-zero exit from `gate --mode=commit`; a deny payload from
   * `gate --mode=pretooluse`) or only warns (`warn` → zero exit; an allow with
   * a stderr note from `gate --mode=pretooluse`, since a deny payload IS the
   * block on both hook dialects — there is no "allow, but say this" channel).
   * Under `warn`, both commands still print every violation and every added
   * suppression in full — `gateCommitCommand` before returning 0,
   * `gatePreToolUseCommand` on stderr — and both then state outright that they
   * are not blocking and which setting makes them enforce, so a passing result
   * is never mistakable for a clean gate.
   * This repo's own CI does not currently invoke either command — its
   * `Guardrails verify` step calls bare `verify`, which does not consult this
   * field at all and always fails the build on an error-severity violation.
   *
   * Enforcement lives entirely in those two commands' exit code / deny
   * payload: no hook definition or workflow template encodes the policy
   * separately, so config and wiring cannot drift apart — anything that later
   * shells out to `gate --mode=commit` (a CI step, a different git hook)
   * inherits the enforcement decision for free, without reading this field.
   *
   * It deliberately does NOT gate the Claude Code Stop loop — that loop is the
   * flagship local feature and always runs regardless of `enforcement`; its
   * safety comes from the bounded attempt counter and the `--no-verify`
   * bypass, not from this flag. Softening the Stop loop under `warn` would be
   * switching the feature off rather than making it advisory, which is a
   * different decision than this field exists to make. `toGateConfig`
   * intentionally does not forward it.
   *
   * Parsed asymmetrically: absent → `warn`, present but invalid → `block`.
   * See `pickEnforcement`.
   */
  enforcement: 'warn' | 'block';
  /** Copilot model id for the fast/thorough fixer .agent.md (the tier ladder on
   * Copilot). Unset → omit `model` so the agent loads on Copilot's default. */
  copilotFastModel?: string;
  copilotThoroughModel?: string;
}

export function defaultConfig(): RepoConfig {
  return {
    baseBranch: 'main',
    maxAttempts: 3,
    recurThreshold: 3,
    graduationThreshold: 3,
    fastFixer: 'guardrail-fixer',
    thoroughFixer: 'guardrail-fixer-thorough',
    looseRules: [],
    analyzers: {},
    sanctionedSuppressions: [],
    sanctionedFiles: [],
    distribution: 'solo',
    enforcement: 'warn',
  };
}

/**
 * Parse a `guardrails.config.json` TEXT into its sanction list, defensively.
 * Shared by `loadConfig` (which keeps only `.valid`, so the gate still fails
 * closed on a malformed entry) and the CI sanctions check, which reads the
 * base revision of the file out of git rather than off disk and additionally
 * reports `.malformed` so a mistake is visible instead of silently dropped.
 */
export function parseSanctionsJson(text: string): SanctionParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { valid: [], files: [], malformed: ['config is not valid JSON'] };
  }
  if (!isRecord(raw)) {
    return { valid: [], files: [], malformed: [] };
  }
  const keyed = pickSanctions(raw.sanctionedSuppressions);
  const paths = pickSanctionedFiles(raw.sanctionedFiles);
  return {
    valid: keyed.valid,
    files: paths.files,
    // Both lists of complaints reach the CI check together: a malformed path
    // grant is as invisible-but-broken as a malformed keyed one.
    malformed: [...keyed.malformed, ...paths.malformed],
  };
}

/**
 * True when `value` is present and NOT a positive integer — i.e. malformed.
 * `Number.isInteger` never coerces (it returns `false`, never throws, for any
 * non-number type), so it alone already implies "not a valid count" for a
 * non-number `value` — a separate `typeof value !== 'number'` clause would be
 * fully subsumed by it and is deliberately omitted. The cast on the second
 * operand is sound (not merely convenient): `||` only evaluates it once
 * `!Number.isInteger(value)` is false, i.e. once `value` is already known, at
 * runtime, to be a number — `Number.isInteger`'s signature just can't express
 * that as a type guard for TypeScript to narrow on.
 */
function isMalformedCount(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) <= 0)
  );
}

/** Parse one raw sanction entry: either a valid suppression, or a
 * human-readable reason it is malformed (`entry <position>: ...`). */
function parseSanctionEntry(
  entry: unknown,
  position: number,
): ParsedEntry<SanctionedSuppression> {
  if (!isRecord(entry)) {
    return { malformed: `entry ${position}: not an object` };
  }
  const { key, reason, count } = entry;
  if (typeof key !== 'string' || key.trim() === '') {
    return { malformed: `entry ${position}: missing key` };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { malformed: `entry ${position}: missing reason` };
  }
  if (isMalformedCount(count)) {
    return {
      malformed: `entry ${position}: count must be a positive integer`,
    };
  }
  return {
    value: typeof count === 'number' ? { key, reason, count } : { key, reason },
  };
}

/**
 * A string carrying something. Written as a type guard rather than inline
 * `typeof x !== 'string' || !x.trim()` checks so the `typeof` half stays
 * KILLABLE: forcing it true makes `.trim()` run on a non-string and throw,
 * which a test observes. Inline behind an `||`, the same clause is a provably
 * equivalent mutant, because a non-string fails the check that follows anyway
 * — the shape this repo has had to sanction repeatedly elsewhere.
 */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * One parsed entry: the value, or a human-readable reason it was rejected.
 */
type ParsedEntry<T> = { value: T } | { malformed: string };

/**
 * Walk a config array, splitting entries into the ones that validated and the
 * reasons the rest did not.
 *
 * Shared by both sanction forms. The two used to carry a copy each of this
 * loop, which the `dupes` analyzer reported as 17 duplicated lines the moment
 * the second one was written — the duplication was introduced and removed in
 * the same change, which is the analyzer working exactly as intended.
 *
 * Positions are 1-based, because the message is read by a human counting
 * entries in a JSON array.
 */
function parseEntryList<T>(
  value: unknown,
  parseEntry: (entry: unknown, position: number) => ParsedEntry<T>,
): { values: T[]; malformed: string[] } {
  if (!Array.isArray(value)) {
    return { values: [], malformed: [] };
  }
  const values: T[] = [];
  const malformed: string[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseEntry(entry, index + 1);
    if ('malformed' in parsed) {
      malformed.push(parsed.malformed);
    } else {
      values.push(parsed.value);
    }
  }
  return { values, malformed };
}

/**
 * Parse one `sanctionedFiles` entry. A `count` is REJECTED rather than ignored:
 * removing the count churn is the whole reason this grant exists (#39), and
 * silently dropping one would leave an adopter believing they had bounded a
 * grant that is in fact unbounded.
 */
function parseSanctionedFile(
  entry: unknown,
  position: number,
): ParsedEntry<SanctionedFile> {
  if (!isRecord(entry)) {
    return { malformed: `sanctionedFiles ${position}: not an object` };
  }
  const { path: filePath, kind, reason, count } = entry;
  if (!isNonBlankString(filePath)) {
    return { malformed: `sanctionedFiles ${position}: missing path` };
  }
  // No `typeof kind === 'string'` guard: the Set rejects every non-string on
  // its own, so the clause would be a provably equivalent mutant rather than a
  // check.
  if (!auditKinds().has(kind as AuditKind)) {
    return {
      malformed: `sanctionedFiles ${position}: unknown kind ${String(kind)}`,
    };
  }
  if (!isNonBlankString(reason)) {
    return { malformed: `sanctionedFiles ${position}: missing reason` };
  }
  if (count !== undefined) {
    return {
      malformed:
        `sanctionedFiles ${position}: count is not supported — a path grant ` +
        `covers every occurrence, which is what removes the churn`,
    };
  }
  return { value: { path: filePath, kind: kind as AuditKind, reason } };
}

function pickSanctionedFiles(value: unknown): {
  files: SanctionedFile[];
  malformed: string[];
} {
  const { values, malformed } = parseEntryList(value, parseSanctionedFile);
  return { files: values, malformed };
}

function pickSanctions(value: unknown): Omit<SanctionParseResult, 'files'> {
  const { values, malformed } = parseEntryList(value, parseSanctionEntry);
  return { valid: values, malformed };
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  // Equivalent mutant on the `typeof value === 'object'` half: a primitive that
  // slips through is still read field-by-field with `pick*` fallbacks, so every
  // field lands on its default — the same result as rejecting the value here.
  // Stryker disable next-line ConditionalExpression
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString<T extends string>(
  value: unknown,
  fallback: T,
  allowed?: readonly T[],
): T {
  if (typeof value !== 'string') {
    return fallback;
  }
  if (allowed && !allowed.includes(value as T)) {
    return fallback;
  }
  return value as T;
}

/** The three modes, as a list rather than three comparisons -- the type is the
 *  authority, this is the runtime witness of it. */
const ANALYZER_MODES: ReadonlySet<AnalyzerMode> = new Set([
  'off',
  'auto',
  'required',
]);

function isAnalyzerMode(value: unknown): value is AnalyzerMode {
  return ANALYZER_MODES.has(value as AnalyzerMode);
}

/**
 * Parse the `analyzers` block. `true`/`false` are accepted as the natural
 * shorthand for `required`/`off`. Anything else is DROPPED rather than
 * defaulted, so a typo'd value falls back to `auto` (the analyzer keeps
 * running) instead of silently disabling a guard — failing toward more
 * checking, like every other defensive path in this file.
 */
export function pickAnalyzers(value: unknown): Record<string, AnalyzerMode> {
  if (!isRecord(value)) {
    return {};
  }
  const modes: Record<string, AnalyzerMode> = {};
  for (const [tool, raw] of Object.entries(value)) {
    if (raw === true) {
      modes[tool] = 'required';
    } else if (raw === false) {
      modes[tool] = 'off';
    } else if (isAnalyzerMode(raw)) {
      modes[tool] = raw;
    }
  }
  return modes;
}

/**
 * Parse `enforcement`, asymmetrically and on purpose. ABSENT falls back to the
 * caller's default (`'warn'`): a new adopter should not be blocked by a gate
 * they never asked for, and that humane default is deliberate. PRESENT but not
 * one of the two valid values — `"Block"`, `"blocked"`, `true` — resolves to
 * `'block'` instead, because an author who typed the field meant to configure
 * enforcement, and a typo must never be the thing that silently turns a gate
 * advisory. Both directions fail toward more checking, like every other
 * defensive path in this file; only the absent case can produce `'warn'`.
 */
function pickEnforcement(
  value: unknown,
  fallback: RepoConfig['enforcement'],
): RepoConfig['enforcement'] {
  if (value === undefined) {
    return fallback;
  }
  return value === 'warn' ? 'warn' : 'block';
}

function pickNumber(value: unknown, fallback: number): number {
  // Equivalent mutant on the `typeof value === 'number'` half: Number.isFinite
  // does NOT coerce, so a non-number is rejected by the second half regardless.
  // Stryker disable next-line ConditionalExpression
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const CONFIG_FILE_NAME = 'guardrails.config.json';

/**
 * Read `guardrails.config.json` TEXT off disk, or `undefined` if it is
 * missing. Exported so the CI sanctions check can run `parseSanctionsJson`
 * against the same head-revision text `loadConfig` reads, to recover the
 * malformed entries `loadConfig` itself drops. Checks existence explicitly
 * (rather than a try/catch around the read) so a missing file is the only
 * `undefined` path — an unexpected read error still throws, instead of
 * silently reading as "no config".
 */
export function readConfigText(repoRoot: string): string | undefined {
  const filePath = path.join(repoRoot, CONFIG_FILE_NAME);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

export function loadConfig(repoRoot: string): RepoConfig {
  const defaults = defaultConfig();
  let raw: unknown;
  // Equivalent mutants: emptying either block leaves `raw` undefined, which the
  // `isRecord` guard below rejects — the function still returns `defaults`. A
  // range directive is required because `disable next-line` only attaches to a
  // statement-LEADING comment, which a `} catch {` line does not have.
  // Stryker disable BlockStatement
  try {
    raw = JSON.parse(
      readFileSync(path.join(repoRoot, CONFIG_FILE_NAME), 'utf8'),
    );
  } catch {
    return defaults;
  }
  // Stryker restore BlockStatement
  if (!isRecord(raw)) {
    return defaults;
  }
  return {
    baseBranch: pickString(raw.baseBranch, defaults.baseBranch),
    maxAttempts: pickNumber(raw.maxAttempts, defaults.maxAttempts),
    recurThreshold: pickNumber(raw.recurThreshold, defaults.recurThreshold),
    graduationThreshold: pickNumber(
      raw.graduationThreshold,
      defaults.graduationThreshold,
    ),
    fastFixer: pickString(raw.fastFixer, defaults.fastFixer),
    thoroughFixer: pickString(raw.thoroughFixer, defaults.thoroughFixer),
    looseRules: pickStringArray(raw.looseRules),
    analyzers: pickAnalyzers(raw.analyzers),
    sanctionedSuppressions: pickSanctions(raw.sanctionedSuppressions).valid,
    sanctionedFiles: pickSanctionedFiles(raw.sanctionedFiles).files,
    distribution: pickString(raw.distribution, defaults.distribution, [
      'solo',
      'team',
    ]),
    enforcement: pickEnforcement(raw.enforcement, defaults.enforcement),
    ...(typeof raw.copilotFastModel === 'string' && {
      copilotFastModel: raw.copilotFastModel,
    }),
    ...(typeof raw.copilotThoroughModel === 'string' && {
      copilotThoroughModel: raw.copilotThoroughModel,
    }),
  };
}

// Note: `enforcement` and `distribution` are intentionally not projected here —
// they steer Phase-B surfaces (CI required-check, Copilot commit-gate), not the
// Stop-loop decision engine. See RepoConfig.enforcement.
export function toGateConfig(config: RepoConfig): GateConfig {
  return {
    maxAttempts: config.maxAttempts,
    recurThreshold: config.recurThreshold,
    graduationThreshold: config.graduationThreshold,
    fastFixer: config.fastFixer,
    thoroughFixer: config.thoroughFixer,
    // Built-in loose-rule defaults, extended by the repo's exact rule-ids, so
    // loose-class violations route to the thorough fixer from attempt 1 (§2.3).
    isLoose: makeIsLoose(config.looseRules),
  };
}
