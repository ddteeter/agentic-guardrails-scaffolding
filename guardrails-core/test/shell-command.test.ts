/**
 * `withoutInertStrings` decides which of a command's separators can start a
 * command: one inside a quoted string that is only DATA cannot. It is not a
 * shell parser, and its one hard rule is the direction it may be wrong in --
 * text that stays is a spurious gate run, text that goes could be a commit
 * nobody checked.
 *
 * So it does not look for the strings that are scripts; it looks for the
 * commands whose strings can only be data, and empties nothing anywhere else.
 * Its first version did the opposite, and seven shapes got past it: a script
 * piped to a shell, `-c` in the middle of a flag group, a script in two
 * adjacent quoted pieces, a script held in a variable, programs other than a
 * shell that run their argument, a shell with other quoting rules, and a
 * heredoc whose delimiter is not a word.
 */
import { describe, expect, it } from 'vitest';

import { withoutInertStrings } from '../src/shell-command.js';

/**
The commands that did NOT come back exactly as they went in.
*/
function touched(commands: readonly string[]): string[] {
  return commands.filter((command) => withoutInertStrings(command) !== command);
}

describe('withoutInertStrings: a string given to a program that only reads it', () => {
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

  it('empties every string of a command made only of such programs', () => {
    expect(
      withoutInertStrings(
        `cd src && ps aux | grep -E "a|b" | grep -v 'c; d' ; echo "x; y"`,
      ),
    ).toBe(`cd src && ps aux | grep -E "" | grep -v '' ; echo ""`);
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
    expect(withoutInertStrings(String.raw`echo 'a\' ; echo 'b; c'`)).toBe(
      "echo '' ; echo ''",
    );
  });

  it('follows the close-escape-reopen idiom for a quote in single quotes', () => {
    expect(withoutInertStrings(String.raw`echo 'it'\''s; x' && ls`)).toBe(
      String.raw`echo ''\''' && ls`,
    );
  });

  it('reads a dollar or a backtick inside single quotes as text', () => {
    expect(withoutInertStrings("grep -E 'a$|`b`|git commit' log")).toBe(
      "grep -E '' log",
    );
  });

  it('reads a here-string as an ordinary string, not a heredoc', () => {
    expect(withoutInertStrings('grep x <<< "a|git commit"')).toBe(
      'grep x <<< ""',
    );
  });

  it('does not take a # inside a word for a comment', () => {
    expect(withoutInertStrings("echo a#b 'x; git commit'")).toBe("echo a#b ''");
  });

  it('does not take an escaped # for a comment', () => {
    expect(withoutInertStrings(String.raw`echo \# 'x; git commit'`)).toBe(
      String.raw`echo \# ''`,
    );
  });

  it('sees through a file-descriptor duplication, whose & separates nothing', () => {
    expect(withoutInertStrings('ps aux 2>&1 | grep -E "a|git commit"')).toBe(
      'ps aux 2>&1 | grep -E ""',
    );
    expect(withoutInertStrings('grep -E "a|git commit" log >&2')).toBe(
      'grep -E "" log >&2',
    );
  });

  it.each([
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
  ])('counts %s as a program that only reads its strings', (program) => {
    expect(withoutInertStrings(`${program} "a; git commit"`)).toBe(
      `${program} ""`,
    );
  });
});

describe('withoutInertStrings: anything else is left whole', () => {
  it('keeps a string piped or here-stringed to a shell', () => {
    // `echo` only prints -- into a shell that runs what it printed.
    expect(
      touched([
        `echo 'true; git commit -m x' | sh`,
        `bash <<< 'true; git commit -m x'`,
        `printf '%s\n' 'true; git push' | bash -s`,
        `echo 'true; git commit -m x' | tee /dev/stderr | zsh`,
      ]),
    ).toEqual([]);
  });

  it('keeps a string a shell is handed, however the flag is written', () => {
    expect(
      touched([
        'bash -c "cd x && git commit -m y"',
        `bash -ce 'true; git commit -m x'`,
        `bash -c -e 'true; git commit -m x'`,
        `bash -c -- 'true; git commit -m x'`,
        `zsh -cf 'true; git commit -m x'`,
        `sh -lc 'cd x && git commit'`,
        'eval "true; git commit"',
      ]),
    ).toEqual([]);
  });

  it('keeps a script written as adjacent quoted pieces', () => {
    expect(
      touched([
        `bash -c 'cd /r'"; git commit -m x"`,
        `bash -c 'cd /r'' && git push'`,
      ]),
    ).toEqual([]);
  });

  it('keeps a script held in a variable, where it is assigned', () => {
    expect(
      touched([
        `S='true; git commit -m x'; eval "$S"`,
        `S='true; git commit -m x'; bash -c "$S"`,
        `S='true; git commit -m x'; eval $S`,
        // An assignment in front of a program that only reads.
        `S='true; git commit -m x' echo hi`,
      ]),
    ).toEqual([]);
  });

  it('keeps the string of any program that is not known only to read it', () => {
    expect(
      touched([
        `git rebase -x 'true; git commit --amend'`,
        `git rebase --exec 'true; git commit --amend'`,
        `git submodule foreach 'true; git commit -m y'`,
        `git -c alias.x='!f(){ true; git commit -m y; }; f' x`,
        `node -e 'x(); git commit'`,
        `perl -e 'system("true; git commit -m x")'`,
        `awk 'BEGIN{system("true; git commit -m x")}'`,
        String.raw`find . -exec sh -c 'true; git commit -m x' \;`,
        `xargs -I{} sh -c 'true; git commit -m x'`,
        `tmux send-keys 'true; git commit -m x' Enter`,
        `watch 'true; git push'`,
        // Programs that read, and can be told to run something.
        `rg --pre 'sh -c "true; git commit"' x`,
        `sort --compress-program='sh' 'a; git commit'`,
        `sed 's/a/b; git commit/e' f`,
      ]),
    ).toEqual([]);
  });

  it('keeps everything when one command among several is not such a program', () => {
    expect(
      touched([
        'grep -E "a|b" log && git commit -m "x; y"',
        'echo "a; b" ; make',
        '(echo "a; b"; sh)',
        'echo "a; b" > >(sh)',
        'cat <(echo "a; b"; date)',
        '{ echo "a; b"; date; }',
        'echo "a; b" & date',
      ]),
    ).toEqual([]);
  });

  it('keeps a program it knows when the name is not written plainly', () => {
    expect(
      touched([
        '/bin/echo "a; b"',
        String.raw`\echo "a; b"`,
        '"echo" "a; b"',
        `ec'ho' "a; b"`,
        'time echo "a; b"',
        'env echo "a; b"',
        '! grep -q "a; b" f',
        'if grep -q "a; b" f; then ls; fi',
        'echo; > out "a; b"',
        'echoes "a; b"',
        'Echo "a; b"',
      ]),
    ).toEqual([]);
  });

  it('keeps a command the shell expands anything in', () => {
    // An expansion can become a program, a flag or a whole script.
    expect(
      touched([
        'echo "$(git commit -m x)"',
        'echo "`git commit -m x`"',
        'echo "$HOME; git commit"',
        'echo $X "a; git commit"',
        'echo `date` "a; git commit"',
        'echo "a; git commit" $(date)',
        String.raw`echo $'it\'s' ; echo 'x; y'`,
        "echo $'a|b'",
        'echo "cost $"',
      ]),
    ).toEqual([]);
  });

  it('keeps a command with an unterminated string', () => {
    expect(
      touched([
        'echo "abc ; git commit',
        "echo 'abc ; git commit",
        `echo "a|b" 'abc ; git commit`,
        'echo "abc\\',
      ]),
    ).toEqual([]);
  });

  it('does not open a string at an escaped quote', () => {
    expect(
      touched([
        String.raw`echo \" ; git commit ; echo \"`,
        String.raw`echo \' ; git commit ; echo \'`,
      ]),
    ).toEqual([]);
  });

  it('keeps a command with a heredoc, whatever its delimiter', () => {
    // A heredoc body is text: an apostrophe in it opens nothing. A delimiter
    // need not be a word, and one that was not went unrecognised.
    expect(
      touched([
        "cat <<EOF\nit's\nEOF\necho 'x; y'\ncat <<EOF\nit's\nEOF",
        "cat <<'EOF'\nit's\nEOF\necho 'x; y'",
        "cat <<.\nit's\n.\necho 'x; y' # it's ok",
        "cat <<''\nit's\n\necho 'x; y' # it's ok",
        "cat <<-.\n\tit's\n\t.\necho 'x; y'",
        'cat << "E O F"\nx\nE O F\necho "a; b"',
      ]),
    ).toEqual([]);
  });

  it('keeps a command with a heredoc that would otherwise read as plain data', () => {
    // Every other reason to leave these alone is absent: the delimiter and
    // the body lines are programs that only read, and the quotes pair up.
    // Read without the heredoc rule, the two apostrophes pair across the
    // commit between the heredocs and empty it.
    expect(
      touched([
        "cat <<true\necho '\ntrue\ngit commit -m x\ncat <<true\necho '\ntrue",
        "cat <<true\necho 'a; b'\ntrue",
        "cat <<-true\necho 'a; b'\ntrue",
      ]),
    ).toEqual([]);
  });

  it('keeps a command with a comment that would otherwise read as plain data', () => {
    // No apostrophe in the comment and nothing but programs that only read:
    // the comment is the one reason left.
    expect(
      touched([
        "echo 'a; b' # fine",
        "echo 'a; b' #fine",
        "# note\necho 'x; y'",
        "ls;# note\necho 'x; y'",
        "ls\t# note\necho 'x; y'",
        "ls\n# note\necho 'x; y'",
        "ls &# note\necho 'x; y'",
        "ls |# note\necho 'x; y'",
        "(# note\necho 'x; y')",
        "cat <# 'x; y'",
        "cat ># 'x; y'",
      ]),
    ).toEqual([]);
  });

  it('tells a comment by what comes before the #, not after', () => {
    expect(withoutInertStrings("echo a# 'x; git commit'")).toBe("echo a# ''");
  });

  it('keeps a command with an expansion in the middle of a word', () => {
    // Where the character before it does not end a word, an expansion is
    // still an expansion.
    expect(
      touched(['echo pre$X "a; b"', 'echo pre`date` "a; b"', 'echo "a; b"$X']),
    ).toEqual([]);
  });

  it('keeps a command with a comment in it', () => {
    // Whether `#` starts a comment depends on the shell and how it was
    // started, and a wrong guess pairs the quotes after it differently.
    expect(
      touched([
        "echo 'a; b' # it's fine",
        "# don't\necho 'x; y'",
        "ls;# it's\necho 'x; y'",
        "ls\t# it's\necho 'x; y'",
        "ls\n# it's\necho 'x; y'",
        "ls &# it's\necho 'x; y'",
        "ls |# it's\necho 'x; y'",
        "(# it's\necho 'x; y')",
      ]),
    ).toEqual([]);
  });

  it('keeps a command whose & is not a file-descriptor duplication', () => {
    expect(
      touched([
        'echo "a; b" &> out',
        'echo "a; b" >& out',
        'echo "a; b" 2>&x',
        // A duplication does not hide the separator before it.
        'echo "a; b";>&2 sh',
      ]),
    ).toEqual([]);
  });
});

/**
`count` short strings in one command.
*/
function manyStrings(count: number): string {
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
