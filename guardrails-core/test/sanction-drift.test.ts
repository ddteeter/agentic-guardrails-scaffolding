import { describe, expect, it } from 'vitest';

import { auditSource, findingKey } from '../src/audit.js';
import {
  sanctionCountDrift,
  sanctionIntegrity,
  toIntegrityViolations,
} from '../src/sanctions.js';

const DISABLE = '// Stryker disable next-line ConditionalExpression';
// A strict PREFIX of the directive above. Counting by substring rather than by
// the auditor's own extraction would score this as an occurrence of the
// shorter key, over-provisioning its budget.
const WIDER =
  '// Stryker disable next-line ConditionalExpression,BlockStatement';

describe('auditSource', () => {
  it('finds a suppression in whole-file source, not just a diff', () => {
    const findings = auditSource(
      'src/a.ts',
      `const x = 1;\n${DISABLE}\nfoo();`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toBe(DISABLE);
    expect(findings[0]?.file).toBe('src/a.ts');
  });

  it('does not confuse a directive with a longer one sharing its prefix', () => {
    const findings = auditSource('src/a.ts', `${WIDER}\nfoo();`);
    expect(findings.map((f) => f.text)).toEqual([WIDER]);
    // The narrower key must score ZERO occurrences here.
    const narrow = `src/a.ts|mutation-suppress|${DISABLE}`;
    expect(findings.filter((f) => findingKey(f) === narrow)).toHaveLength(0);
    expect(findings.map((f) => findingKey(f))).toEqual([
      `src/a.ts|mutation-suppress|${WIDER}`,
    ]);
  });

  it('ignores a directive that is only mentioned inside a string literal', () => {
    // The auditor's lexer already knows the difference; reusing it is the
    // reason this check does not do its own matching.
    const findings = auditSource('src/a.ts', `const s = "${DISABLE}";`);
    expect(findings).toEqual([]);
  });

  it('ignores files whose extension is not auditable', () => {
    expect(auditSource('README.md', DISABLE)).toEqual([]);
  });
});

const read =
  (contents: Record<string, string>) =>
  (file: string): string | undefined =>
    contents[file];

describe('sanctionCountDrift', () => {
  it('reports nothing when every declared count matches reality', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r', count: 2 }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}\nbar();` }),
    );
    expect(drift).toEqual([]);
  });

  it('reports an over-declared count — the stale-config case', () => {
    // A refactor deleted one of the two suppressed sites without touching the
    // policy file, so the budget silently over-provisions.
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r', count: 2 }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();` }),
    );
    expect(drift).toEqual([
      {
        key: `src/a.ts|mutation-suppress|${DISABLE}`,
        declared: 2,
        actual: 1,
      },
    ]);
  });

  it('reports an under-declared count too', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r' }],
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}` }),
    );
    expect(drift[0]).toMatchObject({ declared: 1, actual: 2 });
  });

  it('sums several entries that grant the same key', () => {
    // The config legitimately splits one key across entries with separate
    // reasons; the budget is their sum, so the check must compare the sum.
    const key = `src/a.ts|mutation-suppress|${DISABLE}`;
    const drift = sanctionCountDrift(
      [
        { key, reason: 'first', count: 3 },
        { key, reason: 'second', count: 1 },
      ],
      read({ 'src/a.ts': Array.from({ length: 4 }, () => DISABLE).join('\n') }),
    );
    expect(drift).toEqual([]);
  });

  it('treats a vanished file as zero occurrences', () => {
    const drift = sanctionCountDrift(
      [{ key: `src/gone.ts|mutation-suppress|${DISABLE}`, reason: 'r' }],
      read({}),
    );
    expect(drift).toEqual([
      {
        key: `src/gone.ts|mutation-suppress|${DISABLE}`,
        declared: 1,
        actual: 0,
      },
    ]);
  });

  it('reads each file once even when several keys point at it', () => {
    const reads: string[] = [];
    const drift = sanctionCountDrift(
      [
        { key: `src/a.ts|mutation-suppress|${DISABLE}`, reason: 'r' },
        { key: `src/a.ts|mutation-suppress|${WIDER}`, reason: 'r' },
      ],
      (file) => {
        reads.push(file);
        return `${DISABLE}\nfoo();\n${WIDER}\nbar();`;
      },
    );
    expect(drift).toEqual([]);
    expect(reads).toEqual(['src/a.ts']);
  });
});

describe('sanctionCountDrift — several keys in one file', () => {
  it('reports drift for EVERY key in a file, not just one of them', () => {
    // Guards the per-file grouping: an implementation that kept only the first
    // or only the last key for a file would report one of these two, not both.
    const first = `src/a.ts|mutation-suppress|${DISABLE}`;
    const second = `src/a.ts|mutation-suppress|${WIDER}`;
    const drift = sanctionCountDrift(
      [
        { key: first, reason: 'r', count: 2 },
        { key: second, reason: 'r', count: 3 },
      ],
      () => `${DISABLE}\n${WIDER}`,
    );
    expect(drift).toEqual([
      { key: first, declared: 2, actual: 1 },
      { key: second, declared: 3, actual: 1 },
    ]);
  });
});

/**
 * #103: the integrity half of `sanctions-check` — the three FACTUAL failures
 * (malformed, count drift, misplaced directive) — has to be reachable from the
 * local rungs, where it costs milliseconds, rather than only from CI, where the
 * reporter discovered a count drift 1h9m after committing it.
 *
 * Precedence is asserted rather than assumed: a stale count means the source
 * moved under the policy file, and every placement report that follows is noise
 * about the same one defect. `sanctionsCheckCommand` already ordered them that
 * way; pulling the order into one function is what stops the two callers
 * drifting apart.
 */
describe('sanctionIntegrity', () => {
  const key = `src/a.ts|mutation-suppress|${DISABLE}`;

  it('is ok when the config is absent entirely', () => {
    // The overwhelmingly common case, and the one every rung pays for: a repo
    // with no sanctions must cost nothing and report nothing.
    expect(sanctionIntegrity(undefined, read({}))).toEqual({ kind: 'ok' });
  });

  it('is ok when every declared count matches the source', () => {
    expect(
      sanctionIntegrity(
        JSON.stringify({
          sanctionedSuppressions: [{ key, reason: 'r', count: 1 }],
        }),
        read({ 'src/a.ts': `${DISABLE}\nfoo();` }),
      ),
    ).toEqual({ kind: 'ok' });
  });

  it('reports a count that no longer matches the source', () => {
    // The reporter's exact case: a sibling line copied the granted directive,
    // so the file holds 2 where the policy still declares 1.
    const integrity = sanctionIntegrity(
      JSON.stringify({
        sanctionedSuppressions: [{ key, reason: 'r', count: 1 }],
      }),
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}\nbar();` }),
    );
    expect(integrity).toEqual({
      kind: 'drift',
      entries: [{ key, declared: 1, actual: 2 }],
    });
  });

  it('reports malformed entries ahead of any count drift', () => {
    const integrity = sanctionIntegrity(
      JSON.stringify({
        sanctionedSuppressions: [{ key, count: 1 }],
      }),
      read({ 'src/a.ts': `${DISABLE}\nfoo();\n${DISABLE}\nbar();` }),
    );
    expect(integrity.kind).toBe('malformed');
  });

  it('reports drift ahead of placement, so one defect reads as one finding', () => {
    // Both are true here: the count is stale AND the region disable never
    // closes. Only the count is reported.
    const region = '// Stryker disable ConditionalExpression';
    const regionKey = `src/a.ts|mutation-suppress|${region}`;
    const integrity = sanctionIntegrity(
      JSON.stringify({
        sanctionedSuppressions: [{ key: regionKey, reason: 'r', count: 2 }],
      }),
      read({ 'src/a.ts': `${region}\nfoo();` }),
    );
    expect(integrity.kind).toBe('drift');
  });

  it('reports a region disable that never closes', () => {
    const region = '// Stryker disable ConditionalExpression';
    const regionKey = `src/a.ts|mutation-suppress|${region}`;
    const integrity = sanctionIntegrity(
      JSON.stringify({
        sanctionedSuppressions: [{ key: regionKey, reason: 'r', count: 1 }],
      }),
      read({ 'src/a.ts': `${region}\nfoo();` }),
    );
    expect(integrity.kind).toBe('placement');
  });
});

describe('toIntegrityViolations', () => {
  const key = `src/a.ts|mutation-suppress|${DISABLE}`;

  it('is empty for an ok result', () => {
    expect(
      toIntegrityViolations({ kind: 'ok' }, 'guardrails.config.json'),
    ).toEqual([]);
  });

  it('names the policy file, not the source file', () => {
    // The edit that resolves this is a decision about the GRANT -- bump the
    // count, or remove the suppression. Filing it against `src/a.ts` would
    // point the reader at the half of the pair that may well be correct.
    const [violation] = toIntegrityViolations(
      { kind: 'drift', entries: [{ key, declared: 1, actual: 2 }] },
      'guardrails.config.json',
    );
    expect(violation).toMatchObject({
      ruleId: 'guardrails/sanction-count-drift',
      file: 'guardrails.config.json',
      severity: 'error',
      fixable: false,
      tool: 'guardrails',
    });
    expect(violation?.message).toContain('declared 1, found 2');
    expect(violation?.message).toContain(key);
  });

  it('carries a placement issue with its source line', () => {
    const [violation] = toIntegrityViolations(
      {
        kind: 'placement',
        entries: [
          {
            file: 'src/a.ts',
            line: 3,
            text: '// Stryker disable ConditionalExpression',
            detail: 'never closed',
            problem: 'unclosed-disable',
          },
        ],
      },
      'guardrails.config.json',
    );
    expect(violation).toMatchObject({
      ruleId: 'guardrails/sanction-placement',
      file: 'guardrails.config.json',
      severity: 'error',
      fixable: false,
    });
    expect(violation?.message).toContain('src/a.ts:3');
  });

  it('renders a malformed entry through the existing violation shape', () => {
    const [violation] = toIntegrityViolations(
      { kind: 'malformed', entries: ['entry 1: missing reason'] },
      'guardrails.config.json',
    );
    expect(violation?.ruleId).toBe('guardrails/malformed-sanction');
  });
});
