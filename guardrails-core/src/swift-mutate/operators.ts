import { blockStatement } from './blocks.js';
import { emptinessNegation, nilCoalescing, optionalChain } from './chains.js';
import { conditionalExpression, guardNegation } from './conditions.js';
import { methodSwap } from './methods.js';
import { stringLiteral } from './strings.js';
import {
  booleanLiteral,
  integerLiteral,
  isAppending,
  isConcatenation,
  isTypeConstraint,
  swapInfix,
  unaryOperator,
} from './swaps.js';
import type { Mutator } from './syntax.js';

/**
The `mutatorName` of every operator, in table order: the order that breaks
ties between mutants of one span.

A literal, and not derived from the table below, so that nothing here runs
when the module loads.
*/
export const OPERATOR_NAMES = [
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
] as const;

type OperatorName = (typeof OPERATOR_NAMES)[number];

/**
A named mutation operator.
*/
export interface Operator {
  readonly name: string;
  readonly mutate: Mutator;
}

function mutators(): Record<OperatorName, Mutator> {
  return {
    EqualityOperator: swapInfix('== != === !==', isTypeConstraint),
    RelationalBoundary: swapInfix('< <= > >='),
    RelationalNegation: swapInfix('< >= > <='),
    LogicalOperator: swapInfix('&& ||'),
    ConditionalExpression: conditionalExpression,
    BooleanLiteral: booleanLiteral,
    ArithmeticOperator: swapInfix('+ - * / % *', isConcatenation),
    UnaryOperator: unaryOperator,
    AssignmentOperator: swapInfix('+= -= *= /=', isAppending),
    BlockStatement: blockStatement,
    StringLiteral: stringLiteral,
    IntegerLiteral: integerLiteral,
    GuardNegation: guardNegation,
    NilCoalescing: nilCoalescing,
    OptionalChain: optionalChain,
    IsEmptyNegation: emptinessNegation,
    MethodSwap: methodSwap,
  };
}

/**
The operators, in table order.
*/
export function operators(): readonly Operator[] {
  const table = mutators();
  return OPERATOR_NAMES.map((name) => ({ name, mutate: table[name] }));
}
