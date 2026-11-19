/**
 * The installed packages whose versions can change a mutation verdict (#177),
 * as `name@version` pins for the cache fingerprint.
 *
 * The fingerprint used to hash every lockfile, so a formatter or linter bump
 * threw away every cached and seeded verdict. What can change whether a mutant
 * is killed is the code the project runs and the stack that runs its tests:
 *
 * - every `dependencies` and required `peerDependencies` entry of every tracked
 *   `package.json` (the root and each workspace member, whatever the package
 *   manager calls its workspaces);
 * - the `devDependencies` that run the tests (`TEST_STACK`), and any names the
 *   project adds with `mutationCache.verdictDependencies`;
 * - and, transitively, what each of those depends on, resolved through
 *   `node_modules` as Node resolves it.
 *
 * Versions come from the installed manifests, not a lockfile, so npm, pnpm,
 * yarn and bun are one code path, and a resolution follows a package's REAL
 * path so pnpm's symlinked store resolves its siblings. `optionalDependencies`
 * are not followed: they are where platform binaries live, and a macOS
 * checkout and Linux CI install different ones, so counting them would make a
 * CI seed never match a local checkout. The parent's version, which those
 * binaries follow, still counts.
 */

import { readFile as fsReadFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { Exec } from '../exec.js';
import { isRecord } from '../is-record.js';
import { parseJsonText } from '../json-file.js';
import { upwardFrom } from '../path-walk.js';

/**
 * The devDependencies that run the tests, so their versions can change a
 * verdict. Every other devDependency -- linters, formatters, build tools --
 * cannot. `typescript` is here because stryker's TypeScript checker turns a
 * type error into `CompileError`; `tsx` and `esbuild` because they transpile
 * the code under test.
 */
const TEST_STACK_NAMES = new Set([
  'vitest',
  'jest',
  'ts-jest',
  'babel-jest',
  'mocha',
  'ava',
  'jasmine',
  'jsdom',
  'happy-dom',
  '@cloudflare/vitest-pool-workers',
  'typescript',
  'tsx',
  'esbuild',
]);

/**
Scopes whose every package runs the tests: `<scope>.+`.
*/
const TEST_STACK_SCOPES = [
  '@stryker-mutator/',
  '@vitest/',
  '@jest/',
  '@testing-library/',
];

function isTestStack(name: string): boolean {
  if (TEST_STACK_NAMES.has(name) || /^karma(?:-.+)?$/.test(name)) {
    return true;
  }
  return TEST_STACK_SCOPES.some((scope) => name.startsWith(scope));
}

export interface DependencySeams {
  /**
  Repo-relative paths of the tracked `package.json` files, or `undefined`.
  */
  listManifests: () => Promise<readonly string[] | undefined>;
  /**
  Reads a file; throws when it is not there.
  */
  readFile: (filePath: string) => Promise<string>;
  realPath: (filePath: string) => Promise<string>;
}

/**
The real filesystem, with `listManifests` from the caller.
*/
export function nodeDependencySeams(
  listManifests: DependencySeams['listManifests'],
): DependencySeams {
  return {
    listManifests,
    readFile: (filePath) => fsReadFile(filePath, 'utf8'),
    realPath: (filePath) => realpath(filePath),
  };
}

/**
 * The tracked `package.json` files, from git: the same set in every checkout
 * of a commit, and never a nested worktree's or a sandbox's. `undefined` when
 * git cannot answer.
 */
export function gitManifestLister(
  exec: Exec,
  repoRoot: string,
): DependencySeams['listManifests'] {
  return async () => {
    const listed = await exec(
      'git',
      ['ls-files', '-z', '--', 'package.json', '*/package.json'],
      { cwd: repoRoot },
    );
    if (listed.code !== 0 || listed.signal !== undefined) {
      return;
    }
    return listed.stdout.split('\0').filter((file) => file !== '');
  };
}

type Fields = Record<string, unknown>;

function parseManifest(text: string): Fields | undefined {
  const { parsed } = parseJsonText(text);
  return isRecord(parsed) ? parsed : undefined;
}

function namesIn(manifest: Fields, field: string): string[] {
  const entries = manifest[field];
  return isRecord(entries) ? Object.keys(entries) : [];
}

/**
Is `name` a peer this manifest marks optional in `peerDependenciesMeta`?
*/
function isOptionalPeer(manifest: Fields, name: string): boolean {
  const meta = manifest.peerDependenciesMeta;
  const entry = isRecord(meta) ? meta[name] : undefined;
  return isRecord(entry) && entry.optional === true;
}

/**
 * What a package's own manifest makes it depend on at runtime. Optional peers
 * are left out: one flips from missing to installed whenever an unrelated
 * tool happens to pull it in, and a project that really uses one lists it
 * itself, where it counts.
 */
function runtimeNames(manifest: Fields): string[] {
  return [
    ...namesIn(manifest, 'dependencies'),
    ...namesIn(manifest, 'peerDependencies').filter(
      (name) => !isOptionalPeer(manifest, name),
    ),
  ];
}

/**
A package that resolved: where it really is, and its manifest.
*/
interface Resolved {
  directory: string;
  manifest: Fields;
}

/**
 * `name` as Node resolves it from `from`: the nearest `node_modules/<name>` at
 * or above it, at its real path. `undefined` when none is installed.
 */
async function resolvePackage(
  seams: DependencySeams,
  from: string,
  name: string,
): Promise<Resolved | undefined> {
  for (const directory of upwardFrom(from)) {
    const candidate = path.join(directory, 'node_modules', name);
    let text: string;
    try {
      text = await seams.readFile(path.join(candidate, 'package.json'));
    } catch {
      continue;
    }
    return {
      directory: await seams.realPath(candidate),
      manifest: parseManifest(text) ?? {},
    };
  }
  return undefined;
}

interface Request {
  from: string;
  name: string;
}

/**
The names a tracked manifest counts, each to resolve from its directory.
*/
function rootRequests(directory: string, manifest: Fields): Request[] {
  return [
    ...runtimeNames(manifest),
    ...namesIn(manifest, 'devDependencies').filter((name) => isTestStack(name)),
  ].map((name) => ({ from: directory, name }));
}

async function readTrackedManifests(
  seams: DependencySeams,
  repoRoot: string,
  tracked: readonly string[],
): Promise<Resolved[]> {
  const manifests = tracked.filter(
    (file) => path.posix.basename(file) === 'package.json',
  );
  const read = await Promise.all(
    manifests.map(async (file): Promise<Resolved[]> => {
      const directory = path.join(repoRoot, path.dirname(file));
      try {
        const manifest = parseManifest(
          await seams.readFile(path.join(repoRoot, file)),
        );
        return manifest === undefined ? [] : [{ directory, manifest }];
      } catch {
        return [];
      }
    }),
  );
  return read.flat();
}

function pinOf(name: string, resolved: Resolved | undefined): string {
  if (resolved === undefined) {
    return `${name}@missing`;
  }
  const { version } = resolved.manifest;
  return `${name}@${typeof version === 'string' ? version : 'unversioned'}`;
}

/**
 * The requests a resolved package makes, or none when it did not resolve or
 * was already walked.
 */
function expand(found: Resolved | undefined, walked: Set<string>): Request[] {
  if (found === undefined || walked.has(found.directory)) {
    return [];
  }
  walked.add(found.directory);
  return runtimeNames(found.manifest).map((dependency) => ({
    from: found.directory,
    name: dependency,
  }));
}

/**
 * Every pin the walk reaches from the tracked manifests and `extraNames`,
 * sorted, or `undefined` when the manifests cannot be listed or none could be
 * read -- the caller then falls back to the lockfiles.
 */
export async function verdictDependencyPins(
  seams: DependencySeams,
  repoRoot: string,
  extraNames: readonly string[],
): Promise<string[] | undefined> {
  const tracked = await seams.listManifests();
  if (tracked === undefined) {
    return undefined;
  }
  const roots = await readTrackedManifests(seams, repoRoot, tracked);
  if (roots.length === 0) {
    return undefined;
  }
  const pins = new Set<string>();
  const walked = new Set<string>();
  let frontier: Request[] = [
    ...roots.flatMap(({ directory, manifest }) =>
      rootRequests(directory, manifest),
    ),
    ...extraNames.map((name) => ({ from: repoRoot, name })),
  ];
  // Breadth-first, each level read concurrently: the closure of a real
  // project is hundreds to thousands of manifests.
  while (frontier.length > 0) {
    const resolved = await Promise.all(
      frontier.map(async (request) => ({
        name: request.name,
        found: await resolvePackage(seams, request.from, request.name),
      })),
    );
    const next: Request[] = [];
    for (const { name, found } of resolved) {
      pins.add(pinOf(name, found));
      next.push(...expand(found, walked));
    }
    frontier = next;
  }
  return [...pins].toSorted((left, right) => left.localeCompare(right));
}
