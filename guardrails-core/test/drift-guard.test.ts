import { describe, expect, it } from 'vitest';

import { checkDrift, type DriftEntry } from '../src/drift-guard.js';

const entry = (over: Partial<DriftEntry>): DriftEntry => ({
  tool: 'fake',
  knownIds: ['a', 'b'],
  probe: () => Promise.resolve(new Set(['a', 'b', 'c'])),
  hint: 'edit fake-rules.ts',
  ...over,
});

describe('checkDrift', () => {
  it('reports no missing ids when all known ids are present', async () => {
    const result = await checkDrift(entry({}));
    expect(result.missing).toEqual([]);
  });

  it('reports the known ids absent from the probe set', async () => {
    const result = await checkDrift(
      entry({ probe: () => Promise.resolve(new Set(['a'])) }),
    );
    expect(result.missing).toEqual(['b']);
    expect(result.hint).toBe('edit fake-rules.ts');
    expect(result.tool).toBe('fake');
  });

  it('reports all ids missing when the probe set is empty', async () => {
    const result = await checkDrift(
      entry({ probe: () => Promise.resolve(new Set()) }),
    );
    expect(result.missing).toEqual(['a', 'b']);
  });
});
