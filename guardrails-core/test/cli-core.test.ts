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
  saveSession,
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
    selfPath: path.join(
      root,
      'node_modules',
      'guardrails-core',
      'dist',
      'cli.mjs',
    ),
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

function writeActiveViolations(
  sessionId: string,
  violations: readonly Violation[],
): void {
  const directory = stateDirectory(root);
  writeViolations(directory, sessionId, violations);
  writeFileSync(path.join(directory, `${sessionId}.pre-fix.json`), '[]');
}

/** A repo whose commit gate blocks: one eslint error on a changed TS file.
 *  `enforcement` is written into the config the command will load. */
function blockingCommitDeps(enforcement: 'warn' | 'block'): CliDeps {
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ baseBranch: 'main', enforcement }),
  );
  const eslintJson = JSON.stringify([
    {
      filePath: path.join(root, 'src/foo.ts'),
      messages: [
        {
          ruleId: 'no-console',
          severity: 2,
          message: 'Unexpected console.',
          line: 1,
        },
      ],
    },
  ]);
  const exec: Exec = (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.includes('--name-only')) return Promise.resolve(ok('src/foo.ts'));
    if (line.includes('eslint')) return Promise.resolve(ok(eslintJson));
    // merge-base resolves to nothing, so branchDiff falls back to the staged
    // diff, which is empty — the block comes from the violation, not a finding.
    return Promise.resolve(ok(''));
  };
  return deps({ exec });
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
    writeActiveViolations('sid', [violation('src/allowed.ts')]);
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
    writeActiveViolations('sid', [violation('src/allowed.ts')]);
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

  it('denies a fixer Read outside the repo (e.g. ~/.claude memory)', async () => {
    // The manifest is what makes this a FIXER session. Without it the read
    // lock must stand aside -- see 'allows an out-of-repo read when NO fixer
    // is active' below.
    writeActiveViolations('default', [violation('src/a.ts')]);
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
    writeActiveViolations('sid', [violation('src/allowed.ts')]);
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

  // `guardrails/analyzer-missing`, `guardrails/analyzer-failed` (both
  // `file: 'package.json'`) and `guardrails/analyzer-unknown`
  // (`file: 'guardrails.config.json'`) are all error-severity, so a repo with
  // clean code but a missing or crashing analyzer produces a manifest whose
  // every entry names an undeditable policy file — and still spawns a fixer.
  // That manifest must lock the fixer OUT, not disengage the lock.
  describe('a manifest naming only denied files', () => {
    beforeEach(() => {
      writeActiveViolations('sid', [
        violation('package.json'),
        violation('guardrails.config.json'),
      ]);
    });

    it('denies an edit to the denied file itself', async () => {
      expect(
        await runScopeCheck(
          scopeStdin('edit', path.join(root, 'package.json')),
        ),
      ).toContain('deny');
    });

    it('denies an edit to an arbitrary unrelated file', async () => {
      // THE regression pin: an all-denied manifest yields an empty file set,
      // and a scope-lock keyed on "is the set non-empty" would read that as
      // "no fixer is running" and hand the fixer the whole repo.
      expect(
        await runScopeCheck(
          scopeStdin('edit', path.join(root, 'src/anything.ts')),
        ),
      ).toContain('deny');
    });
  });

  it('keeps the non-denied files of a mixed manifest editable', async () => {
    writeActiveViolations('sid', [
      violation('src/allowed.ts'),
      violation('package.json'),
    ]);
    expect(
      await runScopeCheck(
        scopeStdin('edit', path.join(root, 'src/allowed.ts')),
      ),
    ).toBe('');
    expect(
      await runScopeCheck(scopeStdin('edit', path.join(root, 'package.json'))),
    ).toContain('deny');
  });

  it('denies a denied file named with different casing', async () => {
    // macOS and Windows resolve `Package.json` to the real file on write, so a
    // case-sensitive denylist lookup would be a way straight through it.
    writeActiveViolations('sid', [
      violation('src/allowed.ts'),
      violation('Package.json'),
    ]);
    expect(
      await runScopeCheck(scopeStdin('edit', path.join(root, 'Package.json'))),
    ).toContain('deny');
  });

  it('denies a fixer Copilot `view` read outside the repo', async () => {
    writeActiveViolations('default', [violation('src/a.ts')]);
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
    // Explicit 'block': this test is about the deny payload shape, not
    // enforcement, and the default 'warn' would route it to stderr instead.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ enforcement: 'block' }),
    );
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
    // Also asserts stderr: a clean gate must stay fully silent. Without this,
    // a mutant that skips the `!blocked` early return would still pass the
    // stdout check above (the default 'warn' enforcement routes the deny to
    // stderr, not stdout), leaving the mutant alive.
    expect(errors.join('')).toBe('');
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

/** git fake for install-hooks: `rev-parse --show-toplevel` always resolves to
 *  the fixture `root`, regardless of the cwd it is asked from -- which is
 *  exactly what lets a test prove the SECOND call (`git config`) used that
 *  resolved root rather than whatever cwd it was invoked with. `configResult`
 *  is what the `git config` call itself resolves to. */
/**
 * `install-hooks` reads the repo through `detect`, so its fake git has to
 * answer everything `detect` asks: the toplevel, the base branch, and the
 * `core.hooksPath` already configured (`existingHooksPath`, '' for none).
 * Only the WRITE -- `git config core.hooksPath .githooks` -- gets
 * `configResult`.
 */
function installHooksExec(
  configResult: ExecResult,
  existingHooksPath = '',
): {
  exec: Exec;
  calls: { args: string[]; cwd: string | undefined }[];
} {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const exec: Exec = (command, args, execOptions) => {
    calls.push({ args, cwd: execOptions?.cwd });
    if (args[0] === 'rev-parse') {
      return Promise.resolve(ok(`${root}\n`));
    }
    if (args[0] === 'symbolic-ref') {
      return Promise.resolve(ok('origin/main\n'));
    }
    if (args[1] === '--get') {
      return Promise.resolve(ok(existingHooksPath));
    }
    return Promise.resolve(configResult);
  };
  return { exec, calls };
}

const HOOKS_WRITE = ['config', 'core.hooksPath', '.githooks'];

describe('runCommand — install-hooks', () => {
  // `core.hooksPath` is per-clone LOCAL git config: setting it from anywhere
  // but the resolved repo root configures the wrong repository (or none), so
  // the whole point of this command lives in that cwd, not merely its argv.
  it('resolves the repo root and runs git config core.hooksPath there, not from cwd', async () => {
    const subdirectory = path.join(root, 'packages', 'app');
    mkdirSync(subdirectory, { recursive: true });
    const { exec, calls } = installHooksExec(ok(''));
    expect(
      await runCommand('install-hooks', [], deps({ exec, cwd: subdirectory })),
    ).toBe(0);
    expect(calls[0]).toEqual({
      args: ['rev-parse', '--show-toplevel'],
      cwd: subdirectory,
    });
    expect(calls).toContainEqual({ args: HOOKS_WRITE, cwd: root });
  });

  // `scripts.prepare` runs this on EVERY `npm install`, so an unconditional
  // repoint does not merely break a husky consumer's hooks once -- it
  // re-breaks them forever, immediately after `husky` restores them.
  it('leaves an existing foreign core.hooksPath alone and warns instead', async () => {
    const { exec, calls } = installHooksExec(ok(''), '.husky/_\n');
    expect(await runCommand('install-hooks', [], deps({ exec }))).toBe(0);
    expect(calls.map((call) => call.args)).not.toContainEqual(HOOKS_WRITE);
    const warned = errors.join('');
    expect(warned).toContain('.husky/_');
    expect(warned).toContain('.githooks/pre-commit');
  });

  it('still repoints when core.hooksPath already points at .githooks', async () => {
    const { exec, calls } = installHooksExec(ok(''), '.githooks\n');
    expect(await runCommand('install-hooks', [], deps({ exec }))).toBe(0);
    expect(calls.map((call) => call.args)).toContainEqual(HOOKS_WRITE);
    expect(errors.join('')).toBe('');
  });

  it('reports a non-zero git exit and returns 1', async () => {
    const { exec } = installHooksExec({
      stdout: '',
      stderr: 'error: could not lock config file\n',
      code: 1,
    });
    expect(await runCommand('install-hooks', [], deps({ exec }))).toBe(1);
    expect(errors.join('')).toContain('core.hooksPath');
    expect(errors.join('')).toContain('could not lock config file');
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
  // These trigger-condition tests are about the shell-tool + git-write
  // self-filter, not about enforcement, so make that assumption explicit:
  // without it the default 'warn' would route the deny to stderr instead.
  writeFileSync(
    path.join(root, 'guardrails.config.json'),
    JSON.stringify({ enforcement: 'block' }),
  );
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
  it('denies a multi-file Codex patch when any path is outside the manifest', async () => {
    writeActiveViolations('default', [violation('src/allowed.ts')]);
    const command = [
      '*** Begin Patch',
      '*** Update File: src/allowed.ts',
      '*** Add File: src/forbidden.ts',
      '*** End Patch',
    ].join('\n');
    const stdin = JSON.stringify({
      cwd: root,
      tool_name: 'apply_patch',
      tool_input: { command },
    });
    expect(await runScopeCheck(stdin)).toContain('src/forbidden.ts');
  });

  it('denies shell and MCP tools while a fixer manifest is active', async () => {
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('Bash', undefined))).toContain(
      'deny',
    );
    out.length = 0;
    expect(
      await runScopeCheck(scopeStdin('mcp__server__write', undefined)),
    ).toContain('deny');
  });

  it('treats only an exact read-tool name as a read (my-read)', async () => {
    // Kills the READ_TOOLS anchor mutants. Both paths DENY here, so the
    // assertion is on WHICH denial: an unanchored pattern classifies `my-read`
    // as a read and rejects it with the read-scope message, where the correct
    // edit-family path rejects it with the manifest scope-lock message.
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('my-read', OUTSIDE_PATH))).toContain(
      'scope-lock',
    );
  });

  it('treats only an exact read-tool name as a read (read-only)', async () => {
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(
      await runScopeCheck(scopeStdin('read-only', OUTSIDE_PATH)),
    ).toContain('scope-lock');
  });

  it('does not treat an arbitrary defined tool name as a read', async () => {
    // Kills `toolName !== undefined && ...` -> `||` (and -> true): an edit tool
    // would be read-classified and rejected with the read-scope message.
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('edit', OUTSIDE_PATH))).toContain(
      'scope-lock',
    );
  });

  it('still denies a genuine out-of-repo read while a fixer is active', async () => {
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('Read', OUTSIDE_PATH))).toContain(
      'read-scope',
    );
  });

  it('allows an out-of-repo read when NO fixer is active', async () => {
    // The scope-lock is a FIXER lock. With no manifest this session is the
    // main agent, which legitimately reads outside the repo -- the user's
    // ~/.claude memory, a sibling checkout, a build log. The read branch was
    // the only one of the three not gated on `scope.active`, which made the
    // lock permanent for every session in every repo that scaffolds
    // guardrails. Found by it denying the main agent mid-session.
    expect(await runScopeCheck(scopeStdin('Read', OUTSIDE_PATH))).toBe('');
  });

  it('allows an in-repo read while a fixer IS active', async () => {
    // The positive control for the pair above: in-repo exploration is how the
    // thorough tier diagnoses subtle rules, so gating the branch must not turn
    // it into deny-every-read.
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(
      await runScopeCheck(scopeStdin('Read', path.join(root, 'src/other.ts'))),
    ).toBe('');
  });

  it('returns early when no filePath is supplied', async () => {
    // Kills `input.filePath === undefined` -> false: continuing would pass
    // undefined into the path checks.
    writeActiveViolations('default', [violation('src/a.ts')]);
    expect(await runScopeCheck(scopeStdin('edit', undefined))).toBe('');
  });

  it('allows any edit when no manifest is active', async () => {
    // Kills `scope.active` -> true: with no manifest the fixer is not running,
    // and the scope-lock must not interfere. This escape is what the all-denied
    // manifest tests above must NOT be allowed to reuse.
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
    writeActiveViolations('default', [violation('src/a.ts')]);
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
    // gate and never block a dirty commit. `enforcement: 'block'` because the
    // default is 'warn' (see "gate --mode=commit enforcement" below) and this
    // test is about routing, not the enforcement policy.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ enforcement: 'block' }),
    );
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
    const codex = await primeStopGate(3, ['--dialect=codex']);
    rmSync(stateDirectory(root), { recursive: true, force: true });
    const claude = await primeStopGate(3, []);

    expect(copilot).not.toBe('');
    expect(claude).not.toBe('');
    // Claude carries additionalContext in hookSpecificOutput; Copilot inlines
    // it into `reason` because its hook host has no such field.
    expect(claude).toContain('hookSpecificOutput');
    expect(copilot).not.toContain('hookSpecificOutput');
    expect(codex).not.toContain('hookSpecificOutput');
    expect(codex).toContain('reason');
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

  it('forwards the host retry marker into the stop decision', async () => {
    const run = (stopHookActive: boolean) =>
      runCommand(
        'gate',
        ['--mode=stop'],
        deps({
          exec: failingVerifyExec(),
          readStdin: () =>
            Promise.resolve(
              JSON.stringify({
                cwd: root,
                session_id: 'retry-session',
                stop_hook_active: stopHookActive,
              }),
            ),
        }),
      );
    await run(false);
    await run(true);
    const counts = loadSession(
      stateDirectory(root),
      'retry-session',
    ).ruleCounts;
    expect(counts['no-console']).toBe(1);
    expect(counts['guardrails/analyzer-failed']).toBe(1);
  });

  it('warns when an unresolved terminal retry is released', async () => {
    saveSession(stateDirectory(root), 'release-session', {
      attempts: 0,
      escalated: true,
      ruleCounts: {},
      corrected: [],
    });
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({
        exec: failingVerifyExec(),
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              cwd: root,
              session_id: 'release-session',
              stop_hook_active: true,
            }),
          ),
      }),
    );
    expect(out.join('')).toBe('');
    expect(errors.join('')).toContain(
      'releasing Stop retry with unresolved violations',
    );
    expect(errors.join('')).toContain('commit and CI gates remain active');
  });

  it('does not warn about a release when the stop still blocks', async () => {
    await runCommand(
      'gate',
      ['--mode=stop'],
      deps({
        exec: failingVerifyExec(),
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({ cwd: root, session_id: 'blocking-session' }),
          ),
      }),
    );
    expect(out.join('')).toContain('"decision"');
    expect(errors.join('')).not.toContain('releasing Stop retry');
  });

  it('prints each added suppression found by the commit gate', async () => {
    // Kills the findings-loop block removal: the gate would block with no
    // explanation of WHICH suppression tripped it. `enforcement: 'block'`
    // because the default is 'warn' and this test is about the findings
    // message, not the enforcement policy.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({ enforcement: 'block' }),
    );
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
    // `enforcement: 'block'` here (rather than the default 'warn') proves the
    // 0 comes from the exemption clearing the block, not from the enforcement
    // policy silently downgrading a real block to a warning.
    writeFileSync(
      path.join(root, 'guardrails.config.json'),
      JSON.stringify({
        enforcement: 'block',
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
  it('runs eslint --fix on every TypeScript file in a Codex apply_patch', async () => {
    const { exec, calls } = execRecorder();
    const command = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '*** Add File: src/b.tsx',
      '*** Update File: README.md',
      '*** End Patch',
    ].join('\n');
    await runCommand(
      'autofix',
      [],
      deps({
        exec,
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              cwd: root,
              tool_name: 'apply_patch',
              tool_input: { command },
            }),
          ),
      }),
    );
    const eslintCall = calls.find(
      (call) => call[0]?.includes('eslint') === true,
    );
    expect(eslintCall).toContain('src/a.ts');
    expect(eslintCall).toContain('src/b.tsx');
    expect(eslintCall).not.toContain('README.md');
  });

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

describe('gate --mode=commit enforcement', () => {
  it('exits 1 on a blocking violation when enforcement is block', async () => {
    const code = await runCommand(
      'gate',
      ['--mode=commit'],
      blockingCommitDeps('block'),
    );
    expect(code).toBe(1);
    expect(errors.join('')).not.toContain('enforcement: warn');
  });

  it('exits 0 when enforcement is warn, but still prints the violations', async () => {
    const code = await runCommand(
      'gate',
      ['--mode=commit'],
      blockingCommitDeps('warn'),
    );
    expect(code).toBe(0);
    const output = errors.join('');
    expect(output).toContain('not blocking (enforcement: warn)');
    // A passing exit code must never be mistakable for a clean gate.
    expect(output).toContain('no-console');
  });
});

/** As blockingCommitDeps, plus the preToolUse hook payload that gets past the
 *  command's shell-tool + git-commit self-filter. */
function blockingPreToolUseDeps(enforcement: 'warn' | 'block'): CliDeps {
  const base = blockingCommitDeps(enforcement);
  return {
    ...base,
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          cwd: root,
          tool_name: 'bash',
          tool_input: { command: 'git commit -m x' },
        }),
      ),
  };
}

describe('gate --mode=pretooluse enforcement', () => {
  it('emits a deny payload when enforcement is block', async () => {
    await runCommand(
      'gate',
      ['--mode=pretooluse'],
      blockingPreToolUseDeps('block'),
    );
    expect(out.join('')).toContain('deny');
  });

  it('writes feedback to stderr and emits no deny payload when enforcement is warn', async () => {
    await runCommand(
      'gate',
      ['--mode=pretooluse'],
      blockingPreToolUseDeps('warn'),
    );
    // A deny payload IS the block in both hook dialects, so there is no
    // allow-with-message channel: stdout must stay empty.
    expect(out.join('')).toBe('');
    const output = errors.join('');
    expect(output).toContain('not blocking (enforcement: warn)');
    // Counts alone would leave a zero-exit hook mistakable for a clean gate, so
    // this path prints the same per-violation detail its commit-gate sibling
    // does, and the same pointer at the setting that makes it enforce.
    expect(output).toContain('src/foo.ts:1 [no-console] Unexpected console.');
    expect(output).toContain('"enforcement": "block"');
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

describe('out-of-repo self-check', () => {
  it('refuses to run when resolved from outside the repository', async () => {
    // Node's node_modules walk does not stop at the repo, so an install in an
    // ancestor directory satisfies it. Guarding a repo with a version nobody
    // in it chose, silently, is worse than not running.
    mkdirSync(path.join(root, '.git'));
    const outside = path.join(
      path.dirname(root),
      'node_modules',
      'guardrails-core',
      'dist',
      'cli.mjs',
    );

    const code = await runCommand('verify', [], deps({ selfPath: outside }));

    expect(code).not.toBe(0);
    expect(errors.join('')).toContain(outside);
    expect(errors.join('')).toContain(root);
  });

  it('runs normally when resolved from inside the repository', async () => {
    mkdirSync(path.join(root, '.git'));
    const inside = path.join(
      root,
      'node_modules',
      'guardrails-core',
      'dist',
      'cli.mjs',
    );

    const code = await runCommand('verify', [], deps({ selfPath: inside }));

    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('outside');
  });

  it('skips the check when there is no repository to bound', async () => {
    // Advisory, not authoritative: a non-git directory has no boundary, so the
    // check must degrade to today's behaviour rather than reject a directory
    // it cannot bound. `root` has no .git here.
    const outside = path.join(path.dirname(root), 'elsewhere', 'cli.mjs');

    const code = await runCommand('verify', [], deps({ selfPath: outside }));

    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('outside');
  });

  it('falls back to import.meta.url when selfPath is not injected', async () => {
    // Production-only path: cli.ts is a logic-free wire that must stay out of
    // the mutation gate's diff scope, so it cannot inject selfPath itself.
    // outsideRepoMessage falls back to reading import.meta.url from inside
    // this already-covered module instead. Under vitest that resolves to
    // cli-core.ts's own real source path, so the fixture directory must be
    // this real repository (not a disposable temp directory the way the
    // other tests here use) for that path to land inside the bound.
    const { selfPath: _selfPath, ...withoutSelfPath } = deps({
      cwd: process.cwd(),
    });

    const code = await runCommand('verify', [], withoutSelfPath);

    expect(code).toBe(0);
    expect(errors.join('')).not.toContain('outside');
  });
});
