import { describe, expect, it } from 'vitest';

import {
  applyMutant,
  generateMutants,
  OPERATOR_NAMES,
  type Mutant,
} from '../src/swift-mutate/index.js';

/**
The mutants the named operators make of `source`.
*/
function mutants(source: string, ...operators: string[]): Mutant[] {
  return generateMutants({ source, operators });
}

/**
The source after each of those mutants, in output order.
*/
function mutated(source: string, ...operators: string[]): string[] {
  return mutants(source, ...operators).map((mutant) =>
    applyMutant(source, mutant),
  );
}

/**
A span on one line, as a mutant location.
*/
function span(line: number, from: number, to: number) {
  return { start: { line, column: from }, end: { line, column: to } };
}

describe('applyMutant', () => {
  it('replaces the located span on the first line', () => {
    expect(
      applyMutant('a == b', { location: span(1, 3, 5), replacement: '!=' }),
    ).toBe('a != b');
  });

  it('replaces a span on a later line', () => {
    expect(
      applyMutant('x\ny == z\nw', {
        location: span(2, 3, 5),
        replacement: '!=',
      }),
    ).toBe('x\ny != z\nw');
  });

  it('replaces a span that crosses lines', () => {
    expect(
      applyMutant('f {\n  a\n}\ng', {
        location: {
          start: { line: 1, column: 3 },
          end: { line: 3, column: 2 },
        },
        replacement: '{}',
      }),
    ).toBe('f {}\ng');
  });

  it('inserts at an empty span', () => {
    expect(
      applyMutant('a\nbc', { location: span(2, 2, 2), replacement: '!' }),
    ).toBe('a\nb!c');
  });
});

describe('generateMutants: the operator table', () => {
  it('names the seventeen operators in table order', () => {
    expect(OPERATOR_NAMES).toEqual([
      'EqualityOperator',
      'RelationalBoundary',
      'RelationalNegation',
      'LogicalOperator',
      'ConditionalExpression',
      'BooleanLiteral',
      'ArithmeticOperator',
      'UnaryOperator',
      'AssignmentOperator',
      'BlockStatement',
      'StringLiteral',
      'IntegerLiteral',
      'GuardNegation',
      'NilCoalescing',
      'OptionalChain',
      'IsEmptyNegation',
      'MethodSwap',
    ]);
  });

  it.each([{}, { operators: 'default' as const }])(
    'runs every operator when the options are %j',
    (options) => {
      const names = generateMutants({
        source: 'x = a == b && c < 5',
        ...options,
      }).map((mutant) => mutant.mutatorName);
      expect(names).toEqual([
        'EqualityOperator',
        'LogicalOperator',
        'RelationalBoundary',
        'RelationalNegation',
        'IntegerLiteral',
      ]);
    },
  );

  it('runs only the operators it is given', () => {
    const source = 'x = a == b && c < 5';
    expect(mutated(source, 'LogicalOperator', 'IntegerLiteral')).toEqual([
      'x = a == b || c < 5',
      'x = a == b && c < 6',
    ]);
    expect(mutants(source)).toEqual([]);
    expect(mutants(source, 'NoSuchOperator')).toEqual([]);
  });
});

describe('generateMutants: output', () => {
  it('describes a mutant by operator, replacement and exclusive location', () => {
    expect(
      mutants('x = 1\n  let ok = left == right', 'EqualityOperator'),
    ).toEqual([
      {
        id: '0',
        mutatorName: 'EqualityOperator',
        replacement: '!=',
        location: span(2, 17, 19),
      },
    ]);
  });

  it('orders by start position, then by the operator table, and numbers in that order', () => {
    const source = 'y = true\nx = a < b && c';
    const all = generateMutants({ source });
    expect(
      all.map((mutant) => [
        mutant.id,
        mutant.mutatorName,
        mutant.replacement,
        mutant.location.start.line,
        mutant.location.start.column,
      ]),
    ).toEqual([
      ['0', 'BooleanLiteral', 'false', 1, 5],
      ['1', 'RelationalBoundary', '<=', 2, 7],
      ['2', 'RelationalNegation', '>=', 2, 7],
      ['3', 'LogicalOperator', '||', 2, 11],
    ]);
  });

  it('orders line 10 after line 9', () => {
    const source = Array.from({ length: 11 }, () => 'x = a == b').join('\n');
    const lines = mutants(source, 'EqualityOperator').map(
      (mutant) => mutant.location.start.line,
    );
    expect(lines).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it.each(['f(a == b', 'a == b)', 'x = [a == b)}'])(
    'makes nothing of %j, whose brackets do not balance',
    (source) => {
      expect(generateMutants({ source })).toEqual([]);
    },
  );
});

const FIVE_LINES = [
  'a = 1 == 2',
  'b = 1 == 2',
  'c = 1 == 2',
  'd = 1 == 2',
  'e = 1 == 2',
].join('\n');

/**
The lines the EqualityOperator mutants of FIVE_LINES start on, for `ranges`.
*/
function linesIn(ranges: readonly (readonly [number, number])[]): number[] {
  return generateMutants({
    source: FIVE_LINES,
    ranges,
    operators: ['EqualityOperator'],
  }).map((mutant) => mutant.location.start.line);
}

describe('generateMutants: ranges', () => {
  it.each([
    [[[3, 3]], [3]],
    [[[2, 4]], [2, 3, 4]],
    [
      [
        [1, 1],
        [5, 5],
      ],
      [1, 5],
    ],
    [
      [
        [1, 2],
        [2, 3],
      ],
      [1, 2, 3],
    ],
    [[[4, 99]], [4, 5]],
    [[[6, 9]], []],
    [[], []],
  ] as const)('keeps the mutants on the lines of %j', (ranges, lines) => {
    expect(linesIn(ranges)).toEqual(lines);
  });

  it('numbers the kept mutants from 0', () => {
    const kept = generateMutants({
      source: FIVE_LINES,
      ranges: [[4, 5]],
      operators: ['EqualityOperator'],
    });
    expect(kept.map((mutant) => mutant.id)).toEqual(['0', '1']);
  });
});

/**
The status fields of the first EqualityOperator mutant of `source`.
*/
function status(source: string) {
  const [first] = mutants(source, 'EqualityOperator', 'LogicalOperator');
  return { status: first?.status, statusReason: first?.statusReason };
}

const UNTOUCHED = { status: undefined, statusReason: undefined };
const DIRECTIVE = '// guardrails-mutate:disable-next-line';

describe('generateMutants: the disable directive', () => {
  it.each([
    [
      `${DIRECTIVE} EqualityOperator -- both sides are normalised`,
      'both sides are normalised',
    ],
    [`${DIRECTIVE} all -- generated code`, 'generated code'],
    [
      `${DIRECTIVE} LogicalOperator, EqualityOperator -- listed second`,
      'listed second',
    ],
    [
      `${DIRECTIVE} LogicalOperator ,EqualityOperator -- spaced list`,
      'spaced list',
    ],
    [`${DIRECTIVE} EqualityOperator --   padded reason  `, 'padded reason'],
    [`${DIRECTIVE} EqualityOperator -- a -- b`, 'a -- b'],
    [`${DIRECTIVE} EqualityOperator`, ''],
    [
      `/// guardrails-mutate:disable-next-line all -- in a doc comment`,
      'in a doc comment',
    ],
    [
      `call() ${DIRECTIVE} all -- trailing a line of code`,
      'trailing a line of code',
    ],
  ])('ignores the mutant under %j', (directive, statusReason) => {
    expect(status(`${directive}\nx = a == b`)).toEqual({
      status: 'Ignored',
      statusReason,
    });
  });

  it('still returns the mutant it ignores, without the fields on any other', () => {
    const source = `${DIRECTIVE} all -- why\nx = a == b\ny = a == b`;
    expect(mutants(source, 'EqualityOperator')).toEqual([
      {
        id: '0',
        mutatorName: 'EqualityOperator',
        replacement: '!=',
        location: span(2, 7, 9),
        status: 'Ignored',
        statusReason: 'why',
      },
      {
        id: '1',
        mutatorName: 'EqualityOperator',
        replacement: '!=',
        location: span(3, 7, 9),
      },
    ]);
  });

  it.each([
    `${DIRECTIVE} LogicalOperator -- another operator\nx = a == b`,
    `${DIRECTIVE} all -- two lines above\n\nx = a == b`,
    `x = a == b\n${DIRECTIVE} all -- below`,
    `// see guardrails-mutate:disable-next-line all -- not leading\nx = a == b`,
    `// guardrails-mutate:disable-next-lineall -- no space\nx = a == b`,
    `// guardrails-mutate:disable-next-line\nx = a == b`,
    `// guardrails-mutate:disable-next-LINE all -- wrong case\nx = a == b`,
    `// EqualityOperator guardrails-mutate:disable-next-line -- prefix last\nx = a == b`,
  ])('leaves the mutant of %j alone', (source) => {
    expect(status(source)).toEqual(UNTOUCHED);
  });

  it('applies to the operators it names and no others', () => {
    const source = `${DIRECTIVE} LogicalOperator -- only this\nx = a == b && c`;
    expect(
      mutants(source, 'EqualityOperator', 'LogicalOperator').map((mutant) => [
        mutant.mutatorName,
        mutant.status,
      ]),
    ).toEqual([
      ['EqualityOperator', undefined],
      ['LogicalOperator', 'Ignored'],
    ]);
  });
});

describe('EqualityOperator', () => {
  it.each([
    ['x = a == b', 'x = a != b'],
    ['x = a != b', 'x = a == b'],
    ['x = a === b', 'x = a !== b'],
    ['x = a !== b', 'x = a === b'],
    ['x = a\n  == b', 'x = a\n  != b'],
    ['x = a ==\n  b', 'x = a !=\n  b'],
    // Only a comparison of two capitalised names is taken for a constraint.
    ['x = aB == Cd', 'x = aB != Cd'],
    ['x = Ab == cD', 'x = Ab != cD'],
    ['x = Kind.a == Kind.b', 'x = Kind.a != Kind.b'],
  ])('swaps the infix operator of %j', (source, expected) => {
    expect(mutated(source, 'EqualityOperator')).toEqual([expected]);
  });

  it.each([
    'x = a==b',
    'x = a ==b',
    'x = a== b',
    'xs.sorted(by: ==)',
    'static func == (lhs: A, rhs: A) -> Bool',
    'infix operator === : ComparisonPrecedence',
    // A same-type constraint: `!=` there does not compile.
    'extension Array where Element == Int {}',
    'func f<T, U>() where T.Element == U.Element {}',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'EqualityOperator')).toEqual([]);
  });
});

describe('RelationalBoundary', () => {
  it.each([
    ['x = a < b', 'x = a <= b'],
    ['x = a <= b', 'x = a < b'],
    ['x = a > b', 'x = a >= b'],
    ['x = a >= b', 'x = a > b'],
  ])('moves the boundary of %j', (source, expected) => {
    expect(mutated(source, 'RelationalBoundary')).toEqual([expected]);
  });

  it.each([
    'let x: Array<Int> = []',
    'x = a<b',
    'xs.sorted(by: <)',
    'static func < (lhs: A, rhs: A) -> Bool',
    'x = a == b',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'RelationalBoundary')).toEqual([]);
  });
});

describe('RelationalNegation', () => {
  it.each([
    ['x = a < b', 'x = a >= b'],
    ['x = a >= b', 'x = a < b'],
    ['x = a > b', 'x = a <= b'],
    ['x = a <= b', 'x = a > b'],
  ])('negates the comparison of %j', (source, expected) => {
    expect(mutated(source, 'RelationalNegation')).toEqual([expected]);
  });

  it.each(['let x: Array<Int> = []', 'x = a>b', 'x = a != b'])(
    'leaves %j alone',
    (source) => {
      expect(mutants(source, 'RelationalNegation')).toEqual([]);
    },
  );
});

describe('LogicalOperator', () => {
  it.each([
    ['x = a && b', 'x = a || b'],
    ['x = a || b', 'x = a && b'],
    ['x = a\n  && b', 'x = a\n  || b'],
  ])('swaps the operator of %j', (source, expected) => {
    expect(mutated(source, 'LogicalOperator')).toEqual([expected]);
  });

  it.each(['x = a&&b', 'x = a & b', 'static func && (lhs: A, rhs: A) -> A'])(
    'leaves %j alone',
    (source) => {
      expect(mutants(source, 'LogicalOperator')).toEqual([]);
    },
  );
});

describe('BooleanLiteral', () => {
  it.each([
    ['x = true', ['x = false']],
    ['x = false', ['x = true']],
    ['if !done {}', ['if done {}']],
    ['x = (!a)', ['x = (a)']],
    ['x = [!a]', ['x = [a]']],
    ['x = {!a}', ['x = {a}']],
    ['f(x,!a)', ['f(x,a)']],
    ['f(x:!a)', ['f(x:a)']],
    ['!a', ['a']],
    ['x = !(a && true)', ['x = (a && true)', 'x = !(a && false)']],
  ])('mutates %j', (source, expected) => {
    expect(mutated(source, 'BooleanLiteral')).toEqual(expected);
  });

  it.each([
    'x = a!.b',
    'f(x!)',
    'x = try! f()',
    'x = y as! T',
    'x = a != b',
    'x = a ! b',
    'x = a!',
    'x = truest',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'BooleanLiteral')).toEqual([]);
  });
});

describe('ArithmeticOperator', () => {
  it.each([
    ['x = a + b', 'x = a - b'],
    ['x = a - b', 'x = a + b'],
    ['x = a * b', 'x = a / b'],
    ['x = a / b', 'x = a * b'],
    ['x = a % b', 'x = a * b'],
    ['x = a[0] + (b)', 'x = a[0] - (b)'],
    ['x = a +', 'x = a -'],
    // A string that is not an operand of the expression is no reason not to.
    ['f("label", a + b)', 'f("label", a - b)'],
    ['f(a + b, "label")', 'f(a - b, "label")'],
    ['x = g("s") + b', 'x = g("s") - b'],
    ['x = a + b\ny = "s"', 'x = a - b\ny = "s"'],
    ['y = "s"\nx = a + b', 'y = "s"\nx = a - b'],
  ])('swaps the operator of %j', (source, expected) => {
    expect(mutated(source, 'ArithmeticOperator')).toEqual([expected]);
  });

  it.each([
    'x = a+b',
    'x = -a',
    'x = xs.reduce(0, +)',
    'static func + (lhs: A, rhs: A) -> A',
    // Concatenation: `-` does not compile for a string or an array.
    'x = "a" + b',
    'x = a + "b"',
    'x = a + [b]',
    'x = a + b + "c"',
    'x = "a" + b + c',
    String.raw`x = "\(a)" + b`,
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'ArithmeticOperator')).toEqual([]);
  });
});

describe('UnaryOperator', () => {
  it.each([
    ['x = -y', 'x = y'],
    ['x = (-y)', 'x = (y)'],
    ['x = [-1]', 'x = [1]'],
    ['f(a, -1)', 'f(a, 1)'],
    ['f(a,-1)', 'f(a,1)'],
    ['-y', 'y'],
    ['case .low: f(-y)', 'case .low: f(y)'],
    ['let low = -1', 'let low = 1'],
  ])('removes the prefix minus of %j', (source, expected) => {
    expect(mutated(source, 'UnaryOperator')).toEqual([expected]);
  });

  it.each([
    'x = a - b',
    'x = a-b',
    'x = a! - b',
    'x = a!-b',
    'x = a -',
    // Two raw values that become equal do not compile.
    'case low = -1',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'UnaryOperator')).toEqual([]);
  });
});

describe('AssignmentOperator', () => {
  it.each([
    ['a += b', 'a -= b'],
    ['a -= b', 'a += b'],
    ['a *= b', 'a /= b'],
    ['a /= b', 'a *= b'],
    ['n += g("s")', 'n -= g("s")'],
    ['n += a\ny = "s"', 'n -= a\ny = "s"'],
    ['s = "x"\nn += a', 's = "x"\nn -= a'],
  ])('swaps the operator of %j', (source, expected) => {
    expect(mutated(source, 'AssignmentOperator')).toEqual([expected]);
  });

  it.each([
    'a+=b',
    'a = b',
    'a %= b',
    'static func += (lhs: inout A, rhs: A)',
    's += "x"',
    'a += [x]',
    's += flag ? "" : "x"',
    's += a + "x"',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'AssignmentOperator')).toEqual([]);
  });
});

describe('IntegerLiteral', () => {
  it.each([
    ['x = 5', 'x = 6'],
    ['x = 0', 'x = 1'],
    ['x = 1', 'x = 0'],
    ['x = 99', 'x = 100'],
    ['x = 1_000', 'x = 1001'],
    ['x = 01', 'x = 0'],
    ['x = 9007199254740993', 'x = 9007199254740994'],
    ['x = -5', 'x = -6'],
    ['x = a[0]', 'x = a[1]'],
    // Conservative: on a `case` line, anything right after `=` is skipped.
    ['case 5: y = 2', 'case 6: y = 2'],
    ['let low = -1', 'let low = -0'],
    ['case .a: x = [5]', 'case .a: x = [6]'],
  ])('steps the literal of %j', (source, expected) => {
    expect(mutated(source, 'IntegerLiteral')).toEqual([expected]);
  });

  it.each([
    'x = 0x10',
    'x = 0b11',
    'x = 0o17',
    'x = 1.5',
    'x = 1e3',
    'x = t.0',
    'x = t./* index */0',
    'x = a1',
    // Two raw values that become equal do not compile.
    'case one = 1',
    'case low = -1',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'IntegerLiteral')).toEqual([]);
  });
});

describe('StringLiteral', () => {
  it.each([
    ['x = "abc"', ['x = ""']],
    ['"abc"', ['""']],
    ['x = ""', ['x = "Stryker was here!"']],
    [String.raw`x = "a \(b) c" + d`, ['x = "" + d']],
    [String.raw`x = "\(a)\(b)"`, ['x = ""']],
    [
      String.raw`x = "a \(f("in")) c"`,
      ['x = ""', String.raw`x = "a \(f("")) c"`],
    ],
    ['f("a", "b")', ['f("", "b")', 'f("a", "")']],
    // The line that closes a multi-line string can start an ordinary one.
    ['x = """\n  a\n  """ + "b"', ['x = """\n  a\n  """ + ""']],
    // A string in the interpolation of a multi-line string is ordinary too.
    [
      'x = """\n  \\(f(\n    "b"\n  ))\n  """',
      ['x = """\n  \\(f(\n    ""\n  ))\n  """'],
    ],
  ])('empties or fills the literal of %j', (source, expected) => {
    expect(mutated(source, 'StringLiteral')).toEqual(expected);
  });

  it('spans the whole literal, interpolations included', () => {
    expect(
      mutants(
        ['x = 1', String.raw`  y = "a \(b) c"`].join('\n'),
        'StringLiteral',
      ),
    ).toMatchObject([{ replacement: '""', location: span(2, 7, 17) }]);
  });

  it.each([
    // Multi-line and raw strings are left alone, whatever their lines hold.
    'x = """\n  "quoted" text\n  """',
    'x = """\n  a\n  """',
    'x = """\n"quoted" at column 1\n"""',
    String.raw`x = """a \(b)"""`,
    'x = #"abc"#',
    'x = ##"abc"##',
    // Where an empty or a changed string does not compile, or means nothing.
    'import "x"',
    '@available(*, deprecated, message: "x")',
    '@available(*, deprecated, message: f("x"))',
    '#warning("x")',
    '#error("x")',
    '#if canImport("x")',
    'case a = "raw"',
    // Unterminated: the literal ends with its line, inside an interpolation.
    String.raw`x = "a \(b)`,
    String.raw`x = "a \(b)` + '\ny',
    String.raw`x = "a \(b` + '\n)',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'StringLiteral')).toEqual([]);
  });
});

describe('where a mutation point may be', () => {
  it.each([
    '#if os(iOS) && DEBUG',
    '#elseif a == b',
    'import a == b',
    '@available(iOS 15, *)',
    'if #available(iOS 15, *) {}',
    '@objc(a == b) x',
    '@Wrapper(f(a == b, 1 + 2)) x',
    '@Wrapper(true) x',
  ])('makes nothing of the directive or attribute %j', (source) => {
    expect(generateMutants({ source })).toEqual([]);
  });

  it('makes mutants in a block that only follows an attribute or a macro', () => {
    expect(mutated('#Preview {\n  x = a + b\n}', 'ArithmeticOperator')).toEqual(
      ['#Preview {\n  x = a - b\n}'],
    );
    expect(mutated('@escaping x = [a + b]', 'ArithmeticOperator')).toEqual([
      '@escaping x = [a - b]',
    ]);
  });
});

/**
For each operator: a one-line snippet it mutates, and what it makes of it.
*/
const SNIPPETS: readonly (readonly [string, string, readonly string[]])[] = [
  ['EqualityOperator', 'x = a == b', ['x = a != b']],
  ['RelationalBoundary', 'x = a < b', ['x = a <= b']],
  ['RelationalNegation', 'x = a < b', ['x = a >= b']],
  ['LogicalOperator', 'x = a && b', ['x = a || b']],
  ['BooleanLiteral', 'x = true', ['x = false']],
  ['ArithmeticOperator', 'x = a + b', ['x = a - b']],
  ['UnaryOperator', 'x = -y', ['x = y']],
  ['AssignmentOperator', 'a += b', ['a -= b']],
  ['IntegerLiteral', 'x = 5', ['x = 6']],
  [
    'ConditionalExpression',
    'x = c ? 1 : 2',
    ['x = false ? 1 : 2', 'x = true ? 1 : 2'],
  ],
  ['BlockStatement', 'func f() { g() }', ['func f() {}']],
  ['GuardNegation', 'guard c else { return }', ['guard !(c) else { return }']],
  ['NilCoalescing', 'x = a ?? b', ['x = b']],
  ['OptionalChain', '{ return a?.b }', ['{ return nil }']],
  ['IsEmptyNegation', 'x = a.isEmpty', ['x = !a.isEmpty']],
  ['MethodSwap', 'x = min(a, b)', ['x = max(a, b)']],
];

describe.each(SNIPPETS)('%s, by context', (operator, snippet, expected) => {
  it('mutates the snippet in code', () => {
    expect(mutated(snippet, operator)).toEqual(expected);
  });

  it.each([
    ['a line comment', `// ${snippet}`],
    ['a doc comment', `/// ${snippet}`],
    ['a nested block comment', `/* a /* ${snippet} */\n${snippet} */`],
    ['a string', `"${snippet}"`],
    ['a multi-line string', `"""\n${snippet}\n"""`],
    ['a raw string', `#"${snippet}"#`],
    ['a backtick identifier', `\`${snippet}\``],
  ])('makes nothing of it in %s', (_context, source) => {
    expect(mutants(source, operator)).toEqual([]);
  });

  it('mutates it inside a string interpolation', () => {
    expect(mutated(String.raw`"a \(${snippet}) b"`, operator)).toEqual(
      expected.map((line) => String.raw`"a \(${line}) b"`),
    );
  });

  it('mutates it inside the interpolation of a multi-line string', () => {
    expect(mutated(`"""\n\\(${snippet})\n"""`, operator)).toEqual(
      expected.map((line) => `"""\n\\(${line})\n"""`),
    );
  });
});

describe('StringLiteral, by context', () => {
  it.each([
    ['a line comment', '// x = "s"'],
    ['a doc comment', '/// x = "s"'],
    ['a nested block comment', '/* a /* x = "s" */\nx = "s" */'],
    ['a multi-line string', '"""\nx = "s"\n"""'],
    ['a raw string', '#"x = "s""#'],
    ['a backtick identifier', '`x = "s"`'],
  ])('makes nothing of a literal in %s', (_context, source) => {
    expect(mutants(source, 'StringLiteral')).toEqual([]);
  });

  it('mutates a literal inside the interpolation of a multi-line string', () => {
    expect(mutated('"""\n\\(x = "s")\n"""', 'StringLiteral')).toEqual([
      '"""\n\\(x = "")\n"""',
    ]);
  });
});
