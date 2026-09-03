/**
 * The one command string every generated hook uses, and the single place any
 * test may spell it.
 *
 * Four separate config files emit it — Claude's settings, the Codex hooks, the
 * Copilot hooks and the plugin's own wiring — and they drifted once already:
 * the Copilot config shipped Claude's `${CLAUDE_PROJECT_DIR}` with a `:-.`
 * fallback into a host that never sets that variable, and no test noticed,
 * because not one of them asserted the path. Asserting against a shared
 * constant is what makes a repeat impossible rather than unlikely.
 *
 * Deliberately not a `.test.ts` file: vitest's include pattern is
 * `guardrails-core/test/**\/*.test.ts`, so this is a helper, not a suite.
 */

/**
 * Locate nothing, name the package. Node resolves `guardrails-core` by walking
 * up from the hook process's cwd, which is correct under npm hoisting, pnpm and
 * subpackage adoption alike — the layouts a constructed absolute path splits on.
 *
 * The literal `guardrails` fills the `argv[1]` slot a script path normally
 * occupies, so `process.argv.slice(2)` in `cli.ts` keeps working unchanged.
 */
export const CLI_PREFIX = `node -e "import('guardrails-core/cli')" guardrails`;

/** The full command string for one subcommand, e.g. `gate --mode=stop`. */
export function cliCommand(subcommand: string): string {
  return `${CLI_PREFIX} ${subcommand}`;
}
