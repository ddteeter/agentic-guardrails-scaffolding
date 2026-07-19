/**
 * Tool-upgrade drift-guard (roadmap: "Tool/language-upgrade drift guard").
 *
 * guardrails-core hardcodes third-party ids (loose-rule names in
 * `loose-rules.ts`, issue-type keys the knip adapter reads). When a tool is
 * upgraded and renames/removes an id, the hardcoded reference silently
 * mis-routes or under-matches. This harness turns that into a build failure:
 * each `DriftEntry` pairs the ids we depend on (`knownIds`) with a `probe` that
 * returns the tool's CURRENT id set, and `checkDrift` reports any known id the
 * probe no longer contains.
 *
 * Probes differ per tool because tools expose their ids differently — knip's
 * are keys in its JSON output, ESLint's are enumerable from loaded plugins — so
 * the registry holds arbitrary probe functions rather than one uniform query.
 */

export interface DriftEntry {
  tool: string;
  knownIds: string[];
  probe: () => Promise<Set<string>>;
  hint: string;
}

export async function checkDrift(
  entry: DriftEntry,
): Promise<{ tool: string; missing: string[]; hint: string }> {
  const current = await entry.probe();
  const missing = entry.knownIds.filter((id) => !current.has(id));
  return { tool: entry.tool, missing, hint: entry.hint };
}
