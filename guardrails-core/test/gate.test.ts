import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import { runStopGate, type StopGateOptions } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import {
  loadSession,
  readViolations,
  stateDirectory,
} from '../src/state-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-gate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const config: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

/** Build a fake exec from a matcher over the joined command line. */
function makeExec(handler: (line: string) => ExecResult): Exec {
  return (command, args) =>
    Promise.resolve(handler([command, ...args].join(' ')));
}

function options(exec: Exec): StopGateOptions {
  return { repoRoot: root, sessionId: 'sid', baseBranch: 'main', exec, config };
}

function eslintError(): string {
  return JSON.stringify([
    {
      filePath: path.join(root, 'src/foo.ts'),
      messages: [
        {
          ruleId: 'no-console',
          severity: 2,
          message: 'Unexpected console.',
          line: 2,
        },
      ],
    },
  ]);
}

describe('runStopGate', () => {
  it('delegates on a failing verify: writes manifest + snapshot, persists attempt', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });

    const { decision } = await runStopGate(options(exec));

    expect(decision.outcome).toBe('delegate');
    expect(decision.block).toBe(true);
    // Manifest persisted for the fixer to read.
    const directory = stateDirectory(root);
    expect(readViolations(directory, 'sid').map((v) => v.ruleId)).toEqual([
      'no-console',
    ]);
    // Attempt counter persisted.
    expect(loadSession(directory, 'sid').attempts).toBe(1);
  });

  it('tolerates non-string entries in a tampered pre-fix snapshot', async () => {
    // The snapshot baseline is read defensively: a corrupt/tampered
    // `<sid>.pre-fix.json` with non-string elements must be filtered, not crash.
    const directory = stateDirectory(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'sid.pre-fix.json'),
      JSON.stringify([{}, 42, 'src/a.ts|eslint-disable|x']),
    );
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('clean');
  });

  it('exits clean when verify finds nothing and resets attempts', async () => {
    const exec = makeExec((line) => {
      if (line.includes('--name-only')) return ok('');
      return ok('');
    });
    const { decision } = await runStopGate(options(exec));
    expect(decision.outcome).toBe('clean');
    expect(decision.block).toBe(false);
  });

  it('catches a suppression the fixer added since the pre-fix snapshot', async () => {
    // Cycle 1: verify fails → delegate, snapshot taken.
    const exec1 = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok('');
      if (line.includes('eslint')) return ok(eslintError());
      return ok('');
    });
    await runStopGate(options(exec1));

    // Cycle 2: verify now passes, but the fixer sneaked in an eslint-disable.
    const sneakyDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+  // eslint-disable-next-line no-console',
      '   console.log(1);',
    ].join('\n');
    const exec2 = makeExec((line) => {
      if (line.includes('--name-only')) return ok('src/foo.ts');
      if (line.includes('--others')) return ok('');
      if (line.includes('diff') && line.includes('HEAD')) return ok(sneakyDiff);
      if (line.includes('eslint')) return ok(JSON.stringify([]));
      return ok('');
    });
    const { decision, auditFindings } = await runStopGate(options(exec2));

    expect(auditFindings.map((f) => f.kind)).toContain('eslint-disable');
    expect(decision.outcome).toBe('delegate');
    // The audit finding is surfaced as a violation in the manifest.
    const ids = readViolations(stateDirectory(root), 'sid').map(
      (v) => v.ruleId,
    );
    expect(ids).toContain('guardrails/added-suppression');
  });
});
