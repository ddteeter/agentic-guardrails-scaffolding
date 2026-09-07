import { describe, expect, it } from 'vitest';

import {
  analyzerMode,
  decideAnalyzer,
  declaredProviders,
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
  it('defaults an unlisted analyzer to auto', () => {
    expect(analyzerMode({}, 'knip')).toBe('auto');
  });

  it('returns the configured mode for a listed analyzer', () => {
    expect(analyzerMode({ knip: 'off' }, 'knip')).toBe('off');
  });

  it('defaults dupes to off rather than auto', () => {
    // Unlike the other five, this analyzer's precision depends on an ignore
    // list that is inherently repo-specific (generated files, ORM schema DSLs,
    // framework boilerplate), so an unconfigured run is noise. Opting in is the
    // adopter's decision -- and defaulting it to `auto` would additionally put
    // every existing consumer into `silentlySkippedAnalyzers`, nagging them to
    // install a tool they never asked for.
    expect(analyzerMode({}, 'dupes')).toBe('off');
  });

  it('lets an explicit setting override a non-auto default', () => {
    expect(analyzerMode({ dupes: 'required' }, 'dupes')).toBe('required');
    expect(analyzerMode({ dupes: 'auto' }, 'dupes')).toBe('auto');
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
