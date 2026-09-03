/**
 * Walking up a directory tree, in one place.
 *
 * Two resolvers need it and they must agree: `findGitRoot` looks upward for
 * `.git`, and `resolveLocalBin` looks upward for `node_modules/.bin`. Two
 * hand-rolled loops would be two chances to get the termination condition
 * wrong, and `path.dirname('/') === '/'` makes that loop non-terminating by
 * default rather than by accident.
 */
import path from 'node:path';

/**
 * `start` (resolved against the working directory) followed by each ancestor,
 * ending with the filesystem root. Always yields at least once.
 */
export function* upwardFrom(start: string): Generator<string> {
  let directory = path.resolve(start);
  for (;;) {
    yield directory;
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
    directory = parent;
  }
}
