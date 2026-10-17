import { describe, expect, it } from 'vitest';

import {
  analyzerMode,
  decideAnalyzer,
  declaredProviders,
  isRung,
} from '../../src/verify/analyzer-policy.js';

describe('decideAnalyzer', () => {
  it('never runs an analyzer turned off, and never reports it missing', () => {
    expect(decideAnalyzer('off', true)).toEqual({
      run: false,
      reportMissing: false,
    });
    expect(decideAnalyzer('off', false)).toEqual({
      run: false,
      reportMissing: false,
    });
  });

  it('runs a required analyzer and reports it missing regardless of declaration', () => {
    expect(decideAnalyzer('required', false)).toEqual({
      run: true,
      reportMissing: true,
    });
    expect(decideAnalyzer('required', true)).toEqual({
      run: true,
      reportMissing: true,
    });
  });

  it('runs an auto analyzer but reports it missing only when the provider is declared', () => {
    expect(decideAnalyzer('auto', true)).toEqual({
      run: true,
      reportMissing: true,
    });
    expect(decideAnalyzer('auto', false)).toEqual({
      run: true,
      reportMissing: false,
    });
  });
});

describe('analyzerMode', () => {
  it('defaults an unlisted analyzer to auto, declared or not', () => {
    expect(analyzerMode({}, 'knip', true)).toBe('auto');
    expect(analyzerMode({}, 'knip', false)).toBe('auto');
  });

  it('returns the configured mode for a listed analyzer', () => {
    expect(analyzerMode({ knip: 'off' }, 'knip', true)).toBe('off');
  });

  it('defaults dupes to off rather than auto, even where fallow is declared', () => {
    // Unlike the other analyzers, this one's precision depends on an ignore
    // list that is inherently repo-specific (generated files, ORM schema DSLs,
    // framework boilerplate), so an unconfigured run is noise -- whether or not
    // fallow is installed. Opting in is the adopter's decision.
    expect(analyzerMode({}, 'dupes', true)).toBe('off');
    expect(analyzerMode({}, 'dupes', false)).toBe('off');
  });

  it('lets an explicit setting override a non-auto default', () => {
    expect(analyzerMode({ dupes: 'required' }, 'dupes', false)).toBe(
      'required',
    );
    expect(analyzerMode({ dupes: 'auto' }, 'dupes', false)).toBe('auto');
  });

  it('defaults complexity to auto where its provider is declared', () => {
    // Thresholds come from the adopter's own fallow config, so a repo that
    // installed fallow has already said what "too complex" means.
    expect(analyzerMode({}, 'complexity', true)).toBe('auto');
  });

  it('defaults complexity to off where its provider is not declared', () => {
    // Under `auto` an undeclared provider would land in
    // `silentlySkippedAnalyzers` and nag about a tool nobody asked for.
    expect(analyzerMode({}, 'complexity', false)).toBe('off');
  });

  it('lets an explicit complexity setting win over both defaults', () => {
    for (const isDeclared of [true, false]) {
      expect(
        analyzerMode({ complexity: 'off' }, 'complexity', isDeclared),
      ).toBe('off');
      expect(
        analyzerMode({ complexity: 'required' }, 'complexity', isDeclared),
      ).toBe('required');
      expect(
        analyzerMode({ complexity: 'auto' }, 'complexity', isDeclared),
      ).toBe('auto');
    }
  });
});

describe('isRung', () => {
  it('accepts each of the four rung names', () => {
    for (const rung of ['stop', 'commit', 'push', 'ci']) {
      expect(isRung(rung)).toBe(true);
    }
  });

  it('rejects a string that names no rung', () => {
    // The membership check itself: a rung-shaped string that is not one of the
    // four must not pass, or a typo in `guardrails.config.json` would move an
    // analyzer to a rung that does not exist.
    expect(isRung('weekly')).toBe(false);
  });

  it('rejects a non-string value outright, not only an unrecognised string', () => {
    // `isRung` is a bare `RUNG_NAMES.has(value)` — there is no `typeof` guard
    // in front of it, deliberately (see the comment on `RUNG_NAMES`). These
    // cases are what make that safe to rely on: `Set.prototype.has` compares
    // with SameValueZero and never coerces, so a non-string can never match a
    // string member. If the set were ever rebuilt from something other than
    // string keys, this is what would notice.
    expect(isRung(42)).toBe(false);
    expect(isRung(undefined)).toBe(false);
    expect(isRung({ rung: 'push' })).toBe(false);
  });
});

describe('declaredProviders', () => {
  it('collects names from every dependency field', () => {
    const names = declaredProviders({
      dependencies: { eslint: '^9' },
      devDependencies: { knip: '^6' },
      optionalDependencies: { 'dependency-cruiser': '^18' },
      peerDependencies: { '@stryker-mutator/core': '^9' },
    });
    expect(
      [...names].toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      '@stryker-mutator/core',
      'dependency-cruiser',
      'eslint',
      'knip',
    ]);
  });

  it('returns an empty set for a manifest that is not an object', () => {
    expect(declaredProviders(undefined).size).toBe(0);
    expect(declaredProviders('nope').size).toBe(0);
    expect(declaredProviders(null).size).toBe(0);
  });

  it('ignores a dependency field that is not an object', () => {
    expect(declaredProviders({ devDependencies: 'nope' }).size).toBe(0);
  });
});
