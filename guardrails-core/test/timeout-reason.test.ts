import { describe, expect, it } from 'vitest';

import { isHitLimitReason } from '../src/timeout-reason.js';

describe('isHitLimitReason', () => {
  it('knows the reason stryker gives a mutant that ran past its hit limit', () => {
    expect(isHitLimitReason('Hit limit reached (501/500)')).toBe(true);
  });

  it.each([
    ['no reason', undefined],
    ['another reason', 'Timed out'],
    ['the words later in the text', 'Note: Hit limit reached'],
    ['a non-string', 42],
  ])('is false for %s', (_label, reason) => {
    expect(isHitLimitReason(reason)).toBe(false);
  });
});
