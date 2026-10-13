/**
 * Which directory a shell command's git write runs in (#123).
 *
 * A hook payload's `cwd` is where the shell stood BEFORE the command ran, so
 * `cd ../other && git commit` commits in `../other` while the payload names
 * the session's repository. The commit gate has to check the repository the
 * commit lands in, so it needs this answer first.
 *
 * Not a shell parser. It reads a narrow set of literal shapes -- a `cd` chain
 * joined to the write by `&&`, `;` or a newline -- and answers `unknown` for
 * everything it cannot be sure of, because a wrong directory here gates the
 * wrong repository: the very bug it exists to fix. Text that is only ever
 * mentioned (quoted strings, heredoc bodies, command substitutions inside a
 * word, comments) never moves the answer.
 */
import path from 'node:path';

export type CommandTarget =
  | { kind: 'directory'; directory: string }
  | { kind: 'unknown'; reason: string };

interface Word {
  /**
  The word with its quoting removed.
  */
  text: string;
  /**
  False when any part of it is expanded: `$…` or a backtick.
  */
  isLiteral: boolean;
  /**
  True when it begins with an unquoted `~`, which the shell expands.
  */
  isTildeExpandable: boolean;
}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'operator'; operator: string }
  | { kind: 'redirect'; operator: string };

/**
Longest first, so `&&` is never read as two `&`.
*/
const OPERATORS = ['&&', '||', ';;', ';', '|', '&', '(', ')', '\n'];

const BLANK = new Set([' ', '\t']);

/**
Characters that start an expansion.
*/
const EXPANSIONS = new Set(['$', '`']);

/**
Characters that end an unquoted word.
*/
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

/**
Redirection operators, longest first.
*/
const REDIRECTS = ['<<-', '<<', '<&', '>&', '>>', '<', '>'];

interface Heredoc {
  delimiter: string;
  isIndented: boolean;
}

interface Cursor {
  readonly text: string;
  index: number;
}

function peek(cursor: Cursor, offset = 0): string {
  return cursor.text.charAt(cursor.index + offset);
}

/**
Skip from an opening backtick past its closing one.
*/
function skipBackticks(cursor: Cursor): void {
  cursor.index += 1;
  while (peek(cursor) !== '`') {
    if (peek(cursor) === '') {
      throw new SyntaxError('an unclosed backtick');
    }
    readCharacter(cursor);
  }
  cursor.index += 1;
}

/**
 * Skip a `$(`, `` ` `` or plain `$` expansion starting at the cursor. A `$(`
 * is read with the full scanner, so quotes, heredocs and parentheses inside
 * it cannot end it early.
 */
function skipExpansion(cursor: Cursor): void {
  if (peek(cursor) === '`') {
    skipBackticks(cursor);
    return;
  }
  if (peek(cursor, 1) === '(') {
    cursor.index += 2;
    scanTokens(cursor, true);
    return;
  }
  cursor.index += 1;
}

function readSingleQuoted(cursor: Cursor): string {
  const close = cursor.text.indexOf("'", cursor.index + 1);
  if (close === -1) {
    throw new SyntaxError('an unclosed single quote');
  }
  const text = cursor.text.slice(cursor.index + 1, close);
  cursor.index = close + 1;
  return text;
}

/**
 * Read one plain character, or the character a backslash escapes, and step
 * past it.
 */
function readCharacter(cursor: Cursor): string {
  const isEscape = peek(cursor) === '\\';
  const character = peek(cursor, Number(isEscape));
  cursor.index += 1 + Number(isEscape);
  return character;
}

/**
Read a double-quoted span; answers its text and whether it expands.
*/
function readDoubleQuoted(cursor: Cursor): {
  text: string;
  isLiteral: boolean;
} {
  let text = '';
  let isLiteral = true;
  cursor.index += 1;
  for (
    let character = peek(cursor);
    character !== '"';
    character = peek(cursor)
  ) {
    if (character === '') {
      throw new SyntaxError('an unclosed double quote');
    }
    if (EXPANSIONS.has(character)) {
      isLiteral = false;
      skipExpansion(cursor);
    } else {
      text += readCharacter(cursor);
    }
  }
  cursor.index += 1;
  return { text, isLiteral };
}

/**
Read one piece of a word into it: a quoted span, an expansion, or a character.
*/
function readWordPiece(cursor: Cursor, word: Word): void {
  const character = peek(cursor);
  if (character === "'") {
    word.text += readSingleQuoted(cursor);
  } else if (character === '"') {
    const quoted = readDoubleQuoted(cursor);
    word.text += quoted.text;
    word.isLiteral &&= quoted.isLiteral;
  } else if (EXPANSIONS.has(character)) {
    word.isLiteral = false;
    skipExpansion(cursor);
  } else {
    word.text += readCharacter(cursor);
  }
}

function readWord(cursor: Cursor): Word {
  const word: Word = {
    text: '',
    isLiteral: true,
    isTildeExpandable: peek(cursor) === '~',
  };
  while (peek(cursor) !== '' && !WORD_END.has(peek(cursor))) {
    readWordPiece(cursor, word);
  }
  return word;
}

/**
Skip one heredoc body, through the line that is its delimiter.
*/
function skipHeredocBody(cursor: Cursor, heredoc: Heredoc): void {
  const lines = cursor.text.slice(cursor.index).split('\n');
  const last = lines.findIndex(
    (line) =>
      (heredoc.isIndented ? line.replace(/^\t+/, '') : line) ===
      heredoc.delimiter,
  );
  const body = last === -1 ? lines : lines.slice(0, last + 1);
  cursor.index += body.join('\n').length + 1;
}

/**
Read a redirection; a heredoc's delimiter is queued for its body.
*/
function readRedirect(cursor: Cursor, scan: Scan): void {
  const operator =
    REDIRECTS.find((candidate) =>
      cursor.text.startsWith(candidate, cursor.index),
    ) ?? peek(cursor);
  cursor.index += operator.length;
  scan.tokens.push({ kind: 'redirect', operator });
  if (operator.startsWith('<<')) {
    while (BLANK.has(peek(cursor))) {
      cursor.index += 1;
    }
    const delimiter = readWord(cursor);
    scan.tokens.push({ kind: 'word', word: delimiter });
    scan.heredocs.push({
      delimiter: delimiter.text,
      isIndented: operator === '<<-',
    });
  }
}

/**
What one `scanTokens` call has read so far.
*/
interface Scan {
  tokens: Token[];
  heredocs: Heredoc[];
}

/**
 * Read a word -- dropping a file-descriptor number, which belongs to the
 * redirection right after it (`2>`).
 */
function readWordToken(cursor: Cursor, scan: Scan): void {
  const word = readWord(cursor);
  if (!/^\d+$/.test(word.text) || !'<>'.includes(peek(cursor))) {
    scan.tokens.push({ kind: 'word', word });
  }
}

/**
 * Read an operator. Answers true when it is the `)` that closes the `$(` being
 * scanned.
 */
function isClosedByOperator(
  cursor: Cursor,
  scan: Scan,
  operator: string,
  isSubstitution: boolean,
): boolean {
  cursor.index += operator.length;
  if (operator === ')' && isSubstitution) {
    return true;
  }
  // Inside a substitution, a nested `(` is read to its own `)`, so only the
  // one that closes the substitution answers true above.
  if (operator === '(' && isSubstitution) {
    scanTokens(cursor, true);
  }
  scan.tokens.push({ kind: 'operator', operator });
  if (operator === '\n') {
    for (const heredoc of scan.heredocs.splice(0)) {
      skipHeredocBody(cursor, heredoc);
    }
  }
  return false;
}

/**
 * Read the next token, or skip a blank or a comment. Answers true when the
 * `$(` being scanned has closed.
 */
function isClosedByToken(
  cursor: Cursor,
  scan: Scan,
  isSubstitution: boolean,
): boolean {
  const character = peek(cursor);
  const operator = OPERATORS.find((candidate) =>
    cursor.text.startsWith(candidate, cursor.index),
  );
  if (BLANK.has(character)) {
    cursor.index += 1;
  } else if (character === '#') {
    const end = cursor.text.indexOf('\n', cursor.index);
    cursor.index = end === -1 ? cursor.text.length : end;
  } else if (character === '<' || character === '>') {
    readRedirect(cursor, scan);
  } else if (operator === undefined) {
    readWordToken(cursor, scan);
  } else {
    return isClosedByOperator(cursor, scan, operator, isSubstitution);
  }
  return false;
}

/**
 * The command's tokens, read up to its end -- or, inside a `$(`, up to the
 * `)` that closes it.
 */
function scanTokens(cursor: Cursor, isSubstitution: boolean): Token[] {
  const scan: Scan = { tokens: [], heredocs: [] };
  while (cursor.index < cursor.text.length) {
    if (isClosedByToken(cursor, scan, isSubstitution)) {
      return scan.tokens;
    }
  }
  if (isSubstitution) {
    throw new SyntaxError('an unclosed $(');
  }
  return scan.tokens;
}

/**
One simple command, and the operators on either side of it.
*/
interface SimpleCommand {
  name: Word;
  parameters: Word[];
  /**
  Nesting: subshells, `{ … }` groups and compound commands.
  */
  depth: number;
  before: string;
  after: string;
}

const OPENERS = new Set(['if', 'while', 'until', 'for', 'case', 'select', '{']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}']);
const PREFIXES = new Set(['then', 'do', 'else', 'elif', '!', 'time']);

/**
Strip a command's leading reserved words, tracking the nesting they open.
*/
function stripKeywords(words: Word[], depth: number): number {
  let nesting = depth;
  for (let [first] = words; first !== undefined; [first] = words) {
    const isOpens = OPENERS.has(first.text);
    const isCloses = CLOSERS.has(first.text);
    if (!isOpens && !isCloses && !PREFIXES.has(first.text)) {
      break;
    }
    nesting += Number(isOpens) - Number(isCloses);
    words.shift();
  }
  return nesting;
}

function simpleCommands(tokens: readonly Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: Word[] = [];
  let before = '';
  let parentheses = 0;
  let compound = 0;
  let isRedirectTarget = false;
  const finish = (after: string): void => {
    compound = stripKeywords(words, compound);
    const [name, ...parameters] = words;
    if (name !== undefined) {
      commands.push({
        name,
        parameters,
        depth: parentheses + compound,
        before,
        after,
      });
    }
    words = [];
    before = after;
  };
  for (const token of tokens) {
    if (token.kind === 'word') {
      if (!isRedirectTarget) {
        words.push(token.word);
      }
      isRedirectTarget = false;
    } else if (token.kind === 'redirect') {
      isRedirectTarget = true;
    } else {
      finish(token.operator);
      parentheses +=
        Number(token.operator === '(') - Number(token.operator === ')');
    }
  }
  finish('');
  return commands;
}

/**
Operators that run the next command, in the same shell, after this one.
*/
const SEQUENCE = new Set(['', '&&', ';', '\n']);

const CHANGE_DIRECTORY = new Set(['cd', 'pushd', 'popd']);

/**
Where a `cd` moves the shell, or why that cannot be known.
*/
function changeDirectory(
  command: SimpleCommand,
  directory: string,
  home: string,
): CommandTarget {
  if (command.name.text !== 'cd') {
    return unknown(`\`${command.name.text}\` moves through a directory stack`);
  }
  const isSequenced =
    command.depth === 0 &&
    SEQUENCE.has(command.before) &&
    SEQUENCE.has(command.after);
  if (!isSequenced) {
    return unknown(
      'a `cd` inside a subshell, a group, a pipeline, or a || or & chain',
    );
  }
  const [target, ...rest] = command.parameters;
  if (target === undefined) {
    return { kind: 'directory', directory: home };
  }
  if (!target.isLiteral || rest.length > 0 || target.text.startsWith('-')) {
    return unknown(`\`cd\` to a path that is not a literal one`);
  }
  if (target.isTildeExpandable && /^~(?:\/|$)/.test(target.text)) {
    return {
      kind: 'directory',
      directory: path.resolve(home, target.text.slice(2)),
    };
  }
  if (target.isTildeExpandable) {
    return unknown('`cd` to another user’s home directory');
  }
  return { kind: 'directory', directory: path.resolve(directory, target.text) };
}

function unknown(reason: string): CommandTarget {
  return { kind: 'unknown', reason };
}

const GIT_WRITES = new Set(['commit', 'push']);

/**
Is this simple command a `git commit` or `git push`?
*/
function isGitWrite(command: SimpleCommand): boolean {
  if (command.name.text !== 'git') {
    return false;
  }
  const subcommand = command.parameters.find(
    (word) => !word.text.startsWith('-'),
  );
  return subcommand !== undefined && GIT_WRITES.has(subcommand.text);
}

/**
 * The directory every git write in `command` runs in, or why it cannot be
 * known. `cwd` is where the shell starts; `home` is what `~` and a bare `cd`
 * mean.
 */
export function commandTarget(
  command: string,
  cwd: string,
  home: string,
): CommandTarget {
  let commands: SimpleCommand[];
  try {
    commands = simpleCommands(scanTokens({ text: command, index: 0 }, false));
  } catch (error) {
    // Every error, not only the scanner's own: a bug here must deny the
    // write, never let it through ungated.
    return unknown(`the command could not be read (${String(error)})`);
  }
  let current: CommandTarget = { kind: 'directory', directory: cwd };
  for (const simple of commands) {
    if (isGitWrite(simple)) {
      return current;
    }
    if (
      current.kind === 'directory' &&
      CHANGE_DIRECTORY.has(simple.name.text)
    ) {
      current = changeDirectory(simple, current.directory, home);
    }
  }
  return { kind: 'directory', directory: cwd };
}
