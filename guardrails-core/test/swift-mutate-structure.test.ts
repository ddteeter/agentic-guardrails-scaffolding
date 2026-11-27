import { describe, expect, it } from 'vitest';

import {
  applyMutant,
  generateMutants,
  type Mutant,
} from '../src/swift-mutate/index.js';

/**
The mutants one operator makes of `source`.
*/
function mutants(source: string, operator: string): Mutant[] {
  return generateMutants({ source, operators: [operator] });
}

/**
The source after each of those mutants, in output order.
*/
function mutated(source: string, operator: string): string[] {
  return mutants(source, operator).map((mutant) => applyMutant(source, mutant));
}

/**
The locations of those mutants as `[startLine, startColumn, endLine,
endColumn]`.
*/
function spans(source: string, operator: string): number[][] {
  return mutants(source, operator).map(({ location: { start, end } }) => [
    start.line,
    start.column,
    end.line,
    end.column,
  ]);
}

describe('ConditionalExpression: if and while', () => {
  it.each([
    ['if a == b {}', ['if false {}', 'if true {}']],
    ['while i < n {}', ['while false {}', 'while true {}']],
    ['if (a) {}', ['if false {}', 'if true {}']],
    // A comma or a brace inside brackets is not the condition's own.
    ['if f(x, y) {}', ['if false {}', 'if true {}']],
    ['if xs.contains(where: { $0 }) {}', ['if false {}', 'if true {}']],
    ['if a &&\n  b {\n}', ['if false {\n}', 'if true {\n}']],
    [
      'if a {} else if b {}',
      [
        'if false {} else if b {}',
        'if true {} else if b {}',
        'if a {} else if false {}',
        'if a {} else if true {}',
      ],
    ],
    // A replacement that changes nothing is not a mutant.
    ['if true {}', ['if false {}']],
    ['while false {}', ['while true {}']],
  ])('replaces the condition of %j', (source, expected) => {
    expect(mutated(source, 'ConditionalExpression')).toEqual(expected);
  });

  it('spans the whole condition, across lines', () => {
    expect(
      spans('x = 1\n  if a &&\n    b {\n}', 'ConditionalExpression'),
    ).toEqual([
      [2, 6, 3, 6],
      [2, 6, 3, 6],
    ]);
  });

  it.each([
    'if let x = y {}',
    'if var x = y {}',
    'if case .a = x {}',
    'if a, b {}',
    'if a, {}',
    'while let x = it.next() {}',
    'if #available(iOS 15, *) {}',
    'if try f() {}',
    'if await f() {}',
    'if a',
    'if {}',
    '#if a\n#endif',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'ConditionalExpression')).toEqual([]);
  });

  it('leaves the condition of a repeat-while, which no brace ends, alone', () => {
    expect(
      mutated('repeat { x } while a\nif b {}', 'ConditionalExpression'),
    ).toEqual([
      'repeat { x } while a\nif false {}',
      'repeat { x } while a\nif true {}',
    ]);
  });

  it('takes a while after a block that is not a repeat for a loop', () => {
    expect(mutated('do { x }\nwhile a {}', 'ConditionalExpression')).toEqual([
      'do { x }\nwhile false {}',
      'do { x }\nwhile true {}',
    ]);
  });
});

describe('ConditionalExpression: the ternary', () => {
  it.each([
    ['x =', ''],
    ['x +=', ''],
    ['x -=', ''],
    ['x *=', ''],
    ['x /=', ''],
    ['return', ''],
    ['throw', ''],
    ['f(a,', ')'],
    ['f(a:', ')'],
    ['f(', ')'],
    ['x = [', ']'],
    ['x = {', '}'],
    ['for i in', ''],
    ['if', ''],
    ['while', ''],
    ['guard', ''],
    ['switch', ''],
    ['where', ''],
    ['else', ''],
  ])('finds the condition between %j and the ?', (before, after) => {
    const source = `${before} c == d ? 1 : 2${after}`;
    expect(mutated(source, 'ConditionalExpression')).toEqual([
      `${before} false ? 1 : 2${after}`,
      `${before} true ? 1 : 2${after}`,
    ]);
  });

  it.each([
    [
      'x = a ? b ? 1 : 2 : 3',
      ['x = false ? b ? 1 : 2 : 3', 'x = true ? b ? 1 : 2 : 3'],
    ],
    [
      'x = a ? 1 : b ? 2 : 3',
      [
        'x = false ? 1 : b ? 2 : 3',
        'x = true ? 1 : b ? 2 : 3',
        'x = a ? 1 : false ? 2 : 3',
        'x = a ? 1 : true ? 2 : 3',
      ],
    ],
    ['x = f(y) + g[0] > 1 ? 1 : 2', ['x = false ? 1 : 2', 'x = true ? 1 : 2']],
    // A boundary inside brackets is not the condition's.
    ['x = f(a, b) ? 1 : 2', ['x = false ? 1 : 2', 'x = true ? 1 : 2']],
    [
      'x = y\nz = c ? 1 : 2',
      ['x = y\nz = false ? 1 : 2', 'x = y\nz = true ? 1 : 2'],
    ],
  ])('replaces the condition of %j', (source, expected) => {
    expect(mutated(source, 'ConditionalExpression')).toEqual(expected);
  });

  it('orders the ternary inside an if before the whole condition, false before true', () => {
    expect(mutated('if c ? a : b {}', 'ConditionalExpression')).toEqual([
      'if false ? a : b {}',
      'if true ? a : b {}',
      'if false {}',
      'if true {}',
    ]);
  });

  it.each([
    // No boundary on the line: the condition's start is not known.
    'c ? 1 : 2',
    'f(\n  c ? 1 : 2\n)',
    'x = c\n  ? 1 : 2',
    'x = ? 1 : 2',
    // `true` in place of the condition would drop what marks the call.
    'x = try c() ? 1 : 2',
    'x = await c ? 1 : 2',
    // A `?` in the condition: an optional chain here, an outer ternary above.
    'x = a?.b ? 1 : 2',
    // Not a ternary at all.
    'x = a?.b',
    'x = a ?b : c',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'ConditionalExpression')).toEqual([]);
  });
});

describe('GuardNegation', () => {
  it.each([
    ['guard a else { return }', 'guard !(a) else { return }'],
    ['guard a == b else { return }', 'guard !(a == b) else { return }'],
    ['guard !a else { return }', 'guard !(!a) else { return }'],
    ['guard f(a, b) else { return }', 'guard !(f(a, b)) else { return }'],
    ['guard a &&\n  b else { return }', 'guard !(a &&\n  b) else { return }'],
    // An `else` inside a closure is not the guard's.
    [
      'guard f({ if $0 { 1 } else { 2 } }) else { return }',
      'guard !(f({ if $0 { 1 } else { 2 } })) else { return }',
    ],
  ])('negates the condition of %j', (source, expected) => {
    expect(mutated(source, 'GuardNegation')).toEqual([expected]);
  });

  it('spans the condition', () => {
    expect(spans('x = 1\n  guard a == b else {}', 'GuardNegation')).toEqual([
      [2, 9, 2, 15],
    ]);
  });

  it.each([
    'guard let x = y else { return }',
    'guard var x = y else { return }',
    'guard case .a = x else { return }',
    'guard a, b else { return }',
    'guard #available(iOS 15, *) else { return }',
    'guard a',
    'guard else {}',
    'if a {} else {}',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'GuardNegation')).toEqual([]);
  });
});

describe('NilCoalescing', () => {
  it.each([
    ['x = a ?? b', 'x = b'],
    ['return a ?? b', 'return b'],
    ['f(a ?? b)', 'f(b)'],
    ['f(x: a.b?.c ?? d)', 'f(x: d)'],
    ['x = [a ?? b]', 'x = [b]'],
    ['x = { a ?? b }', 'x = { b }'],
    ['f(y, a ?? b)', 'f(y, b)'],
    ['x = a[0]!.f(y) ?? d', 'x = d'],
    ['x = (a) ?? b', 'x = b'],
    ['x = [1][0] ?? b', 'x = b'],
    // The left operand is `a`; `b ?? c` is the right one.
    ['x = a ?? b ?? c', 'x = b ?? c'],
    ['x = a ??   b', 'x = b'],
  ])('keeps only the right operand of %j', (source, expected) => {
    expect(mutated(source, 'NilCoalescing')).toEqual([expected]);
  });

  it('spans the left operand, the operator and the space after it', () => {
    expect(spans('x = 1\n  y = a.b ?? c', 'NilCoalescing')).toEqual([
      [2, 7, 2, 14],
    ]);
  });

  it.each([
    // The left operand is more than the postfix chain before the operator.
    'x = y + a ?? b',
    'x = y as? T ?? d',
    'x = try a() ?? b',
    'x = -a ?? b',
    'x = !a ?? b',
    // No operand, or not one this reads.
    'x = ?? b',
    'x = 5 ?? b',
    'x = "s" ?? b',
    'x = .none ?? b',
    'f(.none ?? b)',
    'x = y\n  .z ?? b',
    'a ?? b',
    'return(a) ?? b',
    'x =a ?? b',
    // Not the infix operator, or nothing after it on the line.
    'x = a??b',
    'x = a ??\n  b',
    'x = a ??',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'NilCoalescing')).toEqual([]);
  });
});

describe('IsEmptyNegation', () => {
  it.each([
    ['x = a.isEmpty', 'x = !a.isEmpty'],
    ['if items.isEmpty {}', 'if !items.isEmpty {}'],
    ['x = a.b.isEmpty', 'x = !a.b.isEmpty'],
    ['x = f(y).isEmpty', 'x = !f(y).isEmpty'],
    ['x = a[0].isEmpty', 'x = !a[0].isEmpty'],
    ['x = a!.isEmpty', 'x = !a!.isEmpty'],
    ['x = (a + b).isEmpty', 'x = !(a + b).isEmpty'],
    ['x = [1].isEmpty', 'x = ![1].isEmpty'],
    ['f(a.isEmpty)', 'f(!a.isEmpty)'],
    ['f(x:a.isEmpty)', 'f(x:!a.isEmpty)'],
    ['x = [a.isEmpty]', 'x = [!a.isEmpty]'],
    ['x = a && b.isEmpty', 'x = a && !b.isEmpty'],
    // An optional chain inside an argument is not the chain's own.
    ['x = f(a?.b).isEmpty', 'x = !f(a?.b).isEmpty'],
  ])('negates %j', (source, expected) => {
    expect(mutated(source, 'IsEmptyNegation')).toEqual([expected]);
  });

  it('spans the whole chain', () => {
    expect(spans('x = 1\n  y = a.b.isEmpty', 'IsEmptyNegation')).toEqual([
      [2, 7, 2, 18],
    ]);
  });

  it.each([
    // Already negated, or behind another prefix operator.
    'x = !a.isEmpty',
    'x = -a.isEmpty',
    // `!` does not apply to the optional an optional chain gives.
    'x = a?.isEmpty',
    'x = a?.b.isEmpty',
    // No base this reads, or not a member at all.
    'x = "s".isEmpty',
    'x = .isEmpty',
    'f(.isEmpty)',
    'x = xs\n  .isEmpty',
    'var isEmpty: Bool',
    'x = isEmpty',
    String.raw`x = \Foo.isEmpty`,
    'return(a).isEmpty',
    'x = a.isEmptyish',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'IsEmptyNegation')).toEqual([]);
  });
});

describe('OptionalChain', () => {
  it.each([
    ['return a?.b', 'return nil'],
    ['x = a?.b', 'x = nil'],
    ['self.x = a?.b.c()', 'self.x = nil'],
    ['let x: T? = a?.b', 'let x: T? = nil'],
    ['x = { return a?.b }', 'x = { return nil }'],
    ['x = a?[0]', 'x = nil'],
    ['x = a?.b\ny = 1', 'x = nil\ny = 1'],
    ['return a?.b?.c', 'return nil'],
    ['return f(x)?.b', 'return nil'],
  ])('replaces the chain of %j with nil', (source, expected) => {
    expect(mutated(source, 'OptionalChain')).toEqual([expected]);
  });

  it('spans the whole chain', () => {
    expect(spans('x = 1\n  return a?.b.c', 'OptionalChain')).toEqual([
      [2, 10, 2, 16],
    ]);
  });

  it.each([
    // An inferred type would stop being inferable.
    'let x = a?.b',
    'var x = a?.b',
    'let (x) = a?.b',
    'if let x = a?.b {}',
    'guard\n  let x = a?.b\nelse { return }',
    // The chain is not the whole operand.
    'return a?.b ?? c',
    'x = a?.b y',
    'x = a?.b; y = 1',
    'x = a?.b\n  .c',
    'x = a?.b\n  as? T',
    'x = a?.b\n  ?? c',
    'return try a?.b()',
    'return -a?.b',
    // Not after `return` or `=`.
    'x == a?.b',
    'f(a?.b)',
    'a?.b',
    // No optional chaining at the top of the chain.
    'return f(a?.b)',
    'return a.b',
    'return a!.b',
    'return .a?.b',
    'var x: Int?',
    'return x as Int?',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'OptionalChain')).toEqual([]);
  });
});

describe('MethodSwap', () => {
  it.each([
    ['x = min(a, b)', 'x = max(a, b)'],
    ['x = max(a, b)', 'x = min(a, b)'],
    ['x = xs.min()', 'x = xs.max()'],
    ['x = xs.max(by: f)', 'x = xs.min(by: f)'],
    ['x = xs.first', 'x = xs.last'],
    ['x = xs.last', 'x = xs.first'],
    ['x = a.b().first', 'x = a.b().last'],
    ['x = xs[0].first', 'x = xs[0].last'],
    ['x = xs?.first', 'x = xs?.last'],
    ['x = xs.prefix(3)', 'x = xs.suffix(3)'],
    ['x = xs.suffix(3)', 'x = xs.prefix(3)'],
    ['x = xs\n  .prefix(3)', 'x = xs\n  .suffix(3)'],
    ['x = xs.allSatisfy { $0 > 0 }', 'x = xs.contains { $0 > 0 }'],
    ['x = xs.allSatisfy(isValid)', 'x = xs.contains(where: isValid)'],
    ['x = xs.contains { $0 > 0 }', 'x = xs.allSatisfy { $0 > 0 }'],
    ['x = xs.contains(where: isValid)', 'x = xs.allSatisfy(isValid)'],
    ['x = xs.contains(where:   isValid)', 'x = xs.allSatisfy(isValid)'],
    ['let x = a.b.contains(where: p) && y', 'let x = a.b.allSatisfy(p) && y'],
  ])('swaps the method of %j', (source, expected) => {
    expect(mutated(source, 'MethodSwap')).toEqual([expected]);
  });

  it('spans the name, and for contains(where:) everything up to the argument', () => {
    expect(spans('x = 1\n  y = xs.first', 'MethodSwap')).toEqual([
      [2, 10, 2, 15],
    ]);
    expect(spans('y = xs.allSatisfy(p)', 'MethodSwap')).toEqual([
      [1, 8, 1, 19],
    ]);
    expect(spans('y = xs.contains(where: p)', 'MethodSwap')).toEqual([
      [1, 8, 1, 24],
    ]);
  });

  it.each([
    // A declaration, a label, or a name that is not called.
    'func min(a: Int)',
    'case min(Int)',
    'x = min',
    'x = min + 1',
    'x = min (a, b)',
    'f(min: 3)',
    // The closure forms of first and last are other methods.
    'x = xs.first(where: f)',
    'x = xs.first { $0 }',
    // No base: an implicit member, perhaps an enum case.
    'x = .first',
    'f(.first)',
    'return .first',
    'x = xs\n  .first',
    'let first = 1',
    // A labelled prefix or suffix has no counterpart.
    'x = xs.prefix(while: f)',
    'x = xs.prefix(upTo: 3)',
    'x = xs.suffix(from: 3)',
    'x = prefix(3)',
    'x = xs.prefix',
    // Only the predicate forms of contains.
    'x = xs.contains(y)',
    'x = xs.contains(y) + z',
    'x = xs.contains(by: p)',
    'x = xs.contains (where: p)',
    'x = xs.contains(where:\n  f)',
    'x = xs.contains(where y)',
    'x = xs.contains',
    'x = contains { $0 }',
    'x = allSatisfy { $0 }',
    'x = xs.allSatisfy',
    'x = xs.allSatisfy (p)',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'MethodSwap')).toEqual([]);
  });
});

describe('BlockStatement', () => {
  it.each([
    ['func f() { g() }', 'func f() {}'],
    ['func f() -> Void { g() }', 'func f() -> Void {}'],
    ['func f() -> () { g() }', 'func f() -> () {}'],
    ['func f() async throws { g() }', 'func f() async throws {}'],
    ['func f() -> Bool { g() }', 'func f() -> Bool { return false }'],
    ['func f() -> Int { g() }', 'func f() -> Int { return 0 }'],
    ['func f() -> Double { g() }', 'func f() -> Double { return 0 }'],
    ['func f() -> String { g() }', 'func f() -> String { return "" }'],
    ['func f() -> [Int] { g() }', 'func f() -> [Int] { return [] }'],
    ['func f() -> [[Int]] { g() }', 'func f() -> [[Int]] { return [] }'],
    ['func f() -> Array<Int> { g() }', 'func f() -> Array<Int> { return [] }'],
    [
      'func f() -> Array<Array<Int>> { g() }',
      'func f() -> Array<Array<Int>> { return [] }',
    ],
    ['func f() -> Int? { g() }', 'func f() -> Int? { return nil }'],
    ['func f() -> [Int]? { g() }', 'func f() -> [Int]? { return nil }'],
    [
      'func f() -> Optional<Int> { g() }',
      'func f() -> Optional<Int> { return nil }',
    ],
    [
      'func f() -> ((Int) -> Int)? { g() }',
      'func f() -> ((Int) -> Int)? { return nil }',
    ],
    [
      'func f() async throws -> Int { g() }',
      'func f() async throws -> Int { return 0 }',
    ],
    [
      'func f<T>(x: T) -> T? where T: P { g() }',
      'func f<T>(x: T) -> T? where T: P { return nil }',
    ],
    [
      'static func == (l: A, r: A) -> Bool { l.x == r.x }',
      'static func == (l: A, r: A) -> Bool { return false }',
    ],
    ['func f(g: () -> Int = { 1 }) { h() }', 'func f(g: () -> Int = { 1 }) {}'],
    ['func f() {\n  g()\n}\nx', 'func f() {}\nx'],
    // A requirement has no body; the function after it has its own.
    ['func f()\nfunc g() { h() }', 'func f()\nfunc g() {}'],
  ])('replaces the body of %j', (source, expected) => {
    expect(mutated(source, 'BlockStatement')).toEqual([expected]);
  });

  it('mutates a function and the function inside it', () => {
    const source = 'func f() {\n  func g() -> Int { 1 }\n}';
    expect(mutated(source, 'BlockStatement')).toEqual([
      'func f() {}',
      'func f() {\n  func g() -> Int { return 0 }\n}',
    ]);
    expect(spans(source, 'BlockStatement')).toEqual([
      [1, 10, 3, 2],
      [2, 19, 2, 24],
    ]);
  });

  it.each([
    // No body.
    'protocol P {\n  func f()\n  func g() -> Int\n}',
    'protocol P {\n  func f()\n  var x: Int { get }\n}',
    'protocol P {\n  func f()\n  subscript(i: Int) -> Int { get }\n}',
    'func f()\ninit() { g() }',
    'struct S {\n  func f()\n  let x = { 1 }\n}',
    'func f()',
    'func f',
    // A return type this does not know a value of.
    'func f() -> some View { g() }',
    'func f() -> T { g() }',
    'func f() -> Never { g() }',
    'func f() -> Int! { g() }',
    'func f() -> (Int) -> Int? { g() }',
    'func f() -> [String: Int] { g() }',
    'func f() -> Swift.Optional<Int> { g() }',
    'func f() -> Optional<Int>.Wrapped { g() }',
    'func f() -> [Int].Index { g() }',
    'func f() -> sending [Int] { g() }',
    'func f() -> Swift.Array<Int> { g() }',
    'func f() -> Array<Int>.Index { g() }',
    'func f() -> Voids { g() }',
    // Already the replacement, whatever its spacing or comments.
    'func f() {}',
    'func f() { }',
    'func f() {\n}',
    'func f() { /* nothing */ }',
    'func f() -> Int { return 0 }',
    'func f() -> Bool {\n  return false\n}',
    // Not a func.
    'init() { x = 1 }',
    'deinit { x() }',
    'var x: Int { 1 }',
    'let f = { g() }',
  ])('leaves %j alone', (source) => {
    expect(mutants(source, 'BlockStatement')).toEqual([]);
  });

  const BODY = 'x = 1\nfunc f() {\n  g()\n}\ny = 2';

  it.each([
    [[[2, 2]], 1],
    [[[3, 3]], 1],
    [[[4, 4]], 1],
    [[[1, 2]], 1],
    [[[4, 5]], 1],
    [
      [
        [1, 1],
        [5, 5],
      ],
      0,
    ],
    [[[1, 1]], 0],
    [[[5, 5]], 0],
  ] as const)(
    'keeps a body on lines 2 to 4 when it touches the ranges %j',
    (ranges, count) => {
      expect(
        generateMutants({
          source: BODY,
          ranges,
          operators: ['BlockStatement'],
        }),
      ).toHaveLength(count);
    },
  );

  it('is ignored by a directive on the line above where the body starts', () => {
    const source =
      '// guardrails-mutate:disable-next-line BlockStatement -- logging only\nfunc f() {\n  g()\n}';
    expect(mutants(source, 'BlockStatement')).toMatchObject([
      { status: 'Ignored', statusReason: 'logging only' },
    ]);
  });
});
