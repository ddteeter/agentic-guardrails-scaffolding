import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, loadConfig, toGateConfig } from '../src/config.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('defaultConfig', () => {
  it('is solo/warn with the documented thresholds', () => {
    expect(defaultConfig()).toMatchObject({
      baseBranch: 'main',
      maxAttempts: 3,
      recurThreshold: 3,
      graduationThreshold: 3,
      distribution: 'solo',
      enforcement: 'warn',
      fastFixer: 'guardrail-fixer',
      thoroughFixer: 'guardrail-fixer-thorough',
    });
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig(root)).toEqual(defaultConfig());
  });

  it('merges file values over defaults', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        baseBranch: 'develop',
        maxAttempts: 5,
        enforcement: 'block',
      }),
    );
    const config = loadConfig(root);
    expect(config.baseBranch).toBe('develop');
    expect(config.maxAttempts).toBe(5);
    expect(config.enforcement).toBe('block');
    // Unspecified fields keep their defaults.
    expect(config.recurThreshold).toBe(3);
    expect(config.fastFixer).toBe('guardrail-fixer');
  });

  it('ignores a corrupt config file and falls back to defaults', () => {
    writeFileSync(path.join(root, 'guardrails.config.json'), '{ not json');
    expect(loadConfig(root)).toEqual(defaultConfig());
  });

  it('ignores unknown keys and wrongly-typed values', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ maxAttempts: 'lots', bogus: true }),
    );
    expect(loadConfig(root).maxAttempts).toBe(3);
  });
});

describe('toGateConfig', () => {
  it('projects the repo config onto the gate config shape', () => {
    const gate = toGateConfig(defaultConfig());
    expect(gate).toEqual({
      maxAttempts: 3,
      recurThreshold: 3,
      graduationThreshold: 3,
      fastFixer: 'guardrail-fixer',
      thoroughFixer: 'guardrail-fixer-thorough',
    });
  });
});
