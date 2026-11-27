/**
 * For the tests that need a repository with NO `typescript` to find.
 *
 * Node resolves a bare specifier through the `node_modules` directories
 * above the importer and then through its global folders, which include
 * every entry of `NODE_PATH`. A machine that sets `NODE_PATH` to a directory
 * holding `typescript` (a cloud agent's container does) therefore finds one
 * from an empty temporary repository, and "nothing to find" cannot be set
 * up. This takes `NODE_PATH` out of resolution for the rest of the calling
 * file's tests, and puts it back afterwards.
 *
 * Node reads `NODE_PATH` once, at start-up, so deleting the variable is not
 * enough: the module system has to be told to read it again. `_initPaths`
 * is the function Node itself calls for that. It is not in the documented
 * API, so it is looked up rather than called by name; where a future Node
 * drops it, this does nothing and the tests fail as they did before.
 */

import Module from 'node:module';
import process from 'node:process';

import { afterAll, beforeAll } from 'vitest';

function rereadGlobalFolders(): void {
  const initPaths: unknown = Reflect.get(Module, '_initPaths');
  if (typeof initPaths === 'function') {
    Reflect.apply(initPaths, Module, []);
  }
}

/**
Call at the top of a test file whose tests need no globally installed module.
*/
export function withoutGlobalModules(): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.NODE_PATH;
    delete process.env.NODE_PATH;
    rereadGlobalFolders();
  });
  afterAll(() => {
    if (saved !== undefined) {
      process.env.NODE_PATH = saved;
    }
    rereadGlobalFolders();
  });
}
