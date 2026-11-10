import { describe, expect, it } from 'vitest';
import { ParseError, UnsupportedExpressionError } from '../src/errors.js';
import { parseLambdaSource } from '../src/parser/parser.js';
import { toExpression } from '../src/parser/lambda.js';

describe('parseLambdaSource', () => {
  it('parses a concise arrow body', () => {
    const arrow = parseLambdaSource('(u) => u.age > 18');
    expect(arrow.params).toEqual(['u']);
    expect(arrow.body.type).toBe('binary');
  });

  it('parses a single parameter without parentheses', () => {
    expect(parseLambdaSource('u => u.id').params).toEqual(['u']);
  });

  it('parses a block body with a single return statement', () => {
    const arrow = parseLambdaSource('(u, p) => { return u.age >= p.min; }');
    expect(arrow.params).toEqual(['u', 'p']);
  });

  it('accepts the function form some transpilers emit', () => {
    const arrow = parseLambdaSource('function (u) { return u.name; }');
    expect(arrow.params).toEqual(['u']);
    expect(arrow.body.type).toBe('member');
  });

  it('rejects a body with statements other than return', () => {
    expect(() => parseLambdaSource('(u) => { const x = 1; return x; }')).toThrow(ParseError);
  });

  it('rejects template literal substitutions', () => {
    expect(() => parseLambdaSource('(u) => u.name === `a${1}b`')).toThrow(ParseError);
  });

  it('keeps operator precedence', () => {
    const arrow = parseLambdaSource('(u) => u.a || u.b && u.c');
    // `&&` binds tighter, so the root must be the `||`.
    expect(arrow.body).toMatchObject({ type: 'binary', operator: '||' });
  });
});

describe('binding', () => {
  it('binds row parameters and the parameter bag', () => {
    const expression = toExpression((u: { age: number }, p: { min: number }) => u.age >= p.min, {
      rowParameterCount: 1,
      bagId: 'p0',
    });

    expect(expression.body).toMatchObject({
      kind: 'binary',
      operator: '>=',
      left: { kind: 'member', object: { kind: 'parameter', name: 'u' }, property: 'age' },
      right: { kind: 'external', path: ['p0', 'min'] },
    });
  });

  it('collapses a nested bag path into one external reference', () => {
    const expression = toExpression(
      (u: { age: number }, p: { filter: { min: number } }) => u.age >= p.filter.min,
      { rowParameterCount: 1, bagId: 'p0' },
    );

    expect(expression.body).toMatchObject({
      right: { kind: 'external', path: ['p0', 'filter', 'min'] },
    });
  });

  it('normalises strict equality to the loose operator', () => {
    const expression = toExpression((u: { name: string }) => u.name === 'ada', {
      rowParameterCount: 1,
    });
    expect(expression.body).toMatchObject({ kind: 'binary', operator: '==' });
  });

  it('rejects a captured variable with an actionable message', () => {
    const minimum = 18;
    expect(() =>
      toExpression((u: { age: number }) => u.age > minimum, { rowParameterCount: 1 }),
    ).toThrow(/not a parameter of this lambda/);
  });

  it('rejects a call into user code', () => {
    expect(() =>
      toExpression((u: { name: string }) => normalise(u.name) === 'x', { rowParameterCount: 1 }),
    ).toThrow(UnsupportedExpressionError);
  });

  it('rejects a bag reference when no arguments were supplied', () => {
    expect(() =>
      toExpression((u: { age: number }, p: { min: number }) => u.age > p.min, {
        rowParameterCount: 1,
      }),
    ).toThrow(/no argument values were supplied/);
  });
});

function normalise(value: string): string {
  return value.trim();
}
