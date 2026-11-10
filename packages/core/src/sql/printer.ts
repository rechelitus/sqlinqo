import { InvalidQueryError } from '../errors.js';
import type { SqlDialect } from './dialect.js';
import type {
  ParameterSource,
  SqlDelete,
  SqlExpression,
  SqlFrom,
  SqlInsert,
  SqlJoin,
  SqlOrdering,
  SqlSelect,
  SqlUpdate,
  SqlSetOperation,
} from './nodes.js';

/**
 * A statement ready to hand to a driver.
 *
 * `parameters` describes where each placeholder's value comes from rather than
 * holding the values themselves, so a compiled statement can be cached and
 * replayed with different arguments.
 */
export interface CompiledStatement {
  readonly text: string;
  readonly parameters: readonly ParameterSource[];
}

/**
 * SQL operator precedence, used to decide when a subexpression needs
 * parentheses. Emitting them only where they change meaning keeps the generated
 * SQL close to what a person would have written, which matters when the output
 * is being read during debugging or compared against another ORM.
 */
const PRECEDENCE: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 4,
  '<>': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  LIKE: 4,
  '+': 5,
  '-': 5,
  '||': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const JOIN_KEYWORDS: Record<SqlJoin['kind'], string> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL JOIN',
  cross: 'CROSS JOIN',
};

const SET_OPERATORS: Record<SqlSetOperation['kind'], string> = {
  union: 'UNION',
  intersect: 'INTERSECT',
  except: 'EXCEPT',
};

/**
 * Functions the standard spells with a keyword between their arguments rather
 * than a comma. The compiler builds them as ordinary two-argument calls, so the
 * keyword lives here and only here.
 */
const KEYWORD_ARGUMENTS: Record<string, string> = {
  CAST: 'AS',
  EXTRACT: 'FROM',
  POSITION: 'IN',
};

/**
 * The operators that do not associate, so that neither operand may be another
 * of the same precedence without parentheses around it.
 *
 * Comparison chains are not a thing in SQL as they are in Python: `a = b = c`
 * is a syntax error in PostgreSQL rather than a comparison of a comparison.
 * That only comes up once an operator puts one comparison inside another, which
 * `chunkBy` does when it asks whether a boolean key still matches the row
 * before it.
 */
const NON_ASSOCIATIVE = new Set(['=', '<>', '<', '<=', '>', '>=']);

const NOT_PRECEDENCE = 3;
const ATOM_PRECEDENCE = 100;

export function printSelect(select: SqlSelect, dialect: SqlDialect): CompiledStatement {
  const printer = new Printer(dialect);
  const text = printer.select(select);
  return { text, parameters: printer.parameters };
}

/**
 * Renders an `INSERT`, its rows, and the clause that reads them back.
 *
 * A second entry point rather than a branch inside `printSelect`, because the
 * two share only the expression printer: nothing that shapes a `SELECT` has
 * anything to say about a statement with no `FROM`.
 */
export function printInsert(insert: SqlInsert, dialect: SqlDialect): CompiledStatement {
  const printer = new Printer(dialect);
  const text = printer.insert(insert);
  return { text, parameters: printer.parameters };
}

/** Renders an `UPDATE`, its assignments, its predicate, and what it reads back. */
export function printUpdate(update: SqlUpdate, dialect: SqlDialect): CompiledStatement {
  const printer = new Printer(dialect);
  const text = printer.update(update);
  return { text, parameters: printer.parameters };
}

/** Renders a `DELETE`, its predicate, and the rows it reads back on the way out. */
export function printDelete(remove: SqlDelete, dialect: SqlDialect): CompiledStatement {
  const printer = new Printer(dialect);
  const text = printer.delete(remove);
  return { text, parameters: printer.parameters };
}

/**
 * Resolves the placeholder descriptors produced by `printSelect` into the
 * ordered value array a driver expects.
 */
export function bindParameters(
  parameters: readonly ParameterSource[],
  bags: Readonly<Record<string, unknown>>,
): unknown[] {
  return parameters.map((parameter) => {
    if (parameter.type === 'value') return parameter.value;
    return readPath(bags, parameter.path);
  });
}

/** Walks a dotted path into the parameter bags, failing loudly on a typo. */
export function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;

  for (const [index, segment] of path.entries()) {
    if (current === null || current === undefined) {
      throw new InvalidQueryError(
        `Cannot read "${path.join('.')}" from the query parameters: "${path.slice(0, index).join('.')}" is ${String(current)}.`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

class Printer {
  readonly parameters: ParameterSource[] = [];

  /**
   * Placeholder already emitted for a given value, keyed by `shareKey`.
   *
   * The compiler routinely puts one expression in two clauses at once: a
   * `groupBy` key is both projected and grouped by, and a projected expression
   * is inlined into any later filter. Giving each occurrence its own
   * placeholder makes those clauses differ as text, and PostgreSQL then refuses
   * `GROUP BY "age" >= $2` as no match for `SELECT "age" >= $1`.
   */
  private readonly shared = new Map<string, string>();

  constructor(private readonly dialect: SqlDialect) {}

  /**
   * The comments a statement carries, rendered ahead of its first keyword.
   *
   * Block comments rather than `--` line comments, because a tag may hold a
   * newline and a line comment would turn everything after one into SQL. The
   * operator refuses a tag containing a comment delimiter, which is what makes
   * this safe to interpolate at all: nothing else in a statement is text the
   * caller wrote.
   */
  private tags(node: { readonly tags?: readonly string[] }): string[] {
    return (node.tags ?? []).map((text) => `/* ${text} */`);
  }

  update(node: SqlUpdate): string {
    const table = node.table.schema
      ? `${this.dialect.quoteIdentifier(node.table.schema)}.${this.dialect.quoteIdentifier(node.table.name)}`
      : this.dialect.quoteIdentifier(node.table.name);

    // The assignments are printed before the `WHERE`, so their placeholders are
    // numbered before the predicate's, which is the order they appear in.
    const assignments = node.assignments
      .map(
        (assignment) =>
          // Bare, not qualified: SQL names the column being assigned without
          // the alias, since there is only one table it could belong to, and
          // PostgreSQL rejects the qualified form outright.
          `${this.dialect.quoteIdentifier(assignment.column)} = ${this.expression(assignment.value, 0)}`,
      )
      .join(', ');

    const parts = [
      ...this.tags(node),
      `UPDATE ${table} AS ${this.dialect.quoteIdentifier(node.table.alias)} SET ${assignments}`,
    ];

    if (node.where) parts.push('WHERE', this.expression(node.where, 0));

    if (node.returning.length > 0) {
      parts.push(
        this.dialect.formatReturning(
          node.returning.map(
            (projection) =>
              `${this.expression(projection.expression, 0)} AS ${this.dialect.quoteIdentifier(projection.alias)}`,
          ),
        ),
      );
    }

    return parts.join(' ');
  }

  delete(node: SqlDelete): string {
    const table = node.from.schema
      ? `${this.dialect.quoteIdentifier(node.from.schema)}.${this.dialect.quoteIdentifier(node.from.name)}`
      : this.dialect.quoteIdentifier(node.from.name);

    // The alias is introduced here even though nothing but the predicate uses
    // it, because the predicate was compiled against a query and every column
    // it resolved is qualified by it.
    const parts = [
      ...this.tags(node),
      `DELETE FROM ${table} AS ${this.dialect.quoteIdentifier(node.from.alias)}`,
    ];

    if (node.where) parts.push('WHERE', this.expression(node.where, 0));

    if (node.returning.length > 0) {
      parts.push(
        this.dialect.formatReturning(
          node.returning.map(
            (projection) =>
              `${this.expression(projection.expression, 0)} AS ${this.dialect.quoteIdentifier(projection.alias)}`,
          ),
        ),
      );
    }

    return parts.join(' ');
  }

  insert(node: SqlInsert): string {
    const table = node.into.schema
      ? `${this.dialect.quoteIdentifier(node.into.schema)}.${this.dialect.quoteIdentifier(node.into.name)}`
      : this.dialect.quoteIdentifier(node.into.name);

    const columns = node.columns.map((name) => this.dialect.quoteIdentifier(name)).join(', ');

    // A `VALUES` list parenthesises each row and a query is printed bare: SQL
    // puts the `SELECT` straight after the column list, and wrapping that one
    // in parentheses is a syntax error rather than merely noise. Either way the
    // rows are printed in order, so the placeholders they contribute are
    // numbered in that order too.
    const source =
      node.source.kind === 'values'
        ? `VALUES ${node.source.rows
            .map((row) => `(${row.map((value) => this.expression(value, 0)).join(', ')})`)
            .join(', ')}`
        : this.select(node.source.select);

    const parts = [...this.tags(node), `INSERT INTO ${table} (${columns}) ${source}`];

    if (node.onConflict) {
      parts.push(this.dialect.formatUpsert(node.onConflict.columns, node.onConflict.update));
    }

    if (node.returning.length > 0) {
      parts.push(
        this.dialect.formatReturning(
          node.returning.map(
            (projection) =>
              `${this.expression(projection.expression, 0)} AS ${this.dialect.quoteIdentifier(projection.alias)}`,
          ),
        ),
      );
    }

    return parts.join(' ');
  }

  select(node: SqlSelect): string {
    const parts: string[] = [...this.tags(node), 'SELECT'];
    if (node.distinct) parts.push('DISTINCT');

    parts.push(
      node.columns
        .map((projection) => {
          const expression = this.expression(projection.expression, 0);
          return `${expression} AS ${this.dialect.quoteIdentifier(projection.alias)}`;
        })
        .join(', '),
    );

    parts.push('FROM', this.from(node.from));

    for (const join of node.joins) {
      parts.push(JOIN_KEYWORDS[join.kind], this.from(join.source));
      if (join.on) parts.push('ON', this.expression(join.on, 0));
    }

    if (node.where) parts.push('WHERE', this.expression(node.where, 0));

    if (node.groupBy.length > 0) {
      parts.push(
        'GROUP BY',
        node.groupBy.map((expression) => this.expression(expression, 0)).join(', '),
      );
    }

    if (node.having) parts.push('HAVING', this.expression(node.having, 0));

    // Before ORDER BY and paging, which in SQL bind to the whole set operation
    // rather than to the branch they follow.
    for (const operation of node.setOperations) {
      const keyword = SET_OPERATORS[operation.kind];
      parts.push(operation.all ? `${keyword} ALL` : keyword, this.select(operation.select));
    }

    if (node.orderBy.length > 0) parts.push('ORDER BY', this.orderings(node.orderBy));

    const paging = this.dialect.formatPaging(
      node.limit ? this.expression(node.limit, 0) : null,
      node.offset ? this.expression(node.offset, 0) : null,
    );
    if (paging) parts.push(paging);

    return parts.join(' ');
  }

  /** Sort keys, as they read in an `ORDER BY` and inside a window alike. */
  private orderings(list: readonly SqlOrdering[]): string {
    return list
      .map((ordering) => {
        const expression = this.expression(ordering.expression, 0);
        return ordering.descending ? `${expression} DESC` : `${expression} ASC`;
      })
      .join(', ');
  }

  private from(node: SqlFrom): string {
    const alias = this.dialect.quoteIdentifier(node.alias);

    if (node.kind === 'unit') return this.dialect.formatUnitTable(node.alias);

    if (node.kind === 'table') {
      const qualified = node.schema
        ? `${this.dialect.quoteIdentifier(node.schema)}.${this.dialect.quoteIdentifier(node.name)}`
        : this.dialect.quoteIdentifier(node.name);
      return `${qualified} AS ${alias}`;
    }

    if (node.kind === 'raw') {
      // Each value is printed the way any other expression is, which is what
      // keeps it a bound parameter sharing the statement's own placeholder
      // count rather than text spliced into the fragment around it.
      const text = node.parts
        .map((part, index) =>
          index < node.values.length ? part + this.expression(node.values[index]!, 0) : part,
        )
        .join('');
      return `(${text}) AS ${alias}`;
    }

    const prefix = node.lateral ? 'LATERAL ' : '';
    return `${prefix}(${this.select(node.select)}) AS ${alias}`;
  }

  private expression(node: SqlExpression, parentPrecedence: number): string {
    switch (node.kind) {
      case 'column':
        return node.table === null
          ? this.dialect.quoteIdentifier(node.name)
          : `${this.dialect.quoteIdentifier(node.table)}.${this.dialect.quoteIdentifier(node.name)}`;

      case 'parameter':
        return this.parameter(node.source);

      case 'literal':
        return node.text;

      case 'raw':
        return node.sql;

      case 'binary': {
        const precedence = PRECEDENCE[node.operator] ?? ATOM_PRECEDENCE;
        // Arithmetic and the connectives associate to the left, so a left
        // operand of equal precedence needs no parentheses and `a - b - c`
        // reads as written. Comparison does not associate at all: PostgreSQL
        // rejects `a > b = c` outright and another database could read it as
        // something other than the comparison of a comparison that was meant.
        const left = NON_ASSOCIATIVE.has(node.operator) ? precedence + 1 : precedence;
        const text = `${this.expression(node.left, left)} ${node.operator} ${this.expression(node.right, precedence + 1)}`;
        return parenthesize(text, precedence, parentPrecedence);
      }

      case 'unary': {
        const operand = this.expression(node.operand, NOT_PRECEDENCE);
        const text = node.operator === 'NOT' ? `NOT ${operand}` : `${node.operator}${operand}`;
        return parenthesize(text, NOT_PRECEDENCE, parentPrecedence);
      }

      case 'nullTest': {
        // Anything built from an operator is parenthesised first. `IS NULL` binds
        // more loosely than a comparison, so `a >= b IS NULL` reads as the test
        // of a comparison in PostgreSQL and as a comparison against a test
        // elsewhere; the parentheses say which was meant.
        const operand = this.expression(node.operand, ATOM_PRECEDENCE);
        const text = `${operand} IS ${node.negated ? 'NOT NULL' : 'NULL'}`;
        return parenthesize(text, PRECEDENCE['=']!, parentPrecedence);
      }

      case 'in': {
        if (node.values.length === 0) {
          // `x IN ()` is a syntax error, and an empty set is a constant result.
          return node.negated ? '1 = 1' : '1 = 0';
        }
        const operand = this.expression(node.operand, PRECEDENCE['=']!);
        const values = node.values.map((value) => this.expression(value, 0)).join(', ');
        const text = `${operand} ${node.negated ? 'NOT IN' : 'IN'} (${values})`;
        return parenthesize(text, PRECEDENCE['=']!, parentPrecedence);
      }

      case 'inSubquery': {
        const operand = this.expression(node.operand, PRECEDENCE['=']!);
        const text = `${operand} ${node.negated ? 'NOT IN' : 'IN'} (${this.select(node.select)})`;
        return parenthesize(text, PRECEDENCE['=']!, parentPrecedence);
      }

      case 'subscript': {
        // A subscript binds tighter than any operator, so anything built from one
        // has to be parenthesised before it can be indexed.
        const from = this.expression(node.index, 0);
        const bounds = node.to ? `${from}:${this.expression(node.to, 0)}` : from;
        return `${this.expression(node.target, ATOM_PRECEDENCE)}[${bounds}]`;
      }

      case 'function':
        return this.functionCall(node.name, node.args);

      case 'over': {
        const args = node.args.map((argument) => this.expression(argument, 0)).join(', ');
        const partition = node.partitionBy
          .map((expression) => this.expression(expression, 0))
          .join(', ');
        const window = [
          partition ? `PARTITION BY ${partition}` : '',
          node.orderBy.length > 0 ? `ORDER BY ${this.orderings(node.orderBy)}` : '',
          node.frame ?? '',
        ]
          .filter(Boolean)
          .join(' ');
        return `${node.name}(${args}) OVER (${window})`;
      }

      case 'subquery':
        // Already as tight as an operand can be, so it needs no precedence of
        // its own: the parentheses a subquery brings are the parentheses.
        return `${node.prefix ?? ''}(${this.select(node.select)})`;

      case 'exists': {
        // The subquery brings its own parentheses, so the whole thing is already
        // as tight as an operand can be. It is still given `NOT`'s precedence
        // rather than an atom's, which is what puts parentheses around it were
        // it ever to become the operand of a comparison.
        const keyword = node.negated ? 'NOT EXISTS' : 'EXISTS';
        return parenthesize(
          `${keyword} (${this.select(node.select)})`,
          NOT_PRECEDENCE,
          parentPrecedence,
        );
      }

      case 'aggregate': {
        const distinct = node.distinct ? 'DISTINCT ' : '';
        const argument = node.argument ? this.expression(node.argument, 0) : '*';
        return `${node.name.toUpperCase()}(${distinct}${argument})`;
      }

      case 'case': {
        const branches = node.branches
          .map(
            (branch) =>
              `WHEN ${this.expression(branch.condition, 0)} THEN ${this.expression(branch.result, 0)}`,
          )
          .join(' ');
        const otherwise = node.otherwise ? ` ELSE ${this.expression(node.otherwise, 0)}` : '';
        return `CASE ${branches}${otherwise} END`;
      }
    }
  }

  /**
   * Emits a placeholder, reusing the one already standing for the same value.
   *
   * Sharing is what keeps two clauses that were compiled from one expression
   * identical as text, and it binds the value once instead of once per
   * mention. A dialect whose placeholders are positional rather than numbered
   * cannot do this, since there every occurrence consumes the next value.
   */
  private parameter(source: ParameterSource): string {
    const key = this.dialect.sharesParameters ? shareKey(source) : null;
    if (key !== null) {
      const existing = this.shared.get(key);
      if (existing !== undefined) return existing;
    }

    const placeholder = this.dialect.parameterPlaceholder(this.parameters.length);
    this.parameters.push(source);
    if (key !== null) this.shared.set(key, placeholder);
    return placeholder;
  }

  private functionCall(name: string, args: readonly SqlExpression[]): string {
    const keyword = KEYWORD_ARGUMENTS[name];
    if (keyword && args.length === 2) {
      return `${name}(${this.expression(args[0]!, 0)} ${keyword} ${this.expression(args[1]!, 0)})`;
    }

    const printed = args.map((argument) => this.expression(argument, 0)).join(', ');
    return `${name}(${printed})`;
  }
}

/**
 * A key identifying the value a parameter stands for, or `null` when two
 * parameters cannot be told apart cheaply enough to risk sharing one.
 *
 * Bag references are keyed by path, so the same path always resolves to the
 * same value. Literals are keyed by value, but only the primitives whose
 * identity survives being turned into a string: a `Date` or an object is left
 * alone rather than compared by a stringification that might collide.
 */
function shareKey(source: ParameterSource): string | null {
  if (source.type === 'external') return `external ${JSON.stringify(source.path)}`;

  const value = source.value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return `${type} ${String(value)}`;
  }
  return null;
}

function parenthesize(text: string, precedence: number, parentPrecedence: number): string {
  return precedence < parentPrecedence ? `(${text})` : text;
}
