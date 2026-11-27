import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CommandLockOptions,
  commandIdentity,
  holderShimArgv,
  type LockCommandDependencies,
  lockCommand,
  parseLockArguments,
  runCommandUnderLock,
} from '../src/command-lock.js';
import { type Exec, spawnExec } from '../src/exec.js';
import { parseJsonText } from '../src/json-file.js';
import { readHolder } from '../src/lock-holder.js';
import {
  detectLocker,
  LOCK_HELD_VARIABLE,
  LOCK_TIMEOUT_MARKER,
} from '../src/mutation-lock.js';
import { parseRuns } from '../src/run-log.js';

let directory: string;
let lockPath: string;
let startedFile: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'guardrails-command-lock-'));
  lockPath = path.join(directory, 'gate.lock');
  startedFile = path.join(directory, 'started');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
A sink for what a test does not look at.
*/
function ignore(): void {
  // Nothing here is under test.
}

/**
A timer or listener whose stop function does nothing.
*/
function noTimer(): () => void {
  return ignore;
}

/**
A sink that keeps each chunk in `into`.
*/
function collect(into: string[]): (text: string) => void {
  return (text) => {
    into.push(text);
  };
}

const RECORD = { repo: '/dev/app', command: 'npm', token: 'tok-1' };

describe('holderShimArgv', () => {
  it('runs the command through a sh shim, under the locker', () => {
    const shim = holderShimArgv({
      locker: 'lockf',
      lockPath: '/locks/gate.lock',
      waitSeconds: 60,
      startedFile: '/marks/started',
      record: RECORD,
      argv: ['npm', 'run', 'build'],
    });
    expect(shim.command).toBe('lockf');
    expect(shim.args.slice(0, 5)).toEqual([
      '-k',
      '-s',
      '-t',
      '60',
      '/locks/gate.lock',
    ]);
    expect(shim.args.slice(5, 7)).toEqual(['sh', '-c']);
    expect(shim.args.slice(8)).toEqual([
      'guardrails-lock',
      '/marks/started',
      '/locks/gate.lock.holder.json',
      '{"kind":"lock","repo":"/dev/app","command":"npm","token":"tok-1","pid":',
      'npm',
      'run',
      'build',
    ]);
  });

  it('takes the flock form too', () => {
    const shim = holderShimArgv({
      locker: 'flock',
      lockPath: '/locks/gate.lock',
      waitSeconds: 0,
      startedFile: '/marks/started',
      record: RECORD,
      argv: ['make'],
    });
    expect(shim.command).toBe('flock');
    expect(shim.args.slice(0, 6)).toEqual([
      '-w',
      '0',
      '-E',
      '75',
      '/locks/gate.lock',
      'sh',
    ]);
    expect(shim.args.at(-1)).toBe('make');
  });
});

/**
The shim run by a real sh, with no locker around it.
*/
async function runShim(argv: string[]) {
  const shim = holderShimArgv({
    locker: 'lockf',
    lockPath,
    waitSeconds: 0,
    startedFile,
    record: RECORD,
    argv,
  });
  const shArguments = shim.args.slice(6);
  return spawnExec('sh', shArguments);
}

describe('the holder shim, run by sh', () => {
  it('marks the start, writes the holder with its own pid, then becomes the command', async () => {
    const result = await runShim([
      'sh',
      '-c',
      'cat "$1"; echo "$$"; exit 3',
      'inner',
      `${lockPath}.holder.json`,
    ]);
    expect(result.code).toBe(3);
    const [written = '', pid = ''] = result.stdout.split('\n', 2);
    const holder = readHolder(
      `${lockPath}.holder.json`,
      () => parseJsonText(written),
      () => true,
    );
    expect(holder).toMatchObject({
      kind: 'lock',
      repo: '/dev/app',
      command: 'npm',
      pid: Number(pid),
    });
    const { parsed } = parseJsonText(written);
    expect(parsed).toMatchObject({ token: 'tok-1' });
    expect(holder?.startedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(existsSync(startedFile)).toBe(true);
  });

  it('passes arguments through untouched, spaces and quotes included', async () => {
    const result = await runShim([
      'node',
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'a b',
      `it's "quoted"`,
      '$HOME',
    ]);
    expect(JSON.parse(result.stdout)).toEqual([
      'a b',
      `it's "quoted"`,
      '$HOME',
    ]);
  });

  it('still runs the command when the holder file cannot be written', async () => {
    const shim = holderShimArgv({
      locker: 'lockf',
      lockPath: path.join(directory, 'missing', 'gate.lock'),
      waitSeconds: 0,
      startedFile,
      record: RECORD,
      argv: ['echo', 'ran'],
    });
    const result = await spawnExec('sh', shim.args.slice(6));
    expect(result).toEqual({ stdout: 'ran\n', stderr: '', code: 0 });
  });

  it('refuses to run the command, exiting 73, when the start mark cannot be written', async () => {
    startedFile = path.join(directory, 'missing', 'started');
    const result = await runShim(['echo', 'ran']);
    expect(result).toEqual({ stdout: '', stderr: '', code: 73 });
    expect(existsSync(`${lockPath}.holder.json`)).toBe(false);
  });

  it('exits 127 for a command that does not exist', async () => {
    const result = await runShim(['guardrails-no-such-command']);
    expect(result.code).toBe(127);
  });
});

const lockConfig = {
  commitWaitSeconds: 60,
  pushWaitSeconds: 10_800,
  stopGraceSeconds: 45,
};

interface Call {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  processGroup: boolean;
  isStreamed: boolean;
}

/**
 * A machine with `lockf`. The lock is free or busy; the locked run either
 * times out (exit 75 and the shim never ran) or runs, as the shim does:
 * it marks the start, writes the holder file, and exits `commandCode`.
 */
function machine(state: {
  hasLocker?: boolean;
  busy?: boolean;
  timesOut?: boolean;
  commandCode?: number;
  holderToken?: string;
  markFails?: boolean;
}) {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({
      command,
      args,
      env: options?.env,
      processGroup: options?.processGroup === true,
      isStreamed: options?.stream !== undefined,
    });
    if (command === 'sh') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: state.hasLocker === false ? 1 : 0,
      });
    }
    if (command === 'ps') {
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    }
    if (command === 'lockf' && args.at(-1) === 'true') {
      return Promise.resolve({
        stdout: '',
        stderr: '',
        code: state.busy === true ? 75 : 0,
      });
    }
    if (command === 'lockf') {
      if (state.timesOut === true) {
        return Promise.resolve({ stdout: '', stderr: '', code: 75 });
      }
      if (state.markFails === true) {
        return Promise.resolve({ stdout: '', stderr: '', code: 73 });
      }
      const [started = '', holderFile = ''] = args.slice(9, 11);
      writeFileSync(started, '');
      writeFileSync(
        holderFile,
        JSON.stringify({
          kind: 'lock',
          repo: '/dev/app',
          pid: 1,
          startedAt: 0,
          command: 'npm',
          token: state.holderToken ?? 'tok-1',
        }),
      );
    }
    options?.stream?.stdout('out');
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: state.commandCode ?? 0,
    });
  };
  return { exec, calls };
}

function options(
  exec: Exec,
  over: Partial<CommandLockOptions> = {},
): { options: CommandLockOptions; lines: string[]; output: string[] } {
  const lines: string[] = [];
  const output: string[] = [];
  return {
    lines,
    output,
    options: {
      exec,
      lock: { path: lockPath, config: lockConfig },
      argv: ['npm', 'run', 'build'],
      waitSeconds: 600,
      repoRoot: '/dev/app',
      cwd: '/dev/app/packages/web',
      progress: (line) => {
        lines.push(line);
      },
      stream: {
        stdout: collect(output),
        stderr: collect(output),
      },
      environment: { PATH: '/bin' },
      token: 'tok-1',
      startedFile,
      clock: () => 1000,
      watch: { every: noTimer },
      ...over,
    },
  };
}

describe('runCommandUnderLock', () => {
  it('runs the command under the lock, streamed, as its own process group', async () => {
    const { exec, calls } = machine({});
    const { options: given, output } = options(exec);
    const run = await runCommandUnderLock(given);
    expect(run).toMatchObject({
      outcome: 'ran',
      result: { code: 0 },
      lock: { queuedMs: 0, heldMs: 0, depthOnArrival: 0 },
    });
    const locked = calls.at(-1);
    expect(locked?.command).toBe('lockf');
    expect(locked?.args.slice(0, 7)).toEqual([
      '-k',
      '-s',
      '-t',
      '600',
      lockPath,
      'sh',
      '-c',
    ]);
    expect(locked?.args.slice(-3)).toEqual(['npm', 'run', 'build']);
    expect(locked).toMatchObject({ processGroup: true, isStreamed: true });
    expect(output).toEqual(['out']);
    expect(run).not.toHaveProperty('lock.holderOnArrival');
  });

  it('tells the command it holds the lock, through its environment', async () => {
    const { exec, calls } = machine({});
    await runCommandUnderLock(options(exec).options);
    expect(calls.at(-1)?.env).toEqual({
      PATH: '/bin',
      [LOCK_HELD_VARIABLE]: lockPath,
    });
  });

  it('passes the command’s exit code through, 75 included once it ran', async () => {
    const { exec } = machine({ commandCode: 75 });
    expect(await runCommandUnderLock(options(exec).options)).toMatchObject({
      outcome: 'ran',
      result: { code: 75 },
    });
  });

  it('reads a 75 whose shim never ran as a lock timeout, naming the holder', async () => {
    const { exec } = machine({ busy: true, timesOut: true });
    const { options: given, lines } = options(exec);
    const run = await runCommandUnderLock(given);
    expect(run).toMatchObject({
      outcome: 'lock-timeout',
      holding: 'another checkout holds it',
    });
    expect(run).not.toHaveProperty('result');
    expect(run).toMatchObject({
      lock: { holderOnArrival: 'another checkout holds it', depthOnArrival: 0 },
    });
    expect(lines[0]).toBe(
      'guardrails: waiting for the gate lock (up to 600s): another checkout holds it.',
    );
  });

  it('reports a start mark it could not write, never a lock timeout', async () => {
    const { exec } = machine({ markFails: true });
    expect(await runCommandUnderLock(options(exec).options)).toEqual({
      outcome: 'no-start-mark',
      startedFile,
      lock: { queuedMs: 0, heldMs: 0, depthOnArrival: 0 },
    });
  });

  it('passes a 73 through once the command ran', async () => {
    const { exec } = machine({ commandCode: 73 });
    expect(await runCommandUnderLock(options(exec).options)).toMatchObject({
      outcome: 'ran',
      result: { code: 73 },
    });
  });

  it('stops watching the wait once the locked run settles', async () => {
    const { exec } = machine({ busy: true });
    let stops = 0;
    const stop = (): void => {
      stops += 1;
    };
    const { options: given } = options(exec, {
      watch: { every: () => stop },
    });
    await runCommandUnderLock(given);
    expect(stops).toBe(1);
  });

  it('tries once without waiting at --timeout=0, and never runs the command', async () => {
    const { exec, calls } = machine({ busy: true });
    const { options: given } = options(exec, { waitSeconds: 0 });
    expect(await runCommandUnderLock(given)).toEqual({
      outcome: 'lock-timeout',
      holding: 'another checkout holds it',
      lock: {
        queuedMs: 0,
        heldMs: 0,
        holderOnArrival: 'another checkout holds it',
        depthOnArrival: 0,
      },
    });
    expect(calls.some((call) => call.args.includes('npm'))).toBe(false);
  });

  it('deletes the holder file it wrote, and keeps one another run wrote', async () => {
    const own = machine({});
    await runCommandUnderLock(options(own.exec).options);
    expect(existsSync(`${lockPath}.holder.json`)).toBe(false);
    expect(existsSync(startedFile)).toBe(false);
    const foreign = machine({ holderToken: 'someone-else' });
    await runCommandUnderLock(options(foreign.exec).options);
    expect(readFileSync(`${lockPath}.holder.json`, 'utf8')).toContain(
      'someone-else',
    );
  });

  it('runs unserialized, and says so, with no locker on the machine', async () => {
    const { exec, calls } = machine({ hasLocker: false });
    const { options: given, lines } = options(exec);
    expect(await runCommandUnderLock(given)).toMatchObject({
      outcome: 'unserialized',
      result: { code: 0 },
    });
    expect(calls.at(-1)).toMatchObject({
      command: 'npm',
      args: ['run', 'build'],
      env: { PATH: '/bin' },
      processGroup: true,
      isStreamed: true,
    });
    expect(lines).toEqual([
      'guardrails: no lockf or flock on this machine — running npm unserialized. Install util-linux (flock) to serialize it.',
    ]);
  });

  it('runs unserialized, and names the fix, when the lock file cannot be opened', async () => {
    const { exec, calls } = machine({});
    const { options: given, lines } = options(exec, {
      lock: {
        path: path.join(directory, 'no', 'gate.lock'),
        config: lockConfig,
      },
    });
    expect(await runCommandUnderLock(given)).toMatchObject({
      outcome: 'unserialized',
    });
    expect(calls.at(-1)?.command).toBe('npm');
    expect(lines[0]).toContain('could not open the gate lock at');
    expect(lines[0]).toContain('GUARDRAILS_GATE_LOCK');
  });

  it('runs the command directly when this process already holds the lock', async () => {
    const { exec, calls } = machine({});
    const { options: given, lines } = options(exec, {
      environment: { [LOCK_HELD_VARIABLE]: lockPath },
    });
    expect(await runCommandUnderLock(given)).toMatchObject({
      outcome: 'already-held',
      result: { code: 0 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'npm', processGroup: true });
    expect(lines).toEqual([
      `guardrails: the gate lock (${lockPath}) is already held by the guardrails lock this runs under — running npm without queueing for it.`,
    ]);
  });

  it('still queues when the lock held is another one', async () => {
    const { exec, calls } = machine({});
    await runCommandUnderLock(
      options(exec, { environment: { [LOCK_HELD_VARIABLE]: '/other.lock' } })
        .options,
    );
    expect(calls.at(-1)?.command).toBe('lockf');
  });

  it('runs in the directory it was given', async () => {
    const cwds: (string | undefined)[] = [];
    const { exec } = machine({});
    const recording: Exec = (command, args, given) => {
      cwds.push(given?.cwd);
      return exec(command, args, given);
    };
    await runCommandUnderLock(options(recording).options);
    expect(cwds.at(-1)).toBe('/dev/app/packages/web');
  });

  it('times the wait and the hold from the start mark', async () => {
    const times = [1000, 9000];
    const { exec } = machine({});
    const { options: given } = options(exec, {
      clock: () => times.shift() ?? 0,
      startedAt: () => 4000,
    });
    expect(await runCommandUnderLock(given)).toMatchObject({
      lock: { queuedMs: 3000, heldMs: 5000 },
    });
  });

  it('logs whole milliseconds, though a start mark’s mtime has fractions', async () => {
    const times = [1000, 9000];
    const { exec } = machine({});
    const { options: given } = options(exec, {
      clock: () => times.shift() ?? 0,
      startedAt: () => 4000.6,
    });
    expect(await runCommandUnderLock(given)).toMatchObject({
      lock: { queuedMs: 3001, heldMs: 4999 },
    });
  });
});

describe('runCommandUnderLock with a real locker', () => {
  it('holds the lock for the command, names it, and frees it after', async () => {
    // macOS has lockf and every Linux this runs on has flock.
    const locker = (await detectLocker(spawnExec)) ?? expect.unreachable();
    const holderFile = `${lockPath}.holder.json`;
    const output: string[] = [];
    const run = await runCommandUnderLock({
      exec: spawnExec,
      lock: { path: lockPath, config: lockConfig },
      argv: ['sh', '-c', `cat "${holderFile}"; exit 7`],
      waitSeconds: 5,
      repoRoot: '/dev/app',
      cwd: directory,
      progress: ignore,
      stream: {
        stdout: collect(output),
        stderr: collect(output),
      },
      environment: process.env,
    });
    expect(run).toMatchObject({ outcome: 'ran', result: { code: 7 } });
    expect(JSON.parse(output.join(''))).toMatchObject({
      kind: 'lock',
      command: 'sh',
      repo: '/dev/app',
    });
    expect(existsSync(holderFile)).toBe(false);
    const probe = await spawnExec(locker, [
      ...(locker === 'lockf' ? ['-k', '-s', '-t', '0'] : ['-w', '0']),
      lockPath,
      'true',
    ]);
    expect(probe.code).toBe(0);
  });
});

describe('parseLockArguments', () => {
  it('takes everything after -- as the command, flags before it', () => {
    expect(
      parseLockArguments(['--timeout=60', '--', 'npm', 'run', 'build']),
    ).toEqual({ timeoutSeconds: 60, argv: ['npm', 'run', 'build'] });
  });

  it('leaves the timeout to the default when none is given', () => {
    const parsed = parseLockArguments(['--', 'make']);
    expect(parsed).toEqual({ argv: ['make'] });
    expect(parsed).not.toHaveProperty('timeoutSeconds');
  });

  it('takes --timeout=0 as try once', () => {
    expect(parseLockArguments(['--timeout=0', '--', 'make'])).toEqual({
      timeoutSeconds: 0,
      argv: ['make'],
    });
  });

  it('reads no flag after --: those are the command’s own', () => {
    expect(
      parseLockArguments(['--', 'stryker', 'run', '--timeout=5', '--']),
    ).toEqual({ argv: ['stryker', 'run', '--timeout=5', '--'] });
  });

  it('refuses a command line with no --', () => {
    expect(parseLockArguments(['npm', 'test'])).toEqual({
      error: 'put the command after --: guardrails lock -- <cmd> [args…]',
    });
  });

  it('refuses an empty command', () => {
    expect(parseLockArguments(['--timeout=5', '--'])).toEqual({
      error: 'put the command after --: guardrails lock -- <cmd> [args…]',
    });
  });

  it.each(['--timeout=', '--timeout=-1', '--timeout=1.5', '--timeout=1m'])(
    'refuses %s, which is not a whole number of seconds',
    (timeout) => {
      expect(parseLockArguments([timeout, '--', 'make'])).toEqual({
        error: `${timeout} is not a whole number of seconds`,
      });
    },
  );

  it('refuses a flag it does not know', () => {
    expect(parseLockArguments(['--wait=5', '--', 'make'])).toEqual({
      error: 'unknown flag --wait=5 (only --timeout=<seconds>)',
    });
  });
});

describe('commandIdentity', () => {
  it('names the command by its basename and hashes the whole line', () => {
    const identity = commandIdentity(['/usr/local/bin/npm', 'run', 'build']);
    expect(identity.command).toBe('npm');
    expect(identity.commandHash).toMatch(/^[\da-f]{16}$/);
  });

  it('gives one command line the same hash every time', () => {
    expect(commandIdentity(['npm', 'test']).commandHash).toBe(
      commandIdentity(['npm', 'test']).commandHash,
    );
  });

  it('tells command lines apart, argument boundaries included', () => {
    const hashes = new Set(
      [
        ['npm', 'test'],
        ['npm', 'run', 'test'],
        ['npm', 'run test'],
        ['npm', 'runtest'],
      ].map((argv) => commandIdentity(argv).commandHash),
    );
    expect(hashes.size).toBe(4);
  });

  it('is the sha256 of the argv as JSON, cut to 16 hex', () => {
    // sha256('["make"]'), precomputed: the hash is a stable, documented
    // function of the command line, so two machines' logs can be joined.
    expect(commandIdentity(['make']).commandHash).toBe('840a81f15ea72b48');
  });

  it('carries no argument value', () => {
    const identity = commandIdentity(['deploy', '--token=secret']);
    expect(JSON.stringify(identity)).not.toContain('secret');
  });
});

/**
A machine whose checkout belongs to the clone `app-clone` (#236).
*/
const inClone: Exec = (command, args, given) =>
  command === 'git' && args.includes('--git-common-dir')
    ? Promise.resolve({ stdout: '/dev/app-clone/.git\n', stderr: '', code: 0 })
    : machine({}).exec(command, args, given);

/**
What `lockCommand` printed and logged, and how it exited.
*/
function cli(exec: Exec, over: Partial<LockCommandDependencies> = {}) {
  const out: string[] = [];
  const errors: string[] = [];
  const dependencies: LockCommandDependencies = {
    exec,
    cwd: directory,
    env: { GUARDRAILS_GATE_LOCK: lockPath, PATH: '/bin' },
    stdout: collect(out),
    stderr: collect(errors),
    onTermination: noTimer,
    ...over,
  };
  const rows = () => {
    const file = `${lockPath}.runs.jsonl`;
    return existsSync(file) ? parseRuns(readFileSync(file, 'utf8')) : [];
  };
  return { dependencies, out, errors, rows };
}

/**
A machine with no locker where `make` cannot be started.
*/
const unstartableMake: Exec = (command, args, given) =>
  command === 'make'
    ? Promise.resolve({
        stdout: '',
        stderr: 'spawn make ENOENT',
        code: 1,
        spawnFailed: true,
      })
    : machine({ hasLocker: false }).exec(command, args, given);

/**
A free lock, where `make` is killed by SIGKILL once it runs.
*/
const makeKilled: Exec = (command, args, given) =>
  command === 'lockf' && args.includes('make')
    ? Promise.resolve({ stdout: '', stderr: '', code: 0, signal: 'SIGKILL' })
    : machine({}).exec(command, args, given);

describe('lockCommand', () => {
  it('runs the command under the lock and exits with its code', async () => {
    const { exec, calls } = machine({ commandCode: 3 });
    const { dependencies, out, errors } = cli(exec);
    expect(await lockCommand(dependencies, ['--', 'npm', 'test'])).toBe(3);
    expect(out).toEqual(['out']);
    expect(errors).toEqual([]);
    const locked = calls.find((call) => call.args.includes('npm'));
    expect(locked?.args.slice(0, 5)).toEqual([
      '-k',
      '-s',
      '-t',
      '10800',
      lockPath,
    ]);
  });

  it('logs one lock row, naming the command but not its arguments', async () => {
    const { exec } = machine({});
    const { dependencies, rows } = cli(exec);
    await lockCommand(dependencies, ['--', '/usr/bin/npm', 'test', 'secret']);
    expect(rows()).toEqual([
      expect.objectContaining({
        kind: 'lock',
        repo: path.basename(directory),
        command: 'npm',
        commandHash: commandIdentity(['/usr/bin/npm', 'test', 'secret'])
          .commandHash,
        exitCode: 0,
        outcome: 'ran',
        lock: expect.objectContaining({ depthOnArrival: 0 }),
      }),
    ]);
    expect(JSON.stringify(rows())).not.toContain('secret');
  });

  it('names the clone the checkout belongs to, on a run that ends and one that is killed (#236)', async () => {
    const ended = cli(inClone);
    await lockCommand(ended.dependencies, ['--', 'make']);
    expect(ended.rows()).toMatchObject([{ project: 'app-clone' }]);

    let stop: (signal: 'SIGINT' | 'SIGTERM') => void = ignore;
    let isRunning = false;
    const pending: Exec = (command, args, given) => {
      if (command === 'lockf' && args.includes('make')) {
        isRunning = true;
        return new Promise(() => {
          // Never settles: the run is stopped part-way.
        });
      }
      return inClone(command, args, given);
    };
    const killed = cli(pending, {
      exit: ignore,
      onTermination: (handler) => {
        stop = handler;
        return ignore;
      },
    });
    void lockCommand(killed.dependencies, ['--', 'make']);
    await waitFor(() => isRunning);
    stop('SIGTERM');
    expect(killed.rows()).toMatchObject([
      { project: 'app-clone' },
      { outcome: 'killed', project: 'app-clone' },
    ]);
  });

  it('waits the configured push wait by default, and --timeout when given', async () => {
    writeFileSync(
      path.join(directory, 'guardrails.config.json'),
      JSON.stringify({ mutationLock: { pushWaitSeconds: 99 } }),
    );
    const first = machine({});
    await lockCommand(cli(first.exec).dependencies, ['--', 'make']);
    expect(first.calls.at(-1)?.args.slice(2, 4)).toEqual(['-t', '99']);
    const second = machine({});
    await lockCommand(cli(second.exec).dependencies, [
      '--timeout=7',
      '--',
      'make',
    ]);
    expect(second.calls.at(-1)?.args.slice(2, 4)).toEqual(['-t', '7']);
  });

  it('exits 75 with the lock-timeout marker when the wait runs out', async () => {
    const { exec } = machine({ busy: true });
    const { dependencies, errors, rows } = cli(exec);
    expect(await lockCommand(dependencies, ['--timeout=0', '--', 'make'])).toBe(
      75,
    );
    expect(errors.at(-1)).toBe(
      `${LOCK_TIMEOUT_MARKER} after 0s (another checkout holds it).\n`,
    );
    expect(rows()).toMatchObject([
      { outcome: 'lock-timeout', exitCode: 75, command: 'make' },
    ]);
  });

  it('exits 73, naming the start mark, when it could not be written', async () => {
    const { exec } = machine({ markFails: true });
    const { dependencies, errors, rows } = cli(exec);
    expect(await lockCommand(dependencies, ['--', 'make'])).toBe(73);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^guardrails lock: could not write the start mark at .+\.started — make was not run\. Point TMPDIR at a writable directory\.\n$/u,
    );
    expect(errors[0]).not.toContain(LOCK_TIMEOUT_MARKER);
    expect(rows()).toMatchObject([
      { outcome: 'no-start-mark', exitCode: 73, command: 'make' },
    ]);
  });

  it('prints the lock’s own lines to stderr', async () => {
    const { exec } = machine({ hasLocker: false });
    const { dependencies, errors, rows } = cli(exec);
    expect(await lockCommand(dependencies, ['--', 'make'])).toBe(0);
    expect(errors).toEqual([
      'guardrails: no lockf or flock on this machine — running make unserialized. Install util-linux (flock) to serialize it.\n',
    ]);
    expect(rows()).toMatchObject([{ outcome: 'unserialized' }]);
    expect(rows()[0]).not.toHaveProperty('lock');
  });

  it('exits 127, and says why, for a program that could not be started', async () => {
    const { dependencies, errors, rows } = cli(unstartableMake);
    expect(await lockCommand(dependencies, ['--', 'make'])).toBe(127);
    expect(errors.at(-1)).toBe(
      'guardrails lock: could not start make (spawn make ENOENT).\n',
    );
    expect(rows()).toMatchObject([{ exitCode: 127 }]);
  });

  it('exits as a shell would for a command killed by a signal', async () => {
    const { dependencies, rows } = cli(makeKilled);
    expect(await lockCommand(dependencies, ['--', 'make'])).toBe(137);
    expect(rows()).toMatchObject([
      { exitCode: 137, signal: 'SIGKILL', outcome: 'ran' },
    ]);
  });

  it('logs a killed row and exits as a shell would when it is stopped', async () => {
    let stop: (signal: 'SIGINT' | 'SIGTERM') => void = ignore;
    let released = 0;
    const release = (): void => {
      released += 1;
    };
    const exits: number[] = [];
    let isRunning = false;
    const pending: Exec = (command, args, given) => {
      if (command === 'lockf' && args.includes('make')) {
        isRunning = true;
        return new Promise(() => {
          // Never settles: the run is stopped part-way.
        });
      }
      return machine({}).exec(command, args, given);
    };
    const { dependencies, rows } = cli(pending, {
      exit: (code) => {
        exits.push(code);
      },
      onTermination: (handler) => {
        stop = handler;
        return release;
      },
    });
    void lockCommand(dependencies, ['--', 'make']);
    await waitFor(() => isRunning);
    expect(rows()).toEqual([]);
    stop('SIGTERM');
    expect(exits).toEqual([143]);
    expect(rows()).toMatchObject([
      {
        kind: 'lock',
        command: 'make',
        exitCode: 143,
        signal: 'SIGTERM',
        outcome: 'killed',
        lock: { depthOnArrival: 0 },
      },
    ]);
    expect(released).toBe(0);
  });

  it('stops listening for signals once the command is done', async () => {
    let released = 0;
    const release = (): void => {
      released += 1;
    };
    const { dependencies } = cli(machine({}).exec, {
      onTermination: () => release,
    });
    await lockCommand(dependencies, ['--', 'make']);
    expect(released).toBe(1);
  });

  it('logs nothing while still asking for a locker, and keeps another holder file', async () => {
    const stryker = JSON.stringify({ repo: '/r', rung: 'push', pid: 1 });
    writeFileSync(`${lockPath}.holder.json`, stryker);
    const { exec, isReached } = pendingAt(
      (command, args) => command === 'sh' && args.at(-1) === 'command -v lockf',
    );
    const { dependencies, rows, stop } = stoppable(exec);
    void lockCommand(dependencies, ['--', 'make']);
    await waitFor(isReached);
    stop('SIGINT');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ exitCode: 130, outcome: 'killed' });
    expect(rows()[0]).not.toHaveProperty('lock');
    expect(readFileSync(`${lockPath}.holder.json`, 'utf8')).toBe(stryker);
  });

  it('logs the queue so far for a run stopped while it asks if the lock is busy', async () => {
    const { exec, isReached } = pendingAt(
      (command, args) => command === 'lockf' && args.at(-1) === 'true',
    );
    const { dependencies, rows, stop } = stoppable(exec);
    void lockCommand(dependencies, ['--', 'make']);
    await waitFor(isReached);
    stop('SIGINT');
    expect(rows()).toMatchObject([
      { outcome: 'killed', lock: { heldMs: 0, depthOnArrival: 0 } },
    ]);
  });

  it('logs the hold from the start mark, and removes it, for a run stopped mid-way', async () => {
    let mark = '';
    const { exec, isReached } = pendingAt(
      (command, args) => command === 'lockf' && args.includes('make'),
      (args) => {
        mark = args[9] ?? '';
        writeFileSync(mark, '');
        utimesSync(mark, 0, 0);
      },
    );
    const { dependencies, rows, stop } = stoppable(exec);
    void lockCommand(dependencies, ['--', 'make']);
    await waitFor(isReached);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    stop('SIGTERM');
    const [row] = rows();
    expect(row).toMatchObject({ outcome: 'killed', lock: { queuedMs: 0 } });
    expect(row?.kind === 'lock' && row.lock?.heldMs).toBeGreaterThanOrEqual(25);
    expect(mark).not.toBe('');
    expect(existsSync(mark)).toBe(false);
  });

  it('exits through process.exit by default when it is stopped', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    try {
      const { exec, isReached } = pendingAt(
        (command, args) => command === 'lockf' && args.includes('make'),
      );
      const { dependencies, stop } = stoppable(exec);
      const { exit: _exit, ...withoutExit } = dependencies;
      void lockCommand(withoutExit, ['--', 'make']);
      await waitFor(isReached);
      expect(() => {
        stop('SIGTERM');
      }).toThrow('exit 143');
      expect(exit).toHaveBeenCalledWith(143);
    } finally {
      exit.mockRestore();
    }
  });

  it('listens for SIGINT and SIGTERM on this process while the command runs', async () => {
    const before = [
      process.listenerCount('SIGINT'),
      process.listenerCount('SIGTERM'),
    ];
    let finish: () => void = ignore;
    let isRunning = false;
    const exec: Exec = (command, args, given) => {
      if (command === 'lockf' && args.includes('make')) {
        isRunning = true;
        return new Promise((resolve) => {
          finish = () => {
            resolve({ stdout: '', stderr: '', code: 0 });
          };
        });
      }
      return machine({}).exec(command, args, given);
    };
    const { onTermination: _default, ...dependencies } = cli(exec).dependencies;
    const run = lockCommand(dependencies, ['--', 'make']);
    await waitFor(() => isRunning);
    expect([
      process.listenerCount('SIGINT'),
      process.listenerCount('SIGTERM'),
    ]).toEqual(before.map((count) => count + 1));
    finish();
    await run;
    expect([
      process.listenerCount('SIGINT'),
      process.listenerCount('SIGTERM'),
    ]).toEqual(before);
  });

  it('says so on stderr when the run log cannot be written', async () => {
    const { exec } = machine({});
    const unwritable = path.join(directory, 'missing', 'gate.lock');
    const { dependencies, errors } = cli(exec, {
      env: { GUARDRAILS_GATE_LOCK: unwritable, PATH: '/bin' },
    });
    expect(await lockCommand(dependencies, ['--', 'make'])).toBe(0);
    expect(errors.at(-1)).toMatch(
      /^guardrails: could not write the run log \(.*ENOENT.*\)\.\n$/,
    );
  });

  it('exits 2 with the usage for a command line it cannot read', async () => {
    const { exec, calls } = machine({});
    const { dependencies, errors, rows } = cli(exec);
    expect(await lockCommand(dependencies, ['make'])).toBe(2);
    expect(errors).toEqual([
      'guardrails lock: put the command after --: guardrails lock -- <cmd> [args…]\n' +
        'usage: guardrails lock [--timeout=<seconds>] -- <cmd> [args…]\n',
    ]);
    expect(calls).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

/**
 * A free-lock machine where the first call `isPending` matches never settles,
 * so a test can stop the run there. `onReach` sees that call's args.
 */
function pendingAt(
  isPending: (command: string, args: string[]) => boolean,
  onReach: (args: string[]) => void = ignore,
) {
  let isReachedYet = false;
  const exec: Exec = (command, args, given) => {
    if (isPending(command, args)) {
      isReachedYet = true;
      onReach(args);
      return new Promise(() => {
        // Never settles: the run is stopped here.
      });
    }
    return machine({}).exec(command, args, given);
  };
  return { exec, isReached: () => isReachedYet };
}

/**
`cli`, with the termination handler captured so a test can stop the run.
*/
function stoppable(exec: Exec) {
  let handler: (signal: 'SIGINT' | 'SIGTERM') => void = ignore;
  const exits: number[] = [];
  const harness = cli(exec, {
    exit: (code) => {
      exits.push(code);
    },
    onTermination: (registered) => {
      handler = registered;
      return ignore;
    },
  });
  return {
    ...harness,
    exits,
    stop: (signal: 'SIGINT' | 'SIGTERM') => {
      handler(signal);
    },
  };
}

async function flushTurns(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function waitFor(isReady: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !isReady(); turn += 1) {
    await flushTurns();
  }
}
