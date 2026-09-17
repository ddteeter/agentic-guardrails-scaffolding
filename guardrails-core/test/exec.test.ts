import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signalFromExitCode, spawnExec } from '../src/exec.js';

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

describe('spawn failure is distinguishable from a failing run', () => {
  it('flags spawnFailed when the binary does not exist', async () => {
    // A missing analyzer must not look like a clean one. Exit code cannot carry
    // this: eslint exits 1 on findings and tsc exits non-zero on type errors, so
    // non-zero is the NORMAL case.
    const result = await spawnExec('guardrails-no-such-binary-xyz', [
      '--version',
    ]);
    expect(result.spawnFailed).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('does NOT flag spawnFailed for a process that ran and exited non-zero', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('does NOT flag spawnFailed for a successful run', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log("ok")',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.spawnFailed).toBeUndefined();
  });
});

describe('env replacement', () => {
  it('passes an explicit env through, replacing the inherited one', async () => {
    // Load-bearing: hooks run with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
    // exported into the environment, and a `git` spawned from inside a hook
    // would target the HOOK's repo regardless of cwd unless they are stripped.
    const result = await spawnExec(
      process.execPath,
      ['-e', 'console.log(process.env.GUARDRAILS_PROBE)'],
      { env: { GUARDRAILS_PROBE: 'replaced' } },
    );
    expect(result.stdout.trim()).toBe('replaced');
  });

  it('inherits the parent environment when no env is given', async () => {
    const result = await spawnExec(process.execPath, [
      '-e',
      'console.log(process.env.PATH === undefined ? "stripped" : "inherited")',
    ]);
    expect(result.stdout.trim()).toBe('inherited');
  });
});

describe('stderr capture from a real process', () => {
  // The `child.stderr.on('data')` handler was previously exercised only via the
  // spawn-error path (a missing binary), which fills `stderr` from the `error`
  // event instead. `analyzerFailedViolation` quotes the first line of stderr as
  // its diagnostic, so a process that RUNS and writes to stderr is the case
  // that actually has to work.
  it('accumulates what a running process writes to stderr', async () => {
    const result = await spawnExec(node, [
      '-e',
      String.raw`process.stderr.write("first line\nsecond line"); process.exit(2)`,
    ]);
    expect(result.stderr).toBe('first line\nsecond line');
    expect(result.code).toBe(2);
    expect(result.spawnFailed).toBeUndefined();
  });

  it('accumulates stderr across multiple chunks without interleaving stdout', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.stderr.write("a"); process.stdout.write("OUT"); process.stderr.write("b");',
    ]);
    expect(result.stderr).toBe('ab');
    expect(result.stdout).toBe('OUT');
  });
});

describe('a signal-killed run is distinguishable from a clean one', () => {
  // Node reports a process killed by a signal as `code === null,
  // signal === 'SIGTERM'`, and this spawn deliberately uses `shell: false`, so
  // there is no shell to translate that into 128+N. Coalescing the null to zero
  // made a killed analyzer — empty stdout, "exit 0" — read exactly like a clean
  // one.
  it('carries the signal that killed the process', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.kill(process.pid, "SIGTERM")',
    ]);
    expect(result.signal).toBe('SIGTERM');
  });

  it('never presents a killed run as the reading a caller treats as clean', async () => {
    const result = await spawnExec(node, [
      '-e',
      'process.kill(process.pid, "SIGKILL")',
    ]);
    // The whole fail-open in one assertion: "exit 0, nothing on stderr, no
    // signal" is what every consumer of this seam reads as success.
    expect(result.code === 0 && result.signal === undefined).toBe(false);
  });

  it('leaves signal absent for a process that exited on its own', async () => {
    const result = await spawnExec(node, ['-e', 'process.exit(3)']);
    expect(result.signal).toBeUndefined();
    expect(result.code).toBe(3);
  });

  it('leaves signal absent for a clean run', async () => {
    const result = await spawnExec(node, ['-e', 'process.stdout.write("ok")']);
    expect(result.signal).toBeUndefined();
    expect(result.code).toBe(0);
  });

  it('leaves signal absent when the binary could not be started', async () => {
    const result = await spawnExec('guardrails-no-such-binary-xyz', []);
    expect(result.spawnFailed).toBe(true);
    expect(result.signal).toBeUndefined();
  });
});

describe('signalFromExitCode', () => {
  // A wrapper binary between guardrails and the analyzer (npx, sh, a shell
  // script) waits on the child itself and re-reports the kill the way a shell
  // does: 128 + the signal number. By the time that reaches this process it is
  // an ordinary exit code with no signal attached, so the only way to recognise
  // it is to read the number.
  it('recognises the shell convention for a SIGTERM kill (143)', () => {
    expect(signalFromExitCode(143)).toBe('SIGTERM');
  });

  it('recognises an OOM kill (137)', () => {
    expect(signalFromExitCode(137)).toBe('SIGKILL');
  });

  it('recognises a Ctrl-C (130)', () => {
    expect(signalFromExitCode(130)).toBe('SIGINT');
  });

  // The whole table, so a signal cannot quietly drop out of the list it is
  // decoded from. The numbers are the POSIX-standard ones, which is what makes
  // 128+N a convention rather than a per-platform accident.
  it.each([
    [129, 'SIGHUP'],
    [130, 'SIGINT'],
    [131, 'SIGQUIT'],
    [132, 'SIGILL'],
    [134, 'SIGABRT'],
    [136, 'SIGFPE'],
    [137, 'SIGKILL'],
    [139, 'SIGSEGV'],
    [141, 'SIGPIPE'],
    [142, 'SIGALRM'],
    [143, 'SIGTERM'],
    [152, 'SIGXCPU'],
    [153, 'SIGXFSZ'],
  ])('decodes exit %i as %s', (code, name) => {
    expect(signalFromExitCode(code)).toBe(name);
  });

  it('returns undefined for exit codes analyzers really use', () => {
    // eslint exits 1 on findings and 2 on a crash; tsc uses 1/2/3; git uses
    // 128 for "bad revision". None of these are kills, and reading them as one
    // would replace a true diagnosis with a wrong story about timeouts.
    expect(signalFromExitCode(0)).toBeUndefined();
    expect(signalFromExitCode(1)).toBeUndefined();
    expect(signalFromExitCode(2)).toBeUndefined();
    expect(signalFromExitCode(128)).toBeUndefined();
  });

  it('returns undefined for a number above the signal range', () => {
    expect(signalFromExitCode(255)).toBeUndefined();
  });
});
