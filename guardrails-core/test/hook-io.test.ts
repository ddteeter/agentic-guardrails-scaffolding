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
import {
  formatStopHookOutput,
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
      }),
    );
    expect(parsed).toEqual({ sessionId: 'abc', cwd: '/repo' });
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
});
