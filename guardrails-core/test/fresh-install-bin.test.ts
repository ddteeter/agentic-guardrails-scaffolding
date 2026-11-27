/**
 * One `npm ci` in a fresh clone or worktree of THIS repo must leave
 * `node_modules/.bin/guardrails-core` behind.
 *
 * The workspace's `bin` points at `dist/cli.mjs`, and `dist/` is gitignored:
 * the root `prepare` script builds it, AFTER npm has linked bins, and npm
 * skips a bin whose target does not exist. So a first install had no link, and
 * `npx guardrails-core ...` walked up to whatever an enclosing checkout had
 * built -- which the CLI then refuses as "resolved from ... which is outside".
 * A second `npm install --ignore-scripts` made the link; nobody runs one.
 *
 * Driven through REAL npm, in a throwaway workspace with no dependencies (so
 * nothing is fetched), running this repo's own `prepare` script verbatim. Only
 * `husky` and the build are stand-ins: the build writes the file the real one
 * would, at the path this repo's `bin` names.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.join(import.meta.dirname, '..', '..');

interface PackageJson {
  bin: Record<string, string>;
  scripts: Record<string, string>;
}

function readPackage(...segments: string[]): PackageJson {
  return JSON.parse(
    readFileSync(path.join(repoRoot, ...segments, 'package.json'), 'utf8'),
  ) as PackageJson;
}

const PREPARE = readPackage().scripts.prepare ?? '';
const BIN = readPackage('guardrails-core').bin;
const BIN_TARGET = BIN['guardrails-core'] ?? '';

/**
What a fresh install had before the fix: build, and nothing after it.
*/
const PREPARE_WITHOUT_LINK = 'husky && npm run build';

let sandbox: string;
let checkout: string;
let environment: NodeJS.ProcessEnv;

/**
`npm` in the throwaway checkout, offline, failing loudly.
*/
function npm(...args: string[]): void {
  const result = spawnSync(
    'npm',
    [...args, '--offline', '--no-audit', '--no-fund'],
    { cwd: checkout, encoding: 'utf8', env: environment },
  );
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.stderr}`);
  }
}

/**
A clone as git hands it over: sources and a lockfile, no `dist/`.
*/
function freshClone(prepare: string): void {
  writeFileSync(
    path.join(checkout, 'package.json'),
    JSON.stringify({
      name: 'fresh-clone',
      version: '0.0.0',
      private: true,
      workspaces: ['guardrails-core'],
      scripts: { build: 'node build.mjs', prepare },
    }),
  );
  writeFileSync(
    path.join(checkout, 'build.mjs'),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      `const target = path.join('guardrails-core', ${JSON.stringify(BIN_TARGET)});`,
      'mkdirSync(path.dirname(target), { recursive: true });',
      String.raw`writeFileSync(target, "#!/usr/bin/env node\nconsole.log('the built cli');\n");`,
      '',
    ].join('\n'),
  );
  mkdirSync(path.join(checkout, 'guardrails-core'));
  writeFileSync(
    path.join(checkout, 'guardrails-core', 'package.json'),
    JSON.stringify({ name: 'guardrails-core', version: '0.0.0', bin: BIN }),
  );
  npm('install', '--package-lock-only', '--ignore-scripts');
}

function linkedBin(): string {
  return path.join(checkout, 'node_modules', '.bin', 'guardrails-core');
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'guardrails-fresh-install-'));
  checkout = path.join(sandbox, 'checkout');
  mkdirSync(checkout);

  // `husky` is the first word of `prepare`, and this workspace installs
  // nothing, so a stand-in answers for it.
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const husky = path.join(bin, 'husky');
  writeFileSync(husky, '#!/bin/sh\nexit 0\n');
  chmodSync(husky, 0o755);

  // This suite runs under `npm test` and under git hooks. Both export
  // settings (`npm_config_*`, `GIT_DIR`) that would aim the npm spawned here
  // at the real checkout instead of the throwaway one.
  environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:npm_|GIT_)/i.test(key),
      ),
    ),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('a fresh install of this repo', () => {
  it('points the workspace bin at a file only the build creates', () => {
    // The premise of everything below: were `dist/` committed, npm would link
    // the bin on its own and `prepare` would have nothing to repair.
    expect(BIN_TARGET).toBe('./dist/cli.mjs');
    expect(
      readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split('\n'),
    ).toContain('dist/');
  });

  it(
    'has no bin link after one `npm ci` when prepare only builds',
    { timeout: 120_000 },
    () => {
      freshClone(PREPARE_WITHOUT_LINK);
      npm('ci');
      // Built, so the target exists by now -- and still no link to it.
      expect(
        existsSync(path.join(checkout, 'guardrails-core', BIN_TARGET)),
      ).toBe(true);
      expect(existsSync(linkedBin())).toBe(false);
    },
  );

  it(
    'has a working bin link after one `npm ci` with this repo’s prepare',
    { timeout: 120_000 },
    () => {
      freshClone(PREPARE);
      npm('ci');
      expect(existsSync(linkedBin())).toBe(true);
      const ran = spawnSync(linkedBin(), [], {
        cwd: checkout,
        encoding: 'utf8',
        env: environment,
      });
      expect(ran.stdout).toBe('the built cli\n');
    },
  );
});
