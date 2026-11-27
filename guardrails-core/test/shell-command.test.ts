/**
 * `withoutInertStrings` decides which of a command's separators can start a
 * command: one inside a quoted string cannot. It is not a shell parser, and
 * its one hard rule is the direction it may be wrong in -- text that stays is
 * a spurious gate run, text that goes could be a commit nobody checked. So
 * every construct it does not model leaves the command untouched.
 */
import { describe, expect, it } from 'vitest';

import { withoutInertStrings } from '../src/shell-command.js';

/**
The commands that did NOT come back exactly as they went in.
*/
function touched(commands: readonly string[]): string[] {
  return commands.filter((command) => withoutInertStrings(command) !== command);
}

describe('withoutInertStrings: what a quoted string says is not a command', () => {
  it('empties a double-quoted string, keeping its quotes', () => {
    // The dogfooding finding: a process listing filtered by this pattern ran
    // the whole commit gate, because `git commit` follows a `|`.
    expect(
      withoutInertStrings('ps aux | grep -E "eslint|tsc|vitest|git commit"'),
    ).toBe('ps aux | grep -E ""');
  });

  it('empties a single-quoted string', () => {
    expect(withoutInertStrings("grep -E 'a|git commit' log")).toBe(
      "grep -E '' log",
    );
  });

  it('empties a single-quoted string that starts with a dollar', () => {
    expect(withoutInertStrings("grep '$HOME|git commit' log")).toBe(
      "grep '' log",
    );
  });

  it('empties every string and keeps what runs between them', () => {
    expect(withoutInertStrings('echo "a|b" && git commit -m "x; y"')).toBe(
      'echo "" && git commit -m ""',
    );
  });

  it('reads a string that spans lines as one string', () => {
    expect(withoutInertStrings('echo "one\ngit commit" ; ls')).toBe(
      'echo "" ; ls',
    );
  });

  it('leaves an empty string alone', () => {
    expect(touched([`echo "" ''`])).toEqual([]);
  });

  it('does not end a double-quoted string at an escaped quote', () => {
    expect(withoutInertStrings(String.raw`echo "a \" | git commit" ; ls`)).toBe(
      'echo "" ; ls',
    );
  });

  it('reads the other kind of quote inside a string as text', () => {
    expect(withoutInertStrings(`echo 'say "hi"; git commit' ; ls`)).toBe(
      "echo '' ; ls",
    );
    expect(withoutInertStrings(`echo "it's; git commit" ; ls`)).toBe(
      'echo "" ; ls',
    );
  });

  it('gives a backslash no power inside single quotes', () => {
    // `'a\'` is a whole string, so the quote after it opens the next one.
    expect(withoutInertStrings(String.raw`echo 'a\' ; git commit -m 'b'`)).toBe(
      "echo '' ; git commit -m ''",
    );
  });

  it('follows the close-escape-reopen idiom for a quote in single quotes', () => {
    expect(withoutInertStrings(String.raw`echo 'it'\''s' && git commit`)).toBe(
      String.raw`echo ''\''' && git commit`,
    );
  });

  it('reads a literal dollar in double quotes as text', () => {
    expect(withoutInertStrings('echo "$HOME|git commit" "cost $"')).toBe(
      'echo "" ""',
    );
    expect(withoutInertStrings(String.raw`echo "\$(git commit)" ; ls`)).toBe(
      'echo "" ; ls',
    );
  });

  it('reads a here-string as an ordinary string, not a heredoc', () => {
    expect(withoutInertStrings('grep x <<< "a|git commit"')).toBe(
      'grep x <<< ""',
    );
  });
});

describe('withoutInertStrings: what it does not model, it does not touch', () => {
  it('does not open a string at an escaped quote', () => {
    // Read as strings, these would swallow the commit between them.
    expect(
      touched([
        String.raw`echo \" ; git commit ; echo \"`,
        String.raw`echo \' ; git commit ; echo \'`,
      ]),
    ).toEqual([]);
  });

  it('leaves a command with an unterminated string whole', () => {
    expect(
      touched([
        'echo "abc ; git commit',
        "echo 'abc ; git commit",
        // Whole, not partly stripped: the first string is closed.
        `echo "a|b" 'abc ; git commit`,
        // A backslash is the last thing in it.
        'echo "abc\\',
      ]),
    ).toEqual([]);
  });

  it('leaves a command whose double quotes hold a command substitution whole', () => {
    // The substitution RUNS, and the quotes inside it pair with each other
    // rather than with the ones around it, which this does not follow.
    expect(
      touched([
        'echo "$(git commit -m x)"',
        'echo "`git commit -m x`"',
        'echo "a|b" "$(date)" ; git commit -m "x"',
      ]),
    ).toEqual([]);
  });

  it('leaves a command with an ANSI-C string whole', () => {
    // `$'...'` takes backslash escapes, so `\'` does not close it. Read as an
    // ordinary string, the first of these pairs its quotes across the commit
    // and empties it.
    expect(
      touched([
        String.raw`echo $'a\'' ; git commit -m x ; echo 'b'\'`,
        String.raw`echo $'it\'s' ; git commit -m 'x'`,
        "echo $'a|b'",
      ]),
    ).toEqual([]);
  });

  it('leaves a command with a heredoc whole', () => {
    // A heredoc body is text: an apostrophe in it opens nothing. Paired with
    // each other, the two in the first of these would hide the commit between.
    expect(
      touched([
        "cat <<EOF\nit's\nEOF\ngit commit -m x\ncat <<EOF\nit's\nEOF",
        "cat <<EOF\nit's\nEOF\ngit commit -m 'x'",
        "cat <<'EOF'\nit's\nEOF\ngit commit -m 'x'",
      ]),
    ).toEqual([]);
  });

  it('keeps a string a shell is handed to run', () => {
    expect(
      touched([
        'bash -c "cd x && git commit -m y"',
        "sh -lc 'cd x && git commit'",
        'eval "true; git commit"',
        'git rebase --exec "true; git commit --amend"',
        'git rebase --exec="true; git commit --amend"',
        'sh -c\t"true; git commit"',
        'bash -c  "true; git commit"',
      ]),
    ).toEqual([]);
  });

  it('goes on reading after a string it kept', () => {
    expect(withoutInertStrings('bash -c "x; y" ; echo "a|b"')).toBe(
      'bash -c "x; y" ; echo ""',
    );
  });

  it('does not take a string for a script unless the word before it says so', () => {
    expect(withoutInertStrings('bash -c ls "a|git commit"')).toBe(
      'bash -c ls ""',
    );
    expect(withoutInertStrings('echo c "a|git commit"')).toBe('echo c ""');
    expect(withoutInertStrings('evaluate "a|git commit"')).toBe('evaluate ""');
    expect(withoutInertStrings('grep -cv "a|git commit"')).toBe('grep -cv ""');
    expect(withoutInertStrings('bash -c"a|git commit"')).toBe('bash -c""');
  });

  it('looks only at the word just before the string, however long the command', () => {
    const padding = 'x'.repeat(40);
    expect(withoutInertStrings(`sh -c ${padding} "a|git commit"`)).toBe(
      `sh -c ${padding} ""`,
    );
    expect(touched([`${padding} sh -c "a; git commit"`])).toEqual([]);
  });
});

describe('withoutInertStrings: a comment is not where a string opens', () => {
  it('reads an apostrophe in a comment as text', () => {
    expect(withoutInertStrings("# don't\ngit commit -m 'x'")).toBe(
      "# don't\ngit commit -m ''",
    );
    expect(withoutInertStrings("ls # it's\ngit commit -m 'x'")).toBe(
      "ls # it's\ngit commit -m ''",
    );
  });

  it('starts a comment after any character that ends a word', () => {
    for (const before of [' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']) {
      const command = `ls${before}# it's\ngit commit -m 'x'`;
      expect(withoutInertStrings(command), JSON.stringify(before)).toBe(
        `ls${before}# it's\ngit commit -m ''`,
      );
    }
  });

  it('starts a comment after a backtick, where a command can start', () => {
    expect(withoutInertStrings("echo `# it's\n` 'a|b'")).toBe(
      "echo `# it's\n` ''",
    );
  });

  it('ends a comment at the end of its line, or of the command', () => {
    expect(touched(["ls # it's", "# it's"])).toEqual([]);
    expect(withoutInertStrings("ls # one\necho 'a|b' # it's")).toBe(
      "ls # one\necho '' # it's",
    );
  });

  it('tells a comment by what comes before the #, not after', () => {
    expect(withoutInertStrings("echo a# 'x; git commit'")).toBe("echo a# ''");
    expect(withoutInertStrings("ls #it's\ngit commit -m 'x'")).toBe(
      "ls #it's\ngit commit -m ''",
    );
  });

  it('does not take a # inside a word for a comment', () => {
    expect(withoutInertStrings("echo a#b 'x; git commit'")).toBe("echo a#b ''");
    expect(withoutInertStrings("echo $# 'x; git commit'")).toBe("echo $# ''");
  });

  it('does not take an escaped # for a comment', () => {
    expect(withoutInertStrings(String.raw`echo \# 'x; git commit'`)).toBe(
      String.raw`echo \# ''`,
    );
  });

  it('reads a # inside a string as text', () => {
    expect(withoutInertStrings(`echo " # it's" 'a|b'`)).toBe(`echo "" ''`);
  });
});

/**
`count` short strings in one command.
*/
function manyStrings(count: number): string {
  // Each behind a flag: the word before a string is what gets looked at, and
  // looking further back than that is what would make this quadratic.
  return `echo ${'-x "a|b" '.repeat(count)}`;
}

function millisecondsToStrip(command: string): number {
  const started = process.hrtime.bigint();
  withoutInertStrings(command);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe('withoutInertStrings: cost', () => {
  it('stays linear on a long run of strings', () => {
    millisecondsToStrip(manyStrings(1000));
    expect(millisecondsToStrip(manyStrings(40_000))).toBeLessThan(1000);
  });
});
