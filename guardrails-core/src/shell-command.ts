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
 * The programs whose quoted arguments can only be DATA: they read their
 * strings, or print them, and have no way to be told to run one.
 *
 * Short on purpose, and a program earns its place by what it CANNOT do.
 * `rg` reads like `grep` and runs a command for `--pre`; `sort` has
 * `--compress-program`; `sed` has an `e` flag; `awk`, `find` and `xargs` run
 * things by design. None of them is here. A name is matched exactly, so a
 * path (`/bin/echo`), a wrapper (`time echo`) or a quoted name is not on it
 * either.
 */
const PLAIN_DATA_PROGRAMS = new Set([
  'grep',
  'egrep',
  'fgrep',
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'wc',
  'uniq',
  'cut',
  'tr',
  'ls',
  'ps',
  'pgrep',
  'cd',
  'pwd',
  'true',
  'false',
  'tee',
]);

/**
 * The `>&1` of a file-descriptor duplication (`2>&1`, `>&2`): the one `&` in
 * a command that separates nothing. Anything else after `>&` is a file name,
 * and is left to read as the separator it looks like.
 */
const DESCRIPTOR_DUPLICATION = />&\d/g;

/**
Where one simple command ends and the next begins.
*/
const COMMAND_SEPARATOR = /[\n;&|(){}]/;

/**
 * Is every simple command in this text -- a command with its strings already
 * emptied -- one of the programs that only read their strings?
 *
 * ALL of them, not the one a string belongs to: `echo '...' | sh` is an
 * `echo` that only prints, into a shell that runs what it printed.
 */
function isPlainData(emptied: string): boolean {
  return emptied
    .replaceAll(DESCRIPTOR_DUPLICATION, ' ')
    .split(COMMAND_SEPARATOR)
    .every((simple) => {
      const [program = ''] = simple.trim().split(/\s/, 1);
      return program === '' || PLAIN_DATA_PROGRAMS.has(program);
    });
}

/**
 * Any heredoc, by its operator alone and not by a delimiter this would have
 * to recognise: `<<.` and `<<''` are heredocs too. A here-string, `<<<`, is
 * not one.
 */
const ANY_HEREDOC = /(?<!<)<<(?!<)/;

/**
 * Where a `#` starts a comment: at the start of a word, just past whitespace
 * or a shell metacharacter. Elsewhere it is an ordinary character (`a#b`).
 *
 * The very start of the command needs no case of its own: a `#` there is
 * read as a character, which makes it the first word of the first command,
 * and no program that only reads its strings is called that.
 */
const ENDS_A_WORD = /[\s;&|()<>]/;

function isCommentStart(command: string, index: number): boolean {
  return ENDS_A_WORD.test(command.charAt(index - 1));
}

/**
 * The index of the quote that closes the double-quoted string opened at
 * `open`. `undefined` when there is none, and when the string holds anything
 * the shell expands: a `$` or a backtick.
 */
function closingDoubleQuote(command: string, open: number): number | undefined {
  // The characters that decide it: the closing quote, a backslash (which
  // takes the next character with it), and the two that start an expansion.
  const decisive = /["`\\$]/g;
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
One step of the scan: what it keeps, and where the next step starts.
*/
interface Piece {
  text: string;
  end: number;
}

/**
 * The string opened at `index`, emptied. `undefined` when where it closes
 * cannot be told. A single-quoted string ends at the next single quote,
 * whatever is in it.
 */
function emptiedString(command: string, index: number): Piece | undefined {
  const quote = command.charAt(index);
  const found =
    quote === "'"
      ? command.indexOf("'", index + 1)
      : closingDoubleQuote(command, index);
  return found === undefined || found === -1
    ? undefined
    : { text: quote + quote, end: found + 1 };
}

/**
 * The piece that starts at one of the characters the scan stops on, or
 * `undefined` for one it does not model: an expansion, a comment, a string
 * that does not close.
 */
function pieceAt(command: string, index: number): Piece | undefined {
  const char = command.charAt(index);
  if (char === '\\') {
    return { text: command.slice(index, index + 2), end: index + 2 };
  }
  if (char === "'" || char === '"') {
    return emptiedString(command, index);
  }
  return char === '#' && !isCommentStart(command, index)
    ? { text: char, end: index + 1 }
    : undefined;
}

/**
 * The command with every quoted string emptied -- the quotes stay -- or
 * `undefined` when it holds something this does not model.
 */
function withStringsEmptied(command: string): string | undefined {
  // Everything between two of these is kept as it is.
  const stop = /['"\\#$`]/g;
  let kept = '';
  let from = 0;
  for (
    let match = stop.exec(command);
    match !== null;
    match = stop.exec(command)
  ) {
    const piece = pieceAt(command, match.index);
    if (piece === undefined) {
      return undefined;
    }
    kept += command.slice(from, match.index) + piece.text;
    from = piece.end;
    stop.lastIndex = from;
  }
  return kept + command.slice(from);
}

/**
 * The command with the text of its quoted strings removed -- the quotes stay
 * -- so a separator inside a string no longer reads as the start of a command.
 * Only for a command in which every string is provably DATA; any other
 * command comes back untouched.
 *
 * Found dogfooding: a process listing piped into
 * `grep -E "eslint|tsc|...|git commit"` ran the whole commit gate, stryker
 * included, and was denied with 32 violations for a commit nobody asked for.
 * The alternation puts `git commit` right after a `|`, which is where
 * `COMMAND_START` says a pipeline stage begins.
 *
 * The first version of this emptied every string it could not show to be a
 * script, and was wrong seven ways, each a commit that lost this gate: a
 * script piped or here-stringed to a shell; `-c` in the middle of a flag
 * group; a script in two adjacent quoted pieces; a script assigned to a
 * variable; a program other than a shell that runs its argument; a shell
 * with other quoting rules; a heredoc whose delimiter is not a word. Every
 * one is the same mistake -- listing what is dangerous -- so this lists what
 * is safe instead, and is exact about ONE thing: the direction it is wrong
 * in. Text that stays costs a spurious gate run; text that goes could be a
 * commit nobody checked.
 *
 * So strings are emptied only when EVERY simple command in the line is a
 * program that can only read them (`PLAIN_DATA_PROGRAMS`), and the line
 * holds nothing this does not model: no heredoc, no expansion (`$`, a
 * backtick) outside single quotes, no comment, no string left open. It reads
 * bash quoting; the caller keeps it away from any other shell.
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
  const emptied = withStringsEmptied(command);
  return emptied !== undefined && isPlainData(emptied) ? emptied : command;
}
