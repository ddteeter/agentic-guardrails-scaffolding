import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnExec } from '../src/exec.js';

const node = process.execPath;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-exec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('spawnExec', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.stdout.write("hi")']);
    expect(result.stdout).toBe('hi');
    expect(result.code).toBe(0);
  });

  it('captures a non-zero exit code', async () => {
    const result = await spawnExec(node, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('runs in the given cwd', async () => {
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(process.cwd())'],
      {
        cwd: root,
      },
    );
    // macOS symlinks /var → /private/var; compare basenames to avoid that.
    expect(path.basename(result.stdout)).toBe(path.basename(root));
  });

  it('applies a custom environment (and can drop inherited vars)', async () => {
    // The load-bearing case: a caller wanting an isolated git invocation must be
    // able to strip inherited GIT_* vars so a hook's GIT_DIR can't hijack it.
    const result = await spawnExec(
      node,
      ['-e', 'process.stdout.write(String(process.env.GIT_DIR))'],
      { env: { PATH: process.env.PATH } },
    );
    expect(result.stdout).toBe('undefined');
  });

  it('resolves (does not reject) when the command does not exist', async () => {
    const result = await spawnExec('definitely-not-a-real-binary-xyz', []);
    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
