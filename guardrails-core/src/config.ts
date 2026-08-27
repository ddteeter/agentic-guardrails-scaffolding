/**
 * Per-repo policy (`guardrails.config.json`, §3.3/§10.3). Records the choices
 * that let the solo→team transition be a config flip, not a rewrite. Every
 * field has a safe default so a missing or partial file still yields a working
 * config; unknown or wrongly-typed values are ignored defensively.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { GateConfig } from './gate-decision.js';
import { makeIsLoose } from './loose-rules.js';

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
   * Reviewed, checked-in escape hatch for the diff-auditor: exact
   * `file|kind|text` keys of suppressions a human has deliberately sanctioned
   * (e.g. a mutation-exclusion around a hand-written lexer). ONLY the commit
   * gate consults it — the Stop gate has a tighter, per-fix-loop snapshot
   * baseline, so a fixer still cannot add one mid-loop. Empty by default:
   * every entry is a deliberate, reviewable line in `guardrails.config.json`.
   */
  sanctionedSuppressions: string[];
  distribution: 'solo' | 'team';
  /**
   * RESERVED — read by the CI gate and the Copilot commit-gate, both Phase B;
   * not yet consumed. It governs whether a *failing gate on those surfaces*
   * blocks (`block` → CI required status check / commit-gate deny) or only warns
   * (`warn` → non-blocking CI). It deliberately does NOT gate the Claude Code
   * Stop-loop — that loop is the flagship local feature and always runs; its
   * safety comes from the bounded attempt counter and the `--no-verify` bypass,
   * not from this flag. `toGateConfig` intentionally does not forward it.
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
    sanctionedSuppressions: [],
    distribution: 'solo',
    enforcement: 'warn',
  };
}

function pickStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadConfig(repoRoot: string): RepoConfig {
  const defaults = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(path.join(repoRoot, 'guardrails.config.json'), 'utf8'),
    );
  } catch {
    return defaults;
  }
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
    sanctionedSuppressions: pickStringArray(raw.sanctionedSuppressions),
    distribution: pickString(raw.distribution, defaults.distribution, [
      'solo',
      'team',
    ]),
    enforcement: pickString(raw.enforcement, defaults.enforcement, [
      'warn',
      'block',
    ]),
    ...(typeof raw.copilotFastModel === 'string'
      ? { copilotFastModel: raw.copilotFastModel }
      : {}),
    ...(typeof raw.copilotThoroughModel === 'string'
      ? { copilotThoroughModel: raw.copilotThoroughModel }
      : {}),
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
