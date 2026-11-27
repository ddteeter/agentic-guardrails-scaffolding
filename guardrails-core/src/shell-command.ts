/**
 * Reading a shell command the way the shell will, just enough to tell what it
 * RUNS from what it merely mentions. Not a parser: every hook that matches a
 * command shape (the git-write gate, the foreground-wait denial) needs the same
 * two answers -- where a command can start, and which text is literal -- and a
 * second copy of either would drift from the first.
 */

/**
 * Where a shell would START a command: the beginning of the string, or just
 * past a separator. See `GIT_WRITE` in `cli-core.ts` for why the separator and
 * the padding classes are disjoint.
 */
export const COMMAND_START = String.raw`(?:^|[\n;&|()\`{}])[ \t]*`;

/**
 * A heredoc opener: `<<WORD`, `<<-WORD`, or a quoted delimiter (`<<'WORD'`,
 * `<<"WORD"`, `<<\WORD`). Not a here-string: `<<<` is excluded on both sides.
 * Groups: 1 the `-` that lets the terminator be tab-indented, 2-4 a QUOTED
 * delimiter, 5 an unquoted one.
 */
const HEREDOC_OPENER =
  /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\(\w+)|(\w+))/g;

/**
 * The command with the bodies of its QUOTED heredocs removed.
 *
 * A quoted heredoc is literal text -- the shell expands nothing inside it --
 * yet its backticks used to count as command separators, so a script or a
 * commit message that merely quoted a git write in backticks ran the commit
 * gate. Unquoted heredocs DO expand `$(...)` and backticks, so their bodies are
 * kept. Every opener on a line queues its body in order, quoted or not, so an
 * unquoted body is never mistaken for a quoted one's.
 *
 * Fails toward gating: if any body is left unterminated the command is
 * returned untouched, because a wrong guess here must cost a spurious gate
 * run, never a missed commit.
 */
export function withoutQuotedHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const dropped = new Set<number>();
  const pending: { word: string; isIndented: boolean; isQuoted: boolean }[] =
    [];
  for (const [index, line] of lines.entries()) {
    const [body] = pending;
    if (body === undefined) {
      for (const opener of line.matchAll(HEREDOC_OPENER)) {
        const [, dash, single, double, escaped, bare] = opener;
        const quoted = single ?? double ?? escaped;
        pending.push({
          word: quoted ?? bare ?? '',
          isIndented: dash === '-',
          isQuoted: quoted !== undefined,
        });
      }
      continue;
    }
    const candidate = body.isIndented ? line.replace(/^\t+/, '') : line;
    if (candidate === body.word) {
      pending.shift();
    } else if (body.isQuoted) {
      dropped.add(index);
    }
  }
  return pending.length === 0
    ? lines.filter((_line, index) => !dropped.has(index)).join('\n')
    : command;
}

/**
 * How much of the text before a string is read to tell whether a shell is
 * being handed that string to run. The longest spelling looked for is
 * `--exec=`; the rest of the command, however long, says nothing about it.
 */
const SCRIPT_WORD_WINDOW = 16;

/**
 * The word that hands the NEXT string to a shell: `-c` in any flag cluster
 * (`sh -c`, `bash -lc`), `eval`, and git's `--exec` -- which the first
 * alternative already matches, since it too is a dash, word characters and a
 * `c`. Wider than it needs to be (`grep -c` is here as well), and that is the
 * direction to be wrong in: a string kept is a gate run, a script emptied is a
 * commit nobody checked.
 */
const HANDS_OVER_A_SCRIPT = /(?:-\w*c|eval)[ \t=]+$/;

/**
 * Is the string opened at `index` one a shell is handed to run? Read from the
 * command itself, a few characters back, and not from the text kept so far:
 * slicing a string that is still being built costs its whole length each
 * time, which made this quadratic.
 */
function isScript(command: string, index: number): boolean {
  return HANDS_OVER_A_SCRIPT.test(
    command.slice(Math.max(0, index - SCRIPT_WORD_WINDOW), index),
  );
}

/**
 * Where a `#` starts a comment: at the start of a word, which is the start of
 * the command or just past whitespace or a shell metacharacter. Elsewhere it
 * is an ordinary character (`a#b`, `$#`).
 */
const ENDS_A_WORD = /[\s;&|()<>`]/;

function isCommentStart(command: string, index: number): boolean {
  return index === 0 || ENDS_A_WORD.test(command.charAt(index - 1));
}

/**
 * The index of the quote that closes the single-quoted string opened at
 * `open`, or `undefined` when there is none -- and for `$'...'`, which takes
 * backslash escapes this does not follow.
 */
function closingSingleQuote(command: string, open: number): number | undefined {
  const close = command.indexOf("'", open + 1);
  return close === -1 || command.charAt(open - 1) === '$' ? undefined : close;
}

/**
 * The index of the quote that closes the double-quoted string opened at
 * `open`. `undefined` when there is none, and when the string holds a command
 * substitution: that text RUNS, and the quotes inside it pair with each other
 * rather than with the ones around it.
 */
function closingDoubleQuote(command: string, open: number): number | undefined {
  // The characters that decide it: the closing quote, a backslash (which
  // takes the next character with it), and the two ways a substitution opens.
  const decisive = /["`\\]|\$\(/g;
  decisive.lastIndex = open + 1;
  for (
    let match = decisive.exec(command);
    match !== null;
    match = decisive.exec(command)
  ) {
    if (match[0] === '"') {
      return match.index;
    }
    if (match[0] !== '\\') {
      return undefined;
    }
    decisive.lastIndex += 1;
  }
  return undefined;
}

/**
 * `HEREDOC_OPENER` without its `g` flag, for a yes-or-no answer: a global
 * pattern remembers where its last match ended.
 */
const ANY_HEREDOC = new RegExp(HEREDOC_OPENER.source);

/**
One step of the scan: what it keeps, and where the next step starts.
*/
interface Piece {
  text: string;
  end: number;
}

/**
 * The string opened at `index`: emptied, or kept whole when it is handed to a
 * shell to run. `undefined` when where it closes cannot be told.
 */
function stringPiece(command: string, index: number): Piece | undefined {
  const quote = command.charAt(index);
  const close =
    quote === "'"
      ? closingSingleQuote(command, index)
      : closingDoubleQuote(command, index);
  if (close === undefined) {
    return undefined;
  }
  const end = close + 1;
  return {
    text: isScript(command, index) ? command.slice(index, end) : quote + quote,
    end,
  };
}

/**
 * The piece that starts at one of the characters the scan stops on: a string,
 * an escaped character with its backslash, a comment up to the end of its
 * line, or a `#` that is only a character.
 */
function pieceAt(command: string, index: number): Piece | undefined {
  const char = command.charAt(index);
  if (char === '\\') {
    return plain(command, index, index + 2);
  }
  if (char !== '#') {
    return stringPiece(command, index);
  }
  if (!isCommentStart(command, index)) {
    return plain(command, index, index + 1);
  }
  const newline = command.indexOf('\n', index);
  return plain(command, index, newline === -1 ? command.length : newline);
}

function plain(command: string, index: number, end: number): Piece {
  return { text: command.slice(index, end), end };
}

/**
 * The command with the text of its quoted strings removed -- the quotes stay
 * -- so a separator inside a string no longer reads as the start of a command.
 *
 * Found dogfooding: a process listing piped into
 * `grep -E "eslint|tsc|...|git commit"` ran the whole commit gate, stryker
 * included, and was denied with 32 violations for a commit nobody asked for.
 * The alternation puts `git commit` right after a `|`, which is where
 * `COMMAND_START` says a pipeline stage begins.
 *
 * Not a parser, so it is exact about ONE thing: the direction it is wrong in.
 * Text that stays costs a spurious gate run; text that goes could be a commit
 * nobody checked. So a string a shell is handed to run is kept (`isScript`),
 * and anything this does not model returns the command UNTOUCHED: an
 * unterminated string, a `$'...'` string, a command substitution inside
 * double quotes, and any heredoc, whose body is text where a quote opens
 * nothing. A comment is skipped for the same reason -- `# don't` would
 * otherwise open a string that swallows the commit on the next line.
 *
 * `foreground-wait.ts` has a `withoutQuotedText` that looks like this one and
 * is its opposite: there a wrong guess may only MISS a denial, so it drops
 * whatever follows an unterminated quote. They are two functions because they
 * are wrong in two directions, and neither is safe to use for the other's job.
 */
export function withoutInertStrings(command: string): string {
  if (ANY_HEREDOC.test(command)) {
    return command;
  }
  // Everything between two of these is kept as it is.
  const stop = /['"\\#]/g;
  let kept = '';
  let from = 0;
  for (
    let match = stop.exec(command);
    match !== null;
    match = stop.exec(command)
  ) {
    kept += command.slice(from, match.index);
    const piece = pieceAt(command, match.index);
    if (piece === undefined) {
      return command;
    }
    kept += piece.text;
    from = piece.end;
    stop.lastIndex = from;
  }
  return kept + command.slice(from);
}
