/**
Where a block comment stands after scanning part of a line.
*/
export interface BlockCommentScan {
  /**
  Index just past the `*\/` that closed the comment, if one did.
  */
  readonly closedAt: number | undefined;
  /**
  How many comments are open after the scanned text: 0 once it closed.
  */
  readonly depth: number;
}

/**
Scan block-comment text from `from`, already `depth` comments deep. Swift
block comments nest, so every opener deepens and every closer shallows, and
the comment is over only when the depth comes back to 0.
*/
export function scanBlockComment(
  text: string,
  from: number,
  depth: number,
): BlockCommentScan {
  const delimiter = /\/\*|\*\//g;
  delimiter.lastIndex = from;
  let open = depth;
  for (
    let found = delimiter.exec(text);
    found !== null;
    found = delimiter.exec(text)
  ) {
    open += found[0] === '/*' ? 1 : -1;
    if (open === 0) {
      return { closedAt: delimiter.lastIndex, depth: 0 };
    }
  }
  return { closedAt: undefined, depth: open };
}

/**
What a comment token says, for matching directives against: the token's text
without its delimiters or doc-comment markers, trimmed.

The leading run of `/`, `*` and `!` covers every way a comment segment can
start -- `//`, `///`, `/*`, `/**`, `/*!`, and the ` * ` gutter of a block
comment's continuation line -- so `/// x`, `/** x *\/` and ` * x` all say `x`.
*/
export function commentContent(text: string): string {
  return text
    .replace(/^\s*[/*!]+/, '')
    .replace(/\*\/$/, '')
    .trim();
}
