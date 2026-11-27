import { describe, expect, it } from 'vitest';

import {
  lexSwift,
  lexSwiftLine,
  SWIFT_INITIAL_STATE,
  swiftStateAtLine,
  type SwiftLexState,
  type SwiftToken,
} from '../src/swift-lexer/index.js';

/**
A string token that an interpolation ends keeps the backslash, and a string
that ends in a backslash cannot be written with `String.raw`.
*/
const BACKSLASH = '\\';

/**
One token as `kind:text`, the form every table below is written in.
*/
function show(token: SwiftToken): string {
  return `${token.kind}:${token.text}`;
}

/**
Lex one line from the initial (code) state.
*/
function line(text: string, state: SwiftLexState = SWIFT_INITIAL_STATE) {
  return lexSwiftLine(text, state);
}

/**
The `kind:text` view of one line's tokens.
*/
function shown(text: string, state: SwiftLexState = SWIFT_INITIAL_STATE) {
  return line(text, state).tokens.map((token) => show(token));
}

/**
Everything one line lexes to, with its tokens in `kind:text` form.
*/
function view(text: string, state: SwiftLexState = SWIFT_INITIAL_STATE) {
  const lexed = line(text, state);
  return { ...lexed, tokens: lexed.tokens.map((token) => show(token)) };
}

describe('lexSwiftLine: identifiers and punctuation', () => {
  it('starts from an empty frame stack, which means "in code"', () => {
    expect(SWIFT_INITIAL_STATE).toEqual([]);
    expect(Object.isFrozen(SWIFT_INITIAL_STATE)).toBe(true);
  });

  it('lexes an empty line to nothing and stays in code', () => {
    expect(line('')).toEqual({ tokens: [], comments: [], code: '', state: [] });
  });

  it.each([
    ['foo', ['identifier:foo']],
    ['let x', ['identifier:let', 'identifier:x']],
    ['  let\tx  ', ['identifier:let', 'identifier:x']],
    [
      '_ $0 _a1 café',
      ['identifier:_', 'identifier:$0', 'identifier:_a1', 'identifier:café'],
    ],
    // Anything outside ASCII is an identifier character, astral or not.
    ['😀é = x', ['identifier:😀é', 'operator:=', 'identifier:x']],
    [
      'f(a, b)',
      [
        'identifier:f',
        'punctuation:(',
        'identifier:a',
        'punctuation:,',
        'identifier:b',
        'punctuation:)',
      ],
    ],
    [
      '[a]{b};c:d',
      [
        'punctuation:[',
        'identifier:a',
        'punctuation:]',
        'punctuation:{',
        'identifier:b',
        'punctuation:}',
        'punctuation:;',
        'identifier:c',
        'punctuation::',
        'identifier:d',
      ],
    ],
    ['a.b', ['identifier:a', 'punctuation:.', 'identifier:b']],
    [
      String.raw`\Type.name`,
      ['punctuation:\\', 'identifier:Type', 'punctuation:.', 'identifier:name'],
    ],
  ])('lexes %j', (text, expected) => {
    expect(shown(text)).toEqual(expected);
  });
});

describe('lexSwiftLine: numbers', () => {
  it.each([
    ['42', ['number:42']],
    ['7', ['number:7']],
    ['1_000', ['number:1_000']],
    ['0xFF', ['number:0xFF']],
    ['0X1f', ['number:0X1f']],
    ['0b1010', ['number:0b1010']],
    ['3.14', ['number:3.14']],
    ['3.5', ['number:3.5']],
    ['2e3', ['number:2e3']],
    ['1e-3', ['number:1e-3']],
    ['1.5E+10', ['number:1.5E+10']],
    ['1e-10', ['number:1e-10']],
    ['a1', ['identifier:a1']],
    ['1...3', ['number:1', 'operator:...', 'number:3']],
    ['1..<3', ['number:1', 'operator:..<', 'number:3']],
    ['1-3', ['number:1', 'operator:-', 'number:3']],
    ['1e-x', ['number:1e', 'operator:-', 'identifier:x']],
    // `e` is a hex digit, so no exponent sign follows a hex literal.
    ['0xFE-1', ['number:0xFE', 'operator:-', 'number:1']],
    ['3.x', ['number:3', 'punctuation:.', 'identifier:x']],
    ['x.0', ['identifier:x', 'punctuation:.', 'number:0']],
    // Accepted limit: a nested tuple index reads as one fractional number.
    ['t.0.1', ['identifier:t', 'punctuation:.', 'number:0.1']],
  ])('lexes %j', (text, expected) => {
    expect(shown(text)).toEqual(expected);
  });
});

describe('lexSwiftLine: operators', () => {
  it.each([
    '->',
    '==',
    '!=',
    '===',
    '!==',
    '<=',
    '>=',
    '&&',
    '||',
    '??',
    '+=',
    '-=',
    '*=',
    '/=',
    '...',
    '..<',
    '.==',
    '>>',
    '+',
    '-',
    '*',
    '/',
    '%',
    '<',
    '>',
    '&',
    '|',
    '^',
    '~',
    '=',
    '?',
    '!',
  ])('lexes a spaced %j as one operator token', (operator) => {
    expect(shown(`a ${operator} b`)).toEqual([
      'identifier:a',
      `operator:${operator}`,
      'identifier:b',
    ]);
  });

  it.each([
    ['a!.b', ['identifier:a', 'operator:!', 'punctuation:.', 'identifier:b']],
    ['a?.b', ['identifier:a', 'operator:?', 'punctuation:.', 'identifier:b']],
    [
      'f(x!)',
      [
        'identifier:f',
        'punctuation:(',
        'identifier:x',
        'operator:!',
        'punctuation:)',
      ],
    ],
    ['a! + b', ['identifier:a', 'operator:!', 'operator:+', 'identifier:b']],
    ['a!!', ['identifier:a', 'operator:!', 'operator:!']],
    ['a!-b', ['identifier:a', 'operator:!', 'operator:-', 'identifier:b']],
    ['Int??', ['identifier:Int', 'operator:?', 'operator:?']],
    [
      'x as! T',
      ['identifier:x', 'identifier:as', 'operator:!', 'identifier:T'],
    ],
    ['try? f', ['identifier:try', 'operator:?', 'identifier:f']],
    [
      'a[0]!',
      [
        'identifier:a',
        'punctuation:[',
        'number:0',
        'punctuation:]',
        'operator:!',
      ],
    ],
  ])(
    'splits a left-bound ! or ? off as its own token in %j',
    (text, expected) => {
      expect(shown(text)).toEqual(expected);
    },
  );

  it('accepts, as a limit, that an unspaced a??b reads as two postfix ?', () => {
    expect(shown('a??b')).toEqual([
      'identifier:a',
      'operator:?',
      'operator:?',
      'identifier:b',
    ]);
  });

  it.each([
    ['a!=b', ['identifier:a', 'operator:!=', 'identifier:b']],
    ['a!==b', ['identifier:a', 'operator:!==', 'identifier:b']],
  ])(
    'keeps a left-bound ! that = follows inside the operator in %j',
    (text, expected) => {
      expect(shown(text)).toEqual(expected);
    },
  );

  it.each(['(', '[', '{', ',', ';', ':'])(
    'does not count a ?? after %j as left-bound',
    (opener) => {
      expect(shown(`${opener}??`)).toEqual([
        `punctuation:${opener}`,
        'operator:??',
      ]);
    },
  );

  it('does not count an operator at the start of the line as left-bound', () => {
    expect(shown('!!a')).toEqual(['operator:!!', 'identifier:a']);
  });

  it.each([
    [
      'Foo<Bar>!',
      [
        'identifier:Foo',
        'operator:<',
        'identifier:Bar',
        'operator:>',
        'operator:!',
      ],
    ],
    [
      'A<B<C>>?',
      [
        'identifier:A',
        'operator:<',
        'identifier:B',
        'operator:<',
        'identifier:C',
        'operator:>',
        'operator:>',
        'operator:?',
      ],
    ],
    ['a>!=b', ['identifier:a', 'operator:>', 'operator:!=', 'identifier:b']],
    [
      'A<B>.c',
      [
        'identifier:A',
        'operator:<',
        'identifier:B',
        'operator:>',
        'punctuation:.',
        'identifier:c',
      ],
    ],
  ])(
    'ends an operator at a > that ! or ? follows, so a generic can be unwrapped: %j',
    (text, expected) => {
      expect(shown(text)).toEqual(expected);
    },
  );

  it.each([
    ['x = .a', ['identifier:x', 'operator:=', 'punctuation:.', 'identifier:a']],
    ['a==.b', ['identifier:a', 'operator:==', 'punctuation:.', 'identifier:b']],
    ['a..', ['identifier:a', 'operator:..']],
  ])(
    'lets only an operator that starts with a dot contain dots: %j',
    (text, expected) => {
      expect(shown(text)).toEqual(expected);
    },
  );

  it.each([
    ['@objc', ['punctuation:@', 'identifier:objc']],
    ['#if DEBUG', ['punctuation:#', 'identifier:if', 'identifier:DEBUG']],
    ["'a'", ["punctuation:'", 'identifier:a', "punctuation:'"]],
    [
      'it\'s "s"',
      ['identifier:it', "punctuation:'", 'identifier:s', 'string:"s"'],
    ],
  ])(
    'lexes %j with @, # and the apostrophe as plain punctuation',
    (text, expected) => {
      expect(shown(text)).toEqual(expected);
    },
  );
});

const IN_COMMENT: SwiftLexState = [{ kind: 'comment', depth: 1 }];
const IN_NESTED_COMMENT: SwiftLexState = [{ kind: 'comment', depth: 2 }];

describe('lexSwiftLine: line comments', () => {
  it.each([
    ['// hello', ['comment:// hello'], ['hello'], ''],
    ['//', ['comment://'], [''], ''],
    [
      'let x // note',
      ['identifier:let', 'identifier:x', 'comment:// note'],
      ['note'],
      'let x ',
    ],
    ['x//y', ['identifier:x', 'comment://y'], ['y'], 'x'],
    // `//` starts a comment even directly after operator characters.
    ['a +// c', ['identifier:a', 'operator:+', 'comment:// c'], ['c'], 'a +'],
    ['// a // b', ['comment:// a // b'], ['a // b'], ''],
    ['// "s" /* b', ['comment:// "s" /* b'], ['"s" /* b'], ''],
  ])('lexes %j', (text, tokens, comments, code) => {
    expect(view(text)).toEqual({ tokens, comments, code, state: [] });
  });

  it.each([
    ['/// swiftlint:disable all', 'swiftlint:disable all'],
    ['//// four', 'four'],
    ['//! bang', 'bang'],
    [
      '//swiftlint:disable:next force_cast',
      'swiftlint:disable:next force_cast',
    ],
    ['// keeps /inner* !marks', 'keeps /inner* !marks'],
    ['//   padded   ', 'padded'],
  ])(
    'keeps the doc markers of %j out of the comment content',
    (text, content) => {
      expect(line(text).comments).toEqual([content]);
    },
  );
});

describe('lexSwiftLine: block comments', () => {
  it.each([
    ['/* x */', ['comment:/* x */'], ['x'], ''],
    [
      'a /* x */ b',
      ['identifier:a', 'comment:/* x */', 'identifier:b'],
      ['x'],
      'a  b',
    ],
    [
      '/* a */ b /* c */ // d',
      ['comment:/* a */', 'identifier:b', 'comment:/* c */', 'comment:// d'],
      ['a', 'c', 'd'],
      ' b  ',
    ],
    ['/**/', ['comment:/**/'], [''], ''],
    ['/** doc */', ['comment:/** doc */'], ['doc'], ''],
    ['/*! doc */', ['comment:/*! doc */'], ['doc'], ''],
    ['/*** doc */', ['comment:/*** doc */'], ['doc'], ''],
    // `/*` starts a comment even directly after operator characters.
    [
      'a */* c */ b',
      ['identifier:a', 'operator:*', 'comment:/* c */', 'identifier:b'],
      ['c'],
      'a * b',
    ],
    [
      '/* "s" // t */ u',
      ['comment:/* "s" // t */', 'identifier:u'],
      ['"s" // t'],
      ' u',
    ],
  ])('lexes %j', (text, tokens, comments, code) => {
    expect(view(text)).toEqual({ tokens, comments, code, state: [] });
  });

  it('nests: an inner comment does not close the outer one', () => {
    expect(view('/* a /* b */ c */ d')).toEqual({
      tokens: ['comment:/* a /* b */ c */', 'identifier:d'],
      comments: ['a /* b */ c'],
      code: ' d',
      state: [],
    });
  });

  it.each([
    ['x /* open', IN_COMMENT, ['open'], 'x '],
    ['/* a /* b', IN_NESTED_COMMENT, ['a /* b'], ''],
    ['/* a /* b */', IN_COMMENT, ['a /* b'], ''],
    // The `/` after `/*` is comment text, not half of a closing `*/`.
    ['/*/', IN_COMMENT, [''], ''],
  ])(
    'keeps the comment open across the end of %j',
    (text, state, comments, code) => {
      expect(view(text)).toMatchObject({ comments, code, state });
    },
  );

  it.each([
    [' * swiftlint:disable all', ['swiftlint:disable all']],
    ['   let y = try! risky()', ['let y = try! risky()']],
    ['  ', ['']],
    ['', []],
    ['// not a line comment', ['not a line comment']],
    ['"not a string', ['"not a string']],
  ])(
    'lexes the continuation line %j as nothing but comment',
    (text, comments) => {
      expect(view(text, IN_COMMENT)).toEqual({
        tokens: text === '' ? [] : [`comment:${text}`],
        comments,
        code: '',
        state: IN_COMMENT,
      });
    },
  );

  it.each([
    [
      ' end */ let x',
      IN_COMMENT,
      [],
      ['comment: end */', 'identifier:let', 'identifier:x'],
      ['end'],
      ' let x',
    ],
    [' */', IN_COMMENT, [], ['comment: */'], [''], ''],
    [
      'a */ b */ c',
      IN_NESTED_COMMENT,
      [],
      ['comment:a */ b */', 'identifier:c'],
      ['a */ b'],
      ' c',
    ],
    [
      'a */ b',
      IN_NESTED_COMMENT,
      IN_COMMENT,
      ['comment:a */ b'],
      ['a */ b'],
      '',
    ],
    [
      'x /* y',
      IN_COMMENT,
      IN_NESTED_COMMENT,
      ['comment:x /* y'],
      ['x /* y'],
      '',
    ],
  ])(
    'carries the nesting depth into %j',
    (text, before, after, tokens, comments, code) => {
      expect(view(text, before)).toEqual({
        tokens,
        comments,
        code,
        state: after,
      });
    },
  );

  it('starts a continuation line token at column 1, whitespace included', () => {
    const [token] = lexSwiftLine('  x */', IN_COMMENT, 4).tokens;
    expect(token).toMatchObject({ line: 4, column: 1, endColumn: 7 });
  });
});

/**
Each token of a line as `kind:text` with its interpolation depth.
*/
function depths(text: string, state: SwiftLexState = SWIFT_INITIAL_STATE) {
  return line(text, state).tokens.map((token) => [
    show(token),
    token.interpolationDepth,
  ]);
}

describe('lexSwiftLine: string literals', () => {
  it.each([
    ['"hello"', ['string:"hello"'], ''],
    ['""', ['string:""'], ''],
    ['"" + x', ['string:""', 'operator:+', 'identifier:x'], ' + x'],
    [
      'let s = "a // b"',
      ['identifier:let', 'identifier:s', 'operator:=', 'string:"a // b"'],
      'let s = ',
    ],
    ['"a /* b" c', ['string:"a /* b"', 'identifier:c'], ' c'],
    ['"try! x as! Y"', ['string:"try! x as! Y"'], ''],
    [
      String.raw`"a \" b" c`,
      [String.raw`string:"a \" b"`, 'identifier:c'],
      ' c',
    ],
    [String.raw`"a\\" c`, [String.raw`string:"a\\"`, 'identifier:c'], ' c'],
    [String.raw`"\\\"" c`, [String.raw`string:"\\\""`, 'identifier:c'], ' c'],
    [String.raw`"\\(x)" c`, [String.raw`string:"\\(x)"`, 'identifier:c'], ' c'],
    [
      `'a "b" c'`,
      [
        "punctuation:'",
        'identifier:a',
        'string:"b"',
        'identifier:c',
        "punctuation:'",
      ],
      "'a  c'",
    ],
  ])('lexes %j', (text, tokens, code) => {
    expect(view(text)).toEqual({ tokens, comments: [], code, state: [] });
  });

  it.each([
    [
      'let s = "abc',
      ['identifier:let', 'identifier:s', 'operator:=', 'string:"abc'],
    ],
    [String.raw`"abc\ `, [String.raw`string:"abc\ `]],
    [`"abc${BACKSLASH}`, [`string:"abc${BACKSLASH}`]],
    [
      String.raw`"a \(b`,
      [`string:"a ${BACKSLASH}`, 'punctuation:(', 'identifier:b'],
    ],
    [
      String.raw`"a \("b`,
      [`string:"a ${BACKSLASH}`, 'punctuation:(', 'string:"b'],
    ],
    [
      String.raw`"a \(b /* c`,
      [
        `string:"a ${BACKSLASH}`,
        'punctuation:(',
        'identifier:b',
        'comment:/* c',
      ],
    ],
  ])(
    'ends the unterminated single-line string %j at the end of the line',
    (text, tokens) => {
      expect(view(text)).toMatchObject({ tokens, state: [] });
    },
  );
});

describe('lexSwiftLine: string interpolation', () => {
  it('lexes the inside of an interpolation as code', () => {
    expect(view(String.raw`"a \(x) b" c`)).toEqual({
      tokens: [
        `string:"a ${BACKSLASH}`,
        'punctuation:(',
        'identifier:x',
        'punctuation:)',
        'string: b"',
        'identifier:c',
      ],
      comments: [],
      code: '(x) c',
      state: [],
    });
  });

  it('balances parentheses to find where the interpolation closes', () => {
    expect(view(String.raw`"\(f(x, (y)))!" z`)).toMatchObject({
      tokens: [
        `string:"${BACKSLASH}`,
        'punctuation:(',
        'identifier:f',
        'punctuation:(',
        'identifier:x',
        'punctuation:,',
        'punctuation:(',
        'identifier:y',
        'punctuation:)',
        'punctuation:)',
        'punctuation:)',
        'string:!"',
        'identifier:z',
      ],
      code: '(f(x, (y))) z',
    });
  });

  it('keeps adjacent interpolations apart in the code text', () => {
    expect(view(String.raw`"\(a)\(b)"`)).toMatchObject({
      tokens: [
        `string:"${BACKSLASH}`,
        'punctuation:(',
        'identifier:a',
        'punctuation:)',
        'string:\\',
        'punctuation:(',
        'identifier:b',
        'punctuation:)',
        'string:"',
      ],
      code: '(a)(b)',
    });
  });

  it('lexes a string inside an interpolation as a string again', () => {
    expect(view(String.raw`"\(f("s)") + "t")" u`)).toMatchObject({
      tokens: [
        `string:"${BACKSLASH}`,
        'punctuation:(',
        'identifier:f',
        'punctuation:(',
        'string:"s)"',
        'punctuation:)',
        'operator:+',
        'string:"t"',
        'punctuation:)',
        'string:"',
        'identifier:u',
      ],
      code: '(f() + ) u',
    });
  });

  it('counts how many interpolations deep each token is', () => {
    expect(depths(String.raw`x "a \("b \(c)")" y`)).toEqual([
      ['identifier:x', 0],
      [`string:"a ${BACKSLASH}`, 0],
      ['punctuation:(', 1],
      [`string:"b ${BACKSLASH}`, 1],
      ['punctuation:(', 2],
      ['identifier:c', 2],
      ['punctuation:)', 2],
      ['string:"', 1],
      ['punctuation:)', 1],
      ['string:"', 0],
      ['identifier:y', 0],
    ]);
  });

  it('counts the parentheses of each interpolation on its own', () => {
    expect(depths(String.raw`"\(f("\(c)"))" y`)).toEqual([
      [`string:"${BACKSLASH}`, 0],
      ['punctuation:(', 1],
      ['identifier:f', 1],
      ['punctuation:(', 1],
      [`string:"${BACKSLASH}`, 1],
      ['punctuation:(', 2],
      ['identifier:c', 2],
      ['punctuation:)', 2],
      ['string:"', 1],
      ['punctuation:)', 1],
      ['punctuation:)', 1],
      ['string:"', 0],
      ['identifier:y', 0],
    ]);
  });

  it('lexes a comment inside an interpolation as a comment', () => {
    expect(view(String.raw`"\(x /* c */)" // d`)).toMatchObject({
      tokens: [
        `string:"${BACKSLASH}`,
        'punctuation:(',
        'identifier:x',
        'comment:/* c */',
        'punctuation:)',
        'string:"',
        'comment:// d',
      ],
      comments: ['c', 'd'],
      code: '(x ) ',
    });
  });

  it('links a force unwrap inside an interpolation to its operand', () => {
    const { tokens } = line(String.raw`"\(x!)"`);
    expect(tokens.map((token) => show(token))).toEqual([
      `string:"${BACKSLASH}`,
      'punctuation:(',
      'identifier:x',
      'operator:!',
      'punctuation:)',
      'string:"',
    ]);
    expect(tokens[3]?.previous).toBe(tokens[2]);
  });
});

const IN_TEXT: SwiftLexState = [{ kind: 'string', hashes: 0, multiline: true }];
const IN_RAW_TEXT: SwiftLexState = [
  { kind: 'string', hashes: 1, multiline: true },
];

/**
Inside an interpolation of a multi-line string, `parens` parentheses deep.
*/
function inInterpolation(parens: number): SwiftLexState {
  return [...IN_TEXT, { kind: 'interpolation', parens }];
}

const COMMENT_IN_INTERPOLATION: SwiftLexState = [
  ...inInterpolation(1),
  { kind: 'comment', depth: 1 },
];
const TEXT_IN_INTERPOLATION: SwiftLexState = [
  ...inInterpolation(1),
  ...IN_TEXT,
];

describe('lexSwiftLine: multi-line strings', () => {
  it.each([
    [
      'let s = """',
      SWIFT_INITIAL_STATE,
      IN_TEXT,
      ['identifier:let', 'identifier:s', 'operator:=', 'string:"""'],
      'let s = ',
    ],
    [
      '  hello "quoted" // x /* y',
      IN_TEXT,
      IN_TEXT,
      ['string:  hello "quoted" // x /* y'],
      '',
    ],
    ['  try! risky()', IN_TEXT, IN_TEXT, ['string:  try! risky()'], ''],
    [
      '  """ + x',
      IN_TEXT,
      SWIFT_INITIAL_STATE,
      ['string:  """', 'operator:+', 'identifier:x'],
      ' + x',
    ],
    [
      '"""abc""" x',
      SWIFT_INITIAL_STATE,
      SWIFT_INITIAL_STATE,
      ['string:"""abc"""', 'identifier:x'],
      ' x',
    ],
    [String.raw`a \""" b`, IN_TEXT, IN_TEXT, [String.raw`string:a \""" b`], ''],
    ['a "" b', IN_TEXT, IN_TEXT, ['string:a "" b'], ''],
    [
      String.raw`x \(y) z`,
      IN_TEXT,
      IN_TEXT,
      [
        `string:x ${BACKSLASH}`,
        'punctuation:(',
        'identifier:y',
        'punctuation:)',
        'string: z',
      ],
      '(y)',
    ],
  ])('lexes %j', (text, before, after, tokens, code) => {
    expect(view(text, before)).toEqual({
      tokens,
      comments: [],
      code,
      state: after,
    });
  });

  it.each([
    [
      String.raw`a \(foo(`,
      IN_TEXT,
      inInterpolation(2),
      [
        [`string:a ${BACKSLASH}`, 0],
        ['punctuation:(', 1],
        ['identifier:foo', 1],
        ['punctuation:(', 1],
      ],
    ],
    [
      '  bar,',
      inInterpolation(2),
      inInterpolation(2),
      [
        ['identifier:bar', 1],
        ['punctuation:,', 1],
      ],
    ],
    [
      '  baz)) tail """ x',
      inInterpolation(2),
      SWIFT_INITIAL_STATE,
      [
        ['identifier:baz', 1],
        ['punctuation:)', 1],
        ['punctuation:)', 1],
        ['string: tail """', 0],
        ['identifier:x', 0],
      ],
    ],
    [
      'g("abc',
      inInterpolation(1),
      inInterpolation(2),
      [
        ['identifier:g', 1],
        ['punctuation:(', 1],
        ['string:"abc', 1],
      ],
    ],
    [
      String.raw`"a \(b`,
      inInterpolation(1),
      inInterpolation(1),
      [
        [`string:"a ${BACKSLASH}`, 1],
        ['punctuation:(', 2],
        ['identifier:b', 2],
      ],
    ],
    [
      'x /* c',
      inInterpolation(1),
      COMMENT_IN_INTERPOLATION,
      [
        ['identifier:x', 1],
        ['comment:/* c', 1],
      ],
    ],
    [
      ' d */ )',
      COMMENT_IN_INTERPOLATION,
      IN_TEXT,
      [
        ['comment: d */', 1],
        ['punctuation:)', 1],
      ],
    ],
    ['"""', inInterpolation(1), TEXT_IN_INTERPOLATION, [['string:"""', 1]]],
    [
      '""" )',
      TEXT_IN_INTERPOLATION,
      IN_TEXT,
      [
        ['string:"""', 1],
        ['punctuation:)', 1],
      ],
    ],
  ])(
    'carries an interpolation left open across the line break: %j',
    (text, before, after, tokens) => {
      expect(depths(text, before)).toEqual(tokens);
      expect(line(text, before).state).toEqual(after);
    },
  );
});

describe('lexSwiftLine: raw strings', () => {
  it.each([
    [
      String.raw`#"a "q" \(x) \n"# y`,
      [String.raw`string:#"a "q" \(x) \n"#`, 'identifier:y'],
      ' y',
    ],
    [
      String.raw`#"a \#(x) b"# y`,
      [
        String.raw`string:#"a \#`,
        'punctuation:(',
        'identifier:x',
        'punctuation:)',
        'string: b"#',
        'identifier:y',
      ],
      '(x) y',
    ],
    [
      String.raw`##"a "# \#(x) \##(y) "## z`,
      [
        String.raw`string:##"a "# \#(x) \##`,
        'punctuation:(',
        'identifier:y',
        'punctuation:)',
        'string: "##',
        'identifier:z',
      ],
      '(y) z',
    ],
    // A backslash the hashes do not follow is literal: this string closes.
    [String.raw`#"\"# y`, [String.raw`string:#"\"#`, 'identifier:y'], ' y'],
    [
      String.raw`#"\\#(x)"# y`,
      [
        String.raw`string:#"\\#`,
        'punctuation:(',
        'identifier:x',
        'punctuation:)',
        'string:"#',
        'identifier:y',
      ],
      '(x) y',
    ],
    // `\#"` is an escaped quote in a one-hash string.
    [
      String.raw`#"a\#"# b"# y`,
      [String.raw`string:#"a\#"# b"#`, 'identifier:y'],
      ' y',
    ],
    [String.raw`#"a\#`, [String.raw`string:#"a\#`], ''],
    ['#"a" b', ['string:#"a" b'], ''],
    ['#"a"## b', ['string:#"a"#', 'punctuation:#', 'identifier:b'], '# b'],
    ['"a"# b', ['string:"a"', 'punctuation:#', 'identifier:b'], '# b'],
    ['#""# y', ['string:#""#', 'identifier:y'], ' y'],
    // Swift's rule: a raw string whose closing delimiter is on the line of
    // its opening `"""` is a single-line string that starts with quotes.
    ['#"""# y', ['string:#"""#', 'identifier:y'], ' y'],
    ['#"""ab"# y', ['string:#"""ab"#', 'identifier:y'], ' y'],
  ])('lexes %j', (text, tokens, code) => {
    expect(view(text)).toEqual({ tokens, comments: [], code, state: [] });
  });

  it.each([
    ['x = #"""', SWIFT_INITIAL_STATE, IN_RAW_TEXT, 3],
    // `"#` does not close a two-hash string, so this one is multi-line.
    [
      'x = ##""" "# y',
      SWIFT_INITIAL_STATE,
      [{ kind: 'string', hashes: 2, multiline: true }],
      3,
    ],
    [
      'x = ##"""',
      SWIFT_INITIAL_STATE,
      [{ kind: 'string', hashes: 2, multiline: true }],
      3,
    ],
    [String.raw`a """ b \(c)`, IN_RAW_TEXT, IN_RAW_TEXT, 1],
    [String.raw`x \#(y) z`, IN_RAW_TEXT, IN_RAW_TEXT, 5],
    ['x """# z', IN_RAW_TEXT, SWIFT_INITIAL_STATE, 2],
  ])(
    'carries the hash count of a raw multi-line string through %j',
    (text, before, after, tokenCount) => {
      const lexed = line(text, before);
      expect(lexed.state).toEqual(after);
      expect(lexed.tokens).toHaveLength(tokenCount);
    },
  );
});

const DIVISION = ['operator:/', 'identifier:x', 'operator:/', 'identifier:y'];

describe('lexSwiftLine: bare regex literals', () => {
  it.each([
    [
      'x = /ab+c/ y',
      ['identifier:x', 'operator:=', 'regex:/ab+c/', 'identifier:y'],
      'x =  y',
    ],
    ['return /x/', ['identifier:return', 'regex:/x/'], 'return '],
    ['/^a/ // c', ['regex:/^a/', 'comment:// c'], ' '],
    ['  /x/.foo', ['regex:/x/', 'punctuation:.', 'identifier:foo'], '  .foo'],
    [
      'x = /a b/ y',
      ['identifier:x', 'operator:=', 'regex:/a b/', 'identifier:y'],
      'x =  y',
    ],
    [
      'x = /"/ + "s"',
      ['identifier:x', 'operator:=', 'regex:/"/', 'operator:+', 'string:"s"'],
      'x =  + ',
    ],
    [
      String.raw`x = /a\/b/ y`,
      ['identifier:x', 'operator:=', String.raw`regex:/a\/b/`, 'identifier:y'],
      'x =  y',
    ],
    [
      'x = /[/]a/ y',
      ['identifier:x', 'operator:=', 'regex:/[/]a/', 'identifier:y'],
      'x =  y',
    ],
    [
      'x = /[a/b]c/ y',
      ['identifier:x', 'operator:=', 'regex:/[a/b]c/', 'identifier:y'],
      'x =  y',
    ],
    [
      String.raw`x = /[\]/]a/ y`,
      [
        'identifier:x',
        'operator:=',
        String.raw`regex:/[\]/]a/`,
        'identifier:y',
      ],
      'x =  y',
    ],
    // A comment is not what a regex follows: the `=` before it still is.
    [
      'x = /* c */ /re/ y',
      [
        'identifier:x',
        'operator:=',
        'comment:/* c */',
        'regex:/re/',
        'identifier:y',
      ],
      'x =   y',
    ],
  ])('lexes %j', (text, tokens, code) => {
    expect(view(text)).toMatchObject({ tokens, code, state: [] });
  });

  it.each([
    '(',
    '[',
    '{',
    ',',
    ';',
    ':',
    '=',
    '!',
    '&',
    '|',
    '?',
    '+',
    '-',
    '*',
    '%',
    '^',
    '~',
    '<',
    '>',
    '==',
    '&&',
  ])('starts a regex after %j', (before) => {
    expect(shown(`a ${before} /x/ y`).slice(-2)).toEqual([
      'regex:/x/',
      'identifier:y',
    ]);
  });

  it.each([
    ['a', 'identifier:a'],
    ['a)', 'punctuation:)'],
    ['a]', 'punctuation:]'],
    ['a }', 'punctuation:}'],
    ['1', 'number:1'],
    ['"a=b"', 'string:"a=b"'],
    ['returns', 'identifier:returns'],
    ['xreturn', 'identifier:xreturn'],
    ['`return`', 'identifier:`return`'],
    ['a.b', 'identifier:b'],
  ])('reads the / after %j as division', (before, last) => {
    expect(shown(`${before} /x/ y`).slice(-5)).toEqual([last, ...DIVISION]);
  });

  it.each([
    [
      'a / b / c',
      [
        'identifier:a',
        'operator:/',
        'identifier:b',
        'operator:/',
        'identifier:c',
      ],
    ],
    // Swift's own rule: a regex literal cannot start with whitespace.
    ['x = / y', ['identifier:x', 'operator:=', 'operator:/', 'identifier:y']],
    ['x! / 2', ['identifier:x', 'operator:!', 'operator:/', 'number:2']],
    ['x = /', ['identifier:x', 'operator:=', 'operator:/']],
    ['x = // c', ['identifier:x', 'operator:=', 'comment:// c']],
  ])('does not start a regex in %j', (text, tokens) => {
    expect(shown(text)).toEqual(tokens);
  });

  it.each([
    ['x = /abc', ['operator:/', 'identifier:abc']],
    [
      String.raw`x = /a\/b`,
      [
        'operator:/',
        'identifier:a',
        'punctuation:\\',
        'operator:/',
        'identifier:b',
      ],
    ],
    // A class that never closes holds the only `/` there is.
    [
      'x = /[a/b',
      [
        'operator:/',
        'punctuation:[',
        'identifier:a',
        'operator:/',
        'identifier:b',
      ],
    ],
    ['x = /a "b', ['operator:/', 'identifier:a', 'string:"b']],
    // An operator passed as a function is the case Swift has this rule for.
    [
      'x = f(1, /)',
      [
        'identifier:f',
        'punctuation:(',
        'number:1',
        'punctuation:,',
        'operator:/',
        'punctuation:)',
      ],
    ],
  ])(
    'never lets a bare regex span lines: with no closing / on the line, %j has none',
    (text, rest) => {
      expect(view(text)).toMatchObject({
        tokens: ['identifier:x', 'operator:=', ...rest],
        state: [],
      });
    },
  );

  it('lexes a regex inside an interpolation as a regex', () => {
    expect(shown(String.raw`"\(/x/)"`)).toEqual([
      `string:"${BACKSLASH}`,
      'punctuation:(',
      'regex:/x/',
      'punctuation:)',
      'string:"',
    ]);
  });
});

describe('lexSwiftLine: extended regex literals', () => {
  it.each([
    [
      'x = #/a/b/# y',
      ['identifier:x', 'operator:=', 'regex:#/a/b/#', 'identifier:y'],
      'x =  y',
    ],
    // Unlike a bare regex, an extended one starts wherever it stands.
    [
      'foo #/x/# y',
      ['identifier:foo', 'regex:#/x/#', 'identifier:y'],
      'foo  y',
    ],
    ['##/a/#b/## y', ['regex:##/a/#b/##', 'identifier:y'], ' y'],
    ['#/ x /# y', ['regex:#/ x /#', 'identifier:y'], ' y'],
    ['#/"/# y', ['regex:#/"/#', 'identifier:y'], ' y'],
    ['#/a/# + #/b/#', ['regex:#/a/#', 'operator:+', 'regex:#/b/#'], ' + '],
    ['#/a/ b', ['regex:#/a/ b'], ''],
  ])('lexes %j', (text, tokens, code) => {
    expect(view(text)).toMatchObject({ tokens, code, state: [] });
  });

  it('accepts, as a limit, that a multi-line #/ ... /# is cut off at the end of its first line', () => {
    expect(view('let r = #/')).toMatchObject({
      tokens: ['identifier:let', 'identifier:r', 'operator:=', 'regex:#/'],
      state: [],
    });
    // ... so its next line is lexed as the code it is not.
    expect(shown('  [a-z]+')).toEqual([
      'punctuation:[',
      'identifier:a',
      'operator:-',
      'identifier:z',
      'punctuation:]',
      'operator:+',
    ]);
  });
});

describe('lexSwiftLine: backtick identifiers', () => {
  it.each([
    ['`class`', ['identifier:`class`']],
    ['x.`default`', ['identifier:x', 'punctuation:.', 'identifier:`default`']],
    [
      'func `adds two numbers`()',
      [
        'identifier:func',
        'identifier:`adds two numbers`',
        'punctuation:(',
        'punctuation:)',
      ],
    ],
    [
      '`a // b "c" d! /* e` x',
      ['identifier:`a // b "c" d! /* e`', 'identifier:x'],
    ],
    ['`abc d', ['identifier:`abc d']],
  ])('lexes %j, keeping the whole of it as code', (text, tokens) => {
    expect(view(text)).toEqual({ tokens, comments: [], code: text, state: [] });
  });
});

const SOURCE = [
  'let a = 1 /* one', // 1
  '  try! still comment */ let b = """', // 2
  String.raw`  text \(f(`, // 3
  '    a!,', // 4
  '  )) more', // 5
  '  """', // 6
  '// done', // 7
  'b', // 8
].join('\n');

describe('lexSwift', () => {
  it('lexes no source to no tokens', () => {
    expect(lexSwift('')).toEqual([]);
  });

  it('lexes a whole source into tokens with absolute positions', () => {
    const tokens = lexSwift(SOURCE).map((token) => [
      show(token),
      token.line,
      token.column,
      token.endLine,
      token.endColumn,
      token.interpolationDepth,
    ]);
    expect(tokens).toEqual([
      ['identifier:let', 1, 1, 1, 4, 0],
      ['identifier:a', 1, 5, 1, 6, 0],
      ['operator:=', 1, 7, 1, 8, 0],
      ['number:1', 1, 9, 1, 10, 0],
      ['comment:/* one', 1, 11, 1, 17, 0],
      ['comment:  try! still comment */', 2, 1, 2, 24, 0],
      ['identifier:let', 2, 25, 2, 28, 0],
      ['identifier:b', 2, 29, 2, 30, 0],
      ['operator:=', 2, 31, 2, 32, 0],
      ['string:"""', 2, 33, 2, 36, 0],
      [`string:  text ${BACKSLASH}`, 3, 1, 3, 9, 0],
      ['punctuation:(', 3, 9, 3, 10, 1],
      ['identifier:f', 3, 10, 3, 11, 1],
      ['punctuation:(', 3, 11, 3, 12, 1],
      ['identifier:a', 4, 5, 4, 6, 1],
      ['operator:!', 4, 6, 4, 7, 1],
      ['punctuation:,', 4, 7, 4, 8, 1],
      ['punctuation:)', 5, 3, 5, 4, 1],
      ['punctuation:)', 5, 4, 5, 5, 1],
      ['string: more', 5, 5, 5, 10, 0],
      ['string:  """', 6, 1, 6, 6, 0],
      ['comment:// done', 7, 1, 7, 8, 0],
      ['identifier:b', 8, 1, 8, 2, 0],
    ]);
  });

  it('links tokens across lines, skipping the comments between them', () => {
    const tokens = lexSwift('a // one\n/* two */\n\n  b\nc');
    expect(tokens.map((token) => show(token))).toEqual([
      'identifier:a',
      'comment:// one',
      'comment:/* two */',
      'identifier:b',
      'identifier:c',
    ]);
    expect(tokens.map((token) => token.previous)).toEqual([
      undefined,
      tokens[0],
      tokens[0],
      tokens[0],
      tokens[3],
    ]);
  });

  it('treats the carriage return of a CRLF line ending as whitespace', () => {
    const tokens = lexSwift('a // c\r\nb\r\n');
    expect(
      tokens.map((token) => [show(token), token.line, token.hasSpaceAfter]),
    ).toEqual([
      ['identifier:a', 1, true],
      ['comment:// c', 1, true],
      ['identifier:b', 2, true],
    ]);
  });

  it.each([
    SOURCE,
    String.raw`x = a!.b ?? c[0]! /* k */ + f("s \(y) t", #"r"#) // end`,
    'let r = /a[/]b/ + #/c/# - `d e`',
    String.raw`@objc #if 'q' \.k $0 0xFF 1e-3 1...2`,
  ])(
    'covers every non-whitespace character of %j with exactly one token',
    (source) => {
      const lines = source.split('\n');
      const tokens = lexSwift(source);
      // Laying each token down at its own column rebuilds the line only if
      // no two overlap: an overlap pushes the later one to the right.
      const rebuilt = lines.map((text, index) =>
        tokens
          .filter((token) => token.line === index + 1)
          .reduce((row, token) => row.padEnd(token.column - 1) + token.text, '')
          .padEnd(text.length),
      );
      expect(rebuilt).toEqual(lines.map((text) => text.replaceAll(/\s/g, ' ')));
    },
  );
});

describe('swiftStateAtLine', () => {
  it.each([
    [1, SWIFT_INITIAL_STATE],
    [2, IN_COMMENT],
    [3, IN_TEXT],
    [4, inInterpolation(2)],
    [5, inInterpolation(2)],
    [6, IN_TEXT],
    [7, SWIFT_INITIAL_STATE],
    [8, SWIFT_INITIAL_STATE],
    [9, SWIFT_INITIAL_STATE],
    [99, SWIFT_INITIAL_STATE],
  ])('gives the state line %i of the source starts in', (lineNumber, state) => {
    expect(swiftStateAtLine(SOURCE, lineNumber)).toEqual(state);
  });

  it('keeps an unterminated block comment open past the end of the source', () => {
    expect(swiftStateAtLine('a /* b\nc /* d', 3)).toEqual(IN_NESTED_COMMENT);
  });

  it('lets a hunk that begins inside a comment be lexed as comment', () => {
    const state = swiftStateAtLine('/**\n * Never try! here.\n */', 2);
    expect(view(' * Never try! here.', state)).toMatchObject({
      comments: ['Never try! here.'],
      code: '',
    });
  });
});

describe('the documented over-match limit', () => {
  it('lexes the first line of a fragment that starts inside a comment as code when given the initial state', () => {
    expect(view(' * Never try! here.')).toEqual({
      tokens: [
        'operator:*',
        'identifier:Never',
        'identifier:try',
        'operator:!',
        'identifier:here',
        'punctuation:.',
      ],
      comments: [],
      code: ' * Never try! here.',
      state: [],
    });
  });

  it('lexes the first line of a fragment that starts inside a multi-line string as code when given the initial state', () => {
    expect(view('  as! "quoted"')).toEqual({
      tokens: ['identifier:as', 'operator:!', 'string:"quoted"'],
      comments: [],
      code: '  as! ',
      state: [],
    });
  });
});

describe('what the diff auditor reads', () => {
  it.each([
    'final class Box: @unchecked Sendable {}',
    '#if DEBUG',
    '  @_spi(Internal) import Core',
    'let y = try! f(x as! T, z!)',
    'func `adds two numbers`() -> Int? { a ?? b }',
  ])('reproduces the code of %j character for character', (text) => {
    expect(line(text).code).toBe(text);
  });

  it.each([
    ['let y = x!', 'identifier:x', false],
    ['f()!', 'punctuation:)', false],
    ['a[0]!', 'punctuation:]', false],
    ['var x: Int!', 'identifier:Int', false],
    ['var x: Int! = nil', 'identifier:Int', false],
    ['var x: [Int]!', 'punctuation:]', false],
    ['var x: Int?!', 'operator:?', false],
    ['var x: Set<Int>!', 'operator:>', false],
    ['try! f()', 'identifier:try', false],
    ['x as! T', 'identifier:as', false],
    // A prefix `!` is told apart by the whitespace before it.
    ['if !done {}', 'identifier:if', true],
    ['a = /* c */ !b', 'operator:=', true],
  ])(
    'hands the ! of %j the token before it and whether whitespace is',
    (text, before, isSpaced) => {
      const { tokens } = line(text);
      const at = tokens.findIndex((token) => token.text === '!');
      expect(
        tokens
          .slice(at, at + 1)
          .map((bang) => [
            bang.kind,
            bang.previous && show(bang.previous),
            bang.hasSpaceBefore,
          ]),
      ).toEqual([['operator', before, isSpaced]]);
    },
  );
});

const PIECES = [
  '"',
  '"""',
  '#',
  '\\',
  String.raw`\(`,
  String.raw`\#(`,
  '(',
  ')',
  '/',
  '//',
  '/*',
  '*/',
  '`',
  "'",
  '!',
  '?',
  '=',
  '.',
  '<',
  '>',
  '-',
  ' ',
  '\t',
  '\r',
  'a',
  'return',
  '1',
  '0x',
  'e',
  '[',
  ']',
  ',',
  'é',
  '😀',
];

describe('robustness', () => {
  it('lexes arbitrary text from every state it reaches, covering each line exactly once', () => {
    // A fixed linear congruential sequence: the same 3000 lines every run.
    let seed = 1;
    const next = (bound: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % bound;
    };
    let state = SWIFT_INITIAL_STATE;
    const miscovered: string[] = [];
    for (let round = 0; round < 3000; round += 1) {
      const text = Array.from(
        { length: next(12) },
        () => PIECES[next(PIECES.length)],
      ).join('');
      const lexed = lexSwiftLine(
        text,
        next(25) === 0 ? SWIFT_INITIAL_STATE : state,
      );
      const rebuilt = lexed.tokens
        .reduce((row, token) => row.padEnd(token.column - 1) + token.text, '')
        .padEnd(text.length);
      if (rebuilt.replaceAll(/\s/g, ' ') !== text.replaceAll(/\s/g, ' ')) {
        miscovered.push(text);
      }
      state = lexed.state;
    }
    expect(miscovered).toEqual([]);
  });
});

describe('lexSwiftLine: positions and neighbours', () => {
  it('skips comments when linking a token to the one before it', () => {
    const [earlier] = line('x').tokens;
    const { tokens } = lexSwiftLine(
      '/* c */ a /* d */ b',
      SWIFT_INITIAL_STATE,
      2,
      earlier,
    );
    expect(tokens.map((token) => token.previous)).toEqual([
      earlier,
      earlier,
      tokens[1],
      tokens[1],
    ]);
  });

  it('records 1-indexed columns and an exclusive end column', () => {
    const positions = line('  let xy z').tokens.map((token) => [
      token.text,
      token.line,
      token.column,
      token.endLine,
      token.endColumn,
    ]);
    expect(positions).toEqual([
      ['let', 1, 3, 1, 6],
      ['xy', 1, 7, 1, 9],
      ['z', 1, 10, 1, 11],
    ]);
  });

  it('numbers its tokens with the line it is told it is lexing', () => {
    const [token] = lexSwiftLine(' a', SWIFT_INITIAL_STATE, 7).tokens;
    expect([token?.line, token?.endLine, token?.column]).toEqual([7, 7, 2]);
  });

  it.each([
    ['a', [[true, true]]],
    [
      'a b',
      [
        [true, true],
        [true, true],
      ],
    ],
    [
      'f(a)',
      [
        [true, false],
        [false, false],
        [false, false],
        [false, true],
      ],
    ],
    [
      'f( a )',
      [
        [true, false],
        [false, true],
        [true, true],
        [true, true],
      ],
    ],
    [' a\t', [[true, true]]],
    [
      'ab.c',
      [
        [true, false],
        [false, false],
        [false, true],
      ],
    ],
  ])(
    'flags whitespace or a line boundary directly around each token of %j',
    (text, expected) => {
      const flags = line(text).tokens.map((token) => [
        token.hasSpaceBefore,
        token.hasSpaceAfter,
      ]);
      expect(flags).toEqual(expected);
    },
  );

  it('links every token to the significant token before it', () => {
    const { tokens } = line('a ( b');
    expect(tokens.map((token) => token.previous)).toEqual([
      undefined,
      tokens[0],
      tokens[1],
    ]);
  });

  it('links the first token of a line to the token it is handed', () => {
    const [earlier] = line('x').tokens;
    const { tokens } = lexSwiftLine('a b', SWIFT_INITIAL_STATE, 2, earlier);
    expect(tokens.map((token) => token.previous)).toEqual([earlier, tokens[0]]);
  });
});
