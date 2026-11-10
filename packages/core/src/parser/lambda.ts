import type { LambdaExpression } from '../expression/nodes.js';
import type { JsArrow } from './ast.js';
import type { BindOptions } from './bind.js';
import { bindLambda } from './bind.js';
import { parseLambdaSource } from './parser.js';

/**
 * Parsing the same lambda twice is pure waste: a function's source never
 * changes, and hot query paths call the same arrow on every request. Keying the
 * cache on the function object itself lets the entry disappear once the closure
 * that owns it does.
 */
const parseCache = new WeakMap<object, JsArrow>();

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type AnyLambda = Function;

/** Parses a lambda's source once and reuses the result on later calls. */
export function parseLambda(fn: AnyLambda): JsArrow {
  const cached = parseCache.get(fn);
  if (cached) return cached;

  const parsed = parseLambdaSource(Function.prototype.toString.call(fn));
  parseCache.set(fn, parsed);
  return parsed;
}

/** Parses and binds a lambda into the expression IR. */
export function toExpression(fn: AnyLambda, options: BindOptions): LambdaExpression {
  return bindLambda(parseLambda(fn), options);
}
