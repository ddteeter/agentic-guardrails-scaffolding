/**
 * Parity fixtures (GR-01): a consumer repository described as data, written
 * to a temporary directory and run through the real analyzers.
 *
 * A fixture is JSON rather than files on disk for two reasons that both come
 * from this repository gating itself. The diff auditor reads `.ts` files
 * added in a commit, so a checked-in fixture holding a real suppression
 * would block the commit that adds it. And a fixture directory with its own
 * `package.json` and tool configs would need excluding by hand from this
 * repository's tsconfig, ESLint, knip and fallow, and would be copied into
 * Stryker's sandbox.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = path.resolve(here, '..', 'fixtures', 'parity');
export const GOLDEN_DIRECTORY = path.join(here, 'goldens');
const REPO_ROOT = path.resolve(here, '..', '..', '..');

/**
The files every fixture starts from; a fixture's own `base` is laid over it.
*/
const COMMON_BASE = '_base';

export interface ParityFixture {
  description: string;
  /**
   * `link` (the default) symlinks this repository's `node_modules`, so the
   * real analyzers resolve. `none` leaves the fixture's own files alone: the
   * `npm-peers` fixture ships a hand-built tree.
   */
  nodeModules?: 'link' | 'none';
  /**
  Committed on `main`. A `null` drops a file the common base provides.
  */
  base: Record<string, string | null>;
  /**
  Staged on a `work` branch, not committed.
  */
  change: Record<string, string>;
}

function readFixtureFile(name: string): ParityFixture {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIRECTORY, `${name}.json`), 'utf8'),
  ) as ParityFixture;
}

/**
Every fixture by name, the common base excluded.
*/
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter((name) => name !== COMMON_BASE)
    .toSorted((left, right) => left.localeCompare(right));
}

export function loadFixture(name: string): ParityFixture {
  const fixture = readFixtureFile(name);
  return {
    ...fixture,
    base: { ...readFixtureFile(COMMON_BASE).base, ...fixture.base },
  };
}

/**
 * The environment every git call in a fixture runs with. `GIT_*` is dropped:
 * git exports GIT_DIR and GIT_INDEX_FILE into hook processes, this suite runs
 * under the pre-push hook, and those variables override `cwd` (#223).
 */
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

function git(root: string, args: readonly string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=parity',
      '-c',
      'user.email=parity@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, env: cleanEnvironment(), stdio: 'pipe' },
  );
}

function writeFiles(
  root: string,
  files: Readonly<Record<string, string | null>>,
): void {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) {
      continue;
    }
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Write `fixture` as a git repository and return its root: the base files
 * committed on `main`, then the change staged on `work`. One staged change
 * serves every rung: the commit rung reads the index, and the push and ci
 * rungs diff the working tree against the merge-base.
 */
export function materialise(fixture: ParityFixture): string {
  // realpath: on macOS the temporary directory is a symlink, and the tools
  // report the resolved path.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parity-')));
  writeFiles(root, fixture.base);
  if (fixture.nodeModules !== 'none') {
    symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(root, 'node_modules'),
      'dir',
    );
  }
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '--message', 'base']);
  git(root, ['checkout', '--quiet', '-b', 'work']);
  writeFiles(root, fixture.change);
  git(root, ['add', '--all']);
  return root;
}
