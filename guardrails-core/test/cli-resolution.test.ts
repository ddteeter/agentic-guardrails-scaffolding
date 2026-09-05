/**
 * The resolution contract the generated hook command depends on, as a test.
 *
 * Every hook now runs `node -e "import('guardrails-core/cli')"`, so Node's
 * upward `node_modules` walk — not any code in this repo — decides whether the
 * guardrail runs at all. These are the layouts an adopter can be in; the design
 * they justify is in docs/superpowers/specs/2026-09-02-cli-resolution-design.md
 * §3, and this file is what keeps that section honest.
 *
 * The fixtures install a SYNTHETIC package rather than the real build: the
 * subject here is Node's resolution algorithm and our `exports` shape, and a
 * synthetic package needs no `dist/` to exist. `package-exports.test.ts` pins
 * the real map; `smoke:tarball` proves the real tarball.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLI_PREFIX } from './hook-command.js';

let root: string;

beforeEach(() => {
  // realpathSync is load-bearing, not tidiness. On macOS `tmpdir()` is
  // /var/folders/..., a symlink to /private/var/folders/..., and Node returns
  // the REALPATH of a resolved module — the same property that puts this repo's
  // workspace symlink inside its own repo (spec §3, layout E). Without this,
  // every `self` assertion below compares /private/var against /var and fails.
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'guardrails-resolve-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
Install a synthetic guardrails-core into `<where>/node_modules`.
*/
function install(where: string): string {
  const installed = path.join(where, 'node_modules', 'guardrails-core', 'dist');
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    path.join(where, 'node_modules', 'guardrails-core', 'package.json'),
    JSON.stringify({
      name: 'guardrails-core',
      version: '0.0.0-fixture',
      type: 'module',
      exports: { './cli': './dist/cli.mjs' },
    }),
  );
  const cli = path.join(installed, 'cli.mjs');
  writeFileSync(
    cli,
    [
      "import { fileURLToPath } from 'node:url';",
      'console.log(JSON.stringify({',
      '  self: fileURLToPath(import.meta.url),',
      '  argv: process.argv.slice(2),',
      '}));',
    ].join('\n'),
  );
  return cli;
}

interface Probe {
  status: number | null;
  self: string | undefined;
  argv: string[] | undefined;
  stderr: string;
}

/**
Run the exact invocation the hook configs generate, from `cwd`.
*/
function probe(cwd: string): Probe {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "import('guardrails-core/cli')",
      'guardrails',
      'gate',
      '--mode=stop',
    ],
    { cwd, encoding: 'utf8' },
  );
  const parsed =
    result.status === 0
      ? (JSON.parse(result.stdout) as { self: string; argv: string[] })
      : undefined;
  return {
    status: result.status,
    self: parsed?.self,
    argv: parsed?.argv,
    stderr: result.stderr,
  };
}

describe('hook command resolution', () => {
  it('uses the same specifier the generated hook commands carry', () => {
    // Ties the probe above to the string every config emits, so this file
    // cannot drift into testing an invocation nothing ships.
    expect(CLI_PREFIX).toContain("import('guardrails-core/cli')");
    expect(CLI_PREFIX).toContain('node -e');
  });

  it('passes the subcommand through as argv[2] onward (layout A)', () => {
    // `node -e` puts the first argument at argv[1], where a script path
    // normally sits, so the literal `guardrails` restores the offset
    // `process.argv.slice(2)` in cli.ts expects.
    install(root);
    expect(probe(root).argv).toEqual(['gate', '--mode=stop']);
  });

  it('resolves from a flat install at the repo root (layout A)', () => {
    const cli = install(root);
    expect(probe(root).self).toBe(cli);
  });

  it('resolves an ancestor install from a subpackage (layout B, npm hoisting)', () => {
    const cli = install(root);
    const web = path.join(root, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    expect(probe(web).self).toBe(cli);
  });

  it('resolves through a store symlink (layout C, pnpm-shaped)', () => {
    const web = path.join(root, 'packages', 'web');
    const store = path.join(web, 'node_modules', '.pnpm', 'guardrails-core');
    mkdirSync(store, { recursive: true });
    const real = install(store);
    symlinkSync(
      path.join(store, 'node_modules', 'guardrails-core'),
      path.join(web, 'node_modules', 'guardrails-core'),
    );
    // Resolution returns the REALPATH, which is why this repo's own workspace
    // symlink lands inside the repo and passes the CLI's out-of-repo check.
    expect(probe(web).self).toBe(real);
  });

  it('fails loudly, naming the package and the base (layout D)', () => {
    // Deps only in the subpackage, invoked from the repo root. Genuinely
    // unresolvable — no strategy fixes it — but the error says where it looked,
    // unlike the empty `$(git rev-parse ...)` expansion this replaces, which
    // produced "/node_modules/..." and an opaque MODULE_NOT_FOUND.
    const web = path.join(root, 'packages', 'web');
    mkdirSync(web, { recursive: true });
    install(web);
    const result = probe(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('guardrails-core');
    expect(result.stderr).toContain('[eval]');
  });

  it('reaches an install ABOVE the repo, which is why the CLI bounds itself (layout F)', () => {
    // Node's walk does not stop at a repository. This is the escape the
    // out-of-repo self-check exists to catch; asserting it here keeps the
    // justification for that check from becoming folklore.
    const cli = install(root);
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(probe(repo).self).toBe(cli);
  });
});
