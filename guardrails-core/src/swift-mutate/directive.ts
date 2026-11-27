/**
A parsed `guardrails-mutate:disable-next-line` comment.
*/
export interface Directive {
  /**
  The operator names it lists, or `all`.
  */
  readonly names: readonly string[];
  /**
  Everything after the first ` -- `, trimmed; empty when there is none.
  */
  readonly reason: string;
}

const PREFIX = 'guardrails-mutate:disable-next-line ';

/**
The directive a comment's content is, as a list of none or one.

The directive must lead the comment: the content is what the lexer gives for
a comment, already without its `//` and trimmed. After the prefix comes a
comma-separated list of operator names, then optionally ` -- ` and a reason.
*/
export function parseDirective(content: string): readonly Directive[] {
  if (!content.startsWith(PREFIX)) {
    return [];
  }
  const [names = '', ...reason] = content.slice(PREFIX.length).split(' -- ');
  return [
    {
      names: names.split(',').map((name) => name.trim()),
      reason: reason.join(' -- ').trim(),
    },
  ];
}

/**
True when the directive names the operator, or names `all`.
*/
export function isDisabled(directive: Directive, operator: string): boolean {
  return directive.names.includes('all') || directive.names.includes(operator);
}
