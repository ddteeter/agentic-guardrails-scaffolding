/**
 * Generic runtime guard: is this value a non-null, non-array object?
 *
 * Every hand-rolled boundary validator needs this exact three-line check
 * before it can safely index into a value read from outside the program (a
 * JSONL row, a dependency-tree node) — and two of them (`decision-log.ts`,
 * `verify/npm-peers-adapter.ts`) carried verbatim copies until the `dupes`
 * analyzer flagged the pair. Shared here rather than left duplicated: the
 * definition of "a record" is one fact, not one fact per caller, and should
 * not be able to drift between them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
