/**
 * The packages whose versions can change a mutation verdict (#177), read from
 * a real `node_modules` layout on disk.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Exec, spawnExec } from '../../src/exec.js';
import {
  gitManifestLister,
  nodeDependencySeams,
  type DependencySeams,
  verdictDependencyPins,
} from '../../src/verify/verdict-dependencies.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'guardrails-verdict-deps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
}

function writeManifest(directory: string, manifest: Manifest): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
}

/**
Installs `name@version` under `<at>/node_modules`, with its own deps.
*/
function install(
  at: string,
  name: string,
  version: string,
  dependencies: Partial<Manifest> = {},
): string {
  const directory = path.join(at, 'node_modules', name);
  writeManifest(directory, { name, version, ...dependencies });
  return directory;
}

/**
Seams over the real filesystem, listing `tracked` as the tracked manifests.
*/
function seams(tracked: readonly string[] | undefined): DependencySeams {
  return nodeDependencySeams(() => Promise.resolve(tracked));
}

function pinsOf(
  tracked: readonly string[] | undefined = ['package.json'],
  extra: readonly string[] = [],
): Promise<string[] | undefined> {
  return verdictDependencyPins(seams(tracked), root, extra);
}

describe('verdictDependencyPins', () => {
  it('pins every runtime dependency and the test stack, not the other dev tools', async () => {
    writeManifest(root, {
      dependencies: { zod: '^4' },
      devDependencies: { vitest: '^4', prettier: '^3', eslint: '^9' },
    });
    install(root, 'zod', '4.1.0');
    install(root, 'vitest', '4.1.10');
    install(root, 'prettier', '3.6.0');
    install(root, 'eslint', '9.30.0');
    expect(await pinsOf()).toEqual(['vitest@4.1.10', 'zod@4.1.0']);
  });

  it.each([
    '@stryker-mutator/vitest-runner',
    '@vitest/coverage-v8',
    'jest',
    '@jest/globals',
    'ts-jest',
    'babel-jest',
    'mocha',
    'ava',
    'jasmine',
    'karma',
    'karma-chrome-launcher',
    '@testing-library/react',
    'jsdom',
    'happy-dom',
    '@cloudflare/vitest-pool-workers',
    'typescript',
    'tsx',
    'esbuild',
  ])('counts %s as part of the test stack', async (name) => {
    writeManifest(root, { devDependencies: { [name]: '*' } });
    install(root, name, '1.0.0');
    expect(await pinsOf()).toEqual([`${name}@1.0.0`]);
  });

  it.each(['karmafoo', 'not-karma', 'xkarma-runner'])(
    'does not count %s, which only contains karma',
    async (name) => {
      writeManifest(root, { devDependencies: { [name]: '*' } });
      install(root, name, '1.0.0');
      expect(await pinsOf()).toEqual([]);
    },
  );

  it('follows dependencies and peers transitively, but not optional ones', async () => {
    writeManifest(root, { dependencies: { app: '*' } });
    install(root, 'app', '1.0.0', {
      dependencies: { lib: '*' },
      peerDependencies: { react: '*' },
      optionalDependencies: { '@esbuild/darwin-arm64': '*' },
    });
    install(root, 'lib', '2.0.0', { dependencies: { deep: '*' } });
    install(root, 'deep', '3.0.0');
    install(root, 'react', '19.0.0');
    install(root, '@esbuild/darwin-arm64', '0.25.0');
    expect(await pinsOf()).toEqual([
      'app@1.0.0',
      'deep@3.0.0',
      'lib@2.0.0',
      'react@19.0.0',
    ]);
  });

  it('does not follow an optional peer', async () => {
    writeManifest(root, { dependencies: { orm: '*' } });
    install(root, 'orm', '1.0.0', {
      peerDependencies: { pg: '*', mysql2: '*', core: '*' },
      peerDependenciesMeta: {
        pg: { optional: true },
        mysql2: { optional: true },
        core: { optional: false },
      },
    });
    install(root, 'pg', '8.0.0');
    install(root, 'core', '1.0.0');
    expect(await pinsOf()).toEqual(['core@1.0.0', 'orm@1.0.0']);
  });

  it('ignores peer metadata that is not an object', async () => {
    writeManifest(root, { dependencies: { orm: '*' } });
    install(root, 'orm', '1.0.0', {
      peerDependencies: { pg: '*', core: '*' },
      peerDependenciesMeta: { pg: true, core: 'optional' },
    });
    install(root, 'pg', '8.0.0');
    install(root, 'core', '1.0.0');
    expect(await pinsOf()).toEqual(['core@1.0.0', 'orm@1.0.0', 'pg@8.0.0']);
  });

  it('does not follow what an uncounted dev tool depends on', async () => {
    writeManifest(root, { devDependencies: { prettier: '*' } });
    install(root, 'prettier', '3.6.0', { dependencies: { shared: '*' } });
    install(root, 'shared', '1.0.0');
    expect(await pinsOf()).toEqual([]);
  });

  it('resolves from the nearest node_modules, so a nested copy wins over a hoisted one', async () => {
    writeManifest(root, { dependencies: { app: '*', lib: '*' } });
    const app = install(root, 'app', '1.0.0', { dependencies: { lib: '*' } });
    install(root, 'lib', '2.0.0');
    install(app, 'lib', '1.5.0');
    expect(await pinsOf()).toEqual(['app@1.0.0', 'lib@1.5.0', 'lib@2.0.0']);
  });

  it('resolves through a symlink from the real path, as pnpm lays packages out', async () => {
    writeManifest(root, { dependencies: { app: '*' } });
    const store = path.join(root, 'node_modules', '.pnpm', 'app@1.0.0');
    const real = install(store, 'app', '1.0.0', { dependencies: { lib: '*' } });
    install(store, 'lib', '2.0.0');
    symlinkSync(real, path.join(root, 'node_modules', 'app'), 'dir');
    expect(await pinsOf()).toEqual(['app@1.0.0', 'lib@2.0.0']);
  });

  it('terminates on a dependency cycle', async () => {
    writeManifest(root, { dependencies: { a: '*' } });
    install(root, 'a', '1.0.0', { dependencies: { b: '*' } });
    install(root, 'b', '1.0.0', { dependencies: { a: '*' } });
    expect(await pinsOf()).toEqual(['a@1.0.0', 'b@1.0.0']);
  });

  it('pins a package that is not installed as missing, and stops there', async () => {
    writeManifest(root, { dependencies: { gone: '*' } });
    expect(await pinsOf()).toEqual(['gone@missing']);
  });

  it('pins an installed package with no version as unversioned', async () => {
    writeManifest(root, { dependencies: { odd: '*' } });
    writeManifest(path.join(root, 'node_modules', 'odd'), { name: 'odd' });
    expect(await pinsOf()).toEqual(['odd@unversioned']);
  });

  it('counts every tracked manifest, as a workspace member resolves its own', async () => {
    writeManifest(root, { devDependencies: { vitest: '*' } });
    const member = path.join(root, 'packages', 'api');
    writeManifest(member, { dependencies: { hono: '*' } });
    install(root, 'vitest', '4.1.10');
    install(member, 'hono', '4.0.0');
    expect(await pinsOf(['package.json', 'packages/api/package.json'])).toEqual(
      ['hono@4.0.0', 'vitest@4.1.10'],
    );
  });

  it('ignores a tracked file that only ends in package.json, or that is not JSON', async () => {
    writeManifest(root, { dependencies: { zod: '*' } });
    install(root, 'zod', '4.1.0');
    writeFileSync(
      path.join(root, 'not-package.json'),
      '{"dependencies":{"x":"*"}}',
    );
    mkdirSync(path.join(root, 'broken'));
    writeFileSync(path.join(root, 'broken', 'package.json'), 'nope');
    expect(
      await pinsOf(['package.json', 'not-package.json', 'broken/package.json']),
    ).toEqual(['zod@4.1.0']);
  });

  it('adds the names the project lists, resolved from the repo root', async () => {
    writeManifest(root, { devDependencies: { '@vitejs/plugin-react': '*' } });
    install(root, '@vitejs/plugin-react', '5.0.0');
    expect(await pinsOf(['package.json'], ['@vitejs/plugin-react'])).toEqual([
      '@vitejs/plugin-react@5.0.0',
    ]);
  });

  it('has no answer when the tracked manifests cannot be listed', async () => {
    writeManifest(root, { dependencies: { zod: '*' } });
    expect(
      await verdictDependencyPins(seams(undefined), root, []),
    ).toBeUndefined();
  });

  it('has no answer when no tracked manifest could be read', async () => {
    expect(await pinsOf(['package.json'])).toBeUndefined();
  });
});

/**
 * GIT_* stripped: under a hook they point at the real repository.
 */
const exec: Exec = (command, args, options) =>
  spawnExec(command, args, {
    ...options,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
  });

const killed: Exec = () =>
  Promise.resolve({
    stdout: 'package.json\0',
    stderr: '',
    code: 0,
    signal: 'SIGTERM',
  });

async function git(...args: string[]): Promise<void> {
  const result = await exec('git', args, { cwd: root });
  expect(result.code, result.stderr).toBe(0);
}

describe('gitManifestLister', () => {
  it('lists the tracked package.json files at any depth, and nothing else', async () => {
    await git('init', '-q');
    writeManifest(root, {});
    writeManifest(path.join(root, 'packages', 'api'), {});
    writeFileSync(path.join(root, 'not-package.json'), '{}');
    await git('add', '-A');
    writeManifest(path.join(root, 'untracked'), {});
    const listed = await gitManifestLister(exec, root)();
    expect(
      listed?.toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['package.json', 'packages/api/package.json']);
  });

  it('has no answer outside a repository', async () => {
    expect(await gitManifestLister(exec, root)()).toBeUndefined();
  });

  it('has no answer when git is killed', async () => {
    expect(await gitManifestLister(killed, root)()).toBeUndefined();
  });
});
