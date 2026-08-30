import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliDeps, runCommand } from '../src/cli-core.js';
import type { Exec, ExecResult } from '../src/exec.js';
import {
  loadSession,
  sessionFile,
  stateDirectory,
  writeViolations,
} from '../src/state-store.js';
import type { Violation } from '../src/violation.js';

let root: string;
let out: string[];
let errors: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-cli-'));
  out = [];
  errors = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    cwd: root,
    exec: () => Promise.resolve(ok('')),
    readStdin: () => Promise.resolve(''),
    stdout: (text) => out.push(text),
    stderr: (text) => errors.push(text),
    ...over,
  };
}

function violation(file: string): Violation {
  return {
    ruleId: 'no-console',
    file,
    message: 'Unexpected console.',
    severity: 'error',
    fixable: false,
    tool: 'eslint',
  };
}

describe('runCommand — verify', () => {
  it('returns 0 when no TypeScript files changed', async () => {
    expect(await runCommand('verify', [], deps())).toBe(0);
  });

  it('returns 1 and reports violations when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    expect(await runCommand('verify', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('no-console');
  });
});

describe('runCommand — audit', () => {
  it('returns 1 when the working diff adds a suppression', async () => {
    const diff = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+  // eslint-disable-next-line',
    ].join('\n');
    const exec = () => Promise.resolve(ok(diff));
    expect(await runCommand('audit', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('eslint-disable');
  });
});

describe('runCommand — state', () => {
  it('prints the current session and recurrence as JSON', async () => {
    expect(await runCommand('state', [], deps())).toBe(0);
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({
      session: { attempts: 0, ruleCounts: {}, corrected: [] },
      recurrence: {},
    });
  });
});

describe('runCommand — scope-check', () => {
  it('denies an edit to a file outside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/forbidden.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('stays silent for a file inside the manifest', async () => {
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: path.join(root, 'src/allowed.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('denies a Read outside the repo (e.g. ~/.claude memory)', async () => {
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'Read',
      tool_input: { file_path: '/home/u/.claude/projects/x/memory/y.md' },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('allows a Read inside the repo (incl. node_modules)', async () => {
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'Read',
      tool_input: {
        file_path: path.join(root, 'node_modules/some-plugin/rule.js'),
      },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('allows a Copilot `view` read inside the repo, not in the manifest', async () => {
    // A manifest IS active (for a different file) — this is the regression
    // case: a `view` read must not fall through to the edit-family
    // manifest-lock, which would wrongly deny it.
    writeViolations(stateDirectory(root), 'sid', [violation('src/allowed.ts')]);
    const stdin = JSON.stringify({
      workingDirectory: root,
      toolName: 'view',
      toolArgs: { path: path.join(root, 'src/not-in-manifest.ts') },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toBe('');
  });

  it('denies a Copilot `view` read outside the repo', async () => {
    const stdin = JSON.stringify({
      workingDirectory: root,
      toolName: 'view',
      toolArgs: { path: '/home/u/.claude/projects/x/memory/y.md' },
    });
    await runCommand(
      'scope-check',
      [],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(out.join('')).toContain('deny');
    expect(out.join('')).toContain('outside the repository');
  });
});

describe('runCommand — gate stop', () => {
  it('emits a block decision when verify fails', async () => {
    const eslint = JSON.stringify([
      {
        filePath: path.join(root, 'src/foo.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'x', line: 1 },
        ],
      },
    ]);
    const exec = (command: string, args: string[]) => {
      const line = [command, ...args].join(' ');
      if (line.includes('--name-only'))
        return Promise.resolve(ok('src/foo.ts'));
      if (line.includes('HEAD')) return Promise.resolve(ok(''));
      if (line.includes('eslint')) return Promise.resolve(ok(eslint));
      return Promise.resolve(ok(''));
    };
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({ decision: 'block' });
  });
});

/** Canned exec for the pretooluse-gate tests: `merge-base` resolves to a sha,
 * `diff <sha>` returns the mapped diff text, everything else is empty. */
function gitExec(map: Record<string, string>): Exec {
  return (command, args) => {
    let key: string | undefined;
    if (args[0] === 'merge-base') {
      key = 'merge-base';
    } else if (args.slice(0, 2).join(' ') === 'diff BASESHA') {
      key = 'diff BASESHA';
    }
    const stdout = key === undefined ? '' : (map[key] ?? '');
    return Promise.resolve(ok(stdout));
  };
}

describe('runCommand — gate pretooluse (copilot commit/push gate)', () => {
  it('denies a git commit when the tree is dirty (copilot dialect)', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m wip' },
      cwd: root,
    });
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    const printed: unknown = JSON.parse(out.join(''));
    expect(printed).toMatchObject({ permissionDecision: 'deny' });
  });

  it('stays silent for a non-git shell command', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'ls -la' },
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });

  it('stays silent on a clean commit', async () => {
    const stdin = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'git commit -m ok' },
      cwd: root,
    });
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': '+const x = 1;\n',
    });
    const code = await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });
});

describe('runCommand — session lifecycle', () => {
  it('session-start sweeps and returns 0', async () => {
    expect(await runCommand('session-start', [], deps())).toBe(0);
  });

  it('session-end returns 0', async () => {
    const stdin = JSON.stringify({ session_id: 'sid', cwd: root });
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve(stdin) }),
      ),
    ).toBe(0);
  });
});

describe('runCommand — unknown', () => {
  it('prints usage and returns 1', async () => {
    expect(await runCommand('bogus', [], deps())).toBe(1);
    expect(errors.join('')).toContain('usage:');
  });
});

/** stdin payload for the pretooluse gate. */
function preToolUseStdin(toolName: unknown, command: unknown): string {
  return JSON.stringify({ toolName, toolArgs: { command }, cwd: root });
}

/** An exec whose branch diff always carries a suppression, so the gate DENIES
 *  whenever it actually runs — making "did the gate fire?" observable. */
function dirtyExec(): Exec {
  return gitExec({
    'merge-base': 'BASESHA\n',
    'diff BASESHA': [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+// eslint-disable-next-line',
    ].join('\n'),
  });
}

async function runPreToolUse(stdin: string): Promise<string> {
  await runCommand(
    'gate',
    ['--mode=pretooluse', '--dialect=copilot'],
    deps({ exec: dirtyExec(), readStdin: () => Promise.resolve(stdin) }),
  );
  return out.join('');
}

describe('pretooluse gate trigger conditions', () => {
  it('fires only for an exact shell tool name, case-insensitively', async () => {
    // Kills the SHELL_TOOLS anchor mutants: unanchored, any tool whose name
    // merely CONTAINS "bash" would be gated.
    expect(
      await runPreToolUse(preToolUseStdin('BASH', 'git commit -m x')),
    ).toContain('deny');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('run-bash-task', 'git commit -m x')),
    ).toBe('');
  });

  it('matches git commit/push on word boundaries and any spacing', async () => {
    // Kills the GIT_WRITE mutants: `\s+` -> `\s` misses double spaces, and a
    // dropped `\b` would match `legit commit` or `git commits-are-fun`.
    expect(await runPreToolUse(preToolUseStdin('bash', 'git push'))).toContain(
      'deny',
    );
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'git  commit -m x')),
    ).toContain('deny');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'legit commit -m x')),
    ).toBe('');
    out.length = 0;
    expect(
      await runPreToolUse(preToolUseStdin('bash', 'git commits-are-fun')),
    ).toBe('');
  });

  it('stays silent when toolName or command is absent', async () => {
    // Kills the `=== undefined` equality mutants and the `||` -> `&&` chain
    // mutants, which would let a non-matching invocation reach the gate.
    expect(await runPreToolUse(preToolUseStdin(undefined, 'git commit'))).toBe(
      '',
    );
    out.length = 0;
    expect(await runPreToolUse(preToolUseStdin('bash', undefined))).toBe('');
    out.length = 0;
    // A shell command that is not a git write must not reach the gate even
    // though the tree is dirty.
    expect(await runPreToolUse(preToolUseStdin('bash', 'ls -la'))).toBe('');
  });
});

describe('cli-core wiring', () => {
  it('prints ? for a violation with no line number', async () => {
    // Kills `violation.line ?? '?'` -> `&&`. ESLint can report a message with
    // no line (a whole-file parse failure), and the printer must not emit
    // `src/a.ts:undefined`.
    const lineless = JSON.stringify([
      {
        filePath: path.join(root, 'src/a.ts'),
        messages: [
          { ruleId: 'no-console', severity: 2, message: 'Unexpected console.' },
        ],
      },
    ]);
    const exec: Exec = (command, args) =>
      Promise.resolve(ok(args.includes('--name-only') ? 'src/a.ts' : lineless));
    await runCommand('verify', [], deps({ exec }));
    expect(errors.join('')).toContain('src/a.ts:?');
  });

  it('resolves tool binaries against the repo-local node_modules', async () => {
    // Kills the binResolver block removal, which silently degrades every tool
    // lookup to a bare PATH name — the repo-local pin is how the gate avoids
    // running whatever version happens to be on PATH.
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', '.bin', 'eslint'), '');
    const seen: string[] = [];
    const exec: Exec = (command, args) => {
      seen.push(command);
      return Promise.resolve(
        ok(args.includes('--name-only') ? 'src/a.ts' : ''),
      );
    };
    await runCommand('verify', [], deps({ exec }));
    expect(seen.some((command) => command.includes('node_modules'))).toBe(true);
  });
});

const OUTSIDE_PATH = path.join(tmpdir(), 'outside-the-repo.ts');

/** stdin payload for the scope-check hook. */
function scopeStdin(toolName: unknown, filePath: unknown): string {
  // filePath rides in toolArgs.path (parseHookInput reads tool_input.file_path
  // / toolArgs.path), NOT at the top level.
  return JSON.stringify({ toolName, toolArgs: { path: filePath }, cwd: root });
}

async function runScopeCheck(stdin: string): Promise<string> {
  await runCommand(
    'scope-check',
    [],
    deps({ readStdin: () => Promise.resolve(stdin) }),
  );
  return out.join('');
}

/** An exec that fails verify, so the stop gate produces a blocking decision. */
function failingVerifyExec(): Exec {
  const eslintJson = JSON.stringify([
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
  return (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.includes('--name-only')) return Promise.resolve(ok('src/foo.ts'));
    if (line.includes('eslint')) return Promise.resolve(ok(eslintJson));
    if (command === 'stryker') {
      // The `verify` CLI command runs at the 'ci' profile, so stryker runs too
      // and reads its report from the REAL filesystem (CliDeps has no readFile
      // seam). Write an empty-but-valid report at stryker's DEFAULT path — the
      // only path it can use, since the report location is not relocatable per
      // run — so this fixture stays about eslint's finding rather than a
      // fabricated mutation failure.
      const fullPath = path.join(root, 'reports', 'mutation', 'mutation.json');
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, JSON.stringify({ files: {} }));
      return Promise.resolve(ok(''));
    }
    return Promise.resolve(ok(''));
  };
}

describe('scope-check trigger conditions', () => {
  it('treats only exact read-tool names as reads', async () => {
    // Kills the READ_TOOLS anchor mutants. An unanchored pattern would classify
    // `my-read` / `read-only` as reads and deny them for being outside the repo,
    // when they are edit-family tools that an empty manifest must let through.
    expect(await runScopeCheck(scopeStdin('my-read', OUTSIDE_PATH))).toBe('');
    expect(await runScopeCheck(scopeStdin('read-only', OUTSIDE_PATH))).toBe('');
  });

  it('does not treat an arbitrary defined tool name as a read', async () => {
    // Kills `toolName !== undefined && ...` -> `||` (and -> true): an edit tool
    // would be read-classified and denied for an out-of-repo path.
    expect(await runScopeCheck(scopeStdin('edit', OUTSIDE_PATH))).toBe('');
  });

  it('still denies a genuine out-of-repo read', async () => {
    expect(await runScopeCheck(scopeStdin('Read', OUTSIDE_PATH))).toContain(
      'deny',
    );
  });

  it('returns early when no filePath is supplied', async () => {
    // Kills `input.filePath === undefined` -> false: continuing would pass
    // undefined into the path checks.
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('edit', undefined))).toBe('');
  });

  it('allows any edit when no manifest is active', async () => {
    // Kills `files.size > 0` -> `>= 0` / true: with no manifest the fixer is not
    // running, and the scope-lock must not interfere.
    expect(
      await runScopeCheck(scopeStdin('edit', path.join(root, 'src/a.ts'))),
    ).toBe('');
  });
});

describe('cli-core defaults and dialects', () => {
  it('falls back to deps.cwd and the default session when stdin omits them', async () => {
    // Kills the `input.cwd ?? deps.cwd` / `?? 'default'` -> `&&` mutants across
    // the stop, pretooluse, scope-check and session-end paths: with `&&` the
    // repoRoot becomes undefined and the path helpers throw.
    expect(
      await runCommand(
        'gate',
        ['--mode=stop'],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
    expect(
      await runCommand(
        'gate',
        ['--mode=pretooluse'],
        deps({
          readStdin: () =>
            Promise.resolve(
              JSON.stringify({
                toolName: 'bash',
                toolArgs: { command: 'git commit -m x' },
              }),
            ),
        }),
      ),
    ).toBe(0);
    await runCommand(
      'scope-check',
      [],
      deps({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({ toolName: 'edit', filePath: 'a.ts' }),
          ),
      }),
    );
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
    expect(await runCommand('state', [], deps())).toBe(0);
  });

  it('prints nothing when the stop gate produces no hook output', async () => {
    // Kills `if (output)` -> true, which would print `undefined`.
    const code = await runCommand(
      'gate',
      ['--mode=stop'],
      deps({ readStdin: () => Promise.resolve(JSON.stringify({ cwd: root })) }),
    );
    expect(code).toBe(0);
    expect(out.join('')).toBe('');
  });
});

describe('verify and audit exit codes', () => {
  it('reports the clean message only when there are no violations', async () => {
    // Kills the `violations.length === 0` conditional/equality mutants.
    await runCommand('verify', [], deps());
    expect(errors.join('')).toContain('clean (0 violations)');
    errors.length = 0;
    await runCommand('verify', [], deps({ exec: failingVerifyExec() }));
    // A count, not a specific number: the fixture supplies no stryker report,
    // so the fail-closed check correctly adds an analyzer-failed violation too.
    expect(errors.join('')).toContain(' violation(s).');
    expect(errors.join('')).not.toContain('0 violation(s).');
    expect(errors.join('')).not.toContain('clean (0 violations)');
  });

  it('audits the working diff from cwd and exits per findings', async () => {
    // Kills the audit argv/cwd mutants and `findings.length > 0` -> true/>=0.
    const calls: { args: string[]; cwd: string | undefined }[] = [];
    const auditExec =
      (diff: string): Exec =>
      (command, args, execOptions) => {
        calls.push({ args, cwd: execOptions?.cwd });
        return Promise.resolve(ok(diff));
      };
    expect(await runCommand('audit', [], deps({ exec: auditExec('') }))).toBe(
      0,
    );
    expect(calls[0]?.args).toEqual(['diff', 'HEAD']);
    expect(calls[0]?.cwd).toBe(root);

    const dirty = [
      '+++ b/src/a.ts',
      '@@ -1,0 +1,1 @@',
      '+// eslint-disable-next-line',
    ].join('\n');
    expect(
      await runCommand('audit', [], deps({ exec: auditExec(dirty) })),
    ).toBe(1);
  });
});

describe('cli-core residual hardening', () => {
  it('anchors the shell-tool name at BOTH ends', async () => {
    // Kills the two SHELL_TOOLS anchor mutants individually: `bash-task`
    // starts with bash, `run-bash` ends with it — neither may gate.
    expect(
      await runPreToolUse(preToolUseStdin('bash-task', 'git commit')),
    ).toBe('');
    out.length = 0;
    expect(await runPreToolUse(preToolUseStdin('run-bash', 'git commit'))).toBe(
      '',
    );
  });

  it('scope-locks an edit to the manifest, using deps.cwd when stdin omits it', async () => {
    // Kills `toolName !== undefined && READ_TOOLS.test(...)` -> true (an edit
    // treated as a read would be allowed anywhere in-repo) and the
    // `input.cwd ?? deps.cwd` -> `&&` mutant (a lost repoRoot finds no manifest,
    // so the scope-lock silently disengages).
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    await runCommand(
      'scope-check',
      [],
      deps({
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              toolName: 'edit',
              toolArgs: { path: path.join(root, 'src/b.ts') },
            }),
          ),
      }),
    );
    expect(out.join('')).toContain('deny');
  });

  it('routes --mode=commit to the commit gate', async () => {
    // Kills `mode === 'commit'` -> false, which would fall through to the stop
    // gate and never block a dirty commit.
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(1);
  });

  it('defaults the session id for state and session-end', async () => {
    // Kills the `flag(rest,'session') ?? 'default'` and
    // `input.sessionId ?? 'default'` -> `&&` mutants.
    writeViolations(stateDirectory(root), 'default', [violation('src/a.ts')]);
    expect(await runCommand('state', [], deps())).toBe(0);
    expect(out.join('')).toContain('session');
    expect(
      await runCommand(
        'session-end',
        [],
        deps({ readStdin: () => Promise.resolve('{}') }),
      ),
    ).toBe(0);
  });
});

/** Run the stop gate `times` times against a failing verify, returning the last
 *  stdout. Three runs cross the default recurrence threshold, which is the only
 *  condition under which the two dialects' payloads differ. */
async function primeStopGate(
  times: number,
  dialectArguments: string[],
): Promise<string> {
  const stdin = JSON.stringify({ cwd: root, sessionId: 'sid' });
  let last = '';
  for (let run = 0; run < times; run += 1) {
    out.length = 0;
    await runCommand(
      'gate',
      ['--mode=stop', ...dialectArguments],
      deps({
        exec: failingVerifyExec(),
        readStdin: () => Promise.resolve(stdin),
      }),
    );
    last = out.join('');
  }
  return last;
}

describe('cli-core final hardening', () => {
  it('sweeps sessions older than the TTL and keeps fresh ones', async () => {
    // Kills the four SESSION_TTL_MS arithmetic mutants (each shrinks the TTL to
    // milliseconds, sweeping everything) and the `case 'session-start'` block
    // removal (which sweeps nothing).
    const directory = stateDirectory(root);
    mkdirSync(directory, { recursive: true });
    const stale = sessionFile(directory, 'stale');
    const fresh = sessionFile(directory, 'fresh');
    writeFileSync(stale, '{}');
    writeFileSync(fresh, '{}');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(stale, eightDaysAgo, eightDaysAgo);
    // The fresh file must be meaningfully old (but under the TTL), otherwise a
    // mutant that shrinks the TTL to milliseconds still keeps a just-created
    // file and the assertion below passes vacuously.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(fresh, oneDayAgo, oneDayAgo);

    expect(await runCommand('session-start', [], deps())).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('emits dialect-specific stop payloads once a rule crosses recurrence', async () => {
    // Kills the `dialect === 'copilot'` mutants and the dialect resolution
    // default. The two formatters are byte-identical UNTIL additionalContext is
    // present, which only happens on the run that crosses recurThreshold.
    const copilot = await primeStopGate(3, ['--dialect=copilot']);
    rmSync(stateDirectory(root), { recursive: true, force: true });
    const claude = await primeStopGate(3, []);

    expect(copilot).not.toBe('');
    expect(claude).not.toBe('');
    // Claude carries additionalContext in hookSpecificOutput; Copilot inlines
    // it into `reason` because its hook host has no such field.
    expect(claude).toContain('hookSpecificOutput');
    expect(copilot).not.toContain('hookSpecificOutput');
  });

  it('defaults the session id to "default" across stop, state and session-end', async () => {
    // Kills the `?? 'default'` -> `&&` mutants, which route reads and writes to
    // an `undefined.json` session instead.
    const directory = stateDirectory(root);
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({
        exec: failingVerifyExec(),
        readStdin: () => Promise.resolve(JSON.stringify({ cwd: root })),
      }),
    );
    expect(loadSession(directory, 'default').attempts).toBe(1);

    out.length = 0;
    await runCommand('state', [], deps());
    expect(out.join('')).toContain('"attempts": 1');

    await runCommand(
      'session-end',
      [],
      deps({ readStdin: () => Promise.resolve('{}') }),
    );
    expect(existsSync(sessionFile(directory, 'default'))).toBe(false);
  });

  it('prints each added suppression found by the commit gate', async () => {
    // Kills the findings-loop block removal: the gate would block with no
    // explanation of WHICH suppression tripped it.
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('added eslint-disable');
  });
});

describe('sanctioned suppressions reach the commit gate', () => {
  it('exempts a finding whose key is sanctioned in the policy file', async () => {
    // Kills a dropped-forwarding mutant: if `--mode=commit` stopped passing
    // `config.sanctionedSuppressions` through to `runCommitGate`, this finding
    // would exempt nothing and the gate would still block.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        sanctionedSuppressions: [
          {
            key: 'src/a.ts|eslint-disable|// eslint-disable-next-line',
            reason: 'reviewed and approved for this fixture',
          },
        ],
      }),
    );
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    expect(await runCommand('gate', ['--mode=commit'], deps({ exec }))).toBe(0);
  });

  it('also forwards sanctions from the pretooluse gate', async () => {
    // The pretooluse path forwards the list independently of --mode=commit;
    // kills the same dropped-forwarding mutant on that second call site.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        sanctionedSuppressions: [
          {
            key: 'src/a.ts|eslint-disable|// eslint-disable-next-line',
            reason: 'reviewed and approved for this fixture',
          },
        ],
      }),
    );
    const exec = gitExec({
      'merge-base': 'BASESHA\n',
      'diff BASESHA': [
        '+++ b/src/a.ts',
        '@@ -1,0 +1,1 @@',
        '+// eslint-disable-next-line',
      ].join('\n'),
    });
    await runCommand(
      'gate',
      ['--mode=pretooluse', '--dialect=copilot'],
      deps({
        exec,
        readStdin: () =>
          Promise.resolve(preToolUseStdin('bash', 'git commit -m x')),
      }),
    );
    expect(out.join('')).toBe('');
  });
});

/** git fake for sanctions-check: merge-base resolves, `git show` returns the
 *  base revision of the policy file. Records calls for argv/cwd assertions. */
function sanctionsExec(
  baseConfig: string | null,
  mergeBase: ExecResult = ok('BASESHA\n'),
  showCode = 0,
): { exec: Exec; calls: { args: string[]; cwd: string | undefined }[] } {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const exec: Exec = (command, args, execOptions) => {
    calls.push({ args, cwd: execOptions?.cwd });
    if (args[0] === 'merge-base') return Promise.resolve(mergeBase);
    if (args[0] === 'show') {
      return Promise.resolve(
        baseConfig === null
          ? { stdout: '', stderr: 'does not exist', code: 128 }
          : { stdout: baseConfig, stderr: '', code: showCode },
      );
    }
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

/** Writes the policy file AND materializes the source each key names, so the
 *  count drift-guard sees a repo whose suppressions match what is declared.
 *  Fixture keys are real auditable lines for the same reason: a synthetic key
 *  no auditor could ever produce would make the drift-guard the thing under
 *  test in every unrelated case. */
function writeRepoConfig(sanctions: unknown[]): void {
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ sanctionedSuppressions: sanctions }),
  );
  const declared = new Map<string, number>();
  for (const entry of sanctions as { key?: string; count?: number }[]) {
    if (typeof entry.key !== 'string') {
      continue;
    }
    const count = typeof entry.count === 'number' ? entry.count : 1;
    declared.set(entry.key, (declared.get(entry.key) ?? 0) + count);
  }
  const linesByFile = new Map<string, string[]>();
  for (const [key, total] of declared) {
    const [file, , text] = key.split('|');
    if (file === undefined || text === undefined || total < 1) {
      continue;
    }
    linesByFile.set(file, [
      ...(linesByFile.get(file) ?? []),
      ...Array.from({ length: total }, () => text),
    ]);
  }
  for (const [file, lines] of linesByFile) {
    writeFileSync(path.join(root, file), `${lines.join('\n')}\n`);
  }
}

/** git fake where the base branch resolves ONLY as `origin/<branch>` (the CI
 *  checkout shape), or as nothing at all when `resolvable` is empty. */
function baseReferenceExec(resolvable: readonly string[]): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'rev-parse') {
      const reference = args.at(-1) ?? '';
      return Promise.resolve(
        resolvable.some((candidate) => reference.startsWith(candidate))
          ? ok('SHA\n')
          : { stdout: '', stderr: 'fatal: bad revision', code: 128 },
      );
    }
    if (args[0] === 'merge-base') return Promise.resolve(ok('BASESHA\n'));
    if (args[0] === 'show') return Promise.resolve(ok('{}'));
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

const REVIEWED_KEY = 'a.ts|cast-any|const value = input as any;';
const REQUESTED_KEY = 'b.ts|cast-any|const other = input as any;';
const REVIEWED = { key: REVIEWED_KEY, reason: 'proven equivalent' };
const REQUESTED = { key: REQUESTED_KEY, reason: 'newly requested' };

describe('runCommand — sanctions-check (CI approval-visibility gate)', () => {
  it('passes when the branch adds no new exemption', async () => {
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(0);
    expect(errors.join('')).toContain('no new diff-auditor exemptions');
  });

  it('passes and prominently prints each newly-granted exemption', async () => {
    // A new grant is informational, not a failure: the PR merge IS the
    // approval, so a required check that failed here would deadlock it.
    writeRepoConfig([REVIEWED, REQUESTED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(0);
    const printed = errors.join('');
    expect(printed).toContain(REQUESTED_KEY);
    expect(printed).toContain('newly requested');
    expect(printed).toContain('1 new diff-auditor exemption');
    // The already-approved entry must not be re-reported.
    expect(printed).not.toContain(REVIEWED_KEY);
  });

  it('prints a raised count as a new grant, even though the key already existed', async () => {
    // The headline case a bare key-set diff would miss: the key was already
    // approved, but the branch raises how many occurrences it covers.
    const raised = { ...REVIEWED, count: 2 };
    writeRepoConfig([raised]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(0);
    const printed = errors.join('');
    expect(printed).toContain(REVIEWED_KEY);
    expect(printed).toContain('count: 2');
  });

  it('treats every entry as newly granted when the base has no policy file, and still passes', async () => {
    writeRepoConfig([REVIEWED]);
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(null).exec }),
      ),
    ).toBe(0);
    expect(errors.join('')).toContain(REVIEWED_KEY);
  });

  it('fails and names each malformed entry in the head config', async () => {
    writeRepoConfig([REVIEWED, { key: 'c.ts|cast-any|const z = q as any;' }]);
    const base = JSON.stringify({ sanctionedSuppressions: [] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(1);
    const printed = errors.join('');
    expect(printed).toContain('missing reason');
    expect(printed).toContain('malformed');
  });

  it('fails on a non-integer or non-positive count', async () => {
    writeRepoConfig([{ ...REVIEWED, count: 0 }]);
    const base = JSON.stringify({ sanctionedSuppressions: [] });
    expect(
      await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec(base).exec }),
      ),
    ).toBe(1);
    expect(errors.join('')).toContain('count must be a positive integer');
  });

  it('does not report a new grant when the head config is malformed', async () => {
    // Malformed-entry failure is the ONLY failure mode; it must not also spend
    // effort computing (or printing) grants from a config it is rejecting.
    writeRepoConfig([REQUESTED, { key: 'c.ts|cast-any|z' }]);
    const base = JSON.stringify({ sanctionedSuppressions: [] });
    await runCommand(
      'sanctions-check',
      [],
      deps({ exec: sanctionsExec(base).exec }),
    );
    expect(errors.join('')).not.toContain('newly requested');
  });
});

describe('sanctions-check git plumbing', () => {
  it('resolves the merge-base and reads the policy file at that revision', async () => {
    // Kills the argv/cwd/trim mutants: a lost `.trim()` yields the ref
    // "BASESHA\n:guardrails.config.json", and a dropped cwd reads the wrong repo.
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });
    const { exec, calls } = sanctionsExec(base);
    await runCommand('sanctions-check', [], deps({ exec }));
    const mergeBaseCall = calls.find((call) => call.args[0] === 'merge-base');
    const showCall = calls.find((call) => call.args[0] === 'show');
    expect(mergeBaseCall?.args).toEqual(['merge-base', 'main', 'HEAD']);
    expect(mergeBaseCall?.cwd).toBe(root);
    expect(showCall?.args).toEqual(['show', 'BASESHA:guardrails.config.json']);
    expect(showCall?.cwd).toBe(root);
  });

  it('falls back to the base branch when merge-base fails or is empty', async () => {
    // Kills the `code === 0 && sha` conditional/logical/equality mutants: each
    // would use a bogus (or empty) ref instead of the branch name.
    writeRepoConfig([REVIEWED]);
    const base = JSON.stringify({ sanctionedSuppressions: [REVIEWED] });

    const failed = sanctionsExec(base, {
      stdout: 'noise\n',
      stderr: '',
      code: 1,
    });
    await runCommand('sanctions-check', [], deps({ exec: failed.exec }));
    expect(failed.calls.find((call) => call.args[0] === 'show')?.args).toEqual([
      'show',
      'main:guardrails.config.json',
    ]);

    const empty = sanctionsExec(base, ok('   \n'));
    await runCommand('sanctions-check', [], deps({ exec: empty.exec }));
    expect(empty.calls.find((call) => call.args[0] === 'show')?.args).toEqual([
      'show',
      'main:guardrails.config.json',
    ]);
  });

  it('ignores the base file contents when git show fails', async () => {
    // Kills `base.code === 0 ? parse : []` -> true. A failed `git show` may
    // still print stdout; trusting it would treat REVIEWED as already known
    // (base === head) instead of reporting it as a new grant.
    writeRepoConfig([REVIEWED]);
    const { exec } = sanctionsExec(
      JSON.stringify({ sanctionedSuppressions: [REVIEWED] }),
      ok('BASESHA\n'),
      128,
    );
    expect(await runCommand('sanctions-check', [], deps({ exec }))).toBe(0);
    expect(errors.join('')).toContain(REVIEWED_KEY);
  });
});

function execRecorder(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args]);
    return Promise.resolve(ok(''));
  };
  return { exec, calls };
}

// The PostToolUse hook entry point. It runs on every edit in a guarded session,
// and had no test at all: stryker reported its whole body as NoCoverage, which
// the mutation gate did not flag before this change.
describe('autofix command', () => {
  it('runs eslint --fix on the edited file named by the hook payload', async () => {
    const { exec, calls } = execRecorder();
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/edited.ts' },
    });
    const code = await runCommand(
      'autofix',
      [],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    const eslintCall = calls.find(
      (call) => call[0]?.includes('eslint') === true,
    );
    expect(eslintCall).toBeDefined();
    expect(eslintCall).toContain('--fix');
    expect(eslintCall).toContain('src/edited.ts');
  });

  it('runs nothing when the hook payload carries no file path', async () => {
    const { exec, calls } = execRecorder();
    const stdin = JSON.stringify({ cwd: root, tool_name: 'Bash' });
    const code = await runCommand(
      'autofix',
      [],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it('runs nothing when the edited file is not TypeScript', async () => {
    // Paired with the positive case above so an autofix that silently stopped
    // running eslint entirely would still fail this file.
    const { exec, calls } = execRecorder();
    const stdin = JSON.stringify({
      cwd: root,
      tool_input: { file_path: 'README.md' },
    });
    const code = await runCommand(
      'autofix',
      [],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("resolves eslint from the payload cwd's local bin, not the process cwd", async () => {
    // Two things at once, because they can only fail together: the payload
    // `cwd` wins over `deps.cwd` as the repo root, AND the repo-local
    // node_modules/.bin binary is preferred over a bare PATH lookup. A local
    // bin is planted under the payload root only — so a resolver that used
    // `deps.cwd` would fall back to the bare name and fail this.
    const { exec, calls } = execRecorder();
    const payloadRoot = path.join(root, 'nested');
    const localBin = path.join(payloadRoot, 'node_modules', '.bin');
    mkdirSync(localBin, { recursive: true });
    const binName = process.platform === 'win32' ? 'eslint.cmd' : 'eslint';
    writeFileSync(path.join(localBin, binName), '');
    const stdin = JSON.stringify({
      cwd: payloadRoot,
      tool_input: { file_path: 'src/edited.ts' },
    });
    await runCommand(
      'autofix',
      [],
      deps({ exec, readStdin: () => Promise.resolve(stdin) }),
    );
    const eslintCall = calls.find(
      (call) => call[0]?.includes('eslint') === true,
    );
    expect(eslintCall?.[0]).toBe(path.join(localBin, binName));
  });
});

describe('sanctions-check base branch resolution', () => {
  // In a GitHub Actions PR checkout the base branch exists only as
  // `origin/main`. An unresolved merge-base would make EVERY entry read as
  // newly granted, turning the one report a reviewer relies on into noise.
  it('takes the merge-base against origin/<branch> when only that resolves', async () => {
    writeRepoConfig([REVIEWED]);
    const { exec, calls } = baseReferenceExec(['origin/main']);
    await runCommand('sanctions-check', [], deps({ exec }));
    const mergeBase = calls.find((call) => call[1] === 'merge-base');
    expect(mergeBase).toContain('origin/main');
  });

  it('falls back to the configured branch name when nothing resolves', async () => {
    // Paired with the case above so a fallback that produced `undefined`
    // (rather than the branch name) fails here instead of silently passing.
    writeRepoConfig([REVIEWED]);
    const { exec, calls } = baseReferenceExec([]);
    await runCommand('sanctions-check', [], deps({ exec }));
    const mergeBase = calls.find((call) => call[1] === 'merge-base');
    expect(mergeBase).toEqual(['git', 'merge-base', 'main', 'HEAD']);
    expect(mergeBase?.includes('undefined')).toBe(false);
  });
});

describe('sanctions-check count drift-guard', () => {
  it('fails and names each entry whose declared count exceeds the source', async () => {
    // The stale-config case: a refactor deleted one of two suppressed sites
    // without touching the policy file, over-provisioning the budget.
    writeRepoConfig([{ ...REVIEWED, count: 2 }]);
    writeFileSync(path.join(root, 'a.ts'), 'const value = input as any;\n');
    const code = await runCommand(
      'sanctions-check',
      [],
      deps({ exec: sanctionsExec('{}').exec }),
    );
    expect(code).toBe(1);
    const printed = errors.join('');
    expect(printed).toContain(`${REVIEWED_KEY}: declared 2, found 1`);
    expect(printed).toContain('no longer match the source');
  });

  it('passes when every declared count matches, and still reports grants', async () => {
    // Paired with the case above so a guard that always failed — or never ran —
    // is caught rather than passing silently.
    writeRepoConfig([{ ...REVIEWED, count: 2 }]);
    const code = await runCommand(
      'sanctions-check',
      [],
      deps({ exec: sanctionsExec('{}').exec }),
    );
    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('no longer match the source');
  });

  it('does not read a source file outside the repo to satisfy a count', async () => {
    // A key that escapes the repo must read as ABSENT, not be followed. The
    // escape target really exists and really contains the suppression, so a
    // reader without the containment guard would find it and report no drift.
    const escapee = path.join(root, '..', 'guardrails-escape-probe.ts');
    writeFileSync(escapee, 'const value = input as any;\n');
    try {
      const key =
        '../guardrails-escape-probe.ts|cast-any|const value = input as any;';
      writeFileSync(
        path.join(root, 'guardrails.config.json'),
        JSON.stringify({
          sanctionedSuppressions: [{ key, reason: 'escapes the repo' }],
        }),
      );
      const code = await runCommand(
        'sanctions-check',
        [],
        deps({ exec: sanctionsExec('{}').exec }),
      );
      expect(code).toBe(1);
      expect(errors.join('')).toContain('declared 1, found 0');
    } finally {
      rmSync(escapee, { force: true });
    }
  });
});
