import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Exec } from '../src/exec.js';
import { parseJsonText } from '../src/json-file.js';
import {
  detectLocker,
  everyInterval,
  lockerArgv,
  machineLock,
  runUnderLock,
  waitFor,
} from '../src/mutation-lock.js';

const lockConfig = { commitWaitSeconds: 60, pushWaitSeconds: 10_800 };

describe('waitFor', () => {
  it('tries the lock once on the stop rung, then defers', () => {
    expect(waitFor('stop', lockConfig)).toEqual({
      waitSeconds: 0,
      onTimeout: 'defer',
    });
  });

  it('waits the commit wait on the commit rung, then defers', () => {
    expect(waitFor('commit', lockConfig)).toEqual({
      waitSeconds: 60,
      onTimeout: 'defer',
    });
  });

  it('waits the push wait on the push rung, then blocks', () => {
    expect(waitFor('push', lockConfig)).toEqual({
      waitSeconds: 10_800,
      onTimeout: 'block',
    });
  });

  it('takes no lock on ci', () => {
    expect(waitFor('ci', lockConfig)).toBeUndefined();
  });
});

describe('lockerArgv', () => {
  it('builds the lockf form, keeping the lock file and failing silently', () => {
    expect(
      lockerArgv('lockf', '/locks/gate.lock', 60, 'stryker', ['run', '-x']),
    ).toEqual({
      command: 'lockf',
      args: [
        '-k',
        '-s',
        '-t',
        '60',
        '/locks/gate.lock',
        'stryker',
        'run',
        '-x',
      ],
    });
  });

  it('builds the flock form, exiting 75 on a timeout like lockf does', () => {
    expect(
      lockerArgv('flock', '/locks/gate.lock', 0, 'stryker', ['run']),
    ).toEqual({
      command: 'flock',
      args: ['-w', '0', '-E', '75', '/locks/gate.lock', 'stryker', 'run'],
    });
  });
});

/**
An exec where only the named tools exist on the PATH.
*/
function pathWith(...tools: string[]): Exec {
  return (_command, args) => {
    const script = args.at(-1) ?? '';
    const isPresent = tools.some((tool) => script.endsWith(` ${tool}`));
    return Promise.resolve({ stdout: '', stderr: '', code: isPresent ? 0 : 1 });
  };
}

/**
An exec whose every spawn failed to start, yet reports exit 0.
*/
const unstartable: Exec = () =>
  Promise.resolve({ stdout: '', stderr: '', code: 0, spawnFailed: true });

/**
A progress sink for tests that are not about the lock's lines.
*/
function ignoreLine(): void {
  // The lines are not under test here.
}

describe('detectLocker', () => {
  it('prefers lockf, as the hook did', async () => {
    expect(await detectLocker(pathWith('lockf', 'flock'))).toBe('lockf');
  });

  it('falls back to flock', async () => {
    expect(await detectLocker(pathWith('flock'))).toBe('flock');
  });

  it('answers undefined with neither', async () => {
    expect(await detectLocker(pathWith())).toBeUndefined();
  });

  it('does not take a locker that failed to start, whatever code it reports', async () => {
    // `spawnFailed` is independent of the exit code: it is the flag for "never
    // ran", and a fake (or a future spawn path) can pair it with a zero.
    expect(await detectLocker(unstartable)).toBeUndefined();
  });
});

/**
 * A machine with `lockf`, where the lock is free or busy and the locked
 * command exits `commandCode`. Records every call it sees.
 */
function lockfMachine(state: {
  busy: boolean;
  timesOut?: boolean;
  commandCode?: number;
}) {
  const calls: { line: string; processGroup: boolean }[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, processGroup: options?.processGroup === true });
    if (command === 'sh') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: line.endsWith(' lockf') ? 0 : 1,
      });
    }
    if (command === 'lockf' && args.at(-1) === 'true') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: state.busy ? 75 : 0,
      });
    }
    if (command === 'lockf') {
      return Promise.resolve({
        stdout: 'ran',
        stderr: '',
        code: state.timesOut === true ? 75 : (state.commandCode ?? 0),
      });
    }
    return Promise.resolve({ stdout: 'ran bare', stderr: '', code: 0 });
  };
  return { exec, calls };
}

function locked(
  exec: Exec,
  rung: 'stop' | 'commit' | 'push' | 'ci',
  lockPath = '/locks/gate.lock',
) {
  const lines: string[] = [];
  const run = runUnderLock({
    exec,
    rung,
    lock: { path: lockPath, config: lockConfig },
    command: 'stryker',
    args: ['run'],
    cwd: '/repo',
    progress: (line) => {
      lines.push(line);
    },
    canOpenLock: () => true,
  });
  return { run, lines };
}

/**
A machine with neither locker, where only stryker runs.
*/
const noLockerMachine: Exec = (command) =>
  Promise.resolve({
    stdout: command === 'stryker' ? 'ran bare' : '',
    stderr: '',
    code: command === 'stryker' ? 0 : 1,
  });

describe('runUnderLock', () => {
  it('runs the command under the lock, as its own process group', async () => {
    const { exec, calls } = lockfMachine({ busy: false });
    const { run, lines } = locked(exec, 'commit');
    expect(await run).toEqual({
      kind: 'ran',
      result: { stdout: 'ran', stderr: '', code: 0 },
    });
    expect(calls.at(-1)).toEqual({
      line: 'lockf -k -s -t 60 /locks/gate.lock stryker run',
      processGroup: true,
    });
    expect(lines).toEqual([]);
  });

  it('passes the command exit code through untouched', async () => {
    const { exec } = lockfMachine({ busy: false, commandCode: 1 });
    const { run } = locked(exec, 'push');
    expect(await run).toMatchObject({ kind: 'ran', result: { code: 1 } });
  });

  it('says it is waiting before a real wait on a busy lock', async () => {
    const { exec } = lockfMachine({ busy: true });
    const { run, lines } = locked(exec, 'push');
    await run;
    expect(lines[0]).toContain('waiting for the mutation lock (up to 10800s)');
  });

  it('defers on the stop rung without waiting at all', async () => {
    const { exec, calls } = lockfMachine({ busy: true });
    const { run } = locked(exec, 'stop');
    expect(await run).toEqual({
      kind: 'deferred',
      holding: 'another checkout holds it',
    });
    expect(calls.some((call) => call.line.includes('stryker'))).toBe(false);
  });

  it('defers on the commit rung when the wait runs out', async () => {
    const { exec } = lockfMachine({ busy: true, timesOut: true });
    const { run } = locked(exec, 'commit');
    expect(await run).toEqual({
      kind: 'deferred',
      holding: 'another checkout holds it',
    });
  });

  it('times out on the push rung when the wait runs out', async () => {
    const { exec } = lockfMachine({ busy: true, timesOut: true });
    const { run } = locked(exec, 'push');
    expect(await run).toEqual({
      kind: 'timed-out',
      lock: { path: '/locks/gate.lock', config: lockConfig },
      holding: 'another checkout holds it',
    });
  });

  it('takes no lock on ci', async () => {
    const { exec, calls } = lockfMachine({ busy: true });
    const { run } = locked(exec, 'ci');
    expect(await run).toMatchObject({
      kind: 'ran',
      result: { stdout: 'ran bare' },
    });
    expect(calls).toEqual([{ line: 'stryker run', processGroup: false }]);
  });

  it('runs unserialized, once noted, with no locker on the machine', async () => {
    const { run, lines } = locked(noLockerMachine, 'push');
    expect(await run).toMatchObject({
      kind: 'ran',
      result: { stdout: 'ran bare' },
    });
    expect(lines).toEqual([
      'guardrails: no lockf or flock on this machine — mutation testing runs ' +
        'unserialized. Install util-linux (flock) to serialize it.',
    ]);
  });

  it('runs unserialized when the lock file cannot be opened, and names the fix', async () => {
    const { exec, calls } = lockfMachine({ busy: false });
    const lines: string[] = [];
    const result = await runUnderLock({
      exec,
      rung: 'push',
      lock: { path: '/locks/gate.lock', config: lockConfig },
      command: 'stryker',
      args: ['run'],
      cwd: '/repo',
      progress: (line) => {
        lines.push(line);
      },
      canOpenLock: () => false,
    });
    expect(result).toMatchObject({
      kind: 'ran',
      result: { stdout: 'ran bare' },
    });
    expect(calls.at(-1)?.line).toBe('stryker run');
    expect(lines).toEqual([
      'guardrails: could not open the mutation lock at /locks/gate.lock — ' +
        'running unserialized. Set GUARDRAILS_GATE_LOCK to a writable path.',
    ]);
  });
});

/**
 * A machine with `lockf` but no `stryker`: the locker reports the missing
 * command, the bare spawn fails to start.
 */
const missingStrykerMachine =
  (calls: string[]): Exec =>
  (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'sh' || (command === 'lockf' && args.at(-1) === 'true')) {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (command === 'lockf') {
      return Promise.resolve({
        stdout: '',
        stderr: 'lockf: stryker: No such file or directory\n',
        code: 1,
      });
    }
    return Promise.resolve({
      stdout: '',
      stderr: 'spawn stryker ENOENT',
      code: 1,
      spawnFailed: true,
    });
  };

/**
`exec`, with every call's command and working directory noted.
*/
function noteCwd(exec: Exec) {
  const seen: { command: string; cwd: string | undefined }[] = [];
  const wrapped: Exec = (command, args, options) => {
    seen.push({ command, cwd: options?.cwd });
    return exec(command, args, options);
  };
  return { wrapped, seen };
}

/**
The working directory of every call that is not the `sh` locker detection.
*/
function workingDirectories(
  seen: readonly { command: string; cwd: string | undefined }[],
): (string | undefined)[] {
  return seen.filter((call) => call.command !== 'sh').map((call) => call.cwd);
}

describe('runUnderLock runs everything in the repo it was given', () => {
  it('probes and runs under the lock in cwd', async () => {
    const { wrapped, seen } = noteCwd(lockfMachine({ busy: false }).exec);
    await locked(wrapped, 'commit').run;
    expect(workingDirectories(seen)).toEqual(['/repo', '/repo']);
  });

  it('runs bare in cwd when there is no locker', async () => {
    const { wrapped, seen } = noteCwd(noLockerMachine);
    await locked(wrapped, 'push').run;
    expect(workingDirectories(seen)).toEqual(['/repo']);
  });

  it('runs bare in cwd when the lock file cannot be opened', async () => {
    const { wrapped, seen } = noteCwd(lockfMachine({ busy: false }).exec);
    await runUnderLock({
      exec: wrapped,
      rung: 'push',
      lock: { path: '/locks/gate.lock', config: lockConfig },
      command: 'stryker',
      args: ['run'],
      cwd: '/repo',
      progress: ignoreLine,
      canOpenLock: () => false,
    });
    expect(workingDirectories(seen)).toEqual(['/repo']);
  });

  it('re-runs a missing command bare in cwd', async () => {
    const { wrapped, seen } = noteCwd(missingStrykerMachine([]));
    await locked(wrapped, 'push').run;
    expect(workingDirectories(seen)).toEqual(['/repo', '/repo', '/repo']);
  });

  it('runs bare in cwd when no lock is configured', async () => {
    const { wrapped, seen } = noteCwd(lockfMachine({ busy: false }).exec);
    const result = await runUnderLock({
      exec: wrapped,
      rung: 'push',
      lock: undefined,
      command: 'stryker',
      args: ['run'],
      cwd: '/repo',
      progress: ignoreLine,
    });
    expect(result).toMatchObject({
      kind: 'ran',
      result: { stdout: 'ran bare' },
    });
    expect(seen).toEqual([{ command: 'stryker', cwd: '/repo' }]);
  });
});

/**
`runUnderLock` options for a push over a real lock file, with no lock-file seam.
*/
function unlockedOptions(exec: Exec, lockPath: string, lines: string[]) {
  return {
    exec,
    rung: 'push' as const,
    lock: { path: lockPath, config: lockConfig },
    command: 'stryker',
    args: ['run'],
    cwd: '/repo',
    progress: (line: string) => {
      lines.push(line);
    },
  };
}

describe('runUnderLock checks the real lock file by default', () => {
  it('opens (and so creates) a lock file in a writable directory, then locks', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-lock-'));
    try {
      const lockPath = path.join(directory, 'gate.lock');
      const { exec, calls } = lockfMachine({ busy: false });
      const lines: string[] = [];
      const result = await runUnderLock(unlockedOptions(exec, lockPath, lines));
      expect(result).toMatchObject({ kind: 'ran', result: { stdout: 'ran' } });
      expect(existsSync(lockPath)).toBe(true);
      expect(calls.at(-1)?.line).toBe(
        `lockf -k -s -t 10800 ${lockPath} stryker run`,
      );
      expect(lines).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs unserialized when the lock cannot be created', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'guardrails-lock-'));
    try {
      const lockPath = path.join(directory, 'no-such-directory', 'gate.lock');
      const { exec, calls } = lockfMachine({ busy: false });
      const lines: string[] = [];
      const result = await runUnderLock(unlockedOptions(exec, lockPath, lines));
      expect(result).toMatchObject({
        kind: 'ran',
        result: { stdout: 'ran bare' },
      });
      expect(calls.at(-1)?.line).toBe('stryker run');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `could not open the mutation lock at ${lockPath}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('runUnderLock with a missing command', () => {
  it('does not mistake a command that started and exited 0 for a missing one', async () => {
    // The text only means "the locker could not start it" when the locker
    // failed. A zero exit that happens to mention it is a finished run.
    const calls: string[] = [];
    const exec: Exec = (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === 'lockf' && args.at(-1) !== 'true') {
        return Promise.resolve({
          stdout: 'real',
          stderr: 'note: failed to execute stryker\n',
          code: 0,
        });
      }
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: command === 'sh' && !args.at(-1)?.endsWith(' lockf') ? 1 : 0,
      });
    };
    const { run } = locked(exec, 'push');
    expect(await run).toEqual({
      kind: 'ran',
      result: {
        stdout: 'real',
        stderr: 'note: failed to execute stryker\n',
        code: 0,
      },
    });
    expect(calls.at(-1)).toMatch(/^lockf /);
  });

  it('re-runs it bare so the spawn failure is a real one', async () => {
    const calls: string[] = [];
    const { run } = locked(missingStrykerMachine(calls), 'push');
    expect(await run).toMatchObject({
      kind: 'ran',
      result: { spawnFailed: true },
    });
    expect(calls.at(-1)).toBe('stryker run');
  });

  it('passes a command failure through when the command did start', async () => {
    const { exec } = lockfMachine({ busy: false, commandCode: 1 });
    const { run } = locked(exec, 'push');
    expect(await run).toMatchObject({ kind: 'ran', result: { stdout: 'ran' } });
  });
});

describe('machineLock', () => {
  it('uses GUARDRAILS_GATE_LOCK when it is set', () => {
    expect(
      machineLock(lockConfig, { GUARDRAILS_GATE_LOCK: '/locks/mine.lock' }),
    ).toEqual({ path: '/locks/mine.lock', config: lockConfig });
  });

  it.each([undefined, ''])(
    'falls back to the home directory for %j',
    (value) => {
      expect(
        machineLock(lockConfig, { GUARDRAILS_GATE_LOCK: value }).path,
      ).toBe(path.join(homedir(), '.guardrails-gate.lock'));
    },
  );
});

/**
Every call `exec` sees, with the environment it was given.
*/
function noteEnvironment(exec: Exec) {
  const seen: { line: string; env: NodeJS.ProcessEnv | undefined }[] = [];
  const wrapped: Exec = (command, args, options) => {
    seen.push({ line: [command, ...args].join(' '), env: options?.env });
    return exec(command, args, options);
  };
  return { wrapped, seen };
}

const HOLDING = {
  args: ['run', '--appendPlugins', '/dist/plugin.mjs'],
  env: { GUARDRAILS_LOCK_HOLDER_FILE: '/locks/gate.lock.holder.json' },
};

function holdingOptions(exec: Exec, canOpen: boolean) {
  return {
    exec,
    rung: 'push' as const,
    lock: { path: '/locks/gate.lock', config: lockConfig },
    command: 'stryker',
    args: ['run'],
    cwd: '/repo',
    progress: ignoreLine,
    canOpenLock: () => canOpen,
    locked: HOLDING,
  };
}

describe('runUnderLock runs the holder-only args only while holding the lock', () => {
  it('runs the locked args with the locked env once it holds the lock', async () => {
    const { wrapped, seen } = noteEnvironment(
      lockfMachine({ busy: false }).exec,
    );
    await runUnderLock(holdingOptions(wrapped, true));
    expect(seen.at(-1)).toEqual({
      line: 'lockf -k -s -t 10800 /locks/gate.lock stryker run --appendPlugins /dist/plugin.mjs',
      env: HOLDING.env,
    });
  });

  it('gives the probe neither the locked args nor the env', async () => {
    const { wrapped, seen } = noteEnvironment(
      lockfMachine({ busy: false }).exec,
    );
    await runUnderLock(holdingOptions(wrapped, true));
    expect(seen.at(-2)).toEqual({
      line: 'lockf -k -s -t 0 /locks/gate.lock true',
      env: undefined,
    });
  });

  it('runs the plain args when the lock file cannot be opened', async () => {
    const { wrapped, seen } = noteEnvironment(
      lockfMachine({ busy: false }).exec,
    );
    await runUnderLock(holdingOptions(wrapped, false));
    expect(seen.at(-1)).toEqual({ line: 'stryker run', env: undefined });
  });

  it('runs the plain args with no locker on the machine', async () => {
    const { wrapped, seen } = noteEnvironment(noLockerMachine);
    await runUnderLock(holdingOptions(wrapped, true));
    expect(seen.at(-1)).toEqual({ line: 'stryker run', env: undefined });
  });

  it('re-runs a missing command with the plain args', async () => {
    const { wrapped, seen } = noteEnvironment(missingStrykerMachine([]));
    await runUnderLock(holdingOptions(wrapped, true));
    expect(seen.at(-1)).toEqual({ line: 'stryker run', env: undefined });
  });

  it('runs the plain args on ci, which takes no lock', async () => {
    const { wrapped, seen } = noteEnvironment(
      lockfMachine({ busy: false }).exec,
    );
    await runUnderLock({ ...holdingOptions(wrapped, true), rung: 'ci' });
    expect(seen).toEqual([{ line: 'stryker run', env: undefined }]);
  });
});

const HOLDER_JSON = JSON.stringify({
  repo: '/Users/me/dev/dialed-164',
  rung: 'push',
  pid: 500,
  startedAt: 0,
  phase: 'dry-run',
  tested: 0,
  total: 0,
  reused: 0,
  survived: 0,
});

/**
`ps` on a machine where lockf 400 holds the lock for stryker 500, and two
others wait; with `isSelfHolding`, our own locker (parent 99) holds it instead.
*/
function queuePs(isSelfHolding: boolean): string {
  return [
    `400 ${isSelfHolding ? '99' : '300'} lockf -k -s -t 10800 /locks/gate.lock stryker run`,
    '500 400 node stryker run',
    '401 301 lockf -k -s -t 60 /locks/gate.lock stryker run',
    '402 302 lockf -k -s -t 60 /locks/gate.lock stryker run',
  ].join('\n');
}

/**
 * A busy lockf machine whose locked run stays pending until `finish` is
 * called with its exit code, so a test can look at what happens mid-wait.
 */
function pendingMachine() {
  let finish: (code: number) => void = ignoreCode;
  let ps = queuePs(false);
  const exec: Exec = (command, args) => {
    if (command === 'sh') {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (command === 'ps') {
      return Promise.resolve({ stdout: ps, stderr: '', code: 0 });
    }
    if (args.at(-1) === 'true') {
      return Promise.resolve({ stdout: '', stderr: '', code: 75 });
    }
    return new Promise((resolve) => {
      finish = (code) => {
        resolve({ stdout: '', stderr: '', code });
      };
    });
  };
  return {
    exec,
    finish: (code: number) => {
      finish(code);
    },
    setPs: (text: string) => {
      ps = text;
    },
  };
}

function readHolderJson() {
  return parseJsonText(HOLDER_JSON);
}

function atZero(): number {
  return 0;
}

function ignoreCode(code: number): void {
  expect(code).toBeTypeOf('number');
}

/**
`runUnderLock` options with every lock-watching seam pinned.
*/
function watchedOptions(exec: Exec, rung: 'stop' | 'commit' | 'push') {
  const lines: string[] = [];
  const ticks: (() => void)[] = [];
  const cancelled: boolean[] = [];
  const cancel = (): void => {
    cancelled.push(true);
  };
  const options = {
    exec,
    rung,
    lock: { path: '/locks/gate.lock', config: lockConfig },
    command: 'stryker',
    args: ['run'],
    cwd: '/repo',
    progress: (line: string) => {
      lines.push(line);
    },
    canOpenLock: () => true,
    watch: {
      readJson: readHolderJson,
      now: atZero,
      selfPid: 99,
      every: (milliseconds: number, tick: () => void) => {
        expect(milliseconds).toBe(60_000);
        ticks.push(tick);
        return cancel;
      },
    },
  };
  return { options, lines, ticks, cancelled };
}

/**
Let every pending promise callback run.
*/
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

describe('runUnderLock names who holds the lock and the queue', () => {
  it('says who holds it and how many others wait, before a real wait', async () => {
    const machine = pendingMachine();
    const { options, lines } = watchedOptions(machine.exec, 'push');
    const run = runUnderLock(options);
    await flush();
    machine.finish(0);
    await run;
    expect(lines[0]).toBe(
      'guardrails: waiting for the mutation lock (up to 10800s): ' +
        'dialed-164 (push) is running the dry run; 2 others waiting.',
    );
  });

  it('says another checkout holds it when the holder file names a dead pid', async () => {
    const machine = pendingMachine();
    const { options, lines } = watchedOptions(machine.exec, 'push');
    machine.setPs(queuePs(false).replace('500 400', '501 400'));
    const run = runUnderLock(options);
    await flush();
    machine.finish(0);
    await run;
    expect(lines[0]).toBe(
      'guardrails: waiting for the mutation lock (up to 10800s): ' +
        'another checkout holds it; 2 others waiting.',
    );
  });

  it('drops the queue clause when nobody else waits, and says "other" for one', async () => {
    const machine = pendingMachine();
    const { options, lines } = watchedOptions(machine.exec, 'commit');
    machine.setPs(queuePs(false).split('\n').slice(0, 2).join('\n'));
    const run = runUnderLock(options);
    await flush();
    machine.finish(0);
    await run;
    expect(lines[0]).toBe(
      'guardrails: waiting for the mutation lock (up to 60s): ' +
        'dialed-164 (push) is running the dry run.',
    );
    const one = pendingMachine();
    const second = watchedOptions(one.exec, 'commit');
    one.setPs(queuePs(false).split('\n').slice(0, 3).join('\n'));
    const again = runUnderLock(second.options);
    await flush();
    one.finish(0);
    await again;
    expect(second.lines[0]).toContain('; 1 other waiting.');
  });

  it('repeats a still-waiting line each minute while it waits', async () => {
    const machine = pendingMachine();
    const { options, lines, ticks } = watchedOptions(machine.exec, 'push');
    const run = runUnderLock(options);
    await flush();
    expect(ticks).toHaveLength(1);
    ticks[0]?.();
    await flush();
    machine.finish(0);
    await run;
    expect(lines[1]).toBe(
      'guardrails: still waiting for the mutation lock: ' +
        'dialed-164 (push) is running the dry run; 2 others waiting.',
    );
  });

  it('stops the still-waiting line once its own run holds the lock', async () => {
    const machine = pendingMachine();
    const { options, lines, ticks, cancelled } = watchedOptions(
      machine.exec,
      'push',
    );
    const run = runUnderLock(options);
    await flush();
    machine.setPs(queuePs(true));
    ticks[0]?.();
    await flush();
    expect(lines).toHaveLength(1);
    expect(cancelled).toEqual([true]);
    machine.finish(0);
    await run;
    expect(cancelled).toEqual([true, true]);
  });

  it('stops the still-waiting timer when the wait settles', async () => {
    const machine = pendingMachine();
    const { options, lines, ticks, cancelled } = watchedOptions(
      machine.exec,
      'push',
    );
    const run = runUnderLock(options);
    await flush();
    machine.finish(0);
    await run;
    expect(cancelled).toEqual([true]);
    ticks[0]?.();
    await flush();
    expect(lines).toHaveLength(1);
  });

  it('starts no timer when the lock was free', async () => {
    const { exec } = lockfMachine({ busy: false });
    const { options, ticks } = watchedOptions(exec, 'push');
    await runUnderLock(options);
    expect(ticks).toEqual([]);
  });

  it('carries who held it on a deferral', async () => {
    const machine = pendingMachine();
    const { options } = watchedOptions(machine.exec, 'stop');
    expect(await runUnderLock(options)).toEqual({
      kind: 'deferred',
      holding: 'dialed-164 (push) is running the dry run',
    });
  });

  it('carries who held it when a commit wait runs out', async () => {
    const machine = pendingMachine();
    const { options } = watchedOptions(machine.exec, 'commit');
    const run = runUnderLock(options);
    await flush();
    machine.finish(75);
    expect(await run).toEqual({
      kind: 'deferred',
      holding: 'dialed-164 (push) is running the dry run',
    });
  });

  it('carries who held it when a push wait runs out', async () => {
    const machine = pendingMachine();
    const { options } = watchedOptions(machine.exec, 'push');
    const run = runUnderLock(options);
    await flush();
    machine.finish(75);
    expect(await run).toEqual({
      kind: 'timed-out',
      lock: options.lock,
      holding: 'dialed-164 (push) is running the dry run',
    });
  });

  it('asks ps for every process with its parent', async () => {
    const asked: string[] = [];
    const machine = pendingMachine();
    const exec: Exec = (command, args, execOptions) => {
      if (command === 'ps') {
        asked.push([command, ...args].join(' '));
      }
      return machine.exec(command, args, execOptions);
    };
    await runUnderLock(watchedOptions(exec, 'stop').options);
    expect(asked).toEqual(['ps -Ao pid=,ppid=,command=']);
  });

  it('reads no queue from a ps that failed', async () => {
    const machine = pendingMachine();
    const exec: Exec = (command, args, execOptions) =>
      command === 'ps'
        ? Promise.resolve({ stdout: queuePs(false), stderr: '', code: 1 })
        : machine.exec(command, args, execOptions);
    expect(await runUnderLock(watchedOptions(exec, 'stop').options)).toEqual({
      kind: 'deferred',
      holding: 'another checkout holds it',
    });
  });
});

describe('everyInterval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks once per interval until it is stopped', () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const stop = everyInterval(1000, () => {
      ticks.push(Date.now());
    });
    vi.advanceTimersByTime(999);
    expect(ticks).toHaveLength(0);
    vi.advanceTimersByTime(1001);
    expect(ticks).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(ticks).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never keeps the process alive on its own', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      const stop = everyInterval(1000, ignoreLine);
      const timer = spy.mock.results[0]?.value;
      expect(timer?.hasRef()).toBe(false);
      stop();
    } finally {
      spy.mockRestore();
    }
  });
});
