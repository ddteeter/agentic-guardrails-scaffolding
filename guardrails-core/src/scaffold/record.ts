/**
 * Object guard for the scaffold modules.
 *
 * Deliberately NOT shared with `config.ts` / `workspaces.ts` /
 * `verify/analyzer-policy.ts`: those three differ from each other —
 * `workspaces.ts`'s accepts arrays because npm's `workspaces` field can be one —
 * and merging them would silently change array handling at their call sites.
 * This is the scaffold's own, with the array-excluding semantics every scaffold
 * caller wants.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
