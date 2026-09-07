/**
 * The two shape guards every analyzer adapter needs on the far side of
 * `parseJsonText`: "is this a JSON object" and "is this an array of them".
 *
 * Shared for a mutation-testing reason as much as a DRY one. Inline in an
 * adapter, `typeof value === 'object'` is a provably EQUIVALENT mutant — a
 * primitive that slips past it is rejected by the field check on the very next
 * line — so eslint, knip and dependency-cruiser each carried a sanctioned
 * suppression for exactly that clause, with a near-identical justification.
 * Called directly from a test, the same clause becomes observable
 * (`isRecord(5)` is a plain assertion), so the mutant is KILLED rather than
 * exempted. The extraction deletes grants instead of consolidating them.
 *
 * The duplication that prompted it was reported by the `dupes` analyzer on its
 * first run against this repository — `eslint-adapter.ts`'s `isResultArray`
 * against `knip-adapter.ts`'s `isEntryArray` — not by review. See plan.md.
 */

/**
 * A JSON object: not null, not an array.
 *
 * Arrays are excluded deliberately. A JSON array answers string property reads
 * with `undefined` rather than throwing, so an adapter reading `value.issues`
 * off one would see a malformed report as an empty one.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An array whose every entry is a JSON object. An EMPTY array qualifies: a
 * tool reporting no findings has produced a valid report, not a malformed one.
 */
export function isArrayOfRecords(
  value: unknown,
): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry));
}
