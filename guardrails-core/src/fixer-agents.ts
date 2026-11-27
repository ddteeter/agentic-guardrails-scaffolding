/**
 * The Claude Code fixer agents of a checkout that GENERATES them.
 *
 * This repository is one: `.claude/agents/` is gitignored and written by
 * `npm run build` from `guardrails-plugin/agents/`, and Claude Code loads its
 * agents when a session starts. So a session that starts before the first
 * build -- a fresh clone, a new worktree -- has no `guardrail-fixer` agent
 * type, and the first gate that blocks tells it to spawn one. Found
 * dogfooding: the pointer named an agent the session could not spawn.
 *
 * A repository with no source directory generates nothing, and both
 * questions here answer "no": a consumer's agents are committed files that
 * `init` scaffolded, or come from the plugin, and neither is this module's to
 * second-guess.
 */
import path from 'node:path';

/**
Where the fixer agents are written by hand.
*/
const SOURCE_DIRECTORY = path.join('guardrails-plugin', 'agents');

/**
Where the build copies them for Claude Code to load.
*/
const GENERATED_DIRECTORY = path.join('.claude', 'agents');

type ReadSource = (file: string) => string | undefined;

/**
The repo-relative path Claude Code loads the agent `name` from.
*/
function generatedAgentPath(name: string): string {
  return path.join(GENERATED_DIRECTORY, `${name}.md`);
}

function sourceOf(name: string, readSource: ReadSource): string | undefined {
  return readSource(path.join(SOURCE_DIRECTORY, `${name}.md`));
}

/**
 * Of `names`, the agents that have a source and whose generated copy is
 * missing or differs from it: what a build would change. Compared by content,
 * not by modification time, which a checkout rewrites.
 */
export function unbuiltFixerAgents(
  names: readonly string[],
  readSource: ReadSource,
): string[] {
  return [...new Set(names)].filter((name) => {
    const source = sourceOf(name, readSource);
    return (
      source !== undefined && readSource(generatedAgentPath(name)) !== source
    );
  });
}

/**
 * Has the agent `name` a source and NO generated copy? Narrower than
 * `unbuiltFixerAgents` on purpose: a copy that is only behind is still an
 * agent a session can spawn.
 */
export function isFixerAgentMissing(
  name: string,
  readSource: ReadSource,
): boolean {
  return (
    sourceOf(name, readSource) !== undefined &&
    readSource(generatedAgentPath(name)) === undefined
  );
}
