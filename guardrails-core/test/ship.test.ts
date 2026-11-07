import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Exec, ExecResult } from '../src/exec.js';
import {
  LOCK_TIMEOUT_MARKER,
  NOT_INSTALLED_MARKER,
  classifyPushFailure,
  ship,
  type ShipOptions,
  shipSummary,
  writeShipStatus,
} from '../src/ship.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-ship-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });
const failed = (stderr: string, code = 1): ExecResult => ({
  stdout: '',
  stderr,
  code,
});

const PR_JSON = JSON.stringify({
  number: 42,
  url: 'https://github.com/o/r/pull/42',
});

interface Call {
  line: string;
  cwd: string | undefined;
}

/**
 * A git + gh whose every answer is `answers[<command line prefix>]`, else a
 * success with no output. Records every call.
 */
function fakeExec(answers: Record<string, ExecResult | ExecResult[]>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = (command, args, options) => {
    const line = [command, ...args].join(' ');
    calls.push({ line, cwd: options?.cwd });
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    const answer = key === undefined ? ok('') : answers[key];
    const result = Array.isArray(answer)
      ? (answer.shift() ?? ok(''))
      : (answer ?? ok(''));
    return Promise.resolve(result);
  };
  return { exec, calls };
}

const HAPPY: Record<string, ExecResult | ExecResult[]> = {
  'git rev-parse --abbrev-ref HEAD': ok('feat/x\n'),
  'gh pr view': ok(PR_JSON),
  'gh pr checks 42 --json': ok(
    JSON.stringify([
      { name: 'build', bucket: 'pass' },
      { name: 'lint', bucket: 'skipping' },
    ]),
  ),
};

function options(exec: Exec, over: Partial<ShipOptions> = {}): ShipOptions {
  return {
    exec,
    repoRoot: root,
    baseBranch: 'main',
    now: () => new Date('2026-10-12T12:00:00.000Z'),
    delay: () => Promise.resolve(),
    ...over,
  };
}

describe('ship: gh is checked before anything is pushed', () => {
  it('stops before pushing when gh is not installed', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh auth status': {
        stdout: '',
        stderr: 'spawn gh ENOENT',
        code: 1,
        spawnFailed: true,
      },
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('gh (GitHub CLI) is not installed');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('stops before pushing when gh is not logged in', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail).toContain('gh auth login');
    expect(status.tail).toContain('You are not logged into any GitHub hosts.');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('asks gh in the repository it ships', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const asked = calls.find((call) => call.line === 'gh auth status');
    expect(asked?.cwd).toBe(root);
    expect(
      calls.findIndex((call) => call.line === 'gh auth status'),
    ).toBeLessThan(calls.findIndex((call) => call.line.startsWith('git push')));
  });
});

describe('ship: the body file is checked before anything is pushed', () => {
  it('stops before pushing when the body file does not exist', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const missing = path.join(root, 'missing.md');
    const status = await ship(options(exec, { bodyFile: missing }));
    expect(status).toMatchObject({ state: 'error', pr: null, url: null });
    expect(status.tail).toBe(
      `guardrails ship: --body-file ${missing} does not exist (or is not ` +
        'readable). Nothing was pushed.',
    );
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });

  it('pushes as before when the body file is readable', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const body = path.join(root, 'pr.md');
    writeFileSync(body, 'the body\n');
    const status = await ship(options(exec, { bodyFile: body }));
    expect(status.state).toBe('green');
    expect(calls.map((call) => call.line)).toContain('git push -u origin HEAD');
  });

  it('checks gh before the body file', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh auth status': failed('You are not logged into any GitHub hosts.'),
    });
    const missing = path.join(root, 'missing.md');
    const status = await ship(options(exec, { bodyFile: missing }));
    expect(status.tail).toContain('gh auth login');
  });
});

async function stateOf(exec: Exec): Promise<string> {
  const status = await ship(options(exec));
  return status.state;
}

describe('ship: the happy path', () => {
  it('pushes, finds the PR, watches its checks and reports green', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'green',
      branch: 'feat/x',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      failing: [],
      finishedAt: '2026-10-12T12:00:00.000Z',
    });
    const lines = calls.map((call) => call.line);
    expect(lines).toContain('git push -u origin HEAD');
    expect(lines).toContain('gh pr checks 42 --watch');
    expect(lines.some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('runs the steps in order: push, then the PR, then its checks', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    const index = (prefix: string) =>
      calls.findIndex((call) => call.line.startsWith(prefix));
    expect(index('git push')).toBeLessThan(index('gh pr view'));
    expect(index('gh pr view')).toBeLessThan(index('gh pr checks 42 --watch'));
    expect(index('gh pr checks 42 --watch')).toBeLessThan(
      index('gh pr checks 42 --json'),
    );
  });

  it('keeps the tail of the watch output', async () => {
    const watch = Array.from({ length: 60 }, (_, line) => `line ${line}`);
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': ok(`${watch.join('\n')}\n`),
    });
    const status = await ship(options(exec));
    const tail = status.tail.split('\n');
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe('line 20');
    expect(tail.at(-1)).toBe('line 59');
  });
});

describe('ship: finding or creating the pull request', () => {
  it('creates one with --fill when none exists', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('green');
    expect(calls.map((call) => call.line)).toContain(
      'gh pr create --base main --fill',
    );
  });

  it('creates one from a body file, titled by the last commit', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
      'git log -1 --format=%s': ok('feat: the thing\n'),
    });
    const body = path.join(root, 'pr.md');
    writeFileSync(body, 'the body\n');
    await ship(options(exec, { bodyFile: body }));
    expect(calls.map((call) => call.line)).toContain(
      `gh pr create --base main --title feat: the thing --body-file ${body}`,
    );
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it('is an error when the pull request cannot be created', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'gh pr create': {
        stdout: '\n',
        stderr: 'GraphQL: something broke',
        code: 1,
      },
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: null, url: null });
    expect(status.tail).toBe('GraphQL: something broke');
  });

  it('is an error when the pull request cannot be read back', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': [failed('none'), ok('not json')],
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it.each([
    ['a number that is not a number', { number: '42', url: 'u' }],
    ['a url that is not a string', { number: 42, url: 7 }],
    ['null', null],
  ])('rejects a pull request view with %s', async (_label, view) => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': [ok(JSON.stringify(view)), failed('x')],
      'gh pr create': failed('already exists'),
    });
    expect(await stateOf(exec)).toBe('error');
  });
});

/**
A branch with no PR yet, which gh opens; fresh per test because fakeExec consumes the list.
*/
function newPr(): Record<string, ExecResult | ExecResult[]> {
  return {
    ...HAPPY,
    'gh pr view': [failed('no pull requests found'), ok(PR_JSON)],
  };
}

describe('ship: attaching media to the pull request', () => {
  const ATTACH = ['/r/demo.mp4', '/r/after.png#The fixed state'];

  it('opens a new PR with the attachments', async () => {
    const { exec, calls } = fakeExec(newPr());
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', warnings: [] });
    expect(calls.map((call) => call.line)).toContain(
      'gh pr create --base main --fill --attach /r/demo.mp4 --attach /r/after.png#The fixed state',
    );
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });

  it('comments them once on a PR that is already open, before watching', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', warnings: [] });
    const lines = calls.map((call) => call.line);
    const comments = lines.filter((line) => line.startsWith('gh pr comment'));
    expect(comments).toEqual([
      'gh pr comment 42 --attach /r/demo.mp4 --attach /r/after.png#The fixed state',
    ]);
    expect(lines.indexOf(comments[0] ?? '')).toBeLessThan(
      lines.findIndex((line) => line.startsWith('gh pr checks')),
    );
  });

  it('keeps the CI outcome and warns when the comment fails', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr comment': failed('uploading demo.mp4\nHTTP 413: too large'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status.state).toBe('green');
    expect(status.warnings).toEqual([
      'attachments not posted: HTTP 413: too large',
    ]);
  });

  it('carries on with the PR gh opened even when an upload failed', async () => {
    const { exec } = fakeExec({
      ...newPr(),
      'gh pr create': failed('created\nfailed to upload demo.mp4'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'green', pr: 42 });
    expect(status.warnings).toEqual([
      'attachments not posted: failed to upload demo.mp4',
    ]);
  });

  it('warns with the last line of gh output, not a blank or an earlier line', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr comment': failed('uploading\nretrying\nHTTP 500: boom\n'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status.warnings).toEqual(['attachments not posted: HTTP 500: boom']);
  });

  it('reports the read-back failure when gh opened the PR but it cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('view broke'),
      'gh pr create': ok('https://github.com/o/r/pull/42'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe('view broke');
  });

  it('reports the create failure when an upload failed and the PR cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('view broke'),
      'gh pr create': failed('upload exploded'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', pr: null });
    expect(status.tail).toBe('upload exploded');
  });

  it('carries no warnings when gh is unavailable or HEAD is not shippable', async () => {
    const unavailable = fakeExec({
      ...HAPPY,
      'gh auth status': failed('not logged in'),
    });
    const notShippable = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    for (const { exec } of [unavailable, notShippable]) {
      const status = await ship(options(exec, { attach: ATTACH }));
      expect(status.state).toBe('error');
      expect(status.warnings).toEqual([]);
    }
  });

  it('is still an error when a PR without attachments cannot be opened', async () => {
    const { exec } = fakeExec({
      ...newPr(),
      'gh pr create': failed('GraphQL: something broke'),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: null, warnings: [] });
  });

  it('posts nothing and warns nothing without --attach', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec));
    expect(status.warnings).toEqual([]);
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });

  it('warns nothing on a push that failed before any PR step', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git push': failed('fatal: no remote'),
    });
    const status = await ship(options(exec, { attach: ATTACH }));
    expect(status).toMatchObject({ state: 'error', warnings: [] });
    expect(calls.some((call) => call.line.startsWith('gh pr comment'))).toBe(
      false,
    );
  });
});

describe('ship: the branch', () => {
  it.each([
    ['a detached HEAD', ok('HEAD\n')],
    ['the base branch itself', ok('main\n')],
    ['no branch at all', failed('fatal: not a git repository', 128)],
  ])('refuses %s, before pushing anything', async (_label, answer) => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': answer,
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });
});

describe('ship: a push that did not go through', () => {
  const GATE_BLOCK = failed(
    'src/a.ts:1 [no-console]\nguardrails: push blocked — resolve violations or run guardrails verify.\nerror: failed to push some refs',
  );

  it('reports the gate block, with the hook output', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('no pull requests found'),
      'git push': GATE_BLOCK,
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: null,
      url: null,
      failing: [],
    });
    expect(status.tail).toContain('src/a.ts:1 [no-console]');
    // A blocked push only looks the pull request up: it never opens one.
    const lines = calls.map((call) => call.line);
    expect(lines.some((line) => line.startsWith('gh pr create'))).toBe(false);
    expect(lines.some((line) => line.startsWith('gh pr checks'))).toBe(false);
  });

  it('still names the PR the blocked branch already has', async () => {
    const { exec, calls } = fakeExec({ ...HAPPY, 'git push': GATE_BLOCK });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      failing: [],
    });
    expect(status.tail).toContain('src/a.ts:1 [no-console]');
    const view = calls.find((call) => call.line.startsWith('gh pr view'));
    expect(view?.line).toBe('gh pr view feat/x --json number,url');
    expect(view?.cwd).toBe(root);
    expect(calls.some((call) => call.line.startsWith('gh pr create'))).toBe(
      false,
    );
  });

  it('keeps the push state and tail when the PR lookup fails', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': failed('HTTP 502: Bad Gateway'),
      'git push': failed(`${LOCK_TIMEOUT_MARKER} after 10800s`),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'lock-timeout',
      pr: null,
      url: null,
      tail: `${LOCK_TIMEOUT_MARKER} after 10800s`,
    });
  });

  it('ignores a lookup that printed something other than a PR', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr view': ok('not json'),
      'git push': GATE_BLOCK,
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'gate-blocked',
      pr: null,
      url: null,
    });
  });

  it('reports a lock timeout apart from a block', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(`${LOCK_TIMEOUT_MARKER} after 10800s\nerror: failed`),
    });
    expect(await stateOf(exec)).toBe('lock-timeout');
  });

  it('reports any other failure as an error', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed('! [rejected] HEAD -> feat/x (non-fast-forward)'),
    });
    expect(await stateOf(exec)).toBe('error');
  });
});

describe('ship: a branch rewritten since its last push', () => {
  const HINT =
    'guardrails ship: the branch was rewritten since its last push ' +
    '(rebased?); re-run with --force-with-lease';

  it.each([
    '! [rejected]        HEAD -> feat/x (non-fast-forward)\nerror: failed to push some refs',
    '! [rejected]        HEAD -> feat/x (stale info)\nerror: failed to push some refs',
    '! [rejected]        HEAD -> feat/x (fetch first)\nerror: failed to push some refs',
  ])('names --force-with-lease as the fix for %j', async (stderr) => {
    const { exec } = fakeExec({ ...HAPPY, 'git push': failed(stderr) });
    const status = await ship(options(exec));
    expect(status.state).toBe('error');
    expect(status.tail.split('\n').at(-1)).toBe(HINT);
    expect(status.tail).toContain('[rejected]');
  });

  it('adds no hint to a push the gate blocked', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed(
        'guardrails: push blocked — resolve violations or run guardrails verify.',
      ),
    });
    const status = await ship(options(exec));
    expect(status.state).toBe('gate-blocked');
    expect(status.tail).not.toContain('--force-with-lease');
  });

  it('adds no hint to any other failed push', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': failed('fatal: unable to access remote'),
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('fatal: unable to access remote');
  });

  it('pushes plainly by default', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    await ship(options(exec));
    expect(calls.find((call) => call.line.startsWith('git push'))?.line).toBe(
      'git push -u origin HEAD',
    );
  });

  it('pushes --force-with-lease when asked', async () => {
    const { exec, calls } = fakeExec(HAPPY);
    const status = await ship(options(exec, { forceWithLease: true }));
    expect(status.state).toBe('green');
    expect(calls.find((call) => call.line.startsWith('git push'))?.line).toBe(
      'git push --force-with-lease -u origin HEAD',
    );
  });

  it('still refuses to ship the base branch with --force-with-lease', async () => {
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    const status = await ship(options(exec, { forceWithLease: true }));
    expect(status.state).toBe('error');
    expect(calls.some((call) => call.line.startsWith('git push'))).toBe(false);
  });
});

describe('classifyPushFailure', () => {
  it('reads the marker on stdout too', () => {
    expect(
      classifyPushFailure({ stdout: LOCK_TIMEOUT_MARKER, stderr: '', code: 1 }),
    ).toBe('lock-timeout');
    expect(
      classifyPushFailure({
        stdout: 'guardrails: push blocked',
        stderr: '',
        code: 1,
      }),
    ).toBe('gate-blocked');
  });

  it('prefers the lock timeout, which also blocks the push', () => {
    expect(
      classifyPushFailure(
        failed(`${LOCK_TIMEOUT_MARKER}\nguardrails: push blocked`),
      ),
    ).toBe('lock-timeout');
  });

  it('reports an uninstalled checkout as an error, not a gate block', () => {
    expect(
      classifyPushFailure(
        failed(
          `guardrails: push blocked — ${NOT_INSTALLED_MARKER}. Run 'npm ci' here, then push again.`,
        ),
      ),
    ).toBe('error');
  });
});

describe('ship: CI', () => {
  it('reports red checks by name', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed('X build\nX e2e'),
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'fail' },
          { name: 'lint', bucket: 'pass' },
          { name: 'e2e', bucket: 'cancel' },
        ]),
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'ci-red',
      failing: ['build', 'e2e'],
    });
    expect(status.tail).toContain('X e2e');
  });

  it('is an error when a check is still pending after the watch', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pending' }]),
      ),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('watches again when checks register just after the watch gave up', async () => {
    // The race seen on dialed.run #191: the watch ran before CI registered
    // anything and exited with "no checks reported", then the listing a moment
    // later found every check pending. That watch never watched, so a pending
    // check there means "start watching", not "the watch broke".
    const delays: number[] = [];
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': [
        failed("no checks reported on the 'feat/x' branch"),
        ok('build\tpass'),
      ],
      'gh pr checks 42 --json': [
        ok(JSON.stringify([{ name: 'build', bucket: 'pending' }])),
        ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([15_000]);
    expect(
      calls.filter((call) => call.line === 'gh pr checks 42 --watch'),
    ).toHaveLength(2);
  });

  it('does not wait again when the checks had already settled', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed(
        "no checks reported on the 'feat/x' branch",
      ),
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pass' }]),
      ),
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([]);
  });

  it('gives up as an error when checks stay pending past the registration wait', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': failed(
        "no checks reported on the 'feat/x' branch",
      ),
      'gh pr checks 42 --json': ok(
        JSON.stringify([{ name: 'build', bucket: 'pending' }]),
      ),
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('error');
    expect(delays).toHaveLength(8);
  });

  it('is an error when the checks cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok('not json'),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('drops malformed check rows rather than trusting them', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'pass' },
          { name: 5, bucket: 'fail' },
          { name: 'x' },
          'junk',
          null,
        ]),
      ),
    });
    expect(await stateOf(exec)).toBe('green');
  });

  it('counts a row with no bucket as no check at all', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --watch': ok('watched'),
      'gh pr checks 42 --json': ok(JSON.stringify([{ name: 'x' }])),
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('no checks reported');
  });

  it('waits for checks that have not registered yet', async () => {
    const delays: number[] = [];
    const { exec, calls } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': [
        ok('[]'),
        ok('[]'),
        ok(JSON.stringify([{ name: 'build', bucket: 'fail' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('ci-red');
    expect(delays).toEqual([15_000, 15_000]);
    expect(
      calls.filter((call) => call.line === 'gh pr checks 42 --watch'),
    ).toHaveLength(3);
  });

  it("waits through gh's own 'no checks reported' failure", async () => {
    // What `gh pr checks --json` actually does before CI registers: exit 1,
    // nothing on stdout, this sentence on stderr. Seen on the first real run
    // (guardrails PR #122), which gave up as `error` within seconds.
    const delays: number[] = [];
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': [
        failed("no checks reported on the 'feat/x' branch"),
        ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
      ],
    });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status.state).toBe('green');
    expect(delays).toEqual([15_000]);
  });

  it('is still an error when gh fails for any other reason', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': failed('HTTP 502: Bad Gateway'),
    });
    expect(await stateOf(exec)).toBe('error');
  });

  it('is green with no checks once the registration wait runs out', async () => {
    const delays: number[] = [];
    const { exec } = fakeExec({ ...HAPPY, 'gh pr checks 42 --json': ok('[]') });
    const status = await ship(
      options(exec, {
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(status).toMatchObject({ state: 'green', failing: [] });
    expect(delays).toHaveLength(8);
    expect(status.tail).toContain('no checks reported');
  });
});

describe('writeShipStatus and shipSummary', () => {
  it('names each warning on the same line', () => {
    const line = shipSummary(
      {
        state: 'green',
        branch: 'feat/x',
        pr: 42,
        url: 'u',
        failing: [],
        tail: '',
        finishedAt: '',
        warnings: ['attachments not posted: HTTP 413'],
      },
      's.json',
    );
    expect(line).toBe(
      'guardrails ship: green — feat/x, PR #42 u; warning: attachments not posted: HTTP 413 (status: s.json)',
    );
  });

  it('writes the status as JSON, creating the directory', () => {
    const file = path.join(root, 'deep', 'status.json');
    const status = {
      state: 'ci-red' as const,
      branch: 'feat/x',
      pr: 42,
      url: 'u',
      failing: ['build'],
      tail: 'X build',
      finishedAt: '2026-10-12T12:00:00.000Z',
      warnings: [],
    };
    writeShipStatus(file, status);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(status);
  });

  it('says the state, the PR and the failing checks on one line', () => {
    const line = shipSummary(
      {
        state: 'ci-red',
        branch: 'feat/x',
        pr: 42,
        url: 'https://github.com/o/r/pull/42',
        failing: ['build', 'e2e'],
        tail: '',
        finishedAt: '',
        warnings: [],
      },
      'status.json',
    );
    expect(line).toBe(
      'guardrails ship: ci-red — feat/x, PR #42 https://github.com/o/r/pull/42; failing: build, e2e (status: status.json)',
    );
    expect(line).not.toContain('\n');
  });

  it('says plainly when there is no PR yet', () => {
    expect(
      shipSummary(
        {
          state: 'gate-blocked',
          branch: 'feat/x',
          pr: null,
          url: null,
          failing: [],
          tail: '',
          finishedAt: '',
          warnings: [],
        },
        's.json',
      ),
    ).toBe('guardrails ship: gate-blocked — feat/x, no PR (status: s.json)');
  });
});

describe('ship: the details a reader acts on', () => {
  it('keeps stdout and stderr of a failed push, one per line', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git push': { stdout: 'hook says', stderr: 'git says', code: 1 },
    });
    const status = await ship(options(exec));
    expect(status.tail).toBe('hook says\ngit says');
  });

  it('says which branch it would not ship', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': ok('main\n'),
    });
    const status = await ship(options(exec));
    expect(status.tail).toContain('HEAD is main; base is main');
    expect(status.branch).toBe('main');
  });

  it('says unknown when git named no branch', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': failed('fatal: no repo', 128),
    });
    const status = await ship(options(exec));
    expect(status.tail).toContain('HEAD is unknown');
    expect(status.tail).toContain('fatal: no repo');
  });

  it('keeps the PR it found when the checks cannot be read', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok('not json'),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({
      state: 'error',
      pr: 42,
      url: 'https://github.com/o/r/pull/42',
      tail: 'not json',
      failing: [],
    });
  });

  it('is an error while any one check is still pending', async () => {
    const { exec } = fakeExec({
      ...HAPPY,
      'gh pr checks 42 --json': ok(
        JSON.stringify([
          { name: 'build', bucket: 'pass' },
          { name: 'e2e', bucket: 'pending' },
        ]),
      ),
    });
    const status = await ship(options(exec));
    expect(status).toMatchObject({ state: 'error', pr: 42 });
  });

  it('stamps the real time when none is injected', async () => {
    const { exec } = fakeExec(HAPPY);
    const before = Date.now();
    const status = await ship({ exec, repoRoot: root, baseBranch: 'main' });
    const stamped = Date.parse(status.finishedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('really waits between looks when no delay is injected', async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = fakeExec({
        ...HAPPY,
        'gh pr checks 42 --json': [
          ok('[]'),
          ok(JSON.stringify([{ name: 'build', bucket: 'pass' }])),
        ],
      });
      const shipped = ship({ exec, repoRoot: root, baseBranch: 'main' });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(
        calls.filter((call) => call.line === 'gh pr checks 42 --watch'),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await shipped;
      expect(result.state).toBe('green');
    } finally {
      vi.useRealTimers();
    }
  });
});
