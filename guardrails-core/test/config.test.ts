import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultConfig,
  loadConfig,
  parseSanctionsJson,
  readConfigText,
  toGateConfig,
} from '../src/config.js';

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

  it('grants no exemptions of either kind by default', () => {
    // Stated as its own case because it is the one default that would be
    // ACTIVELY dangerous to get wrong: a seeded grant is an exemption nobody
    // asked for and nobody reviewed.
    expect(defaultConfig().sanctionedSuppressions).toEqual([]);
    expect(defaultConfig().sanctionedFiles).toEqual([]);
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

/**
Write a repo config file into the per-test temp root.
*/
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
    // `enforcement` is deliberately NOT in this test: it does not fall back on
    // a bad value — see the "enforcement" describe below.
    writeConfig(JSON.stringify({ distribution: 'enterprise' }));
    expect(loadConfig(root).distribution).toBe('solo');
    // ...while a legitimate non-default value IS honoured.
    writeConfig(JSON.stringify({ distribution: 'team', enforcement: 'block' }));
    expect(loadConfig(root)).toMatchObject({
      distribution: 'team',
      enforcement: 'block',
    });
  });

  describe('enforcement', () => {
    it('defaults to warn when the field is absent', () => {
      writeConfig(JSON.stringify({ baseBranch: 'main' }));
      expect(loadConfig(root).enforcement).toBe('warn');
    });

    it('honours both valid values', () => {
      writeConfig(JSON.stringify({ enforcement: 'warn' }));
      expect(loadConfig(root).enforcement).toBe('warn');
      writeConfig(JSON.stringify({ enforcement: 'block' }));
      expect(loadConfig(root).enforcement).toBe('block');
    });

    it('blocks — not warns — on a value that is present but invalid', () => {
      // A field the author typed and got wrong must never be what silently
      // turns the commit gate advisory.
      for (const value of ['Block', 'blocked', true, 0]) {
        writeConfig(JSON.stringify({ enforcement: value }));
        expect(loadConfig(root).enforcement).toBe('block');
      }
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
          { key: 'c.ts|cast-any|z', reason: ' '.repeat(3) },
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

  it('keeps a valid positive-integer count and drops an entry with a malformed one', () => {
    writeConfig(
      JSON.stringify({
        sanctionedSuppressions: [
          { key: 'a.ts|x|y', reason: 'covers two sites', count: 2 },
          { key: 'b.ts|x|y', reason: 'zero count', count: 0 },
          { key: 'c.ts|x|y', reason: 'negative count', count: -1 },
          { key: 'd.ts|x|y', reason: 'fractional count', count: 1.5 },
          { key: 'e.ts|x|y', reason: 'string count', count: '2' },
        ],
      }),
    );
    expect(loadConfig(root).sanctionedSuppressions).toEqual([
      { key: 'a.ts|x|y', reason: 'covers two sites', count: 2 },
    ]);
  });

  it('omits count from a valid entry that does not declare one', () => {
    writeConfig(
      JSON.stringify({
        sanctionedSuppressions: [{ key: 'a.ts|x|y', reason: 'reviewed' }],
      }),
    );
    const [sanction] = loadConfig(root).sanctionedSuppressions;
    expect(Object.hasOwn(sanction ?? {}, 'count')).toBe(false);
  });
});

describe('readConfigText', () => {
  it('returns the file text when present', () => {
    writeConfig('{"baseBranch":"trunk"}');
    expect(readConfigText(root)).toBe('{"baseBranch":"trunk"}');
  });

  it('returns undefined when the file is missing', () => {
    expect(readConfigText(root)).toBeUndefined();
  });
});

describe('analyzers', () => {
  it('defaults to an empty map, so every analyzer is auto', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    expect(loadConfig(directory).analyzers).toEqual({});
  });

  it('reads the three string modes', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(directory, 'guardrails.config.json'),
      JSON.stringify({
        analyzers: { eslint: 'required', knip: 'auto', stryker: 'off' },
      }),
    );
    expect(loadConfig(directory).analyzers).toEqual({
      eslint: 'required',
      knip: 'auto',
      stryker: 'off',
    });
  });

  it('accepts true/false as shorthand for required/off', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(directory, 'guardrails.config.json'),
      JSON.stringify({ analyzers: { eslint: true, knip: false } }),
    );
    expect(loadConfig(directory).analyzers).toEqual({
      eslint: 'required',
      knip: 'off',
    });
  });

  it('drops an entry whose value is neither a known mode nor a boolean', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(directory, 'guardrails.config.json'),
      JSON.stringify({ analyzers: { knip: 'sometimes', eslint: 3 } }),
    );
    // Dropped, not defaulted to off: a malformed entry must never be the thing
    // that silently disables a guard. toStrictEqual (not toEqual) is load-
    // bearing here: it kills the `resolved !== undefined` -> `true` mutant in
    // pickAnalyzerField, which would set `picked[tool] = undefined` instead of
    // omitting the key entirely -- toEqual ignores undefined-valued
    // properties and would pass against that mutant too.
    expect(loadConfig(directory).analyzers).toStrictEqual({});
  });

  it('ignores an analyzers value that is not an object', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    writeFileSync(
      path.join(directory, 'guardrails.config.json'),
      JSON.stringify({ analyzers: ['knip'] }),
    );
    expect(loadConfig(directory).analyzers).toEqual({});
  });
});

/**
 * The object form of an `analyzers` entry, which carries a cadence rung
 * alongside the mode (#61).
 *
 * The string and boolean forms stay exactly as they were: an adopter who never
 * heard of this keeps the config they wrote, and gets the rungs the built-in
 * table declares.
 */
/**
 * `loadConfig` over a throwaway repo whose config declares just this
 * `analyzers` block.
 */
function configured(analyzers: unknown): ReturnType<typeof loadConfig> {
  const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
  writeFileSync(
    path.join(directory, 'guardrails.config.json'),
    JSON.stringify({ analyzers }),
  );
  return loadConfig(directory);
}

describe('analyzer rung overrides', () => {
  it('defaults to no overrides, so the table decides every rung', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-config-'));
    expect(loadConfig(directory).analyzerRungs).toEqual({});
  });

  it('reads a rung and a mode from the object form', () => {
    const config = configured({ stryker: { mode: 'required', rung: 'push' } });
    expect(config.analyzers).toEqual({ stryker: 'required' });
    expect(config.analyzerRungs).toEqual({ stryker: 'push' });
  });

  it('accepts a rung with no mode, leaving the mode at auto', () => {
    // Moving an analyzer's cadence and opting into it are separate decisions;
    // requiring both would make the common case ("just run it later") wordier
    // than it needs to be.
    const config = configured({ stryker: { rung: 'push' } });
    expect(config.analyzers).toEqual({});
    expect(config.analyzerRungs).toEqual({ stryker: 'push' });
  });

  it('accepts a mode with no rung, which is the string form spelled long', () => {
    const config = configured({ stryker: { mode: 'off' } });
    expect(config.analyzers).toEqual({ stryker: 'off' });
    expect(config.analyzerRungs).toEqual({});
  });

  it('leaves the string and boolean forms untouched', () => {
    const config = configured({ eslint: 'required', knip: true, tsc: false });
    expect(config.analyzers).toEqual({
      eslint: 'required',
      knip: 'required',
      tsc: 'off',
    });
    expect(config.analyzerRungs).toEqual({});
  });

  it('drops an unrecognised rung rather than defaulting it', () => {
    // Same direction as every other defensive path here: a typo must not
    // silently move a guard to a rung that runs it LESS often. Dropping leaves
    // the table's floor, which is the more-checking answer.
    const config = configured({
      stryker: { mode: 'required', rung: 'weekly' },
    });
    expect(config.analyzers).toEqual({ stryker: 'required' });
    expect(config.analyzerRungs).toEqual({});
  });

  it('drops an unrecognised mode while keeping a valid rung', () => {
    const config = configured({ stryker: { mode: 'sometimes', rung: 'push' } });
    expect(config.analyzers).toEqual({});
    expect(config.analyzerRungs).toEqual({ stryker: 'push' });
  });

  it('ignores an entry that is an array or null rather than an object', () => {
    expect(configured({ stryker: ['push'] }).analyzerRungs).toEqual({});
    expect(configured({ stryker: null }).analyzerRungs).toEqual({});
  });
});

describe('parseSanctionsJson', () => {
  it('splits well-formed entries into valid, with no malformed entries', () => {
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedSuppressions: [
          { key: 'a.ts|x|y', reason: 'reviewed' },
          { key: 'b.ts|x|y', reason: 'reviewed twice', count: 2 },
        ],
      }),
    );
    expect(result.valid).toEqual([
      { key: 'a.ts|x|y', reason: 'reviewed' },
      { key: 'b.ts|x|y', reason: 'reviewed twice', count: 2 },
    ]);
    expect(result.malformed).toEqual([]);
  });

  it('reports a 1-indexed, human-readable reason for each malformed entry', () => {
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedSuppressions: [
          { key: 'a.ts|x|y', reason: 'reviewed' },
          { key: 'b.ts|x|y' },
          { key: 'c.ts|x|y', reason: ' '.repeat(3) },
          { reason: 'no key' },
          { key: 'd.ts|x|y', reason: 'reviewed', count: 0 },
          'e.ts|x|y',
        ],
      }),
    );
    expect(result.valid).toEqual([{ key: 'a.ts|x|y', reason: 'reviewed' }]);
    expect(result.malformed).toEqual([
      'entry 2: missing reason',
      'entry 3: missing reason',
      'entry 4: missing key',
      'entry 5: count must be a positive integer',
      'entry 6: not an object',
    ]);
  });

  it('treats a whitespace-only key as missing, not merely typed', () => {
    // A key of type string that is blank once trimmed must still be rejected —
    // an untrimmed check would let "   " through as a "valid" key.
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedSuppressions: [{ key: ' '.repeat(3), reason: 'reviewed' }],
      }),
    );
    expect(result.valid).toEqual([]);
    expect(result.malformed).toEqual(['entry 1: missing key']);
  });

  it('reports invalid JSON itself as malformed, rather than staying silent', () => {
    expect(parseSanctionsJson('not json')).toEqual({
      valid: [],
      files: [],
      malformed: ['config is not valid JSON'],
    });
  });

  it('is empty (not malformed) for a non-object top level or a non-array field', () => {
    // These parse as valid JSON, just not the shape sanctionedSuppressions
    // needs — every OTHER field still gets its own defaults via `pick*`.
    expect(parseSanctionsJson('null')).toEqual({
      valid: [],
      files: [],
      malformed: [],
    });
    expect(
      parseSanctionsJson(JSON.stringify({ sanctionedSuppressions: 'nope' })),
    ).toEqual({ valid: [], files: [], malformed: [] });
  });
});

describe('sanctionedFiles', () => {
  const generated = {
    path: 'src/routeTree.gen.ts',
    kind: 'cast-any',
    reason: 'Generated by TanStack Router; never hand-edited.',
  };

  it('parses a well-formed path grant', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [generated] }),
    );

    expect(result.files).toEqual([generated]);
    expect(result.malformed).toEqual([]);
  });

  it('is empty when the field is absent', () => {
    // Every existing config predates this field; its absence must be normal,
    // not a parse failure.
    expect(parseSanctionsJson('{}').files).toEqual([]);
  });

  it('drops an entry whose kind is not a real audit kind', () => {
    // A typo'd kind would otherwise grant NOTHING while looking in the config
    // exactly like a grant that works -- the worst of both, since the adopter
    // stops looking. Dropped and reported instead.
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedFiles: [{ ...generated, kind: 'cast-anyy' }],
      }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('kind');
  });

  it('drops an entry with no reason', () => {
    // Same rule as a keyed sanction: a bare grant is unreviewable, and this
    // grant is BROADER than a keyed one, so the reason matters more, not less.
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedFiles: [{ ...generated, reason: ' '.repeat(3) }],
      }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('reason');
  });

  it('drops an entry with no path', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [{ ...generated, path: '' }] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('path');
  });

  it('rejects a count, which this grant deliberately does not have', () => {
    // Removing the count churn is the whole point (#39). Silently ignoring a
    // count would leave an adopter believing they had bounded the grant.
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [{ ...generated, count: 50 }] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('count');
  });

  it('drops an entry whose path is not a string at all', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [{ ...generated, path: 42 }] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('path');
  });

  it('drops an entry whose path is only whitespace', () => {
    // Distinct from the empty-path case: a whitespace path would resolve to no
    // file at all while reading in the config like a real one.
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedFiles: [{ ...generated, path: ' '.repeat(3) }],
      }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('path');
  });

  it('drops an entry whose kind is not a string at all', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [{ ...generated, kind: 42 }] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('kind');
  });

  it('drops an entry whose reason is not a string at all', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [{ ...generated, reason: 7 }] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed[0]).toContain('reason');
  });

  it('drops an entry that is not an object', () => {
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: ['nope', 5, null] }),
    );

    expect(result.files).toEqual([]);
    expect(result.malformed).toHaveLength(3);
  });

  it('numbers malformed entries by their position in the array', () => {
    // The message is read by a human counting entries in a JSON array, so the
    // position has to be 1-based and has to be the right one.
    const result = parseSanctionsJson(
      JSON.stringify({ sanctionedFiles: [generated, generated, 'nope'] }),
    );

    expect(result.malformed[0]).toContain('sanctionedFiles 3');
  });

  it('keeps the valid entries when one is malformed', () => {
    const result = parseSanctionsJson(
      JSON.stringify({
        sanctionedFiles: [{ path: 'x.ts' }, generated],
      }),
    );

    expect(result.files).toEqual([generated]);
    expect(result.malformed).toHaveLength(1);
  });

  it('ignores a non-array field', () => {
    expect(parseSanctionsJson('{"sanctionedFiles":"nope"}').files).toEqual([]);
  });
});
