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

import { existsSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import type * as Ts from 'typescript';

import { isWithinRepo } from './scope.js';
import { type Typescript, loadFromRepo, loaded } from './typescript-loader.js';
import { isRecord } from './verify/report-shape.js';

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
  return withTypescript(repoRoot, load, resolverFor);
}

/**
`build` over the repo's TypeScript and real root; `undefined` without one.
*/
function withTypescript<T>(
  repoRoot: string,
  load: () => unknown,
  build: (ts: Typescript, root: string) => T,
): T | undefined {
  const ts = loaded(load);
  return isTypescript(ts) ? build(ts, realRootOf(repoRoot)) : undefined;
}

/**
 * Answers are kept per file: the lookup asks about every test once per
 * violated file, and a file's imports do not depend on which file is being
 * looked for. The text is part of the key, so a caller that hands the same
 * path new contents gets a fresh answer, not a stale one.
 */
function resolverFor(ts: Typescript, root: string): ImportResolver {
  const imports = importsOf(ts, root);
  const answered = new Map<
    string,
    { readonly text: string; readonly imports: readonly string[] }
  >();
  const resolve = (fromFile: string, text: string): readonly string[] =>
    guarded(() => inRepo(imports(fromFile, text)), []);
  return (fromFile, text) => {
    const cached = answered.get(fromFile);
    if (cached?.text === text) {
      return cached.imports;
    }
    const resolved = resolve(fromFile, text);
    answered.set(fromFile, { text, imports: resolved });
    return resolved;
  };
}

/**
 * The repo-relative POSIX paths of the in-repo files `text` imports, or
 * `undefined` when any one of its imports cannot be accounted for (#197).
 *
 * The resolver's answer with its losses turned into a refusal: where it drops
 * an import nothing resolves and answers "imports nothing" when TypeScript
 * throws, this answers `undefined`. A built-in module and an installed package
 * are accounted for — neither is the repo's own code.
 */
export type ImportTracer = (
  fromFile: string,
  text: string,
) => readonly string[] | undefined;

/**
 * Like `createImportResolver`, but failing closed: for the mutation cache,
 * which keeps a verdict only when it can name every test a changed helper
 * reaches, a lost import would keep one nothing re-checked.
 */
export function createImportTracer(
  repoRoot: string,
  load: () => unknown = () => loadFromRepo(repoRoot),
): ImportTracer | undefined {
  return withTypescript(repoRoot, load, tracerFor);
}

function tracerFor(ts: Typescript, root: string): ImportTracer {
  const imports = importsOf(ts, root);
  return (fromFile, text) =>
    guarded(() => {
      const each = imports(fromFile, text);
      return each.includes(undefined) ? undefined : inRepo(each);
    }, undefined);
}

/**
`attempt`'s answer, or `fallback` when TypeScript throws.
*/
function guarded<T>(attempt: () => T, fallback: T): T {
  try {
    return attempt();
  } catch {
    return fallback;
  }
}

/**
The files of the imports that resolved; an unresolved one names none.
*/
function inRepo(
  each: readonly (readonly string[] | undefined)[],
): readonly string[] {
  return each.flatMap((files) => files ?? []);
}

/**
 * Each import of `text`, as `resolvedInRepo` answers it.
 */
type ImportsOf = (
  fromFile: string,
  text: string,
) => readonly (readonly string[] | undefined)[];

function importsOf(ts: Typescript, root: string): ImportsOf {
  const options = projectOptions(ts, root);
  return (fromFile, text) => {
    const containing = path.join(root, fromFile);
    const compilerOptions = options(containing);
    return ts
      .preProcessFile(text, true, true)
      .importedFiles.map(({ fileName }) =>
        resolvedInRepo(ts, root, fileName, containing, compilerOptions),
      );
  };
}

/**
 * The in-repo file `specifier` names, as a one-element list; `[]` for a
 * built-in module, or a file outside the repo or under `node_modules`; and
 * `undefined` when nothing resolves.
 */
function resolvedInRepo(
  ts: Typescript,
  root: string,
  specifier: string,
  containing: string,
  options: Ts.CompilerOptions,
): string[] | undefined {
  if (isBuiltin(specifier)) {
    return [];
  }
  const resolve = (
    compilerOptions: Ts.CompilerOptions,
  ): Ts.ResolvedModuleFull | undefined =>
    ts.resolveModuleName(specifier, containing, compilerOptions, ts.sys)
      .resolvedModule;
  const resolved = resolve(options) ?? resolve(bundlerStyle(ts, options));
  const file =
    resolved === undefined
      ? literalFile(specifier, containing)
      : implementationOf(resolved.resolvedFileName);
  if (file === undefined) {
    return undefined;
  }
  const relative = path.relative(root, file);
  // Not `isExternalLibraryImport`: a workspace package is linked through
  // node_modules, so TypeScript flags it external while handing back its
  // real path in the repo. Where the file IS decides, not how it was reached.
  return isWithinRepo(root, relative) &&
    !relative.split(path.sep).includes('node_modules')
    ? [relative.split(path.sep).join('/')]
    : [];
}

/**
 * The project's options with bundler resolution, for a second try at an
 * import its own resolution rejected. Classic resolution knows no index
 * files -- TypeScript 5 picks it for `module: esnext` with no
 * `moduleResolution` -- and node16 ESM wants extensions, but tests import
 * barrels and extensionless paths whatever the config says, and vitest runs
 * them. Aliases are kept.
 */
function bundlerStyle(
  ts: Typescript,
  options: Ts.CompilerOptions,
): Ts.CompilerOptions {
  return {
    ...options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}

/**
 * A relative import TypeScript cannot resolve, taken by its literal name when
 * that names a file: a `.vue` or `.svelte` component is linted, so it can
 * carry a violation, and no shim makes TypeScript resolve one. Only a regular
 * file -- a directory named `lib.d` is #118 again.
 */
function literalFile(
  specifier: string,
  containing: string,
): string | undefined {
  if (!specifier.startsWith('.') || path.extname(specifier) === '') {
    return undefined;
  }
  const candidate = path.resolve(path.dirname(containing), specifier);
  return isRegularFile(candidate) ? candidate : undefined;
}

/**
 * The JavaScript file behind a hand-written declaration file, when there is
 * one: TypeScript resolves `./a.js` to `a.d.ts` beside `a.js`, but the
 * violation is in `a.js`.
 */
function implementationOf(file: string): string {
  const declaration = /\.d\.([cm]?)ts$/.exec(file);
  if (declaration === null) {
    return file;
  }
  const sibling = `${file.slice(0, declaration.index)}.${declaration[1] ?? ''}js`;
  return isRegularFile(sibling) ? sibling : file;
}

function isRegularFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() === true;
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
