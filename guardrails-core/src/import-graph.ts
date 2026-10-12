/**
 * Which in-repo files a source text imports, answered by the consumer's own
 * TypeScript (#120).
 *
 * The covering-test lookup used to find imports with a regex and resolve them
 * by guessing candidate paths. The regex matched prose -- a `"."` between two
 * quoted strings in a JSDoc line crashed the commit gate (#118) -- and the
 * guessing knew nothing of tsconfig `paths`, so a repo that imports through
 * `@/lib/x` got no `relatedTests` at all, and the scope-lock then kept its
 * fixer away from the one test that would kill a surviving mutant.
 *
 * `preProcessFile` is TypeScript's own import scanner: tokens, not text, so a
 * comment or a string is never an import. `resolveModuleName` is its own
 * resolver, run with the options of the project the importing file belongs to,
 * so the answer is the one the compiler would give.
 *
 * TypeScript is an optional peer, loaded from the CONSUMER's install. Without
 * it there is no answer (`undefined`), and the lookup adds no hint -- the same
 * as a repo past the corpus cap, whose fixer searches for itself.
 */

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as Ts from 'typescript';

import { isWithinRepo } from './scope.js';
import { isRecord } from './verify/report-shape.js';

type Typescript = typeof Ts;

/**
 * The repo-relative POSIX paths of the in-repo files `text` imports, as seen
 * from `fromFile` (itself repo-relative).
 */
export type ImportResolver = (
  fromFile: string,
  text: string,
) => readonly string[];

interface Project {
  readonly options: Ts.CompilerOptions;
  readonly fileNames: ReadonlySet<string>;
  readonly references: readonly string[];
}

/**
 * The answer for a repo with no tsconfig, or one TypeScript cannot read:
 * relative imports in every style a test is written in still resolve; only
 * aliases, which need the config, are lost.
 */
function defaultOptions(ts: Typescript): Ts.CompilerOptions {
  return {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
}

function isTypescript(value: unknown): value is Typescript {
  return (
    isRecord(value) &&
    typeof value.preProcessFile === 'function' &&
    typeof value.resolveModuleName === 'function'
  );
}

function loadFromRepo(repoRoot: string): unknown {
  return createRequire(path.join(repoRoot, 'package.json'))('typescript');
}

/**
 * What `load` gives, or nothing when it throws. A missing install and a
 * non-TypeScript export are then one answer, settled by `isTypescript`.
 */
function loaded(load: () => unknown): unknown {
  try {
    return load();
  } catch {
    // Not installed: falls through to undefined, which is not TypeScript.
  }
}

function realRootOf(repoRoot: string): string {
  return existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
}

/**
 * `load` is injectable so the resolver is testable against this repo's own
 * TypeScript from a tmp repo that has none installed.
 */
export function createImportResolver(
  repoRoot: string,
  load: () => unknown = () => loadFromRepo(repoRoot),
): ImportResolver | undefined {
  const ts = loaded(load);
  return isTypescript(ts) ? resolverFor(ts, realRootOf(repoRoot)) : undefined;
}

/**
 * Answers are kept per file: the lookup asks about every test once per
 * violated file, and a file's imports do not depend on which file is being
 * looked for. The text is part of the key, so a caller that hands the same
 * path new contents gets a fresh answer, not a stale one.
 */
function resolverFor(ts: Typescript, root: string): ImportResolver {
  const options = projectOptions(ts, root);
  const answered = new Map<
    string,
    { readonly text: string; readonly imports: readonly string[] }
  >();
  const resolve = (fromFile: string, text: string): readonly string[] => {
    try {
      const containing = path.join(root, fromFile);
      const compilerOptions = options(containing);
      return ts
        .preProcessFile(text, true, true)
        .importedFiles.flatMap(({ fileName }) =>
          resolvedInRepo(ts, root, fileName, containing, compilerOptions),
        );
    } catch {
      return [];
    }
  };
  return (fromFile, text) => {
    const cached = answered.get(fromFile);
    if (cached?.text === text) {
      return cached.imports;
    }
    const imports = resolve(fromFile, text);
    answered.set(fromFile, { text, imports });
    return imports;
  };
}

function resolvedInRepo(
  ts: Typescript,
  root: string,
  specifier: string,
  containing: string,
  options: Ts.CompilerOptions,
): string[] {
  const resolved = ts.resolveModuleName(
    specifier,
    containing,
    options,
    ts.sys,
  ).resolvedModule;
  if (resolved === undefined || resolved.isExternalLibraryImport === true) {
    return [];
  }
  const relative = path.relative(root, resolved.resolvedFileName);
  return isWithinRepo(root, relative)
    ? [relative.split(path.sep).join('/')]
    : [];
}

/**
 * The compiler options a file is resolved with: those of the nearest tsconfig
 * above it, or of the project that tsconfig references which includes the
 * file -- Vite's react-ts root lists projects and configures none of them.
 * Each config is parsed once.
 */
function projectOptions(
  ts: Typescript,
  root: string,
): (containing: string) => Ts.CompilerOptions {
  const parsed = new Map<string, Project | undefined>();
  const project = (configPath: string): Project | undefined => {
    if (!parsed.has(configPath)) {
      parsed.set(configPath, parseProject(ts, configPath));
    }
    return parsed.get(configPath);
  };
  return (containing) => {
    const configPath = ts.findConfigFile(path.dirname(containing), (file) =>
      ts.sys.fileExists(file),
    );
    const nearest =
      configPath !== undefined && isWithinRepo(root, configPath)
        ? project(configPath)
        : undefined;
    if (nearest === undefined) {
      return defaultOptions(ts);
    }
    const including = [
      nearest,
      ...nearest.references.map((reference) => project(reference)),
    ].find((candidate) => candidate?.fileNames.has(containing) === true);
    return (including ?? nearest).options;
  };
}

function parseProject(ts: Typescript, configPath: string): Project | undefined {
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    return undefined;
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  return {
    options: parsed.options,
    fileNames: new Set(parsed.fileNames.map((file) => path.normalize(file))),
    references: (parsed.projectReferences ?? []).map((reference) =>
      ts.resolveProjectReferencePath(reference),
    ),
  };
}
