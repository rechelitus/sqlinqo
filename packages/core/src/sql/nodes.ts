/**
 * A relational algebra tree, one step below the expression IR.
 *
 * The compiler lowers a query plan into these nodes and the printer turns them
 * into text. Splitting the two means a dialect can inspect and rewrite the tree
 * (adding a `FETCH NEXT` clause, wrapping a paging window) without doing string
 * surgery on generated SQL.
 */

/**
 * Where a parameter's value comes from at execution time.
 *
 * `value` covers literals written in the lambda; `external` points into the
 * parameter bag, which is what lets one compiled statement serve many argument
 * values instead of forcing a recompile per call.
 */
export type ParameterSource =
  | { readonly type: 'value'; readonly value: unknown }
  | { readonly type: 'external'; readonly path: readonly string[] };

export interface SqlColumnRef {
  readonly kind: 'column';
  /**
   * The alias the column is read through, or `null` for a bare name.
   *
   * Every column a query reads is qualified, because a query always has a table
   * or a derived table to read it from. An `INSERT` has neither: its
   * `RETURNING` list names columns of the table being written, which is not in
   * scope under an alias and does not need one.
   */
  readonly table: string | null;
  readonly name: string;
}

export interface SqlParameterRef {
  readonly kind: 'parameter';
  readonly source: ParameterSource;
}

export interface SqlBinary {
  readonly kind: 'binary';
  readonly operator: string;
  readonly left: SqlExpression;
  readonly right: SqlExpression;
}

export interface SqlUnary {
  readonly kind: 'unary';
  readonly operator: string;
  readonly operand: SqlExpression;
}

export interface SqlFunctionCall {
  readonly kind: 'function';
  readonly name: string;
  readonly args: readonly SqlExpression[];
}

export interface SqlNullTest {
  readonly kind: 'nullTest';
  readonly operand: SqlExpression;
  readonly negated: boolean;
}

export interface SqlInList {
  readonly kind: 'in';
  readonly operand: SqlExpression;
  readonly values: readonly SqlExpression[];
  readonly negated: boolean;
}

export interface SqlCase {
  readonly kind: 'case';
  readonly branches: readonly {
    readonly condition: SqlExpression;
    readonly result: SqlExpression;
  }[];
  readonly otherwise: SqlExpression | null;
}

export interface SqlAggregate {
  readonly kind: 'aggregate';
  readonly name: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** `null` means `COUNT(*)`. */
  readonly argument: SqlExpression | null;
  readonly distinct: boolean;
}

/**
 * A function evaluated over a window of rows rather than over the whole group.
 *
 * This is what lets a positional operator be translated at all: SQL has no
 * notion of "the rows before this one" in a `WHERE`, but a window ordered the
 * same way the query is gives every row a view of the ones ahead of it.
 */
export interface SqlOver {
  readonly kind: 'over';
  readonly name: string;
  readonly args: readonly SqlExpression[];
  /**
   * Restarts the window for each distinct combination of these, so a running
   * count or a row number is per group rather than over the whole result.
   */
  readonly partitionBy: readonly SqlExpression[];
  readonly orderBy: readonly SqlOrdering[];
  /**
   * Frame clause, such as `ROWS UNBOUNDED PRECEDING`. Written by the compiler
   * from a fixed set of spellings, never assembled from user input.
   */
  readonly frame: string | null;
}

/**
 * A test for whether a subquery returns any row at all.
 *
 * This is the one place a query sits inside an expression rather than around
 * one, and it is added for the reason `SqlOver` was: no existing node can say
 * it. A subquery cannot be a `SqlSelect` in a `from`, because the question is
 * asked per row of the query around it and answered without producing a column.
 *
 * The subquery is free to name a column of the enclosing query, which is what
 * makes it correlated and what `exceptBy` relies on. Note that this is narrower
 * than a query in expression position generally: the compiler builds these, and
 * a lambda still cannot mention one.
 */
export interface SqlExists {
  readonly kind: 'exists';
  readonly select: SqlSelect;
  /** True for `NOT EXISTS`, which is the anti-join and the commoner of the two. */
  readonly negated: boolean;
}

/**
 * A subquery standing where a value would, yielding exactly one row and column.
 *
 * `SqlExists` asks whether a subquery returns anything; this one reads what it
 * returned, which is what lets `groupJoin` answer an aggregate over the rows
 * matching each outer row without joining them in. Like `SqlExists` it is free
 * to name a column of the query around it, which is what makes it correlated,
 * and like `SqlExists` the compiler builds it and a lambda cannot mention one.
 *
 * Nothing here guarantees the one row: an aggregate with no `GROUP BY` always
 * returns exactly one, and that is the only shape the compiler puts in.
 */
export interface SqlSubquery {
  readonly kind: 'subquery';
  readonly select: SqlSelect;
  /**
   * A keyword printed directly before the parentheses, such as PostgreSQL's
   * `ARRAY` constructor over a subquery. Absent for a subquery standing bare
   * where a value would.
   */
  readonly prefix?: string;
}

/**
 * `x IN (subquery)`, testing membership against a query's own rows rather
 * than a fixed list of values.
 *
 * Kept apart from `SqlInList` rather than widening its `values` field: an
 * empty `SqlInList` folds to a constant at print time, and a subquery's row
 * count is not known until the database runs it.
 *
 * Unlike `SqlExists` and `SqlSubquery`, the query here is not correlated: it
 * is compiled on its own, with no scope reaching back to the row `operand`
 * comes from. It is also the one node in this file a lambda can actually
 * name, through a query passed as a parameter bag's value rather than
 * captured from the enclosing scope; `Queryable.asValues` is what lets a
 * caller mark one for this.
 */
export interface SqlInSubquery {
  readonly kind: 'inSubquery';
  readonly operand: SqlExpression;
  readonly select: SqlSelect;
  readonly negated: boolean;
}

/**
 * One element of an array value, as `x[i]`, or a run of them, as `x[i:j]`.
 *
 * The bounds are whatever the dialect decided they should be, since databases
 * that have arrays at all number them from one while JavaScript numbers from
 * zero. A slice is the same node with an upper bound rather than a node of its
 * own: the printer puts a colon between them and everything else about reading
 * into an array is the same.
 */
export interface SqlSubscript {
  readonly kind: 'subscript';
  readonly target: SqlExpression;
  readonly index: SqlExpression;
  /** The last position to read, for a slice. Absent for a single element. */
  readonly to?: SqlExpression;
}

/** An escape hatch for dialect-specific fragments. Never built from user input. */
export interface SqlRaw {
  readonly kind: 'raw';
  readonly sql: string;
}

export interface SqlLiteral {
  readonly kind: 'literal';
  /** Already-safe token such as `NULL`, `TRUE`, or an integer used for paging. */
  readonly text: string;
}

export type SqlExpression =
  | SqlColumnRef
  | SqlParameterRef
  | SqlBinary
  | SqlUnary
  | SqlFunctionCall
  | SqlNullTest
  | SqlInList
  | SqlCase
  | SqlAggregate
  | SqlOver
  | SqlExists
  | SqlSubquery
  | SqlInSubquery
  | SqlSubscript
  | SqlRaw
  | SqlLiteral;

export interface SqlProjection {
  readonly expression: SqlExpression;
  readonly alias: string;
}

export interface SqlOrdering {
  readonly expression: SqlExpression;
  readonly descending: boolean;
}

/**
 * Where the rows an `INSERT` adds come from.
 *
 * SQL offers exactly two answers and puts them in the same slot: a `VALUES`
 * list the statement carries with it, or a query the database runs to find
 * them. A union rather than two optional fields, because a statement has one
 * or the other, never both and never neither.
 *
 * `values` holds a list of value lists rather than one, so several rows go in
 * one statement. Each is as long as the insert's `columns` and in the same
 * order, which the compiler guarantees by building both from the same list of
 * properties.
 *
 * `query` carries an ordinary `SqlSelect`, already reordered so its projection
 * lines up with those same `columns`. That reordering is not tidiness:
 * `INSERT ... SELECT` matches the two by position and pays no attention to
 * what the projection called each one, so a query whose columns arrive in
 * another order writes every value into the wrong column without a word from
 * the database.
 */
export type SqlInsertSource =
  | { readonly kind: 'values'; readonly rows: readonly (readonly SqlExpression[])[] }
  | { readonly kind: 'query'; readonly select: SqlSelect };

/**
 * Rows added to a table, and the columns read back once they are there.
 *
 * This is the first node here that changes anything, and it is deliberately not
 * a `SqlSelect` with extra fields: nothing about a `WHERE`, a join, or an
 * ordering means anything to it, and giving it those fields would only invite
 * a caller to set one. A query does reach it, but whole, under `source`, rather
 * than as clauses of its own: the difference between a statement that contains
 * a query and a statement that is one.
 *
 * `returning` names the columns to read back and the property each answers to,
 * which is how a generated key reaches the caller. Not every database spells
 * that clause the same way, so the printer asks the dialect for it.
 */
export interface SqlInsert {
  readonly kind: 'insert';
  /**
   * Comments to print before the statement, in the order they were written.
   *
   * Only a `source` of kind `query` ever carries any, and for `SqlUpdate`'s own
   * reason: the tag was written on the query, and the statement the caller sees
   * in a log is this one rather than the `SELECT` inside it.
   */
  readonly tags?: readonly string[];
  readonly into: { readonly schema?: string; readonly name: string };
  /** Physical column names, in the order the source supplies their values. */
  readonly columns: readonly string[];
  readonly source: SqlInsertSource;
  readonly returning: readonly SqlProjection[];
  /**
   * Present for `upsert`: the physical columns a conflict is detected on, and
   * the physical columns to overwrite with the proposed row when one occurs.
   *
   * Both are raw column names rather than pre-quoted fragments, unlike
   * `returning`'s own convention, because the assignment syntax itself
   * (PostgreSQL's `EXCLUDED` pseudo-table) is as dialect-specific as the
   * keyword introducing it, so the dialect builds the whole clause rather
   * than only wrapping fragments the printer already built.
   */
  readonly onConflict?: { readonly columns: readonly string[]; readonly update: readonly string[] };
}

/**
 * Rows already in a table given new values, and the columns read back after.
 *
 * The table carries an alias because the `WHERE` here is compiled by the same
 * machinery that compiles a query's, and every column a query resolves is
 * qualified. `SET` is the one place that alias must not appear: SQL names the
 * column being assigned bare, since there is only one table it could belong to.
 *
 * A `null` `where` updates every row, which is a thing a caller can ask for and
 * a thing the operator makes them ask for in as many words.
 */
export interface SqlUpdate {
  readonly kind: 'update';
  /**
   * Comments to print before the statement, in the order they were written.
   *
   * Optional because almost no statement has one, and absent rather than empty
   * for the same reason. They are collected onto the statement the caller will
   * see rather than onto whichever `SELECT` the tag was written over, so a tag
   * inside a query that was later wrapped in a derived table still reads at the
   * top of the log line rather than from the middle of a subquery.
   */
  readonly tags?: readonly string[];

  readonly table: { readonly schema?: string; readonly name: string; readonly alias: string };
  /** Physical column name and the value it takes, in the order given. */
  readonly assignments: readonly { readonly column: string; readonly value: SqlExpression }[];
  readonly where: SqlExpression | null;
  readonly returning: readonly SqlProjection[];
}

/**
 * Rows taken out of a table, and the columns read back before they go.
 *
 * The shape is an update's with the assignments removed, which is the whole of
 * what the two statements differ by: both name one table, both narrow it with a
 * predicate compiled exactly as a query's would be, and both read the rows they
 * touched back. It is a node of its own rather than an update with an empty
 * assignment list, because an update with nothing to set is a mistake this
 * refuses by name and a delete is not that mistake.
 *
 * The alias is carried for the reason an update carries one: the `WHERE` comes
 * from the query compiler and every column it resolves is qualified, so the
 * table has to be introduced under the name those references already use.
 *
 * A `null` `where` empties the table, which is a thing a caller can ask for
 * and a thing the operator makes them ask for in as many words.
 */
export interface SqlDelete {
  readonly kind: 'delete';
  /**
   * Comments to print before the statement, in the order they were written.
   *
   * Optional because almost no statement has one, and absent rather than empty
   * for the same reason. They are collected onto the statement the caller will
   * see rather than onto whichever `SELECT` the tag was written over, so a tag
   * inside a query that was later wrapped in a derived table still reads at the
   * top of the log line rather than from the middle of a subquery.
   */
  readonly tags?: readonly string[];

  readonly from: { readonly schema?: string; readonly name: string; readonly alias: string };
  readonly where: SqlExpression | null;
  readonly returning: readonly SqlProjection[];
}

export type SqlFrom =
  | {
      readonly kind: 'table';
      readonly schema?: string;
      readonly name: string;
      readonly alias: string;
    }
  | {
      readonly kind: 'derived';
      readonly select: SqlSelect;
      readonly alias: string;
      /**
       * True when this derived table's own body reaches outside itself, to a
       * `FROM` item that precedes it in the same query. Standard SQL refuses
       * that in an ordinary subquery; `LATERAL` is the word that allows it,
       * which correlated `selectMany` flattening needs and nothing else here
       * does, so every other derived table leaves this absent.
       */
      readonly lateral?: boolean;
    }
  /**
   * A source of exactly one row and no columns of its own.
   *
   * `defaultIfEmpty` left-joins the query onto this, which is what turns an
   * empty result into a single row rather than none. It is a kind of its own
   * because no dialect-neutral text says it: a `SELECT` with no `FROM` is what
   * most databases accept here and what the standard does not, so the spelling
   * is the dialect's to choose.
   */
  | { readonly kind: 'unit'; readonly alias: string }
  /**
   * A source read from a caller's own SQL fragment, `RawSourceNode`'s.
   *
   * `parts` is the fragment's literal text, split at every value; `values` is
   * one shorter, so the printer reads `parts[0]`, then `values[0]`, then
   * `parts[1]`, and so on. Printing a value the way any other expression is
   * printed is what keeps it a bound parameter, sharing the running
   * placeholder count the rest of the statement uses, rather than text spliced
   * into the fragment where a quote could end the statement early.
   */
  | {
      readonly kind: 'raw';
      readonly parts: readonly string[];
      readonly values: readonly SqlExpression[];
      readonly alias: string;
    };

/**
 * One joined input and the condition that matches it against the rows already
 * in scope.
 *
 * Joins are held as a flat list rather than nested pairwise because that is how
 * `FROM a JOIN b JOIN c` reads and how every dialect prints it.
 */
export interface SqlJoin {
  readonly kind: 'inner' | 'left' | 'right' | 'full' | 'cross';
  readonly source: SqlFrom;
  /** `null` for a cross join, which pairs every row with every other. */
  readonly on: SqlExpression | null;
}

/**
 * A query appended to another with a set operator, as `UNION SELECT ...`.
 *
 * Branches are held as a flat list, which reads the way SQL does for a run of
 * operators that bind equally tightly. They do not all bind equally tightly:
 * `INTERSECT` binds tighter than `UNION` and `EXCEPT`, so it falls to the
 * compiler to decide when a branch has to become a derived table instead.
 */
export interface SqlSetOperation {
  readonly kind: 'union' | 'intersect' | 'except';
  /** True for the `ALL` variant, which keeps duplicate rows rather than removing them. */
  readonly all: boolean;
  readonly select: SqlSelect;
}

export interface SqlSelect {
  readonly kind: 'select';
  /**
   * Comments to print before the statement, in the order they were written.
   *
   * Optional because almost no statement has one, and absent rather than empty
   * for the same reason. They are collected onto the statement the caller will
   * see rather than onto whichever `SELECT` the tag was written over, so a tag
   * inside a query that was later wrapped in a derived table still reads at the
   * top of the log line rather than from the middle of a subquery.
   */
  readonly tags?: readonly string[];

  readonly distinct: boolean;
  readonly columns: readonly SqlProjection[];
  readonly from: SqlFrom;
  readonly joins: readonly SqlJoin[];
  readonly where: SqlExpression | null;
  readonly groupBy: readonly SqlExpression[];
  /** Filters groups. Separate from `where`, which is applied before grouping. */
  readonly having: SqlExpression | null;
  readonly setOperations: readonly SqlSetOperation[];
  readonly orderBy: readonly SqlOrdering[];
  readonly limit: SqlExpression | null;
  readonly offset: SqlExpression | null;
}

export const column = (table: string, name: string): SqlColumnRef => ({
  kind: 'column',
  table,
  name,
});

export const valueParameter = (value: unknown): SqlParameterRef => ({
  kind: 'parameter',
  source: { type: 'value', value },
});

export const externalParameter = (path: readonly string[]): SqlParameterRef => ({
  kind: 'parameter',
  source: { type: 'external', path },
});

export const sqlBinary = (
  operator: string,
  left: SqlExpression,
  right: SqlExpression,
): SqlBinary => ({ kind: 'binary', operator, left, right });

export const sqlFunction = (name: string, args: readonly SqlExpression[]): SqlFunctionCall => ({
  kind: 'function',
  name,
  args,
});

export const sqlLiteral = (text: string): SqlLiteral => ({ kind: 'literal', text });

export const SQL_NULL = sqlLiteral('NULL');

/** Combines conditions with `AND`, skipping the redundant `TRUE AND ...`. */
export function conjoin(left: SqlExpression | null, right: SqlExpression): SqlExpression {
  return left ? sqlBinary('AND', left, right) : right;
}
