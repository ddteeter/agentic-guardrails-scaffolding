import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GateDecision } from '../src/gate-decision.js';
import type { HookInput } from '../src/hook-io.js';
import {
  formatCopilotStopOutput,
  formatPreToolUseDeny,
  formatStopHookOutput,
  hookFilePaths,
  parseApplyPatchFilePaths,
  parseHookInput,
  resolveLocalBin,
} from '../src/hook-io.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-hook-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseHookInput', () => {
  it('extracts session id and cwd from a Stop payload', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        session_id: 'abc',
        cwd: '/repo',
        hook_event_name: 'Stop',
        stop_hook_active: true,
      }),
    );
    expect(parsed).toEqual({
      sessionId: 'abc',
      cwd: '/repo',
      stopHookActive: true,
    });
  });

  it('extracts the edited file path from a PostToolUse payload', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        session_id: 'abc',
        cwd: '/repo',
        tool_input: { file_path: '/repo/src/a.ts' },
      }),
    );
    expect(parsed.filePath).toBe('/repo/src/a.ts');
  });

  it('extracts the tool name from a PreToolUse payload', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        cwd: '/repo',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/a.ts' },
      }),
    );
    expect(parsed.toolName).toBe('Read');
  });

  it('degrades to empty fields on malformed input', () => {
    expect(parseHookInput('not json')).toEqual({});
    expect(parseHookInput('')).toEqual({});
    expect(parseHookInput('null')).toEqual({});
    expect(parseHookInput('[]')).toEqual({});
  });

  it('omits fields whose runtime values have the wrong types', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        session_id: 42,
        cwd: false,
        tool_name: {},
        stop_hook_active: 'yes',
      }),
    );
    expect(parsed).toEqual({});
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('uses Claude retry state ahead of Copilot fallback state', () => {
    expect(
      parseHookInput(
        JSON.stringify({ stop_hook_active: false, stopHookActive: true }),
      ).stopHookActive,
    ).toBe(false);
    expect(
      parseHookInput(JSON.stringify({ stopHookActive: false })).stopHookActive,
    ).toBe(false);
    expect(
      Object.keys(parseHookInput(JSON.stringify({ stopHookActive: 'false' }))),
    ).toEqual([]);
  });

  it('extracts fields from a Copilot camelCase preToolUse payload', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        sessionId: 'xyz',
        workingDirectory: '/repo',
        toolName: 'bash',
        toolArgs: { command: 'git commit -m wip' },
      }),
    );
    expect(parsed).toEqual({
      sessionId: 'xyz',
      cwd: '/repo',
      toolName: 'bash',
      command: 'git commit -m wip',
    });
  });

  it('reads cwd from Copilot workingDirectory, not just Claude cwd', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        sessionId: 'xyz',
        workingDirectory: '/repo',
        toolName: 'bash',
        toolArgs: { command: 'echo hi' },
      }),
    );
    expect(parsed.cwd).toBe('/repo');
  });

  it('extracts the edited path from a Copilot postToolUse payload', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        sessionId: 'xyz',
        workingDirectory: '/repo',
        toolName: 'edit',
        toolArgs: { path: '/repo/src/a.ts' },
      }),
    );
    expect(parsed.filePath).toBe('/repo/src/a.ts');
  });

  it('reads the git command from a Claude Bash payload too', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      }),
    );
    expect(parsed.command).toBe('git push');
  });

  it('extracts every path from a Codex apply_patch payload', () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '*** Add File: src/added.ts',
      '*** Delete File: src/deleted.ts',
      '*** End Patch',
    ].join('\n');
    const parsed = parseHookInput(
      JSON.stringify({ tool_name: 'apply_patch', tool_input: { command } }),
    );
    expect(parsed.filePaths).toEqual([
      'src/old.ts',
      'src/new.ts',
      'src/added.ts',
      'src/deleted.ts',
    ]);
  });

  it('deduplicates repeated apply_patch paths and ignores other lines', () => {
    expect(
      parseApplyPatchFilePaths(
        '*** Update File: src/a.ts\n+line\n*** Update File: src/a.ts',
      ),
    ).toEqual(['src/a.ts']);
  });

  // The `^` anchor is the scope-lock's defence against a patch BODY line that
  // merely looks like a header: added content is prefixed (`+`), so an attacker
  // controlling patch text cannot smuggle an extra path past the manifest.
  it('ignores an apply_patch header that is not at the start of a line', () => {
    expect(
      parseApplyPatchFilePaths(
        '*** Update File: src/a.ts\n+*** Add File: src/injected.ts',
      ),
    ).toEqual(['src/a.ts']);
  });

  it('trims surrounding whitespace off an apply_patch path', () => {
    expect(parseApplyPatchFilePaths('*** Add File:   src/a.ts  ')).toEqual([
      'src/a.ts',
    ]);
  });

  it('ignores an apply_patch header whose path is only whitespace', () => {
    expect(parseApplyPatchFilePaths('*** Add File:    ')).toEqual([]);
  });

  it('leaves filePaths unset for an apply_patch payload with no command', () => {
    const parsed = parseHookInput(JSON.stringify({ tool_name: 'apply_patch' }));
    expect(parsed.toolName).toBe('apply_patch');
    expect(parsed.filePaths).toBeUndefined();
  });

  it('leaves filePaths unset when an apply_patch command names no file', () => {
    const parsed = parseHookInput(
      JSON.stringify({
        tool_name: 'apply_patch',
        tool_input: { command: '*** Begin Patch\n*** End Patch' },
      }),
    );
    expect(parsed.filePaths).toBeUndefined();
  });

  // Only apply_patch payloads get the header treatment: a shell command whose
  // heredoc body happens to contain a header line must not widen scope.
  it("does not read apply_patch headers out of another tool's command", () => {
    const parsed = parseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: "cat <<'EOF'\n*** Add File: src/injected.ts\nEOF",
        },
      }),
    );
    expect(parsed.command).toContain('*** Add File');
    expect(parsed.filePaths).toBeUndefined();
  });
});

describe('hookFilePaths', () => {
  it('returns an empty list when the payload names no file', () => {
    expect(hookFilePaths({})).toEqual([]);
  });

  it('returns the single edited path when only filePath is set', () => {
    expect(hookFilePaths({ filePath: '/repo/src/a.ts' })).toEqual([
      '/repo/src/a.ts',
    ]);
  });

  it('prefers the multi-path list over the single path', () => {
    expect(
      hookFilePaths({
        filePath: '/repo/src/a.ts',
        filePaths: ['/repo/src/b.ts'],
      }),
    ).toEqual(['/repo/src/b.ts']);
  });

  it('returns a copy the caller cannot use to mutate the payload', () => {
    const input: HookInput = { filePaths: ['/repo/src/a.ts'] };
    hookFilePaths(input).push('/repo/src/b.ts');
    expect(input.filePaths).toEqual(['/repo/src/a.ts']);
  });
});

describe('formatStopHookOutput', () => {
  const base: GateDecision = {
    outcome: 'delegate',
    block: true,
    message: 'spawn the fixer',
    nextSession: { attempts: 1, ruleCounts: {}, corrected: [] },
    nextRecurrence: {},
  };

  it('returns null when the decision does not block', () => {
    expect(
      formatStopHookOutput({ ...base, outcome: 'clean', block: false }),
    ).toBeNull();
  });

  it('emits a Claude Code block decision with the reason', () => {
    expect(formatStopHookOutput(base)).toEqual({
      decision: 'block',
      reason: 'spawn the fixer',
    });
  });

  it('attaches the behavioral correction as separate additionalContext', () => {
    const output = formatStopHookOutput({
      ...base,
      additionalContext: 'stop doing that',
    });
    expect(output?.reason).toBe('spawn the fixer');
    expect(output?.hookSpecificOutput).toEqual({
      hookEventName: 'Stop',
      additionalContext: 'stop doing that',
    });
  });
});

describe('formatPreToolUseDeny', () => {
  it('emits the Claude hookSpecificOutput shape by default', () => {
    expect(formatPreToolUseDeny('nope', 'claude')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      },
    });
  });

  it('emits the Copilot top-level shape', () => {
    expect(formatPreToolUseDeny('nope', 'copilot')).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'nope',
    });
  });

  it('emits the Claude-compatible nested shape for Codex', () => {
    expect(formatPreToolUseDeny('nope', 'codex')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      },
    });
  });
});

describe('formatCopilotStopOutput', () => {
  const base: GateDecision = {
    outcome: 'delegate',
    block: true,
    message: 'spawn the fixer',
    nextSession: { attempts: 1, ruleCounts: {}, corrected: [] },
    nextRecurrence: {},
  };

  it('returns null when not blocking', () => {
    expect(
      formatCopilotStopOutput({ ...base, outcome: 'clean', block: false }),
    ).toBeNull();
  });

  it('folds the correction into reason (no hookSpecificOutput)', () => {
    expect(
      formatCopilotStopOutput({ ...base, additionalContext: 'stop that' }),
    ).toEqual({ decision: 'block', reason: 'spawn the fixer\n\nstop that' });
  });

  it('uses the message verbatim when there is no correction', () => {
    expect(formatCopilotStopOutput(base)).toEqual({
      decision: 'block',
      reason: 'spawn the fixer',
    });
  });
});

describe('resolveLocalBin', () => {
  it('returns the repo-local bin path when it exists', () => {
    const binDirectory = path.join(root, 'node_modules', '.bin');
    mkdirSync(binDirectory, { recursive: true });
    const eslint = path.join(binDirectory, 'eslint');
    writeFileSync(eslint, '#!/usr/bin/env node\n');
    chmodSync(eslint, 0o755);
    expect(resolveLocalBin(root, 'eslint')).toBe(eslint);
  });

  it('falls back to the bare tool name when not installed locally', () => {
    expect(resolveLocalBin(root, 'eslint')).toBe('eslint');
  });

  it('resolves the Windows command shim suffix', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    try {
      const binDirectory = path.join(root, 'node_modules', '.bin');
      mkdirSync(binDirectory, { recursive: true });
      const eslint = path.join(binDirectory, 'eslint.cmd');
      writeFileSync(eslint, '');
      expect(resolveLocalBin(root, 'eslint')).toBe(eslint);
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: original,
      });
    }
  });

  it('finds the bin in an ancestor when the package has no node_modules', () => {
    // npm hoisting: deps live at the monorepo root and packages/web has no
    // node_modules of its own. Before the walk, this fell through to PATH and
    // ran whatever eslint the machine had.
    const binDirectory = path.join(root, 'node_modules', '.bin');
    mkdirSync(binDirectory, { recursive: true });
    const eslint = path.join(binDirectory, 'eslint');
    writeFileSync(eslint, '#!/usr/bin/env node\n');
    chmodSync(eslint, 0o755);
    mkdirSync(path.join(root, '.git'));
    const package_ = path.join(root, 'packages', 'web');
    mkdirSync(package_, { recursive: true });

    expect(resolveLocalBin(package_, 'eslint')).toBe(eslint);
  });

  it('prefers the nearest bin over an ancestor copy', () => {
    const outer = path.join(root, 'node_modules', '.bin');
    mkdirSync(outer, { recursive: true });
    writeFileSync(path.join(outer, 'eslint'), '');
    mkdirSync(path.join(root, '.git'));
    const package_ = path.join(root, 'packages', 'web');
    const inner = path.join(package_, 'node_modules', '.bin');
    mkdirSync(inner, { recursive: true });
    const nearest = path.join(inner, 'eslint');
    writeFileSync(nearest, '');

    expect(resolveLocalBin(package_, 'eslint')).toBe(nearest);
  });

  it('stops at the repo root instead of taking an ancestor toolchain', () => {
    // The bound. A bin above the repo is not this repo's pinned version, and
    // silently running it would change what counts as a violation.
    const outside = path.join(root, 'node_modules', '.bin');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'eslint'), '');
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });

    expect(resolveLocalBin(repo, 'eslint')).toBe('eslint');
  });

  it('still finds a bin at the repo root itself', () => {
    // The boundary is inclusive: the repo root's own node_modules is in scope.
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const binDirectory = path.join(repo, 'node_modules', '.bin');
    mkdirSync(binDirectory, { recursive: true });
    const eslint = path.join(binDirectory, 'eslint');
    writeFileSync(eslint, '');

    expect(resolveLocalBin(repo, 'eslint')).toBe(eslint);
  });
});

describe('agent identity', () => {
  it('reads Claude Code agent identity', () => {
    const input = parseHookInput(
      JSON.stringify({ agent_id: 'a1', agent_type: 'guardrail-fixer' }),
    );
    expect(input.agentId).toBe('a1');
    expect(input.agentType).toBe('guardrail-fixer');
  });

  it('reads Copilot subagent identity', () => {
    // Copilot supplies these on subagentStart/subagentStop, never on
    // preToolUse -- the parser reads them wherever they appear.
    const input = parseHookInput(
      JSON.stringify({ agentId: 'a1', agentType: 'guardrail-fixer' }),
    );
    expect(input.agentId).toBe('a1');
    expect(input.agentType).toBe('guardrail-fixer');
  });

  it('leaves identity absent on a main-thread payload', () => {
    // Absence is the SIGNAL, not a default to be filled in: Claude Code omits
    // agent_id on the main thread, and Codex omits both fields entirely. A
    // consumer must be able to tell "no agent" from "some agent".
    const input = parseHookInput(
      JSON.stringify({ session_id: 's', tool_name: 'Edit' }),
    );
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });

  it('ignores non-string agent fields', () => {
    const input = parseHookInput(
      JSON.stringify({ agent_id: 7, agent_type: { name: 'x' } }),
    );
    expect(input.agentId).toBeUndefined();
    expect(input.agentType).toBeUndefined();
  });
});
