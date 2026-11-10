import { ParseError } from '../errors.js';

export type TokenType =
  'identifier' | 'keyword' | 'number' | 'string' | 'regex' | 'punctuator' | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly start: number;
  /** Decoded value for `number` and `string` tokens. */
  readonly literal?: string | number;
  /** Body and flags for a `regex` token, the text between the slashes and after the closing one. */
  readonly regex?: { readonly source: string; readonly flags: string };
}

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'return', 'function', 'void']);

/**
 * Multi-character punctuators, longest first, so that `===` is never mistaken
 * for `==` followed by `=`.
 */
const PUNCTUATORS = [
  '===',
  '!==',
  '...',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '=>',
  '?.',
  '**',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  '.',
  ':',
  ';',
  '?',
  '!',
  '<',
  '>',
  '=',
];

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
};

/**
 * Tokenizes the subset of JavaScript that can appear in a query lambda.
 *
 * This is intentionally not a general JavaScript lexer. Anything outside the
 * subset raises a `ParseError` at the offending offset, which is far easier to
 * act on than a translation failure discovered later against the database.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw new ParseError('Unterminated block comment', source, index);
      index = end + 2;
      continue;
    }

    // Whether `/` opens a regular expression or means division is context
    // dependent in JavaScript: it divides only right after something that is
    // already a value, such as an identifier or a closing `)`. Anywhere else,
    // including at the very start of the lambda, it opens a literal.
    if (char === '/' && regexAllowedNext(tokens)) {
      const start = index;
      const { source: pattern, flags, next } = readRegex(source, index);
      tokens.push({
        type: 'regex',
        value: source.slice(start, next),
        start,
        regex: { source: pattern, flags },
      });
      index = next;
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index]!)) index += 1;
      const value = source.slice(start, index);
      tokens.push({ type: KEYWORDS.has(value) ? 'keyword' : 'identifier', value, start });
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      index = readNumber(source, index);
      const value = source.slice(start, index);
      tokens.push({ type: 'number', value, start, literal: Number(value) });
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      const { text, next } = readString(source, index, char);
      index = next;
      tokens.push({ type: 'string', value: source.slice(start, index), start, literal: text });
      continue;
    }

    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, index));
    if (punctuator) {
      tokens.push({ type: 'punctuator', value: punctuator, start: index });
      index += punctuator.length;
      continue;
    }

    throw new ParseError(`Unexpected character "${char}"`, source, index);
  }

  tokens.push({ type: 'eof', value: '', start: source.length });
  return tokens;
}

/**
 * Whether the next `/` opens a regular expression rather than dividing.
 *
 * Division only ever follows something that already stands for a value: a
 * name, a number, a string, a closing `)` or `]`, or `true`/`false`/`null`/
 * `undefined`. Anywhere else — the start of the lambda, after an operator,
 * after `(`, `,`, or `return` — the same character can only be opening a
 * literal, since nothing meaningful could otherwise divide by it.
 */
function regexAllowedNext(tokens: readonly Token[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;

  if (previous.type === 'number' || previous.type === 'string' || previous.type === 'identifier') {
    return false;
  }

  if (previous.type === 'keyword') {
    return !['true', 'false', 'null', 'undefined'].includes(previous.value);
  }

  if (previous.type === 'punctuator') {
    return previous.value !== ')' && previous.value !== ']';
  }

  return true;
}

function readRegex(source: string, start: number): { source: string; flags: string; next: number } {
  let index = start + 1;
  let inCharacterClass = false;
  let body = '';

  while (index < source.length) {
    const char = source[index]!;

    if (char === '\n') break;

    if (char === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) break;
      body += char + escaped;
      index += 2;
      continue;
    }

    if (char === '[') inCharacterClass = true;
    else if (char === ']') inCharacterClass = false;

    if (char === '/' && !inCharacterClass) {
      const flagsStart = index + 1;
      let flagsEnd = flagsStart;
      while (flagsEnd < source.length && isIdentifierPart(source[flagsEnd]!)) flagsEnd += 1;
      return { source: body, flags: source.slice(flagsStart, flagsEnd), next: flagsEnd };
    }

    body += char;
    index += 1;
  }

  throw new ParseError('Unterminated regular expression literal', source, start);
}

function readNumber(source: string, start: number): number {
  let index = start;
  while (index < source.length && isDigit(source[index]!)) index += 1;

  if (source[index] === '.') {
    index += 1;
    while (index < source.length && isDigit(source[index]!)) index += 1;
  }

  if (source[index] === 'e' || source[index] === 'E') {
    index += 1;
    if (source[index] === '+' || source[index] === '-') index += 1;
    if (!isDigit(source[index] ?? '')) throw new ParseError('Malformed exponent', source, index);
    while (index < source.length && isDigit(source[index]!)) index += 1;
  }

  return index;
}

function readString(source: string, start: number, quote: string): { text: string; next: number } {
  let index = start + 1;
  let text = '';

  while (index < source.length) {
    const char = source[index]!;

    if (char === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) break;

      if (escaped === 'u') {
        const hex = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new ParseError('Malformed unicode escape', source, index);
        }
        text += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }

      text += ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }

    if (char === quote) {
      return { text, next: index + 1 };
    }

    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      throw new ParseError(
        'Template literal substitutions are not supported; pass the value through the parameter bag instead',
        source,
        index,
      );
    }

    text += char;
    index += 1;
  }

  throw new ParseError('Unterminated string literal', source, start);
}

const isWhitespace = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

const isIdentifierStart = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_' || char === '$';

const isIdentifierPart = (char: string): boolean => isIdentifierStart(char) || isDigit(char);
