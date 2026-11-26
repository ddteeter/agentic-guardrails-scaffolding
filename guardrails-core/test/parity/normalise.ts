/**
 * What a golden may not contain, because no two runs agree on it: the
 * fixture's temporary path. Nothing else is rewritten. Message text, rule
 * ids, ordering and counts are compared as they are, and no recorded output
 * holds a duration, so none is masked.
 */

function escapeForPattern(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

/**
 * `text` with every spelling of the fixture's root replaced by `<root>`.
 * `roots` holds the path as created and as resolved, and the longest goes
 * first so one never eats the other's prefix.
 */
export function normalise(text: string, roots: readonly string[]): string {
  const ordered = [...new Set(roots)].toSorted(
    (left, right) => right.length - left.length,
  );
  let result = text;
  for (const root of ordered) {
    result = result.replaceAll(
      new RegExp(escapeForPattern(root), 'g'),
      '<root>',
    );
  }
  return result;
}
