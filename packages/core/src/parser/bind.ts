import { UnsupportedExpressionError } from '../errors.js';
import type {
  BinaryOperator,
  ExpressionNode,
  LambdaExpression,
  UnaryOperator,
} from '../expression/nodes.js';
import {
  binary,
  call,
  constant,
  external,
  lambda,
  member,
  parameter,
  regex,
  unary,
} from '../expression/nodes.js';
import type { JsArrow, JsNode } from './ast.js';

/**
 * Global namespaces whose members are translatable to SQL functions.
 *
 * A call such as `Math.abs(u.balance)` becomes a `call` node with a `null`
 * target and the method name `Math.abs`, which the dialect then maps onto
 * `ABS(...)`. Anything outside this list is rejected, because a call into
 * arbitrary user code cannot be evaluated by the database.
 */
const GLOBAL_NAMESPACES = new Set(['Math', 'String', 'Number', 'Date', 'Boolean']);

const BINARY_OPERATORS: Record<string, BinaryOperator> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '==': '==',
  '===': '==',
  '!=': '!=',
  '!==': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '&&': '&&',
  '||': '||',
  '??': '??',
};

export interface BindOptions {
  /**
   * How many leading lambda parameters stand for rows. `where` and `select`
   * pass 1; the result selectors of `join` and `groupBy` pass 2.
   *
   * This is a ceiling rather than a requirement. JavaScript lets a lambda
   * ignore trailing parameters it has no use for, so `(key) => key` is a valid
   * two-row selector that simply never mentions the second row.
   */
  readonly rowParameterCount: number;
  /**
   * Identifier of the parameter bag supplied alongside the lambda, if any.
   * When present the lambda may declare one extra trailing parameter that
   * resolves to that bag.
   */
  readonly bagId?: string;
}

/**
 * Turns the parsed JavaScript AST into the engine's expression IR.
 *
 * The binder is the component that gives identifiers meaning. It rejects
 * references to the enclosing scope on purpose: a captured variable cannot be
 * recovered from `Function.prototype.toString()`, so allowing it would produce
 * a query that silently disagrees with the code that wrote it.
 */
export function bindLambda(arrow: JsArrow, options: BindOptions): LambdaExpression {
  const rowParameters = arrow.params.slice(0, options.rowParameterCount);
  const extra = arrow.params.slice(options.rowParameterCount);

  if (extra.length > 1) {
    throw new UnsupportedExpressionError(
      'A lambda may declare at most one parameter bag after its row parameters.',
    );
  }

  const bagName = extra[0];
  if (bagName && !options.bagId) {
    throw new UnsupportedExpressionError(
      `The lambda declares the parameter bag "${bagName}" but no argument values were supplied. ` +
        'Pass them as the second argument of the operator, for example: .where((u, p) => u.age > p.minAge, { minAge: 18 }).',
    );
  }

  const scope: Scope = {
    rows: new Set(rowParameters),
    bagName: bagName ?? null,
    bagId: options.bagId ?? null,
  };

  return lambda(rowParameters, bind(arrow.body, scope));
}

interface Scope {
  readonly rows: ReadonlySet<string>;
  readonly bagName: string | null;
  readonly bagId: string | null;
}

function bind(node: JsNode, scope: Scope): ExpressionNode {
  switch (node.type) {
    case 'literal':
      return constant(node.value);

    case 'regex':
      return regex(node.source, node.flags);

    case 'identifier':
      return bindIdentifier(node.name, scope);

    case 'member': {
      const object = bind(node.object, scope);
      // Collapse chained access on the bag into a single external reference so
      // the compiler can resolve `p.filter.minAge` in one lookup.
      if (object.kind === 'external') {
        return external([...object.path, node.property]);
      }
      return member(object, node.property);
    }

    case 'binary':
      return bindBinary(node.operator, bind(node.left, scope), bind(node.right, scope));

    case 'unary': {
      const operand = bind(node.operand, scope);
      return unary(node.operator as UnaryOperator, operand);
    }

    case 'conditional':
      return {
        kind: 'conditional',
        test: bind(node.test, scope),
        whenTrue: bind(node.whenTrue, scope),
        whenFalse: bind(node.whenFalse, scope),
      };

    case 'object':
      return {
        kind: 'object',
        properties: node.properties.map((property) => ({
          name: property.key,
          value: bind(property.value, scope),
        })),
      };

    case 'array':
      return { kind: 'array', elements: node.elements.map((element) => bind(element, scope)) };

    case 'call':
      return bindCall(node.callee, node.args, scope);

    case 'arrow':
      return bindLambda(node, {
        rowParameterCount: node.params.length,
        bagId: scope.bagId ?? undefined,
      });
  }
}

function bindIdentifier(name: string, scope: Scope): ExpressionNode {
  if (scope.rows.has(name)) return parameter(name);
  if (scope.bagName === name && scope.bagId) return external([scope.bagId]);

  throw new UnsupportedExpressionError(
    `"${name}" is not a parameter of this lambda. Values captured from the surrounding scope cannot be ` +
      'recovered from the function source, so they must be passed explicitly: ' +
      `.where((u, p) => u.something === p.${name}, { ${name} }).`,
  );
}

function bindBinary(operator: string, left: ExpressionNode, right: ExpressionNode): ExpressionNode {
  if (operator === '**') return call(null, 'Math.pow', [left, right]);

  const mapped = BINARY_OPERATORS[operator];
  if (!mapped) {
    throw new UnsupportedExpressionError(`Operator "${operator}" cannot be translated to SQL.`);
  }

  return binary(mapped, left, right);
}

function bindCall(callee: JsNode, args: readonly JsNode[], scope: Scope): ExpressionNode {
  const boundArgs = args.map((argument) => bind(argument, scope));

  if (callee.type === 'member') {
    if (callee.object.type === 'identifier' && GLOBAL_NAMESPACES.has(callee.object.name)) {
      const namespace = callee.object.name;
      if (!scope.rows.has(namespace) && scope.bagName !== namespace) {
        return call(null, `${namespace}.${callee.property}`, boundArgs);
      }
    }

    return call(bind(callee.object, scope), callee.property, boundArgs);
  }

  if (callee.type === 'identifier') {
    throw new UnsupportedExpressionError(
      `Cannot call "${callee.name}" inside a query. Only methods on columns and on the supported ` +
        `global namespaces (${[...GLOBAL_NAMESPACES].join(', ')}) can be translated to SQL.`,
    );
  }

  throw new UnsupportedExpressionError('Only direct method calls can be translated to SQL.');
}
