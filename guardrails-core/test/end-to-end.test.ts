/**
 * End-to-end integration: real `git` and real `spawnExec` (child_process) over a
 * throwaway repo, with only the linter binaries stubbed. Proves the plumbing the
 * unit tests inject around — diff-scoping against a base branch, real process
 * spawning, adapter mapping, gate decision, and state persistence — hangs
 * together for the full Stop-loop.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Exec, spawnExec } from '../src/exec.js';
import { runStopGate } from '../src/gate.js';
import type { GateConfig } from '../src/gate-decision.js';
import {
  loadSession,
  readViolations,
  stateDirectory,
} from '../src/state-store.js';

let root: string;

// Git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into hook processes, and
// those override `cwd`. This suite runs under the pre-push hook (via
// `test:coverage`), so a plain `git` here would target the REAL repo instead of
// the temp one and commit into it. Strip all GIT_* vars so every git call this
// test makes is pinned to `root` regardless of the ambient environment.
function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      env[key] = value;
    }
  }
  return env;
}

const isolatedExec: Exec = (command, args, options) =>
  spawnExec(command, args, { ...options, env: isolatedGitEnvironment() });

async function git(...args: string[]): Promise<void> {
  await isolatedExec('git', args, { cwd: root });
}

const config: GateConfig = {
  maxAttempts: 3,
  recurThreshold: 3,
  graduationThreshold: 3,
  fastFixer: 'guardrail-fixer',
  thoroughFixer: 'guardrail-fixer-thorough',
};

/** Write an executable node stub that ignores its args and prints `output`. */
function writeStub(name: string, output: string): string {
  const file = path.join(root, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-e2e-'));
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'seed.ts'), 'export const seed = 1;\n');
  await git('add', '.');
  await git('commit', '-m', 'seed');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('end-to-end Stop gate', () => {
  it('detects a real uncommitted change, delegates, and persists state', async () => {
    // Introduce an uncommitted TS change the way an agent would.
    writeFileSync(
      path.join(root, 'src', 'foo.ts'),
      'export const foo = () => console.log(1);\n',
    );

    // Stub eslint to report an error on the changed file; tsc reports nothing.
    const eslintStub = writeStub(
      'eslint-stub.mjs',
      JSON.stringify([
        {
          filePath: path.join(root, 'src/foo.ts'),
          messages: [
            {
              ruleId: 'no-console',
              severity: 2,
              message: 'Unexpected console statement.',
              line: 1,
            },
          ],
        },
      ]),
    );
    const tscStub = writeStub('tsc-stub.mjs', '');
    const resolveBin = (tool: string): string =>
      tool === 'eslint' ? eslintStub : tscStub;

    const { decision } = await runStopGate({
      repoRoot: root,
      sessionId: 'e2e',
      baseBranch: 'main',
      exec: isolatedExec,
      config,
      resolveBin,
    });

    expect(decision.outcome).toBe('delegate');
    expect(decision.fixerAgent).toBe('guardrail-fixer');

    const directory = stateDirectory(root);
    expect(readViolations(directory, 'e2e').map((v) => v.ruleId)).toEqual([
      'no-console',
    ]);
    expect(loadSession(directory, 'e2e').attempts).toBe(1);
  });

  it('exits clean when the changed file has no violations', async () => {
    writeFileSync(path.join(root, 'src', 'ok.ts'), 'export const ok = 2;\n');
    const resolveBin = (): string => writeStub('empty.mjs', '');
    // eslint stub returns an empty result set; tsc stub empty too.
    const eslintStub = writeStub('eslint-empty.mjs', '[]');
    const { decision } = await runStopGate({
      repoRoot: root,
      sessionId: 'e2e2',
      baseBranch: 'main',
      exec: isolatedExec,
      config,
      resolveBin: (tool) => (tool === 'eslint' ? eslintStub : resolveBin()),
    });
    expect(decision.outcome).toBe('clean');
    expect(decision.block).toBe(false);
  });
});
