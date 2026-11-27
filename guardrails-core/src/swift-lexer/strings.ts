import type { SwiftLexFrame } from './state.js';

export type StringFrame = Extract<SwiftLexFrame, { kind: 'string' }>;

/**
The opening delimiter of a string literal: any number of `#`, then `"""` for
a multi-line string or `"` for a single-line one.

After hashes, `"""` opens a multi-line string only when no closing delimiter
follows on the line. That is Swift's own test, and what makes `#"""#` the
single-line raw string of one quote that it is, instead of a multi-line
string that swallows the rest of the file.
*/
export function stringOpenerPattern(): RegExp {
  return /(#+)"(?!.*"\1)""|"""|#*"/y;
}

/**
The frame an opening delimiter opens. The hashes are everything before its
first quote.
*/
export function stringFrame(opener: string): StringFrame {
  return {
    kind: 'string',
    hashes: opener.indexOf('"'),
    multiline: opener.endsWith('"""'),
  };
}

/**
Matches string text up to and including the next thing that ends a run of it:
the `\(` that opens an interpolation, or the closing delimiter. No match
means the text runs to the end of the line.

In a string with n hashes the escape character is a backslash followed by n
hashes, and the closing quote must be followed by n hashes. So the text is a
run of three disjoint things: an escape sequence (taken whole, so `\"` does
not close and `\\` does not escape what follows it), a character that is not
a backslash, and a backslash the hashes do not follow, which is literal.

Built per call because it depends on the frame, so it is not a regex literal.
*/
export function stringEventPattern(frame: StringFrame): RegExp {
  const hashes = '#'.repeat(frame.hashes);
  const escape = String.raw`\\${hashes}`;
  const quote = frame.multiline ? '"""' : '"';
  return new RegExp(
    String.raw`(?:${escape}.|[^\\]|\\(?!${hashes}))*?(?:${escape}\(|${quote}${hashes})`,
    'sy',
  );
}
