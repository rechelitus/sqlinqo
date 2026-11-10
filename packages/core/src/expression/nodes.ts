/**
 * The expression tree the rest of the engine operates on.
 *
 * This is the intermediate representation (IR) that sits between the lambda
 * parser and the SQL compiler. Keeping it separate from both means a second
 * front end (a proxy-based builder, a GraphQL filter, a REST query string) can
 * target the same IR, and every SQL dialect keeps consuming one shape.
 */

export type BinaryOperator =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | '??';

export type UnaryOperator = '!' | '-' | '+';

/** A literal value written directly in the lambda body. */
export interface ConstantExpression {
  readonly kind: 'constant';
  readonly value: unknown;
}

/**
 * A regular expression literal written directly in the lambda body, as in
 * `u.name.match(/^A/)`.
 *
 * This is its own node rather than a `ConstantExpression` holding a `RegExp`
 * because the flags decide the SQL operator a dialect prints — PostgreSQL's
 * case-insensitive `~*` against its plain `~` — and that has to be read while
 * compiling rather than travel to the database as a bound value the way the
 * pattern itself does.
 */
export interface RegexExpression {
  readonly kind: 'regex';
  readonly source: string;
  readonly flags: string;
}

/** A reference to a lambda parameter that stands for a row, such as `u` in `u => ...`. */
export interface ParameterExpression {
  readonly kind: 'parameter';
  readonly name: string;
}

/**
 * A value supplied from outside the lambda through the parameter bag.
 *
 * `path` is rooted at the bag identifier, for example `['p0', 'minAge']`.
 * Keeping these symbolic rather than folding the value in at parse time is
 * what allows one compiled statement to be reused across different argument
 * values, the same way Entity Framework Core caches a query plan.
 */
export interface ExternalExpression {
  readonly kind: 'external';
  readonly path: readonly string[];
}

export interface MemberExpression {
  readonly kind: 'member';
  readonly object: ExpressionNode;
  readonly property: string;
}

export interface BinaryExpression {
  readonly kind: 'binary';
  readonly operator: BinaryOperator;
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}

export interface UnaryExpression {
  readonly kind: 'unary';
  readonly operator: UnaryOperator;
  readonly operand: ExpressionNode;
}

/** A method call such as `u.name.startsWith(p.prefix)` or `Math.abs(u.balance)`. */
export interface CallExpression {
  readonly kind: 'call';
  /** `null` for a free function, otherwise the receiver of the call. */
  readonly target: ExpressionNode | null;
  readonly method: string;
  readonly args: readonly ExpressionNode[];
}

export interface ConditionalExpression {
  readonly kind: 'conditional';
  readonly test: ExpressionNode;
  readonly whenTrue: ExpressionNode;
  readonly whenFalse: ExpressionNode;
}

/** An object literal, which is how a projection shapes its output row. */
export interface ObjectExpression {
  readonly kind: 'object';
  readonly properties: readonly { readonly name: string; readonly value: ExpressionNode }[];
}

export interface ArrayExpression {
  readonly kind: 'array';
  readonly elements: readonly ExpressionNode[];
}

export interface LambdaExpression {
  readonly kind: 'lambda';
  readonly parameters: readonly string[];
  readonly body: ExpressionNode;
}

export type ExpressionNode =
  | ConstantExpression
  | RegexExpression
  | ParameterExpression
  | ExternalExpression
  | MemberExpression
  | BinaryExpression
  | UnaryExpression
  | CallExpression
  | ConditionalExpression
  | ObjectExpression
  | ArrayExpression
  | LambdaExpression;

export const constant = (value: unknown): ConstantExpression => ({ kind: 'constant', value });

export const regex = (source: string, flags: string): RegexExpression => ({
  kind: 'regex',
  source,
  flags,
});

export const parameter = (name: string): ParameterExpression => ({ kind: 'parameter', name });

export const external = (path: readonly string[]): ExternalExpression => ({
  kind: 'external',
  path,
});

export const member = (object: ExpressionNode, property: string): MemberExpression => ({
  kind: 'member',
  object,
  property,
});

export const binary = (
  operator: BinaryOperator,
  left: ExpressionNode,
  right: ExpressionNode,
): BinaryExpression => ({ kind: 'binary', operator, left, right });

export const unary = (operator: UnaryOperator, operand: ExpressionNode): UnaryExpression => ({
  kind: 'unary',
  operator,
  operand,
});

export const call = (
  target: ExpressionNode | null,
  method: string,
  args: readonly ExpressionNode[],
): CallExpression => ({ kind: 'call', target, method, args });

export const object = (
  properties: readonly { readonly name: string; readonly value: ExpressionNode }[],
): ObjectExpression => ({ kind: 'object', properties });

export const lambda = (parameters: readonly string[], body: ExpressionNode): LambdaExpression => ({
  kind: 'lambda',
  parameters,
  body,
});

/**
 * Walks an expression tree depth first.
 *
 * Returning `false` from the visitor stops the traversal of that branch, which
 * is enough for the checks the engine currently needs (finding parameter
 * references, detecting unsupported nodes).
 */
export function visit(
  node: ExpressionNode,
  visitor: (node: ExpressionNode) => boolean | void,
): void {
  if (visitor(node) === false) return;
  for (const child of children(node)) {
    visit(child, visitor);
  }
}

export function children(node: ExpressionNode): ExpressionNode[] {
  switch (node.kind) {
    case 'constant':
    case 'regex':
    case 'parameter':
    case 'external':
      return [];
    case 'member':
      return [node.object];
    case 'binary':
      return [node.left, node.right];
    case 'unary':
      return [node.operand];
    case 'call':
      return node.target ? [node.target, ...node.args] : [...node.args];
    case 'conditional':
      return [node.test, node.whenTrue, node.whenFalse];
    case 'object':
      return node.properties.map((property) => property.value);
    case 'array':
      return [...node.elements];
    case 'lambda':
      return [node.body];
  }
}
