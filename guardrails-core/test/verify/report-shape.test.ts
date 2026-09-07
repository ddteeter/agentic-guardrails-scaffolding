import { describe, expect, it } from 'vitest';

import { isArrayOfRecords, isRecord } from '../../src/verify/report-shape.js';

/**
 * These two guards exist as their own tested module for a mutation-testing
 * reason, not only a DRY one. Inline in an adapter, the `typeof x === 'object'`
 * clause is a provably EQUIVALENT mutant — a primitive that slips through is
 * rejected by the field check on the next line anyway — so three adapters each
 * carried a sanctioned suppression for it. Extracted and called directly, the
 * same clause is observable, and the tests below kill the mutant instead of
 * exempting it. Three grants deleted, none added.
 */
describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it('rejects null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('rejects an array', () => {
    // A JSON array has string-indexable properties, so without this an adapter
    // reading `value.issues` off one would silently see `undefined`.
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  it('rejects every primitive', () => {
    // The assertion that makes the extraction worth it: this is the case that
    // was unkillable while the clause lived inline behind a field check.
    expect(isRecord(5)).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('isArrayOfRecords', () => {
  it('accepts an array whose entries are all plain objects', () => {
    expect(isArrayOfRecords([{ a: 1 }, { b: 2 }])).toBe(true);
  });

  it('accepts an empty array', () => {
    // A tool reporting no findings is a valid report, not a malformed one.
    expect(isArrayOfRecords([])).toBe(true);
  });

  it('rejects an array containing a primitive', () => {
    expect(isArrayOfRecords([{ a: 1 }, 5])).toBe(false);
  });

  it('rejects an array containing null', () => {
    expect(isArrayOfRecords([null])).toBe(false);
  });

  it('rejects an array containing a nested array', () => {
    expect(isArrayOfRecords([[]])).toBe(false);
  });

  it('rejects anything that is not an array', () => {
    expect(isArrayOfRecords({ a: 1 })).toBe(false);
    expect(isArrayOfRecords('text')).toBe(false);
    expect(isArrayOfRecords(null)).toBe(false);
    expect(isArrayOfRecords(undefined)).toBe(false);
  });
});
