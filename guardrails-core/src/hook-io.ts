/**
 * Hook-boundary I/O: parse the JSON payload agents pipe in on stdin, format the
 * Claude Code Stop-hook decision, and resolve the repo-local tool binaries so
 * the CLI runs the same pinned eslint/tsc the repo installed. Kept separate
 * from `cli.ts` so the formatting/parsing is pure and unit-testable.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { GateDecision } from './gate-decision.js';

export interface HookInput {
  sessionId?: string;
  cwd?: string;
  filePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHookInput(stdin: string): HookInput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch {
    return {};
  }
  if (!isRecord(raw)) {
    return {};
  }
  const input: HookInput = {};
  if (typeof raw.session_id === 'string') {
    input.sessionId = raw.session_id;
  }
  if (typeof raw.cwd === 'string') {
    input.cwd = raw.cwd;
  }
  const toolInput = raw.tool_input;
  if (isRecord(toolInput) && typeof toolInput.file_path === 'string') {
    input.filePath = toolInput.file_path;
  }
  return input;
}

export interface StopHookOutput {
  decision: 'block';
  reason: string;
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext: string;
  };
}

/**
 * Claude Code Stop-hook output. `null` means "let the turn end" (no block).
 * A block carries the terse pointer as `reason`; any behavioral correction
 * rides separately in `hookSpecificOutput.additionalContext`, which Claude Code
 * injects as a system reminder alongside the block.
 */
export function formatStopHookOutput(
  decision: GateDecision,
): StopHookOutput | null {
  if (!decision.block) {
    return null;
  }
  const output: StopHookOutput = {
    decision: 'block',
    reason: decision.message,
  };
  if (decision.additionalContext !== undefined) {
    output.hookSpecificOutput = {
      hookEventName: 'Stop',
      additionalContext: decision.additionalContext,
    };
  }
  return output;
}

/** Resolve a repo-local `node_modules/.bin` tool, else fall back to the name. */
export function resolveLocalBin(repoRoot: string, tool: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(repoRoot, 'node_modules', '.bin', `${tool}${suffix}`);
  return existsSync(local) ? local : tool;
}
