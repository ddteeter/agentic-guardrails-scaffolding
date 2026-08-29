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
      looseRules: [],
    });
  });

  it('defaults the Copilot model knobs to undefined', () => {
    const config = defaultConfig();
    expect(config.copilotFastModel).toBeUndefined();
    expect(config.copilotThoroughModel).toBeUndefined();
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

  it('sets the Copilot model knobs when present as strings', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        copilotFastModel: 'fast-model-id',
        copilotThoroughModel: 'thorough-model-id',
      }),
    );
    const config = loadConfig(root);
    expect(config.copilotFastModel).toBe('fast-model-id');
    expect(config.copilotThoroughModel).toBe('thorough-model-id');
  });

  it('leaves the Copilot model knobs unset when absent or wrongly typed', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ copilotFastModel: 42 }),
    );
    const config = loadConfig(root);
    expect(config.copilotFastModel).toBeUndefined();
    expect(config.copilotThoroughModel).toBeUndefined();
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

  it('reads looseRules as a string array, dropping non-strings', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ looseRules: ['house/no-raw-sql', 42, null] }),
    );
    expect(loadConfig(root).looseRules).toEqual(['house/no-raw-sql']);
  });

  it('falls back to an empty looseRules when the value is not an array', () => {
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ looseRules: 'nope' }),
    );
    expect(loadConfig(root).looseRules).toEqual([]);
  });
});

describe('toGateConfig', () => {
  it('projects the core fields onto the gate config shape', () => {
    expect(toGateConfig(defaultConfig())).toMatchObject({
      maxAttempts: 3,
      recurThreshold: 3,
      graduationThreshold: 3,
      fastFixer: 'guardrail-fixer',
      thoroughFixer: 'guardrail-fixer-thorough',
    });
  });

  it('builds an isLoose predicate from built-in defaults plus repo looseRules', () => {
    const gate = toGateConfig({ ...defaultConfig(), looseRules: ['house/x'] });
    expect(gate.isLoose?.({ ruleId: 'vitest/expect-expect' } as never)).toBe(
      true,
    );
    expect(gate.isLoose?.({ ruleId: 'house/x' } as never)).toBe(true);
    expect(gate.isLoose?.({ ruleId: 'no-console' } as never)).toBe(false);
  });
});

/** Write a repo config file into the per-test temp root. */
function writeConfig(contents: string): void {
  writeFileSync(path.join(root, 'guardrails.config.json'), contents);
}

describe('loadConfig mutation-hardening', () => {
  it('defaults sanctionedSuppressions to an empty list', () => {
    expect(defaultConfig().sanctionedSuppressions).toEqual([]);
  });

  it('rejects a top-level value that is not a plain object', () => {
    // Kills the isRecord mutants: arrays and null are objects to `typeof`, and
    // a bypassed guard would dereference them.
    writeConfig('null');
    expect(loadConfig(root)).toEqual(defaultConfig());
    writeConfig('[1,2,3]');
    expect(loadConfig(root)).toEqual(defaultConfig());
    writeConfig('"a string"');
    expect(loadConfig(root)).toEqual(defaultConfig());
  });

  it('falls back when an enum-valued field is outside its allowed set', () => {
    // Kills the `allowed && !allowed.includes(...)` mutant and the
    // `['solo','team']` -> `[]` mutant (an empty allowlist rejects everything).
    writeConfig(JSON.stringify({ distribution: 'enterprise' }));
    expect(loadConfig(root).distribution).toBe('solo');
    writeConfig(JSON.stringify({ enforcement: 'shout' }));
    expect(loadConfig(root).enforcement).toBe('warn');
    // ...while a legitimate non-default value IS honoured.
    writeConfig(JSON.stringify({ distribution: 'team', enforcement: 'block' }));
    expect(loadConfig(root)).toMatchObject({
      distribution: 'team',
      enforcement: 'block',
    });
  });

  it('rejects non-finite and non-number thresholds', () => {
    // Kills the `typeof === 'number' && Number.isFinite(...)` mutants.
    writeConfig(JSON.stringify({ maxAttempts: '5' }));
    expect(loadConfig(root).maxAttempts).toBe(3);
    writeConfig('{"maxAttempts": 1e999}'); // JSON for Infinity
    expect(loadConfig(root).maxAttempts).toBe(3);
  });

  it('omits the optional copilot model keys when absent or wrongly typed', () => {
    // Kills the `typeof raw.copilotThoroughModel === 'string'` -> true mutant.
    writeConfig(JSON.stringify({ copilotThoroughModel: 42 }));
    const config = loadConfig(root);
    expect(Object.hasOwn(config, 'copilotThoroughModel')).toBe(false);
    expect(Object.hasOwn(config, 'copilotFastModel')).toBe(false);
  });

  it('yields an empty sanction list when the field is not an array', () => {
    writeConfig(JSON.stringify({ sanctionedSuppressions: 'nope' }));
    expect(loadConfig(root).sanctionedSuppressions).toEqual([]);
  });

  it('reads sanctionedSuppressions and requires a justification per entry', () => {
    // Fails CLOSED: an entry without a written reason is DROPPED, so the
    // exemption simply does not apply and the gate keeps blocking. A reviewer
    // must be able to read WHY each exemption exists.
    writeConfig(
      JSON.stringify({
        sanctionedSuppressions: [
          { key: 'a.ts|cast-any|x', reason: 'proven equivalent mutant' },
          { key: 'b.ts|cast-any|y' },
          { key: 'c.ts|cast-any|z', reason: '   ' },
          'd.ts|cast-any|w',
          { reason: 'no key' },
          7,
          null,
        ],
      }),
    );
    expect(loadConfig(root).sanctionedSuppressions).toEqual([
      { key: 'a.ts|cast-any|x', reason: 'proven equivalent mutant' },
    ]);
  });
});
