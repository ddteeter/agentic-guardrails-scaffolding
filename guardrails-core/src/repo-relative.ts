/**
 * A path as stack ownership, reports and manifests name files: relative to
 * the repository root, with `/` between its parts. Shared by the stryker
 * timeout meter and autofix, which each carried a copy until the `dupes`
 * analyzer reported the pair.
 */

import path from 'node:path';

/**
`fileName` relative to `root`; one that is already relative is kept as is.
*/
export function repoRelative(root: string, fileName: string): string {
  const relative = path.isAbsolute(fileName)
    ? path.relative(root, fileName)
    : fileName;
  return relative.split(path.sep).join('/');
}
