import type { SwiftTokenKind } from './tokens.js';

/**
A token that opens and closes at one place: lexing it never changes what the
lexer is inside of.
*/
export interface Atom {
  readonly kind: SwiftTokenKind;
  readonly text: string;
}

interface AtomRule {
  readonly kind: SwiftTokenKind;
  readonly pattern: RegExp;
}

/**
Run `pattern` (which must be sticky) at exactly `index`.

Every pattern in this module is built by a function, per call: a sticky
`RegExp` carries `lastIndex`, and a shared one would be shared state.
*/
export function matchAt(
  pattern: RegExp,
  text: string,
  index: number,
): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/**
A bare `/.../` regex literal. A `\` escapes the next character and a `[...]`
class may hold a `/`.

Two of Swift's own rules keep a `/` that is really an operator from being
read as one. The literal cannot start with whitespace, so a spaced division
after a postfix `!` stays a division. And it must close on its line -- a bare
regex never spans lines -- so the `/` of `reduce(1, /)` hides nothing.
*/
function bareRegexPattern(): RegExp {
  return /\/(?=\S)(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])*\//y;
}

/**
An extended `#/.../#` regex literal, with any number of hashes: it ends at a
`/` followed by as many hashes as opened it, or at the end of the line.
*/
function extendedRegexPattern(): RegExp {
  return /(#+)\/.*?(?:\/\1|$)/y;
}

/**
A decimal literal, or a binary or octal one: digits and letters, an optional
fraction, and a sign only directly after the `e` of an exponent.
*/
function decimalPattern(): RegExp {
  return /\d\w*(?:\.\d\w*)?(?:(?<=[eE])[-+]\d\w*)?/y;
}

/**
A `!` or `?` that follows its operand with no whitespace is one token on its
own, whatever operator characters come next. The exception is `!` before `=`:
that stays with the `!=` or `!==` it starts.

"Follows its operand" is Swift's own left-bound test: something other than
whitespace or an opening `(`, `[`, `{`, `,`, `;`, `:` is directly before it.
*/
function postfixPattern(): RegExp {
  return /(?<=[^\s([{,;:])(?:\?|!(?!=))/y;
}

/**
Maximal munch over operator characters, with two Swift limits: `//` and `/*`
start a comment even mid-operator, and a `>` that `!` or `?` follows ends the
operator, so the `>` closing a generic argument list leaves the optional mark
after it as its own token. That `>` is then the lone `>` of the rule after
this one.
*/
function operatorPattern(): RegExp {
  return /(?:[-=+!*%<&|^~?]|\/(?![/*])|>(?![!?]))+/y;
}

/**
True when a `/` may start a bare regex literal rather than divide, given the
text of the last significant token before it on the line. It may at the
start of the line, after `return`, and after an operator or an opening
punctuator -- the heuristic of the JavaScript lexer in `audit.ts`, asked of
the previous token instead of the code text so far, so a string or regex
operand counts as the operand it is.
*/
export function canRegexFollow(last: string | undefined): boolean {
  return (
    last === undefined ||
    last === 'return' ||
    /[([{,;:=!&|?+\-*%^~<>]$/.test(last)
  );
}

/**
The rules, in the order they are tried.

- `//` comes before the bare regex, which would read it as an empty one.
- A backtick identifier is one token to its closing backtick, spaces and all.
- A hexadecimal literal comes before the decimal one and takes no exponent
  sign: `e` is a hexadecimal digit, so `0xFE-1` is a subtraction.
- Numbers come before the identifier, whose characters include digits. An
  identifier character is a word character, `$`, or anything outside ASCII.
- Only an operator that starts with a dot may contain dots.
*/
function atomRules(canStartRegex: boolean): readonly AtomRule[] {
  const bareRegex: readonly AtomRule[] = canStartRegex
    ? [{ kind: 'regex', pattern: bareRegexPattern() }]
    : [];
  return [
    { kind: 'comment', pattern: /\/\/.*/y },
    ...bareRegex,
    { kind: 'regex', pattern: extendedRegexPattern() },
    { kind: 'identifier', pattern: /`[^`]*`?/y },
    { kind: 'number', pattern: /0[xX]\w*/y },
    { kind: 'number', pattern: decimalPattern() },
    { kind: 'identifier', pattern: /[\w$\u{80}-\u{10FFFF}]+/uy },
    { kind: 'operator', pattern: postfixPattern() },
    { kind: 'operator', pattern: /\.[-=+!*%<>&|^~?.]+/y },
    { kind: 'operator', pattern: operatorPattern() },
    { kind: 'operator', pattern: />/y },
  ];
}

/**
The atom that starts at `index`: the first rule that matches there, or the
single character as punctuation.
*/
export function lexAtom(
  text: string,
  index: number,
  canStartRegex: boolean,
): Atom {
  for (const { kind, pattern } of atomRules(canStartRegex)) {
    const matched = matchAt(pattern, text, index);
    if (matched !== undefined) {
      return { kind, text: matched };
    }
  }
  return { kind: 'punctuation', text: text.charAt(index) };
}
