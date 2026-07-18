/**
 * Hook-boundary I/O: parse the JSON payload agents pipe in on stdin, format the
 * Claude Code Stop-hook decision, and resolve the repo-local tool binaries so
 * the CLI runs the same pinned eslint/tsc the repo installed. Kept separate
 * from `cli.ts` so the formatting/parsing is pure and unit-testable.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

// The Claude Code hook JSON schema, straight from the SDK the CLI ships. We
// depend on these types directly (a type-only devDependency — erased at build,
// never shipped) so our hook I/O stays provably compatible: if Claude Code
// changes the schema, the SDK type changes and our build breaks, instead of the
// gate silently failing to block or deny at runtime.
import type {
  BaseHookInput,
  PreToolUseHookInput,
  StopHookSpecificOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

import type { GateDecision } from './gate-decision.js';

/** Our normalized (camelCase) view of the fields we read from the payload. */
export interface HookInput {
  sessionId?: string;
  cwd?: string;
  filePath?: string;
  toolName?: string;
  command?: string;
}

/** The raw payload fields we read, typed against the SDK schema. */
type RawHookPayload = Partial<
  Pick<BaseHookInput, 'session_id' | 'cwd'> &
    Pick<PreToolUseHookInput, 'tool_name' | 'tool_input'>
>;

/**
 * Copilot camelCase hook payload — the fields we read. GitHub Copilot's real
 * `BaseHookInput`/`PreToolUseHookInput` (`sessionId`, `workingDirectory`,
 * `toolName`, `toolArgs: unknown`) live in `@github/copilot-sdk`'s
 * `dist/types.d.ts`, but the package's `exports` map only exposes `.` (→
 * `dist/index.d.ts`, which does not re-export them) and `./extension` — there
 * is no supported subpath to import them from. `@github/copilot-sdk` is
 * therefore *not* a devDependency here (it was imported by nothing and only
 * pulled in native FFI deps for zero drift-safety); this interface is
 * hand-declared and local until a future SDK release exports the hook wire
 * types via a supported path — see the Phase-B risk note in `plan.md`.
 */
interface CopilotHookPayload {
  sessionId?: unknown;
  workingDirectory?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First candidate that is a string, else undefined. */
function firstString(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return undefined;
}

/** The tool-argument bag: Claude's `tool_input` or Copilot's `toolArgs`. */
function selectArguments(
  claude: RawHookPayload,
  copilot: CopilotHookPayload,
): Record<string, unknown> {
  if (isRecord(claude.tool_input)) {
    return claude.tool_input;
  }
  if (isRecord(copilot.toolArgs)) {
    return copilot.toolArgs;
  }
  return {};
}

export function parseHookInput(stdin: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  // Defensive over untrusted input: field NAMES come from the SDK types (so a
  // rename breaks the build), values are still runtime-checked. Claude's
  // snake_case is read first; Copilot's camelCase is the fallback.
  const claude = parsed as RawHookPayload;
  const copilot = parsed as CopilotHookPayload;
  const args = selectArguments(claude, copilot);

  // (field, [candidates in precedence order]) — Claude first, Copilot fallback.
  const fields: readonly [keyof HookInput, readonly unknown[]][] = [
    ['sessionId', [claude.session_id, copilot.sessionId]],
    ['cwd', [claude.cwd, copilot.workingDirectory]],
    ['toolName', [claude.tool_name, copilot.toolName]],
    ['filePath', [args.file_path, args.path]],
    ['command', [args.command]],
  ];

  const input: HookInput = {};
  for (const [key, candidates] of fields) {
    const value = firstString(...candidates);
    if (value !== undefined) {
      input[key] = value;
    }
  }
  return input;
}

/** Claude Code hook output — the SDK's canonical synchronous shape. */
export type HookOutput = SyncHookJSONOutput;

/**
 * Claude Code Stop-hook output. `null` means "let the turn end" (no block).
 * A block carries the terse pointer as `reason`; any behavioral correction
 * rides separately in `hookSpecificOutput.additionalContext`, which Claude Code
 * injects as a system reminder alongside the block.
 */
export function formatStopHookOutput(
  decision: GateDecision,
): HookOutput | null {
  if (!decision.block) {
    return null;
  }
  const output: HookOutput = {
    decision: 'block',
    reason: decision.message,
  };
  if (decision.additionalContext !== undefined) {
    const stop: StopHookSpecificOutput = {
      hookEventName: 'Stop',
      additionalContext: decision.additionalContext,
    };
    output.hookSpecificOutput = stop;
  }
  return output;
}

export type Dialect = 'claude' | 'copilot';

/**
 * A Copilot `preToolUse` deny: `permissionDecision`/`permissionDecisionReason`
 * live at the top level of the response, not nested under
 * `hookSpecificOutput` the way Claude Code's `SyncHookJSONOutput` requires
 * (its `hookSpecificOutput.PreToolUseHookSpecificOutput` is the only place the
 * SDK type permits those fields). There is no single SDK type that admits
 * both shapes, so `formatPreToolUseDeny` returns a union rather than forcing
 * the Copilot shape through a cast.
 */
export type PreToolUseDenyOutput =
  HookOutput | { permissionDecision: 'deny'; permissionDecisionReason: string };

/** PreToolUse deny in the requested dialect. Claude nests it under
 * hookSpecificOutput (the only shape SyncHookJSONOutput permits); Copilot
 * wants a top-level permissionDecision, which is why the return type is a
 * union rather than HookOutput alone. */
export function formatPreToolUseDeny(
  reason: string,
  dialect: Dialect,
): PreToolUseDenyOutput {
  if (dialect === 'copilot') {
    return { permissionDecision: 'deny', permissionDecisionReason: reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Copilot agentStop block: correction folded into `reason` (Copilot has no
 * additionalContext channel). `null` lets the turn end. This duplicates the
 * one-liner in gate.ts's `stopHookReason` rather than importing it, to avoid
 * a hook-io -> gate dependency (gate.ts is the higher-level module that
 * orchestrates verify/audit/state and is expected to depend on hook-io, not
 * the reverse). */
export function formatCopilotStopOutput(
  decision: GateDecision,
): HookOutput | null {
  if (!decision.block) {
    return null;
  }
  const reason =
    decision.additionalContext === undefined
      ? decision.message
      : `${decision.message}\n\n${decision.additionalContext}`;
  return { decision: 'block', reason };
}

/**
 * Resolve a repo-local Node tool (`node_modules/.bin/<tool>`), else fall back to
 * the bare name on PATH. This is the **TypeScript-pack** binary resolver:
 * eslint/tsc/knip are Node bins, and resolving `.bin` directly is more
 * deterministic than going through `npm run` scripts (which vary per repo) and
 * avoids `npx`'s overhead/registry check.
 *
 * The Java pack does *not* use this. There is no analogous single binary to
 * resolve — the Java adapter invokes build-tool goals through the repo's
 * wrapper (`./mvnw` / `./gradlew`, e.g. `pmd:check`, `-Dtest=ArchitectureTest`)
 * so the tool versions are pinned by the build, which is exactly why the
 * reviewer's instinct is right: for Java we lean on the build tool, not a bin.
 */
export function resolveLocalBin(repoRoot: string, tool: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(repoRoot, 'node_modules', '.bin', `${tool}${suffix}`);
  return existsSync(local) ? local : tool;
}
