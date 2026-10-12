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
