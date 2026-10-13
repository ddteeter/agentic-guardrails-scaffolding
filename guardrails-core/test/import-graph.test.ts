/**
 * Which in-repo files a source text imports, answered by TypeScript (#120).
 *
 * The covering-test lookup used to find imports with a regex and resolve them
 * by guessing paths. The regex matched prose (#118), and the guessing never
 * knew about tsconfig `paths`, so an alias-heavy repo got no `relatedTests` at
 * all. These tests run the consumer-shaped path: a real tsconfig in a tmp repo,
 * resolved by the real `typescript`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createImportResolver } from '../src/import-graph.js';

let root: string;

function write(file: string, contents: string): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function importsOf(
  fromFile: string,
  text: string,
): readonly string[] | undefined {
  return createImportResolver(root, () => ts)?.(fromFile, text);
}

beforeEach(() => {
  // `tmpdir()` is a symlink on macOS (/var -> /private/var), which is the
  // shape a resolver that returns real paths has to cope with.
  root = mkdtempSync(path.join(tmpdir(), 'import-graph-'));
  write('src/a.ts', 'export const a = 1;\n');
  write('src/lib/index.ts', `export * from '../a.js';\n`);
  write('src/legacy.cjs', 'module.exports = 1;\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createImportResolver — import forms', () => {
  beforeEach(() => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          allowJs: true,
        },
      }),
    );
  });

  it('resolves a .js specifier to the .ts file it means', () => {
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/a.js';`),
    ).toEqual(['src/a.ts']);
  });

  it('resolves an extensionless specifier', () => {
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/a';`),
    ).toEqual(['src/a.ts']);
  });

  it('resolves a barrel directory to its index', () => {
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/lib';`),
    ).toEqual(['src/lib/index.ts']);
  });

  it('resolves require, dynamic import and export-from', () => {
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `const legacy = require('../src/legacy.cjs');`,
          `await import('../src/lib/index.js');`,
          `export { a } from '../src/a.js';`,
        ].join('\n'),
      ),
    ).toEqual(['src/legacy.cjs', 'src/lib/index.ts', 'src/a.ts']);
  });

  it('resolves .js, .jsx, .mjs and .cjs specifiers to their TypeScript sources', () => {
    // ESM TypeScript names the EMITTED file. One of each ending, so a repo
    // writing `.mjs` specifiers is not silently left without hints.
    write('src/w.tsx', 'export const w = 1;\n');
    write('src/x.tsx', 'export const x = 1;\n');
    write('src/m.mts', 'export const m = 1;\n');
    write('src/c.cts', 'export const c = 1;\n');
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `import { w } from '../src/w.js';`,
          `import { x } from '../src/x.jsx';`,
          `import { m } from '../src/m.mjs';`,
          `import c = require('../src/c.cjs');`,
        ].join('\n'),
      ),
    ).toEqual(['src/w.tsx', 'src/x.tsx', 'src/m.mts', 'src/c.cts']);
  });

  it('drops a node: builtin even where a repo file shares its name', () => {
    // A substring matcher would be fooled by `node:path` and `src/path.ts`.
    write('src/path.ts', 'export const p = 1;\n');
    expect(
      importsOf('test/x.test.ts', `import path from 'node:path';`),
    ).toEqual([]);
  });

  it('ignores import-shaped text in comments, strings and templates', () => {
    // #118's input among them: a `"."` between two quoted strings in prose.
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `// import { a } from '../src/a.js';`,
          `/* cards in data-part="rail". "The harness */`,
          `const s = "import '../src/a.js'";`,
          'const t = `import { a } from "../src/a.js"`;',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('keeps the repo imports that sit beside unresolvable and package ones', () => {
    // Paired with a good import so a guard that throws or wrongly accepts is
    // seen: either loses `src/a.ts` or adds the node_modules file.
    write(
      'node_modules/pkg/package.json',
      JSON.stringify({ name: 'pkg', types: 'index.d.ts' }),
    );
    write('node_modules/pkg/index.d.ts', 'export declare const p: number;\n');
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `import { gone } from '../src/gone.js';`,
          `import { p } from 'pkg';`,
          `import { a } from '../src/a.js';`,
        ].join('\n'),
      ),
    ).toEqual(['src/a.ts']);
  });

  it('drops a package import and an unresolvable one', () => {
    expect(
      importsOf(
        'test/x.test.ts',
        `import { it } from 'vitest';\nimport { gone } from '../src/gone.js';`,
      ),
    ).toEqual([]);
  });
});

describe('createImportResolver — configuration', () => {
  it('follows a tsconfig paths alias', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./src/*'] },
        },
      }),
    );
    expect(importsOf('test/x.test.ts', `import { a } from '@/a';`)).toEqual([
      'src/a.ts',
    ]);
  });

  it('follows an alias declared only in a referenced project', () => {
    // Vite's react-ts starter: the root lists projects and checks nothing.
    write(
      'tsconfig.json',
      JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }],
      }),
    );
    write(
      'tsconfig.app.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./src/*'] },
        },
        include: ['src', 'test'],
      }),
    );
    write('test/x.test.ts', '');
    expect(importsOf('test/x.test.ts', `import { a } from '@/a';`)).toEqual([
      'src/a.ts',
    ]);
  });

  it('uses the nearest tsconfig, so a workspace package keeps its alias', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: {} }));
    write(
      'packages/app/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '~/*': ['./src/*'] },
        },
      }),
    );
    write('packages/app/src/b.ts', 'export const b = 1;\n');
    expect(
      importsOf('packages/app/test/b.test.ts', `import { b } from '~/b';`),
    ).toEqual(['packages/app/src/b.ts']);
  });

  it('resolves relative imports in a repo with no tsconfig', () => {
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/a.js';`),
    ).toEqual(['src/a.ts']);
  });

  it('resolves relative imports past a tsconfig it cannot parse', () => {
    write('tsconfig.json', '{ "compilerOptions": ');
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/a';`),
    ).toEqual(['src/a.ts']);
  });

  it('falls back to the defaults, which read JavaScript, with no tsconfig', () => {
    expect(
      importsOf('test/x.test.ts', `import legacy from '../src/legacy.cjs';`),
    ).toEqual(['src/legacy.cjs']);
  });

  it('falls back to the defaults, which read JavaScript, past an unparseable tsconfig', () => {
    write('tsconfig.json', '{ "compilerOptions": ');
    expect(
      importsOf('test/x.test.ts', `import legacy from '../src/legacy.cjs';`),
    ).toEqual(['src/legacy.cjs']);
  });

  describe('the options the resolver is handed when no config applies', () => {
    // Resolution results alone cannot tell these defaults from an empty
    // option set (TypeScript 6 resolves the same either way), so the options
    // themselves are observed at the resolver call. They still matter: the
    // peer range is `>=5`, and TypeScript 5's defaults for an empty set are
    // CommonJS and node10, which ignore `package.json` `imports` -- the
    // explicit set keeps every supported version resolving alike.
    function optionsSeen(): ts.CompilerOptions | undefined {
      let seen: ts.CompilerOptions | undefined;
      createImportResolver(root, () => ({
        ...ts,
        resolveModuleName: (
          ...parameters: Parameters<typeof ts.resolveModuleName>
        ) => {
          seen = parameters[2];
          return ts.resolveModuleName(...parameters);
        },
      }))?.('test/x.test.ts', `import { a } from '../src/a.js';`);
      return seen;
    }

    const defaults = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
    };

    it('are the JavaScript-reading defaults with no tsconfig', () => {
      expect(optionsSeen()).toStrictEqual(defaults);
    });

    it('are the same defaults past a tsconfig it cannot parse', () => {
      write('tsconfig.json', '{ "compilerOptions": ');
      expect(optionsSeen()).toStrictEqual(defaults);
    });
  });

  it('keeps the nearest config when a referenced project cannot be read', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        files: [],
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./src/*'] },
        },
        references: [{ path: './missing.json' }],
      }),
    );
    expect(importsOf('test/x.test.ts', `import { a } from '@/a';`)).toEqual([
      'src/a.ts',
    ]);
  });

  it('answers for a repo root that does not exist', () => {
    const missing = path.join(root, 'not-there');
    expect(
      createImportResolver(missing, () => ts)?.(
        'test/x.test.ts',
        `import { a } from '../src/a.js';`,
      ),
    ).toEqual([]);
  });

  it('answers for a repo root reached through a symlink', () => {
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      expect(
        createImportResolver(link, () => ts)?.(
          'test/x.test.ts',
          `import { a } from '../src/a.js';`,
        ),
      ).toEqual(['src/a.ts']);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('drops a file the import resolves to outside the repo', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@out/*': ['../*'] },
        },
      }),
    );
    writeFileSync(`${root}-outside.ts`, 'export const o = 1;\n');
    try {
      expect(
        importsOf(
          'test/x.test.ts',
          `import { o } from '@out/${path.basename(root)}-outside';`,
        ),
      ).toEqual([]);
    } finally {
      rmSync(`${root}-outside.ts`, { force: true });
    }
  });
});

/**
TypeScript with its import scanner counted.
*/
function counting(): { typescript: typeof ts; scans: () => number } {
  let scans = 0;
  return {
    typescript: {
      ...ts,
      preProcessFile: (...parameters: Parameters<typeof ts.preProcessFile>) => {
        scans += 1;
        return ts.preProcessFile(...parameters);
      },
    },
    scans: () => scans,
  };
}

describe('createImportResolver — what the old lookup matched (PR #121 review)', () => {
  it('resolves a barrel directory and "." under Classic resolution', () => {
    // TS 5 defaults `module: esnext` with no `moduleResolution` to Classic,
    // which knows no index files. Tests sit outside `include` often enough
    // that tsc never objects to the barrel imports vitest accepts.
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { moduleResolution: 'classic' } }),
    );
    write('src/lib/b.test.ts', '');
    expect(
      importsOf('test/x.test.ts', `import { a } from '../src/lib';`),
    ).toEqual(['src/lib/index.ts']);
    expect(importsOf('src/lib/b.test.ts', `import { a } from '.';`)).toEqual([
      'src/lib/index.ts',
    ]);
  });

  it('keeps a relative import of a file TypeScript cannot resolve, by its name', () => {
    // A `.vue` or `.svelte` component is linted, so it can carry a violation,
    // and no `declare module '*.vue'` shim makes TypeScript resolve it.
    write('src/Comp.vue', '<template />\n');
    write('src/Card.svelte', '<div />\n');
    // A directory whose name has an extension: #118's EISDIR, by another road.
    write('src/lib.d/keep.ts', '');
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `import Comp from '../src/Comp.vue';`,
          `import Card from '../src/Card.svelte';`,
          `import Gone from '../src/Gone.vue';`,
          `import Dir from '../src/lib.d';`,
        ].join('\n'),
      ),
    ).toEqual(['src/Comp.vue', 'src/Card.svelte']);
  });

  it('names the JavaScript file behind a hand-written declaration file', () => {
    write('src/js.js', 'export const j = 1;\n');
    write('src/js.d.ts', 'export declare const j: number;\n');
    write('src/types-only.d.ts', 'export declare const t: number;\n');
    expect(
      importsOf(
        'test/x.test.ts',
        `import { j } from '../src/js.js';\nimport { t } from '../src/types-only';`,
      ),
    ).toEqual(['src/js.js', 'src/types-only.d.ts']);
  });

  it('keeps the config aliases when it retries a barrel under bundler resolution', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          moduleResolution: 'classic',
          paths: { '@/*': ['./src/*'] },
        },
      }),
    );
    expect(importsOf('test/x.test.ts', `import { a } from '@/lib';`)).toEqual([
      'src/lib/index.ts',
    ]);
  });

  it('takes only a relative specifier with an extension by its literal name', () => {
    write('src/LICENSE', 'text\n');
    write('test/vendor/thing.vue', '<template />\n');
    write('src/Comp.vue', '<template />\n');
    // None of these is a relative path with an extension: a bare specifier
    // that happens to name a file beside the importer, and an extensionless
    // file. The positive control is the one that is.
    expect(
      importsOf(
        'test/x.test.ts',
        [
          `import Bare from 'vendor/thing.vue';`,
          `import Bare from '../src/LICENSE';`,
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(
      importsOf('test/x.test.ts', `import Comp from '../src/Comp.vue';`),
    ).toEqual(['src/Comp.vue']);
  });

  it('names the module file behind a .d.mts or .d.cts declaration', () => {
    write('src/m.mjs', 'export const m = 1;\n');
    write('src/m.d.mts', 'export declare const m: number;\n');
    write('src/c.cjs', 'module.exports = 1;\n');
    write('src/c.d.cts', 'export declare const c: number;\n');
    expect(
      importsOf(
        'test/x.test.ts',
        `import { m } from '../src/m.mjs';\nimport c from '../src/c.cjs';`,
      ),
    ).toEqual(['src/m.mjs', 'src/c.cjs']);
  });

  it('leaves a source file whose name only starts like a declaration file', () => {
    write('src/x.js', 'export const x = 1;\n');
    write('src/x.d.tsx', 'export const x = 1;\n');
    expect(
      importsOf('test/x.test.ts', `import { x } from '../src/x.d';`),
    ).toEqual(['src/x.d.tsx']);
  });

  it('follows a workspace package to its source in the repo', () => {
    // npm and pnpm link a workspace package into node_modules. TypeScript
    // reports the real, in-repo path but flags it external, from the link.
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { module: 'esnext', moduleResolution: 'bundler' },
      }),
    );
    write(
      'packages/shared/package.json',
      JSON.stringify({ name: '@acme/shared', types: './src/index.ts' }),
    );
    write('packages/shared/src/index.ts', 'export const s = 1;\n');
    write(
      'node_modules/vendor/package.json',
      JSON.stringify({ name: 'vendor', types: './index.d.ts' }),
    );
    write('node_modules/vendor/index.d.ts', 'export declare const v: 1;\n');
    mkdirSync(path.join(root, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(
      path.join(root, 'packages', 'shared'),
      path.join(root, 'node_modules', '@acme', 'shared'),
    );
    expect(
      importsOf(
        'test/x.test.ts',
        `import { s } from '@acme/shared';\nimport { v } from 'vendor';`,
      ),
    ).toEqual(['packages/shared/src/index.ts']);
  });

  it('ignores a tsconfig above the repo root', () => {
    // The repo is `root/repo`; `root/tsconfig.json` belongs to something else
    // and its alias must not reach in.
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./repo/src/*'] },
        },
      }),
    );
    write('repo/src/a.ts', 'export const a = 1;\n');
    expect(
      createImportResolver(path.join(root, 'repo'), () => ts)?.(
        'test/x.test.ts',
        `import { a } from '@/a';\nimport { b } from '../src/a.js';`,
      ),
    ).toEqual(['src/a.ts']);
  });
});

describe('createImportResolver — cost', () => {
  /**
   * The lookup asks about every test file once per violated file. Without
   * this, a manifest naming ten files scanned and resolved the whole corpus
   * ten times: 2.2 s against the regex's 93 ms, on this repo's 535 tests.
   */
  it('scans a file once, however often it is asked about', () => {
    const { typescript, scans } = counting();
    const imports = createImportResolver(root, () => typescript);
    const text = `import { a } from '../src/a.js';`;
    expect(imports?.('test/x.test.ts', text)).toEqual(['src/a.ts']);
    expect(imports?.('test/x.test.ts', text)).toEqual(['src/a.ts']);
    expect(scans()).toBe(1);
  });

  it('scans again when the same file is asked about with other text', () => {
    const { typescript, scans } = counting();
    const imports = createImportResolver(root, () => typescript);
    imports?.('test/x.test.ts', `import { a } from '../src/a.js';`);
    expect(
      imports?.('test/x.test.ts', `import { a } from '../src/lib';`),
    ).toEqual(['src/lib/index.ts']);
    expect(scans()).toBe(2);
  });
});

describe('createImportResolver — configuration cost', () => {
  it('reads a tsconfig once, however many files it is asked about', () => {
    write('tsconfig.json', JSON.stringify({ compilerOptions: {} }));
    let reads = 0;
    const imports = createImportResolver(root, () => ({
      ...ts,
      readConfigFile: (...parameters: Parameters<typeof ts.readConfigFile>) => {
        reads += 1;
        return ts.readConfigFile(...parameters);
      },
    }));
    imports?.('test/x.test.ts', `import { a } from '../src/a.js';`);
    imports?.('test/y.test.ts', `import { a } from '../src/a.js';`);
    expect(reads).toBe(1);
  });
});

describe('createImportResolver — what counts as typescript', () => {
  it.each([
    ['null', null],
    ['an empty object', {}],
    ['only a scanner', { preProcessFile: () => 0 }],
    ['only a resolver', { resolveModuleName: () => 0 }],
  ])('is undefined for %s', (_name, candidate) => {
    expect(createImportResolver(root, () => candidate)).toBeUndefined();
  });

  it('is defined for something with both a scanner and a resolver', () => {
    expect(createImportResolver(root, () => ts)).toBeTypeOf('function');
  });
});

describe('createImportResolver — without typescript', () => {
  it('is undefined when typescript cannot be loaded', () => {
    expect(
      createImportResolver(root, () => {
        throw new Error('Cannot find module typescript');
      }),
    ).toBeUndefined();
  });

  it('loads typescript from the repo it was given, not from guardrails-core', () => {
    // A tmp dir has no node_modules on the way up, so the default loader
    // finds nothing. Asserted rather than assumed, so this cannot pass
    // vacuously on a machine with a stray /tmp/node_modules.
    const ancestors = [root];
    for (
      let parent = path.dirname(root);
      parent !== ancestors.at(-1);
      parent = path.dirname(parent)
    ) {
      ancestors.push(parent);
    }
    expect(
      ancestors.filter((directory) =>
        existsSync(path.join(directory, 'node_modules', 'typescript')),
      ),
    ).toEqual([]);
    expect(createImportResolver(root)).toBeUndefined();
  });

  it('answers "imports nothing" when typescript throws mid-call', () => {
    const throwing = {
      ...ts,
      preProcessFile: () => {
        throw new Error('boom');
      },
    };
    expect(
      createImportResolver(root, () => throwing)?.(
        'test/x.test.ts',
        `import { a } from '../src/a.js';`,
      ),
    ).toEqual([]);
  });
});
