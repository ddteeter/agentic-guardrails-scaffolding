import { describe, expect, it } from 'vitest';

import { commandTarget } from '../src/command-target.js';

const CWD = '/work/session';
const HOME = '/home/agent';

function directoryOf(command: string): string | undefined {
  const target = commandTarget(command, CWD, HOME);
  return target.kind === 'directory' ? target.directory : undefined;
}

function reasonOf(command: string): string | undefined {
  const target = commandTarget(command, CWD, HOME);
  return target.kind === 'unknown' ? target.reason : undefined;
}

describe('commandTarget: literal cd chains', () => {
  it.each([
    ['git commit -m x', CWD],
    ['git push', CWD],
    ['cd /abs && git commit -m x', '/abs'],
    ['cd rel; git commit -m x', `${CWD}/rel`],
    ['cd rel\ngit commit -m x', `${CWD}/rel`],
    ['cd a && cd b && git commit', `${CWD}/a/b`],
    ['cd a && cd .. && git commit', CWD],
    ['cd ~/x && git commit', `${HOME}/x`],
    ['cd ~ && git commit', HOME],
    ['cd && git commit', HOME],
    ['cd "/with space" && git commit', '/with space'],
    ["cd '/single quoted' && git commit", '/single quoted'],
    [String.raw`cd /esc\ aped && git commit`, '/esc aped'],
    ['cd "a"b && git commit', `${CWD}/ab`],
    [String.raw`cd "a\"b" && git commit`, `${CWD}/a"b`],
    // A quoted tilde is not expanded by the shell.
    ['cd "~/x" && git commit', `${CWD}/~/x`],
    ['cd a~ && git commit', `${CWD}/a~`],
    // Leading blanks and tabs before a command.
    ['  \tcd /abs &&\tgit commit', '/abs'],
    // A `cd` AFTER the write cannot move it.
    ['git commit -m x && cd /elsewhere', CWD],
    ['git commit -m x; cd "$X"', CWD],
    // A `cd` the command only MENTIONS.
    ['git commit -m "cd /elsewhere && x"', CWD],
    ["echo 'cd /elsewhere' && git commit", CWD],
    ['echo cd /elsewhere && git commit', CWD],
    ['# cd /elsewhere\ngit commit', CWD],
    ["# don't cd\ncd /abs && git commit", '/abs'],
    ['cd /abs # go there\ngit commit', '/abs'],
    // The commit-message shape agents use every day.
    [
      "git add -A && git commit -m \"$(cat <<'EOF'\nfix: it's (finally) done\n\nCo-Authored-By: x\nEOF\n)\"",
      CWD,
    ],
    [
      'cd /abs && git commit -m "$(cat <<\'EOF\'\nsubject\n\nbody\nEOF\n)"',
      '/abs',
    ],
    // An unquoted heredoc's body is not shell syntax either.
    ["cat <<EOF > notes\ndon't\nEOF\ncd /abs && git commit", '/abs'],
    ["cat <<-EOF\n\tdon't\n\tEOF\ncd /abs && git commit", '/abs'],
    ["cat <<'A' <<B\nit's\nA\nit's\nB\ncd /abs && git commit", '/abs'],
    // A redirection's target is not a parameter of `cd`.
    ['cd /abs >/dev/null && git commit', '/abs'],
    ['cd /abs 2>&1 && git commit', '/abs'],
    ['cd /abs 2> err.log && git commit', '/abs'],
    // Substitutions and backticks inside OTHER words do not matter.
    ['echo `pwd` && cd /abs && git commit -m "$(date) `id`"', '/abs'],
    ['echo $(cd /elsewhere; pwd) && git commit', CWD],
    ['echo "$(echo "(nested)")" && cd /abs && git commit', '/abs'],
    // A git command that writes nothing is not the write.
    ['cd /abs && git status && git commit', '/abs'],
    ['git log && cd /abs && git push origin main', '/abs'],
    // Reserved words lead into a command without being it.
    ['time cd /abs; git commit', '/abs'],
    ['if true; then echo; fi; cd /abs && git commit', '/abs'],
    ['while false; do echo; done\ncd /abs && git commit', '/abs'],
    ['cd /abs && { git commit; }', '/abs'],
    ['(true) && cd /abs && git commit', '/abs'],
    ['cd /abs && (git commit)', '/abs'],
    // A substitution ends at ITS closing parenthesis, not an inner one, and
    // not at an operator inside it.
    ['echo "$( (cd /x) )" && cd /abs && git commit', '/abs'],
    ['echo $(echo a && cd /x); git commit', CWD],
    ['echo $(a; b && cd /x); git commit', CWD],
    ['echo $( (true) ; cd /x) && git commit', CWD],
    // A file-descriptor number is all digits, right before the redirection.
    ['cd a2>/dev/null && git commit', `${CWD}/a2`],
    ['cd 2a>/dev/null && git commit', `${CWD}/2a`],
    ['cd /abs 12>/dev/null && git commit', '/abs'],
    // Heredoc bodies: blanks before the delimiter, only `<<-` strips tabs,
    // all of them, and only from the start of the line.
    ["cat << EOF\nit's\nEOF\ncd /abs && git commit", '/abs'],
    ["cat <<EOF\n\tEOF\nit's\nEOF\ncd /abs && git commit", '/abs'],
    ["cat <<-EOF\nE\tOF\nit's\n\t\tEOF\ncd /abs && git commit", '/abs'],
    ['cat <<"E\'"\nbody\nE\'\ncd /abs && git commit', '/abs'],
    ['cat <<EOF && cd /abs; git commit\nbody\nEOF', '/abs'],
    // A body that never ends runs to the end of the command.
    ["cd /abs && git commit; cat <<EOF\nit's", '/abs'],
    ["cat <<EOF\nit's", CWD],
    // A trailing comment with no newline after it.
    ['cd /abs && git commit # done', '/abs'],
    // `git` itself, not a word that merely names a git subcommand.
    ['echo commit && cd /abs && git commit', '/abs'],
    ['cd /abs && git --no-pager commit', '/abs'],
    // No git write it can find: where the command started.
    ['cd /abs && echo done', CWD],
    ['git', CWD],
  ])('%j runs its write in %s', (command, expected) => {
    expect(directoryOf(command)).toBe(expected);
  });

  it.each([
    ['cd - && git commit', 'not a literal'],
    ['cd "$X" && git commit', 'not a literal'],
    ['cd $X && git commit', 'not a literal'],
    ['cd "$(pwd)/x" && git commit', 'not a literal'],
    ['cd `pwd` && git commit', 'not a literal'],
    ['cd a b && git commit', 'not a literal'],
    ['cd -P /abs && git commit', 'not a literal'],
    ['cd ~other && git commit', 'another user'],
    ['pushd /abs && git commit', 'directory stack'],
    ['popd && git commit', 'directory stack'],
    ['cd "$X" && cd /abs && git commit', 'not a literal'],
    ['cd -P && git commit', 'not a literal'],
    ['cd ~a~/b && git commit', 'another user'],
  ])('%j cannot be resolved (%s)', (command, reason) => {
    expect(reasonOf(command)).toContain(reason);
  });

  it.each([
    ['(cd /abs && git commit)', 'subshell'],
    ['(cd /abs); git commit', 'subshell'],
    ['{ cd /abs; git commit; }', 'subshell'],
    ['if cd /abs; then git commit; fi', 'subshell'],
    ['cd /abs | cat; git commit', 'subshell'],
    ['cat x | cd /abs; git commit', 'subshell'],
    ['cd /abs || git commit', 'subshell'],
    ['false || cd /abs; git commit', 'subshell'],
    ['cd /abs & git commit', 'subshell'],
    ['if x; then y; fi; if a; then cd /abs; fi; git commit', 'subshell'],
    ['(if a; then cd /abs; fi; git commit)', 'subshell'],
    ['( (true) ); (cd /abs; git commit)', 'subshell'],
  ])('%j cannot be resolved: the cd is not sequenced (%s)', (command, word) => {
    expect(reasonOf(command)).toContain(word);
  });

  it.each([
    ['git commit -m "unclosed', 'an unclosed double quote'],
    ["git commit -m 'unclosed", 'an unclosed single quote'],
    ['git commit -m `unclosed', 'an unclosed backtick'],
    ['git commit -m $(unclosed', 'an unclosed $('],
    ['git commit -m "$(unclosed"', 'an unclosed double quote'],
  ])('%j is unreadable (%s)', (command, reason) => {
    expect(reasonOf(command)).toBe(
      `the command could not be read (SyntaxError: ${reason})`,
    );
  });
});
