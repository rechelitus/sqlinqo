import { ParseError } from '../errors.js';
import type { JsArrow, JsNode } from './ast.js';
import { tokenize, type Token } from './lexer.js';

/**
 * Binary operator precedence. Higher numbers bind tighter.
 *
 * `??` shares a rung with `||` because JavaScript forbids mixing the two
 * without parentheses, so the ambiguity can never arise in valid source.
 */
const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '===': 3,
  '!==': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '**': 7,
};

const RIGHT_ASSOCIATIVE = new Set(['**']);

/**
 * Parses the source of a query lambda into a small JavaScript AST.
 *
 * Accepts the arrow forms a developer writes by hand as well as the
 * `function (x) { return ...; }` shape some transpiler targets emit, so the
 * library keeps working when a consumer compiles down to ES5.
 */
export function parseLambdaSource(source: string): JsArrow {
  const parser = new Parser(source);
  const arrow = parser.parseFunction();
  parser.expectEnd();
  return arrow;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  parseFunction(): JsArrow {
    const start = this.peek().start;

    if (this.matchKeyword('function')) {
      // Skip an optional function name.
      if (this.peek().type === 'identifier') this.next();
      const params = this.parseParameterList();
      const body = this.parseBlockBody();
      return { type: 'arrow', params, body, start };
    }

    const params = this.parseParameterList();
    this.expectPunctuator('=>');
    const body = this.checkPunctuator('{') ? this.parseBlockBody() : this.parseExpression();
    return { type: 'arrow', params, body, start };
  }

  expectEnd(): void {
    // A trailing semicolon is harmless and some engines include one.
    this.matchPunctuator(';');
    if (this.peek().type !== 'eof') {
      throw this.error(`Unexpected trailing token "${this.peek().value}"`);
    }
  }

  private parseParameterList(): string[] {
    if (this.peek().type === 'identifier') {
      return [this.next().value];
    }

    this.expectPunctuator('(');
    const params: string[] = [];
    while (!this.checkPunctuator(')')) {
      const token = this.next();
      if (token.type !== 'identifier') {
        throw this.error(
          `Expected a parameter name but found "${token.value}". Destructured and defaulted parameters are not supported.`,
          token,
        );
      }
      params.push(token.value);
      if (!this.matchPunctuator(',')) break;
    }
    this.expectPunctuator(')');
    return params;
  }

  /** Accepts only `{ return <expression>; }`; anything else has no SQL meaning. */
  private parseBlockBody(): JsNode {
    this.expectPunctuator('{');
    if (!this.matchKeyword('return')) {
      throw this.error(
        'A lambda body block must consist of a single return statement; statements cannot be translated to SQL.',
      );
    }
    const body = this.parseExpression();
    this.matchPunctuator(';');
    this.expectPunctuator('}');
    return body;
  }

  private parseExpression(): JsNode {
    return this.parseConditional();
  }

  private parseConditional(): JsNode {
    const test = this.parseBinary(0);
    if (!this.matchPunctuator('?')) return test;

    const whenTrue = this.parseExpression();
    this.expectPunctuator(':');
    const whenFalse = this.parseExpression();
    return { type: 'conditional', test, whenTrue, whenFalse, start: test.start };
  }

  private parseBinary(minPrecedence: number): JsNode {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      if (token.type !== 'punctuator') break;

      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;

      this.next();
      const nextMinimum = RIGHT_ASSOCIATIVE.has(token.value) ? precedence : precedence + 1;
      const right = this.parseBinary(nextMinimum);
      left = { type: 'binary', operator: token.value, left, right, start: left.start };
    }

    return left;
  }

  private parseUnary(): JsNode {
    const token = this.peek();

    if (
      token.type === 'punctuator' &&
      (token.value === '!' || token.value === '-' || token.value === '+')
    ) {
      this.next();
      return {
        type: 'unary',
        operator: token.value,
        operand: this.parseUnary(),
        start: token.start,
      };
    }

    if (token.type === 'keyword' && token.value === 'void') {
      this.next();
      this.parseUnary();
      return { type: 'literal', value: undefined, start: token.start };
    }

    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(target: JsNode): JsNode {
    let node = target;

    for (;;) {
      if (this.matchPunctuator('.') || this.matchPunctuator('?.')) {
        const property = this.next();
        if (property.type !== 'identifier' && property.type !== 'keyword') {
          throw this.error(`Expected a property name but found "${property.value}"`, property);
        }
        node = { type: 'member', object: node, property: property.value, start: node.start };
        continue;
      }

      if (this.checkPunctuator('[')) {
        this.next();
        const index = this.parseExpression();
        this.expectPunctuator(']');
        if (index.type !== 'literal' || typeof index.value !== 'string') {
          throw this.error(
            'Only constant string keys are supported in bracket access; dynamic indexing has no SQL equivalent.',
          );
        }
        node = { type: 'member', object: node, property: index.value, start: node.start };
        continue;
      }

      if (this.checkPunctuator('(')) {
        this.next();
        const args: JsNode[] = [];
        while (!this.checkPunctuator(')')) {
          args.push(this.parseExpression());
          if (!this.matchPunctuator(',')) break;
        }
        this.expectPunctuator(')');
        node = { type: 'call', callee: node, args, start: node.start };
        continue;
      }

      return node;
    }
  }

  private parsePrimary(): JsNode {
    const token = this.next();

    switch (token.type) {
      case 'number':
      case 'string':
        return { type: 'literal', value: token.literal as string | number, start: token.start };

      case 'regex':
        return {
          type: 'regex',
          source: token.regex!.source,
          flags: token.regex!.flags,
          start: token.start,
        };

      case 'identifier':
        return { type: 'identifier', name: token.value, start: token.start };

      case 'keyword':
        return this.parseKeywordPrimary(token);

      case 'punctuator':
        if (token.value === '(') return this.parseParenthesized(token);
        if (token.value === '{') return this.parseObjectLiteral(token);
        if (token.value === '[') return this.parseArrayLiteral(token);
        break;

      default:
        break;
    }

    throw this.error(`Unexpected token "${token.value || 'end of input'}"`, token);
  }

  private parseKeywordPrimary(token: Token): JsNode {
    switch (token.value) {
      case 'true':
        return { type: 'literal', value: true, start: token.start };
      case 'false':
        return { type: 'literal', value: false, start: token.start };
      case 'null':
        return { type: 'literal', value: null, start: token.start };
      case 'undefined':
        return { type: 'literal', value: undefined, start: token.start };
      default:
        throw this.error(`Keyword "${token.value}" cannot appear here`, token);
    }
  }

  /**
   * Handles both grouping and a nested arrow such as the inner lambda of
   * `groupBy`. The lookahead is what distinguishes `(a + b)` from `(a) => a`.
   */
  private parseParenthesized(token: Token): JsNode {
    if (this.isArrowAhead()) {
      this.index -= 1;
      return this.parseFunction();
    }

    const expression = this.parseExpression();
    this.expectPunctuator(')');
    return this.checkPunctuator('=>') ? this.rejectArrowAfterGroup(token) : expression;
  }

  private rejectArrowAfterGroup(token: Token): never {
    throw this.error('Unsupported arrow function parameter list', token);
  }

  /** Scans forward from an open paren to see whether an arrow follows its match. */
  private isArrowAhead(): boolean {
    let depth = 1;
    let cursor = this.index;

    while (cursor < this.tokens.length) {
      const token = this.tokens[cursor]!;
      if (token.type === 'punctuator') {
        if (token.value === '(') depth += 1;
        else if (token.value === ')') {
          depth -= 1;
          if (depth === 0) {
            const after = this.tokens[cursor + 1];
            return after?.type === 'punctuator' && after.value === '=>';
          }
        }
      }
      cursor += 1;
    }

    return false;
  }

  private parseObjectLiteral(token: Token): JsNode {
    const properties: { key: string; value: JsNode }[] = [];

    while (!this.checkPunctuator('}')) {
      const key = this.next();
      if (key.type !== 'identifier' && key.type !== 'string' && key.type !== 'keyword') {
        throw this.error(`Unsupported object key "${key.value}"`, key);
      }
      const name = key.type === 'string' ? String(key.literal) : key.value;

      if (this.matchPunctuator(':')) {
        properties.push({ key: name, value: this.parseExpression() });
      } else {
        // Shorthand `{ id }` is equivalent to `{ id: id }`.
        properties.push({ key: name, value: { type: 'identifier', name, start: key.start } });
      }

      if (!this.matchPunctuator(',')) break;
    }

    this.expectPunctuator('}');
    return { type: 'object', properties, start: token.start };
  }

  private parseArrayLiteral(token: Token): JsNode {
    const elements: JsNode[] = [];

    while (!this.checkPunctuator(']')) {
      elements.push(this.parseExpression());
      if (!this.matchPunctuator(',')) break;
    }

    this.expectPunctuator(']');
    return { type: 'array', elements, start: token.start };
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  private checkPunctuator(value: string): boolean {
    const token = this.peek();
    return token.type === 'punctuator' && token.value === value;
  }

  private matchPunctuator(value: string): boolean {
    if (!this.checkPunctuator(value)) return false;
    this.index += 1;
    return true;
  }

  private matchKeyword(value: string): boolean {
    const token = this.peek();
    if (token.type !== 'keyword' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private expectPunctuator(value: string): void {
    if (!this.matchPunctuator(value)) {
      throw this.error(`Expected "${value}" but found "${this.peek().value || 'end of input'}"`);
    }
  }

  private error(message: string, token: Token = this.peek()): ParseError {
    return new ParseError(message, this.source, token.start);
  }
}
