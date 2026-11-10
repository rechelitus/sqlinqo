import type { Driver, ExecutedStatement, PreparedStatement, ResultRow } from '../driver.js';
import { InvalidQueryError, ModelError, SequenceError } from '../errors.js';
import type { ExpressionNode, LambdaExpression } from '../expression/nodes.js';
import {
  binary,
  call,
  constant,
  external,
  member,
  object,
  parameter,
  unary,
} from '../expression/nodes.js';
import type {
  AnyEntity,
  EntityOf,
  IncludedRow,
  InsertOf,
  Related,
  RelationDefinition,
} from '../metadata/entity.js';
import type { AnyLambda } from '../parser/lambda.js';
import { parseLambda, toExpression } from '../parser/lambda.js';
import {
  compileAverage,
  compileCount,
  compileCountDistinct,
  compileDelete,
  compileInsert,
  compileInsertFrom,
  compileUpdate,
  compileMax,
  compileMin,
  compileQuery,
  compileSum,
} from '../sql/compiler.js';
import type { NestedEmbed, UpdateAssignments } from '../sql/compiler.js';
import type { SqlDialect } from '../sql/dialect.js';
import type { SqlSelect } from '../sql/nodes.js';
import {
  bindParameters,
  printDelete,
  printInsert,
  printSelect,
  printUpdate,
} from '../sql/printer.js';
import { boundQuery } from './bound-query.js';
import type { JoinNode, OrderKey, QueryPlan, SetOperationNode } from './plan.js';
import { rootEntity } from './plan.js';
import { renameBags } from './rebind.js';

/** Everything a query needs at execution time, shared by every `Queryable`. */
export interface QueryRuntime {
  readonly dialect: SqlDialect;
  readonly driver: Driver;
  readonly logger?: (statement: ExecutedStatement) => void;
}

type ParameterBags = Readonly<Record<string, unknown>>;

/** Alias for the loosely typed lambda an overload implementation receives. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseLambda = (...args: any[]) => any;

/**
 * A row every column of which may be missing.
 *
 * An outer row with no match contributes no joined row at all, and SQL reads
 * every column of the absent side as null. A result selector never holds that
 * row, only reads columns off it, so widening each column says what actually
 * happens and leaves `(u, o) => ({ total: o.total })` writable as it stands.
 * Typing the row itself as `TInner | null` would instead demand optional
 * chaining, which the query parser does not accept.
 */
export type NullableRow<T> = { [K in keyof T]: T[K] | null };

/**
 * The rows behind one group, as a `groupBy` or `groupJoin` result selector
 * sees them.
 *
 * These methods exist to be read, not run: the compiler recognises each one
 * and lowers it to SQL, so this is never actually constructed the way a
 * caller's own row is. Most answer with one aggregate value; `toArray` is the
 * exception, answering with every column of every row instead, folded into
 * one JSON value by the database itself rather than read back over a second
 * statement the way `Grouping` below is.
 *
 * The return types describe what the aggregate means in SQL, so that a lambda
 * such as `(city, users) => users.count() > 5` type-checks the way the `HAVING`
 * clause it becomes would. What a driver hands back is a separate question:
 * node-postgres returns `COUNT`, `AVG`, and `SUM` over an exact numeric as
 * strings to avoid losing precision, so convert when reading those columns out
 * of a result row. This is the same trade that maps `decimal` to `string`.
 *
 * `sum` and `average` keep the type of the value selected, which is what makes
 * summing a `decimal` column stay a `string` rather than quietly becoming a
 * float. `min` and `max` return a value that was already in the column.
 *
 * Those two admit a null in the value as well, which is not decoration: a
 * nullable column is an ordinary thing to add up, `SUM` skips the nulls, and
 * refusing one in the type would have made a perfectly good statement
 * unwritable. It is also what makes the answer honest, since a group whose
 * values are every one of them null totals to null and the type now says so.
 * The bound is still there to keep a boolean or a `Date` out, which is the
 * thing it was ever for; `min` and `max` need no bound at all, since anything
 * a column holds is something SQL can order.
 */
export interface Group<T> {
  /** `COUNT(*)` over the rows in the group. */
  count(): number;
  /**
   * `COUNT(DISTINCT x)` over the rows in the group, the same reading the
   * standalone `countDistinct` terminal gives a null: SQL skips it and this
   * counts it once, closing the gap in the generated SQL the way `distinctBy`
   * and `exceptBy` already do for a null key.
   */
  countDistinct<TValue>(value: (row: T) => TValue): number;
  sum<TValue extends number | string | null>(value: (row: T) => TValue): TValue;
  average<TValue extends number | string | null>(value: (row: T) => TValue): TValue;
  min<TValue>(value: (row: T) => TValue): TValue;
  max<TValue>(value: (row: T) => TValue): TValue;
  /**
   * Every row in the group, nested rather than reduced:
   *
   * ```ts
   * const activity = await db.users
   *   .groupJoin(
   *     db.orders,
   *     (u) => u.id,
   *     (o) => o.userId,
   *     (u, orders) => ({ ...u, orders: orders.toArray() }),
   *   )
   *   .toArray();
   * ```
   *
   * That is one user per row, each with its own array of orders, still as one
   * statement: PostgreSQL folds the matches into one JSON value with
   * `json_agg`, the same correlated-subquery shape every other aggregate here
   * takes, and the driver hands the array back already parsed. An outer row
   * with no matches reads as `[]`, the same reasoning that gives `count` zero
   * and `sum` zero for one.
   *
   * A `decimal` or `bigint` column stays the string this library reads it as
   * everywhere else; JSON has only one number type, and PostgreSQL would
   * otherwise narrow it into one that loses precision. A `date` or
   * `timestamp` column has no such rescue: JSON has no date type, so it
   * arrives as whatever text PostgreSQL renders it as rather than the `Date`
   * a column reads as anywhere else, the same kind of gap `Group`'s own
   * `count()` already has against what the driver actually returns.
   */
  toArray(): readonly T[];
}

/**
 * The rows behind one run, as a `windowed` or `expanding` projector sees them.
 *
 * Both operators hand back the same receiver because both reduce a frame of the
 * query's own rows; only how far back the frame reaches differs, and that is
 * the operator's business to say rather than the type's.
 *
 * This is `Group<T>` less `countDistinct`, and the subtraction is the point.
 * Everything else a group answers, a window frame answers the same way, so a
 * run is read with the aggregate names that were already here rather than a
 * second vocabulary meaning the same things. `COUNT(DISTINCT ...)` is the one
 * SQL does not define over a frame and PostgreSQL rejects outright, so it is
 * taken off the type: a run that cannot spell it should say so where the query
 * is written rather than where it is run, which is the same reason `zip` takes
 * an `OrderedQueryable` instead of checking for an ordering later.
 *
 * `toArray` stays, and over a run it is the literal reading of the operator:
 * every column of every row of the run, folded into one JSON value by the
 * database, with the same caveats about `decimal` and `date` columns that
 * `Group`'s own `toArray` carries.
 */
export type Run<T> = Omit<Group<T>, 'countDistinct'>;

/**
 * The rows behind one key, as `groupBy` hands them back when it is given no
 * result selector.
 *
 * Unlike `Group<T>`, whose methods only ever become SQL and never
 * materialise a row the ordinary way, this is the rows themselves, already
 * read: an ordinary array the caller iterates or indexes as any other,
 * carrying the key they were grouped under so a loop need not ask for it
 * separately.
 */
export type Grouping<TKey, T> = readonly T[] & { readonly key: TKey };

/**
 * Renumbers a plan's own bag references past whatever `bags` already holds,
 * and folds its values in.
 *
 * `Queryable.mergeInto` is this applied to another query; `IncludedQueryable`
 * reaches for it directly for a statement it already has a plan and bags for
 * rather than a `Queryable` to read them off, such as an inclusion's own.
 */
function mergeBagsInto(
  bags: ParameterBags,
  plan: QueryPlan,
  otherBags: ParameterBags,
): { plan: QueryPlan; bags: ParameterBags } {
  const renames = new Map<string, string>();
  const merged: Record<string, unknown> = { ...bags };
  let next = Object.keys(bags).length;

  for (const [bagId, values] of Object.entries(otherBags)) {
    const renamed = `p${next}`;
    next += 1;
    renames.set(bagId, renamed);
    merged[renamed] = values;
  }

  return { plan: renameBags(plan, renames), bags: merged };
}

/**
 * A lazily evaluated, strongly typed query over one entity.
 *
 * Nothing touches the database until a terminal operator such as `toArray` or
 * `count` runs. Every intermediate operator returns a new instance, so a
 * partially built query is safe to reuse and to branch.
 */
export class Queryable<T> {
  constructor(
    protected readonly runtime: QueryRuntime,
    protected readonly plan: QueryPlan,
    protected readonly bags: ParameterBags = {},
    /**
     * True when the query projects a single unnamed value, in which case rows
     * are unwrapped from their `value` column before being returned.
     */
    protected readonly scalar: boolean = false,
  ) {}

  /** Filters rows. Values from the surrounding scope go in the parameter bag. */
  where(predicate: (row: T) => boolean): Queryable<T>;
  where<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Queryable<T>;
  where(predicate: LooseLambda, params?: object): Queryable<T> {
    const bound = this.bind(predicate, params);
    return new Queryable<T>(
      this.runtime,
      { kind: 'where', source: this.plan, predicate: bound.expression },
      bound.bags,
      this.scalar,
    );
  }

  /** Reshapes rows. An object literal becomes the projected column list. */
  select<TResult>(projector: (row: T) => TResult): Queryable<TResult>;
  select<TResult, TParams extends object>(
    projector: (row: T, params: TParams) => TResult,
    params: TParams,
  ): Queryable<TResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(projector: LooseLambda, params?: object): Queryable<any> {
    const bound = this.bind(projector, params);

    return new Queryable<unknown>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: bound.expression },
      bound.bags,
      isScalarProjection(bound.expression.body),
    );
  }

  /**
   * Inner-joins another query, matching one key from each side.
   *
   * The signature follows LINQ's `Join`: two key selectors and a result
   * selector that receives both rows. Because the result is a flat row rather
   * than a nested pair, everything downstream (`where`, `orderBy`, paging,
   * another `join`) keeps working unchanged.
   *
   * Both key selectors produce a `TKey`, so a mismatched pair of keys is a
   * compile error rather than a query that silently returns nothing.
   */
  join<TInner, TKey, TResult>(
    inner: Queryable<TInner>,
    outerKey: (outer: T) => TKey,
    innerKey: (inner: TInner) => TKey,
    result: (outer: T, inner: TInner) => TResult,
  ): Queryable<TResult> {
    return this.joinOn(inner, outerKey, innerKey, result, 'inner', 'join');
  }

  /**
   * Joins another query, keeping every row of this one whether or not it
   * matches.
   *
   * The difference from `join` is what happens to an unmatched row: `join`
   * drops it, this keeps it with the joined side's columns null. That is why
   * the result selector sees a `NullableRow<TInner>` rather than a `TInner`.
   *
   * Filtering on a column of the joined side afterwards turns this back into an
   * inner join, since a null fails every comparison. That is what SQL does with
   * a `WHERE` over a `LEFT JOIN`, and it is rarely what was meant: filter the
   * query being joined instead, and the filter is applied before the match.
   */
  leftJoin<TInner, TKey, TResult>(
    inner: Queryable<TInner>,
    outerKey: (outer: T) => TKey,
    innerKey: (inner: TInner) => TKey,
    result: (outer: T, inner: NullableRow<TInner>) => TResult,
  ): Queryable<TResult> {
    return this.joinOn(inner, outerKey, innerKey, result, 'left', 'leftJoin');
  }

  /**
   * Joins another query, keeping every row of both sides whether or not they
   * match.
   *
   * ```ts
   * db.users.fullJoin(
   *   db.cities,
   *   (u) => u.cityId,
   *   (c) => c.id,
   *   (u, c) => ({ who: u.name, city: c.name }),
   * );
   * ```
   *
   * That is every user and every city, paired where they match. Neither side is
   * preserved at the other's expense, which is why the result selector sees a
   * `NullableRow` on both and why this is the one join that cannot be written
   * as a `leftJoin` with the sides swapped.
   *
   * A row where every column is null is genuinely ambiguous here: it may be an
   * unmatched row from either side, or a matched pair that happened to be null
   * throughout. Project a column that cannot be null on each side, such as a
   * primary key, when the answer has to say which.
   *
   * `FULL JOIN` is standard SQL and PostgreSQL has it, but not every database
   * does; MySQL has no spelling for it at all. A statement using this will be
   * rejected there rather than translated to something else.
   */
  fullJoin<TInner, TKey, TResult>(
    inner: Queryable<TInner>,
    outerKey: (outer: T) => TKey,
    innerKey: (inner: TInner) => TKey,
    result: (outer: NullableRow<T>, inner: NullableRow<TInner>) => TResult,
  ): Queryable<TResult> {
    return this.joinOn(inner, outerKey, innerKey, result, 'full', 'fullJoin');
  }

  /**
   * Joins another query and hands each row the matches, rather than one row per
   * match.
   *
   * ```ts
   * db.users.groupJoin(
   *   db.orders,
   *   (u) => u.id,
   *   (o) => o.userId,
   *   (u, orders) => ({ who: u.name, placed: orders.count(), spent: orders.sum((o) => o.total) }),
   * );
   * ```
   *
   * This is LINQ's `GroupJoin`. The difference from `join` is what the result
   * selector holds: one matching row there, all of them here. A row has columns
   * and not a nested sequence, so what can be read off the matches is a
   * question about them, which is why the second parameter is a `Group<TInner>`
   * and not an array. It is the same `Group` a `groupBy` result selector gets,
   * and supports the same aggregates.
   *
   * Every outer row survives, matches or none, which is what separates this
   * from `join` and makes it the way to count something that may be zero.
   * `count()` is 0 for a row with no matches, as it is in LINQ, and `sum` is 0
   * for the reason the terminal `sum` is. `min`, `max`, and `average` are null
   * there, since SQL has no other answer and LINQ would have thrown.
   *
   * Each aggregate compiles to a correlated subquery over the matching rows.
   * That is deliberately not a `leftJoin` with a `groupBy` around it, which
   * would have to group by every column of the outer row to put it back
   * together and would then answer one row where two outer rows happened to be
   * identical. Reading several aggregates costs several subqueries, so ask for
   * the ones you need.
   */
  groupJoin<TInner, TKey, TResult>(
    inner: Queryable<TInner>,
    outerKey: (outer: T) => TKey,
    innerKey: (inner: TInner) => TKey,
    result: (outer: T, matches: Group<TInner>) => TResult,
  ): Queryable<TResult> {
    this.requireSameContext(inner, 'groupJoin');

    const merged = this.merge(inner);
    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<TResult>(
      this.runtime,
      {
        kind: 'groupJoin',
        source: this.plan,
        inner: merged.plan,
        outerKey: toExpression(outerKey, { rowParameterCount: 1 }),
        innerKey: toExpression(innerKey, { rowParameterCount: 1 }),
        projector,
      },
      merged.bags,
      isScalarProjection(projector.body),
    );
  }

  /**
   * Joins another query, keeping every row of *that* one whether or not it
   * matches.
   *
   * The mirror of `leftJoin`: this keeps the joined side and lets the outer
   * side go null, which is why the result selector sees a `NullableRow<T>` and
   * a plain `TInner`.
   *
   * ```ts
   * db.users.rightJoin(
   *   db.cities,
   *   (u) => u.cityId,
   *   (c) => c.id,
   *   (u, c) => ({ city: c.name, who: u.name }),
   * );
   * ```
   *
   * That is every city, with a user where one lives there. Note that
   * `db.cities.leftJoin(db.users, (c) => c.id, (u) => u.cityId, ...)` asks the
   * same question with the sides swapped, and is the spelling to prefer when
   * the query is being written from scratch: it reads in the order the rows
   * come out. This exists for when the outer side is already fixed, which is
   * what happens to a query built up elsewhere and handed here to be extended.
   *
   * Filtering on a column of the outer side afterwards turns this back into an
   * inner join, since a null fails every comparison. That is `leftJoin`'s
   * caveat with the sides exchanged, and it is the same fix: filter the outer
   * query before joining, so the filter runs before the match.
   */
  rightJoin<TInner, TKey, TResult>(
    inner: Queryable<TInner>,
    outerKey: (outer: T) => TKey,
    innerKey: (inner: TInner) => TKey,
    result: (outer: NullableRow<T>, inner: TInner) => TResult,
  ): Queryable<TResult> {
    return this.joinOn(inner, outerKey, innerKey, result, 'right', 'rightJoin');
  }

  /**
   * Flattens many rows per row of this query into one sequence.
   *
   * Given another query, every row is paired with every row of it, which is a
   * `CROSS JOIN`. Given one of this row's collections, each row is paired only
   * with the rows keyed back to it:
   *
   * ```ts
   * db.users.selectMany(
   *   (u) => u.orders,
   *   (u, o) => ({ customer: u.name, total: o.total }),
   * );
   * ```
   *
   * Either way the result multiplies rather than preserves: a row with no
   * matches is gone from it, and one with three appears three times. That is
   * what flattening means, and it is the difference from `leftJoin`, which
   * keeps every row of the query it is called on.
   *
   * A collection may also be read with its own `where`/`orderBy`/`skip`/`take`,
   * applied per outer row rather than once over the whole table:
   *
   * ```ts
   * db.users.selectMany(
   *   (u) => u.orders,
   *   (orders) => orders.orderByDescending((o) => o.placedAt).take(3),
   *   (u, o) => ({ customer: u.name, total: o.total }),
   * );
   * ```
   *
   * That is each user's three most recent orders, not the three most recent
   * orders overall, still as one statement: the shape compiles to a `LATERAL`
   * join, correlated to the outer row rather than read separately the way
   * `include` reads a collection. The row it hands back cannot be included
   * from or navigated further, the same as any other `selectMany`: the
   * projector already said what shape the result is.
   */
  selectMany<TInner, TResult>(
    inner: Queryable<TInner>,
    result: (outer: T, inner: TInner) => TResult,
  ): Queryable<TResult>;
  selectMany<TInner, TResult>(
    collection: (row: T) => readonly TInner[],
    result: (outer: T, inner: TInner) => TResult,
  ): Queryable<TResult>;
  selectMany<TTarget extends AnyEntity, TResult>(
    collection: (row: T) => readonly Related<TTarget>[],
    shape: LateralShape<NoInfer<TTarget>>,
    result: (outer: T, inner: EntityOf<TTarget>) => TResult,
  ): Queryable<TResult>;
  selectMany<TInner, TResult>(
    over: Queryable<TInner> | ((row: T) => readonly TInner[]),
    resultOrShape: LooseLambda,
    maybeResult?: LooseLambda,
  ): Queryable<TResult> {
    const projector = toExpression(maybeResult ?? resultOrShape, { rowParameterCount: 2 });

    if (over instanceof Queryable) {
      this.requireSameContext(over, 'selectMany');
      const merged = this.merge(over);

      return new Queryable<TResult>(
        this.runtime,
        {
          kind: 'selectMany',
          source: this.plan,
          over: { kind: 'query', plan: merged.plan },
          projector,
        },
        merged.bags,
        isScalarProjection(projector.body),
      );
    }

    const selector = toExpression(over, { rowParameterCount: 1 });

    if (maybeResult === undefined) {
      return new Queryable<TResult>(
        this.runtime,
        {
          kind: 'selectMany',
          source: this.plan,
          over: { kind: 'collection', selector },
          projector,
        },
        this.bags,
        isScalarProjection(projector.body),
      );
    }

    const target = collectionTarget(this.plan, selector);
    const table: QueryPlan = { kind: 'source', entity: target };
    const source: QueryPlan = target.filter
      ? { kind: 'where', source: table, predicate: target.filter }
      : table;
    const shaped = (resultOrShape as LateralShape<AnyEntity>)(
      new Queryable<EntityOf<AnyEntity>>(this.runtime, source, {}),
    );
    const merged = this.mergeInto(this.bags, shaped);

    return new Queryable<TResult>(
      this.runtime,
      {
        kind: 'selectMany',
        source: this.plan,
        over: { kind: 'collection', selector, shape: { plan: merged.plan } },
        projector,
      },
      merged.bags,
      isScalarProjection(projector.body),
    );
  }

  /** Shared by the two joins, which differ only in what an unmatched row does. */
  protected joinOn<TInner, TResult>(
    inner: Queryable<TInner>,
    outerKey: LooseLambda,
    innerKey: LooseLambda,
    result: LooseLambda,
    joinKind: JoinNode['joinKind'],
    name: string,
  ): Queryable<TResult> {
    this.requireSameContext(inner, name);

    const merged = this.merge(inner);
    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<TResult>(
      this.runtime,
      {
        kind: 'join',
        joinKind,
        source: this.plan,
        inner: merged.plan,
        outerKey: toExpression(outerKey, { rowParameterCount: 1 }),
        innerKey: toExpression(innerKey, { rowParameterCount: 1 }),
        projector,
      },
      merged.bags,
      isScalarProjection(projector.body),
    );
  }

  /**
   * Groups rows by a key and collapses each group into one row.
   *
   * This is LINQ's `GroupBy` overload that takes a result selector, which is
   * the one that maps onto SQL: the key selector becomes `GROUP BY` and the
   * result selector becomes the projection over it. Return an object from the
   * key selector to group by more than one expression, and reach the aggregates
   * through the group parameter:
   *
   * ```ts
   * db.users.groupBy(
   *   (u) => u.cityId,
   *   (city, users) => ({ city, headcount: users.count() }),
   * );
   * ```
   *
   * A filter applied after this becomes `HAVING`, since by then the rows it
   * would have filtered no longer exist.
   *
   * Called with only a key, this is the other `GroupBy` overload instead: no
   * aggregate is computed, and what comes back is one lazy grouping per
   * distinct key that the caller reads the rows themselves out of.
   *
   * ```ts
   * for await (const group of db.users.groupBy((u) => u.cityId)) {
   *   console.log(group.key, group.length);
   * }
   * ```
   *
   * The distinct keys are read with one statement; the rows behind each one
   * are read with a further statement per key, issued as the loop asks for
   * the next group rather than all at once, so a table too large to hold in
   * memory can still be grouped this way. Reach for the result selector
   * overload instead when only an aggregate over each group is needed: it
   * never reads a group's rows back at all.
   *
   * A key that is null groups together here, as it does in JavaScript and not
   * plainly in SQL, the same treatment `chunkBy` gives a key that repeats.
   */
  groupBy<TKey>(key: (row: T) => TKey): AsyncIterableIterator<Grouping<TKey, T>>;
  groupBy<TKey, TResult>(
    key: (row: T) => TKey,
    result: (key: TKey, group: Group<T>) => TResult,
  ): Queryable<TResult>;
  groupBy(
    key: LooseLambda,
    result?: LooseLambda,
  ): Queryable<unknown> | AsyncIterableIterator<unknown> {
    const keyExpression = toExpression(key, { rowParameterCount: 1 });

    if (result === undefined) {
      return this.groupings(keyExpression);
    }

    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<unknown>(
      this.runtime,
      { kind: 'groupBy', source: this.plan, key: keyExpression, projector },
      this.bags,
      isScalarGroupProjection(projector, keyExpression),
    );
  }

  /**
   * Walks the groups one statement at a time, after reading the distinct keys
   * with one.
   *
   * The key selector is applied through the ordinary `select`/`distinct` pair
   * rather than through anything new, which is what lets a composite key come
   * back shaped the same object it would from `groupBy` with a result
   * selector. Filtering each group back out of the source is then a `where`
   * built from expression IR rather than parsed from a lambda, for the reason
   * `countBy`'s own result selector is: no source text belongs to a lambda
   * built by the library itself.
   */
  private async *groupings<TKey>(
    keyExpression: LambdaExpression,
  ): AsyncIterableIterator<Grouping<TKey, T>> {
    const keys = await new Queryable<TKey>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: keyExpression },
      this.bags,
      isScalarProjection(keyExpression.body),
    )
      .distinct()
      .toArray();

    for (const key of keys) {
      const bagId = `p${Object.keys(this.bags).length}`;
      const predicate: LambdaExpression = {
        kind: 'lambda',
        parameters: keyExpression.parameters,
        body: matchesKey(keyExpression.body, bagId),
      };

      const rows = await new Queryable<T>(
        this.runtime,
        { kind: 'where', source: this.plan, predicate },
        { ...this.bags, [bagId]: key },
        this.scalar,
      ).toArray();

      yield Object.assign(rows, { key }) as Grouping<TKey, T>;
    }
  }

  /**
   * One row per distinct key, with how many rows carried it.
   *
   * ```ts
   * const perCity = await db.users.countBy((u) => u.cityId).toArray();
   * // [{ key: 1, count: 12 }, { key: 2, count: 5 }, ...]
   * ```
   *
   * This is LINQ's `CountBy`, and it is `groupBy` with the one result selector
   * that operator is most often given, so it needs no plan node of its own and
   * compiles to the same `GROUP BY` with a `COUNT(*)` beside it.
   *
   * Rows sharing a null key are counted together, as they are in `groupBy` and
   * in a JavaScript `Map`, and unlike a comparison against null in SQL.
   *
   * The key has to be a single expression, because `key` is one column of the
   * result and a composite key has no column to sit in. Reach for `groupBy`
   * with a result selector when the key is more than one expression: it names
   * each part itself, which is what makes room for them.
   */
  countBy<TKey>(key: (row: T) => TKey): Queryable<{ key: TKey; count: number }> {
    const keyExpression = toExpression(key, { rowParameterCount: 1 });

    // Checked here rather than left to the compiler, so the error names the
    // operator that was written instead of the `groupBy` behind it.
    if (keyExpression.body.kind === 'object') {
      throw new InvalidQueryError(
        '"countBy" puts the key in a single column, so it cannot take a composite key. ' +
          'Use "groupBy" with a result selector, which names each part of the key itself.',
      );
    }

    return new Queryable<{ key: TKey; count: number }>(
      this.runtime,
      { kind: 'groupBy', source: this.plan, key: keyExpression, projector: COUNT_BY },
      this.bags,
      false,
    );
  }

  /**
   * One row per distinct key, with those rows' values totalled.
   *
   * ```ts
   * const spentPerUser = await db.orders.sumBy(
   *   (o) => o.userId,
   *   (o) => o.total,
   * ).toArray();
   * // [{ key: 1, sum: '240.00' }, { key: 2, sum: '13.50' }, ...]
   * ```
   *
   * This is `countBy`'s aggregate sibling and is built the same way: `groupBy`
   * under a result selector, with no plan node, compiler method, or AST node of
   * its own. The two differ only in what sits beside the key, a `SUM` here
   * where `countBy` puts a `COUNT(*)`, so it takes the second lambda `countBy`
   * has no use for: the value to total.
   *
   * `aggregateBy` answers the same question and answers it somewhere else. It
   * reads every row and folds them in JavaScript, which is what lets it take a
   * fold no SQL can express; this stays one `GROUP BY` and brings back one row
   * per key. Reach for that one when the fold is the point, and this one when
   * the rows are.
   *
   * What comes back is what `SUM` means rather than what LINQ's `Sum` means,
   * which is the same trade `groupBy` with a hand-written `g.sum(...)` already
   * makes and the reason this does not quietly improve on it. A group whose
   * values are every one of them null totals to null here, where LINQ skips the
   * nulls and answers zero; the standalone `sum` terminal does wrap its
   * aggregate in a `COALESCE`, but that is there for the empty sequence, and a
   * group is never empty. Widening the sugar past the thing it wraps would make
   * the two spellings mean different things.
   *
   * The type of the total follows the value selected, so a `decimal` column
   * stays a string as it does everywhere else here, and a nullable column
   * carries its null through to the total, which is the only way that last
   * paragraph describes something a caller can actually write.
   *
   * The key has to be a single expression, for `countBy`'s own reason: `key` is
   * one column of the result and a composite key has no column to sit in.
   *
   * Not to be confused with `minBy` and `maxBy`, which are LINQ's and answer
   * with one whole row rather than one row per key. The `By` in those names
   * says what the row was chosen by; the `By` here, as in `countBy` and
   * `aggregateBy`, says what the rows were grouped by.
   */
  sumBy<TKey, TValue extends number | string | null>(
    key: (row: T) => TKey,
    value: (row: T) => TValue,
  ): Queryable<{ key: TKey; sum: TValue }> {
    const keyExpression = toExpression(key, { rowParameterCount: 1 });

    // Checked here rather than left to the compiler, so the error names the
    // operator that was written instead of the `groupBy` behind it.
    if (keyExpression.body.kind === 'object') {
      throw new InvalidQueryError(
        '"sumBy" puts the key in a single column, so it cannot take a composite key. ' +
          'Use "groupBy" with a result selector, which names each part of the key itself.',
      );
    }

    return new Queryable<{ key: TKey; sum: TValue }>(
      this.runtime,
      {
        kind: 'groupBy',
        source: this.plan,
        key: keyExpression,
        projector: sumBySelector(toExpression(value, { rowParameterCount: 1 })),
      },
      this.bags,
      false,
    );
  }

  orderBy(key: (row: T) => unknown): OrderedQueryable<T> {
    return this.orderByKey(key, false);
  }

  orderByDescending(key: (row: T) => unknown): OrderedQueryable<T> {
    return this.orderByKey(key, true);
  }

  /**
   * Sorts a sequence of scalars by themselves, rather than by a key selector.
   *
   * ```ts
   * const ages = await db.users.select((u) => u.age).order().toArray();
   * ```
   *
   * This is LINQ's `Order`, and it only ever makes sense over a query that
   * already projects one value: `orderBy` needs a key to sort by, and a
   * scalar is already its own. A query that still projects a row is refused
   * rather than guessed at, since there is no single value there to sort by.
   *
   * The key is not a lambda parsed from source, for the reason `countBy`'s own
   * result selector is not: it names the column the projection already
   * settled on, under the alias every scalar projection carries, rather than
   * asking a caller to write `(x) => x`, which a parameter taken and handed
   * straight back would only restate.
   */
  order(): OrderedQueryable<T> {
    return this.orderByValue(false);
  }

  /** `order`, sorted the other way. */
  orderDescending(): OrderedQueryable<T> {
    return this.orderByValue(true);
  }

  /** Shared by `order` and `orderDescending`, which differ only in direction. */
  private orderByValue(descending: boolean): OrderedQueryable<T> {
    this.requireScalar('order', 'Use "orderBy" with a key selector instead.');

    const keys: OrderKey[] = [{ key: overScalar(SCALAR_VALUE), descending }];

    return new OrderedQueryable<T>(
      this.runtime,
      { kind: 'orderBy', source: this.plan, keys },
      this.bags,
      this.scalar,
      this.plan,
      keys,
    );
  }

  skip(count: number): Queryable<T> {
    return this.derive({ kind: 'skip', source: this.plan, count });
  }

  take(count: number): Queryable<T> {
    return this.derive({ kind: 'take', source: this.plan, count });
  }

  /**
   * The same query, guaranteed to yield at least one row.
   *
   * ```ts
   * const [totals] = await db.orders
   *   .where((o) => o.userId === 7, {})
   *   .select((o) => ({ total: o.total }))
   *   .defaultIfEmpty()
   *   .toArray();
   * ```
   *
   * A query that matched nothing answers with one row whose every column is
   * null, which is LINQ's `DefaultIfEmpty` and what `default(T)` means for a
   * row here. A query that matched anything is unchanged.
   *
   * The columns widen to `NullableRow<T>` for the reason `leftJoin`'s inner
   * side does: the default row is not a `T`, and saying so in the type is what
   * stops a caller reading `row.total.toFixed(2)` off a row that has no total.
   * A row of nulls cannot be told apart from a real row whose columns happened
   * to be null, so this says nothing about which of the two arrived; ask
   * `any()` when that distinction matters.
   *
   * It compiles to a left join against a source of one row, so the query is
   * read once. Filtering after it can undo it, exactly as filtering after a
   * `leftJoin` does: a null fails every comparison, so the default row is
   * dropped by the very predicate meant to inspect it. Filter before.
   */
  defaultIfEmpty(): Queryable<NullableRow<T>>;
  /**
   * The same query, guaranteed to yield at least one row of its own shape.
   *
   * ```ts
   * const [totals] = await db.orders
   *   .where((o) => o.userId === 7, {})
   *   .select((o) => ({ total: o.total }))
   *   .defaultIfEmpty({ total: 0 })
   *   .toArray();
   * ```
   *
   * This is the other overload of LINQ's `DefaultIfEmpty`, the one that takes
   * a default value rather than relying on `default(T)`. Supplying a row of
   * its own is what keeps the result a `T`: nothing is nullable, since every
   * column that could have been missing now has a value the caller chose.
   *
   * The row travels as ordinary bound values, one per column, exactly as
   * `append`'s does, and for the same reason: nothing here is evaluated
   * beyond building the literal, so a default computed at call time is fixed
   * once and not re-evaluated per query.
   *
   * A query that matched nothing still cannot be told apart from a real row
   * that happened to equal the default, the same ambiguity the no-argument
   * form leaves standing; ask `any()` when that distinction matters.
   */
  defaultIfEmpty(defaultValue: T): Queryable<T>;
  defaultIfEmpty(defaultValue?: T): Queryable<NullableRow<T>> {
    const defaultRow =
      defaultValue === undefined ? null : Queryable.literalRowExpression(defaultValue, this.scalar);

    return new Queryable<NullableRow<T>>(
      this.runtime,
      { kind: 'defaultIfEmpty', source: this.plan, defaultRow },
      this.bags,
      this.scalar,
    );
  }

  distinct(): Queryable<T> {
    return this.derive({ kind: 'distinct', source: this.plan });
  }

  /**
   * Every row of this query and of another, with duplicates removed.
   *
   * This is LINQ's `Union`, and compiles to SQL's. Both sides must project the
   * same columns; they are paired by name rather than by position, so two
   * queries that shaped the same row type in a different order still line up.
   *
   * Removing duplicates costs a sort or a hash over both sides. Reach for
   * `concat` when the sides cannot overlap, or when duplicates are wanted.
   */
  union(other: Queryable<T>): Queryable<T> {
    return this.combine(other, 'union', false, 'union');
  }

  /**
   * The rows this query and another have in common, with duplicates removed.
   *
   * This is LINQ's `Intersect` and SQL's `INTERSECT`. Rows are compared whole,
   * every projected column at once, which is what makes it a set operation
   * rather than a join on a key.
   */
  intersect(other: Queryable<T>): Queryable<T> {
    return this.combine(other, 'intersect', false, 'intersect');
  }

  /**
   * The rows of this query that another does not also have.
   *
   * This is LINQ's `Except` and SQL's `EXCEPT`, and unlike the other three it
   * is not symmetric: `a.except(b)` and `b.except(a)` are different questions.
   */
  except(other: Queryable<T>): Queryable<T> {
    return this.combine(other, 'except', false, 'except');
  }

  /**
   * The rows whose key does not appear in another query.
   *
   * ```ts
   * db.users.exceptBy(db.suppressions, (u) => u.email, (s) => s.address);
   * ```
   *
   * That is every user who has not asked to be left alone. `except` could not
   * ask it: that one compares whole rows, so it only subtracts a query of the
   * same shape, and a suppression list is not a user. Comparing a key alone is
   * what lets the two sides be different entities, which is the usual case.
   *
   * Both keys are given rather than one, as in `join`, and for the same reason:
   * the other side is a query rather than a sequence of bare keys, so how to
   * read a key off it is its own question. Both selectors produce a `TKey`, so
   * a mismatched pair is a compile error rather than a query that quietly
   * returns everything. .NET spells this with one selector over a sequence of
   * keys; the shape here follows `join`, which this library had already
   * settled, and spares the caller a projection.
   *
   * Nothing about it is positional, so unlike `distinctBy` it needs no
   * ordering: whether a key appears somewhere is a question about a set. It
   * compiles to `NOT EXISTS` over a correlated subquery, so a duplicate on the
   * other side costs nothing and no row is ever multiplied.
   *
   * `intersectBy` is the complement, keeping the rows this one drops.
   *
   * A key that is null matches a key that is null, as it does in LINQ and in
   * SQL's own `EXCEPT`, so a row whose key is missing is dropped when the other
   * query has a row whose key is missing too. Return an object from either
   * selector to make the key more than one expression; the parts are then
   * paired by name, and a row is dropped only when all of them match.
   */
  exceptBy<TOther, TKey>(
    other: Queryable<TOther>,
    key: (row: T) => TKey,
    otherKey: (row: TOther) => TKey,
  ): Queryable<T> {
    return this.matchBy(other, key, otherKey, 'except', 'exceptBy');
  }

  /**
   * The rows of this query whose key appears in another.
   *
   * ```ts
   * db.users.intersectBy(db.subscribers, (u) => u.email, (s) => s.address);
   * ```
   *
   * That is every user who is also a subscriber, still shaped as a user. This
   * is LINQ's `IntersectBy`, and the complement of `exceptBy`: between them
   * they partition this query by whether the key was found, so the two return
   * every row exactly once.
   *
   * `intersect` could not ask it. That one compares whole rows, so it only
   * meets a query of the same shape, and a subscriber is not a user. Comparing
   * a key alone is what lets the two sides be different entities.
   *
   * It compiles to `EXISTS` over a correlated subquery, which is `exceptBy`'s
   * `NOT EXISTS` without the negation. Two consequences follow, and both are
   * the reason to reach for this over a `join` that projects the outer row
   * back: a duplicate on the other side costs nothing, and no row is ever
   * multiplied.
   *
   * A key that is null matches a key that is null, as it does in LINQ and in
   * SQL's own `INTERSECT`, so a row whose key is missing is kept when the other
   * query has a row whose key is missing too. Return an object from either
   * selector to make the key more than one expression; the parts are then
   * paired by name, and a row is kept only when all of them match.
   */
  intersectBy<TOther, TKey>(
    other: Queryable<TOther>,
    key: (row: T) => TKey,
    otherKey: (row: TOther) => TKey,
  ): Queryable<T> {
    return this.matchBy(other, key, otherKey, 'intersect', 'intersectBy');
  }

  /** Shared by the two, which differ only in which side of the match they keep. */
  private matchBy<TOther, TKey>(
    other: Queryable<TOther>,
    key: (row: T) => TKey,
    otherKey: (row: TOther) => TKey,
    operator: 'intersect' | 'except',
    name: string,
  ): Queryable<T> {
    this.requireSameContext(other, name);

    const merged = this.merge(other);

    return new Queryable<T>(
      this.runtime,
      {
        kind: 'setOperationBy',
        source: this.plan,
        other: merged.plan,
        key: toExpression(key, { rowParameterCount: 1 }),
        otherKey: toExpression(otherKey, { rowParameterCount: 1 }),
        operator,
      },
      merged.bags,
      this.scalar,
    );
  }

  /**
   * Every row of this query and of another, duplicates kept.
   *
   * This is LINQ's `Concat` and SQL's `UNION ALL`. It is the cheaper of the
   * two, since nothing has to be compared to decide what to drop.
   */
  concat(other: Queryable<T>): Queryable<T> {
    return this.combine(other, 'union', true, 'concat');
  }

  /**
   * The rows of this query, with one more added.
   *
   * ```ts
   * db.users.where((u) => u.isActive).append({ id: 0, name: 'Guest', ... });
   * ```
   *
   * This is LINQ's `Append`. The row is written as a `SELECT` with no table of
   * its own and joined on with `UNION ALL`, which is `concat`'s own operator:
   * the two answer the same question about where the row lands that `concat`
   * already does not, since a SQL result carries no position until an
   * `orderBy` gives it one. Reach for `orderBy` afterward when the row
   * genuinely has to come last.
   *
   * Nothing here is evaluated in this process beyond building the literal: the
   * row travels as ordinary bound values, one per column, the same way any
   * other literal written in a query does.
   */
  append(row: T): Queryable<T> {
    return this.combine(this.literalRow(row), 'union', true, 'append');
  }

  /**
   * The rows of this query, with one more added ahead of them.
   *
   * ```ts
   * db.users.where((u) => u.isActive).prepend({ id: 0, name: 'Guest', ... });
   * ```
   *
   * This is LINQ's `Prepend`, and `append` written the other way round: the
   * same literal `SELECT` and the same `UNION ALL`, with the two sides of it
   * swapped. That answers no question about position `append` does not
   * already leave open either — a SQL result carries none until an `orderBy`
   * gives it one — so the difference is only which branch of the `UNION ALL`
   * a reader sees the row written in.
   */
  prepend(row: T): Queryable<T> {
    return this.literalRow(row).combine(this, 'union', true, 'prepend');
  }

  /** A table-less `SELECT` for the single literal row `append` and `prepend` join on. */
  private literalRow(row: T): Queryable<T> {
    const literal = Queryable.literalRowExpression(row, this.scalar);
    return new Queryable<T>(this.runtime, { kind: 'literalRow', row: literal }, {}, this.scalar);
  }

  /**
   * A caller-supplied row as expression IR, an object literal per property or
   * a bare expression for a scalar projection, the distinction `select`'s own
   * projector makes. Shared by `literalRow`, behind `append` and `prepend`,
   * and by `defaultIfEmpty`'s own-default overload, since both need nothing
   * more than a value handed to them turned into the shape a `LiteralRowNode`
   * or a `DefaultIfEmptyNode` carries.
   */
  private static literalRowExpression<TRow>(row: TRow, scalar: boolean): ExpressionNode {
    return scalar
      ? constant(row)
      : object(
          Object.entries(row as Record<string, unknown>).map(([name, value]) => ({
            name,
            value: constant(value),
          })),
        );
  }

  /**
   * Takes at most `count` rows, chosen at random.
   *
   * The rows come back in no particular order, and a different set each time
   * the query runs. Order the sample by chaining `orderBy` after this rather
   * than before it, since an ordering applied before a sample cannot survive
   * one.
   *
   * The database picks the rows, so nothing is over-fetched, but it does so by
   * sorting every candidate row on a random value. That is fine for a sample of
   * a filtered set and expensive across a large table; narrow the query first
   * when the table is big.
   */
  sample(count: number): Queryable<T> {
    return this.derive({ kind: 'sample', source: this.plan, count });
  }

  /**
   * Gives the rows this query selects new values, and hands them back.
   *
   * ```ts
   * const promoted = await db.users
   *   .where((u) => u.age >= 18 && !u.isActive)
   *   .update({ isActive: true });
   * ```
   *
   * This lives on a query rather than on the entity set, which is the whole
   * difference between it and `insert`: an insert makes rows and needs a place
   * to put them, while an update needs to say which rows it means, and a query
   * is how this library says that. The filter is compiled by the same machinery
   * that compiles it for a read, so anything writable in a `where` is writable
   * here.
   *
   * Only a filter, though. A query that has grown a join, a projection, a
   * grouping, an ordering, or a page is no longer a set of rows in one table,
   * and each of those is refused by the name of the clause that caused it.
   *
   * A query with no filter at all updates every row. That is a thing SQL can do
   * and a thing this will do, so `db.users.update({ isActive: false })` is not
   * a mistake the library catches; it is a sentence that means what it says.
   *
   * What comes back is read from the statement rather than assembled from the
   * argument, as an insert's is, which is what makes a trigger and a computed
   * column visible. The rows come back in whatever order the database wrote
   * them.
   *
   * A lambda sets a column relative to its own current value, rather than to
   * a value already known before the statement runs:
   *
   * ```ts
   * const leveled = await db.users.where((u) => u.isActive).update((u) => ({ score: u.score + 1 }));
   * ```
   *
   * Its object literal reads the same way `select`'s does, but names only
   * columns to overwrite rather than reshaping the row, and it reads no
   * further than the row itself: a navigation such as `u.city.name` is
   * refused, since there is no join for a plain `UPDATE ... SET` to hold one
   * against.
   */
  update(values: Partial<T>): Promise<T[]>;
  update(projector: (row: T) => Partial<T>): Promise<T[]>;
  update<TParams extends object>(
    projector: (row: T, params: TParams) => Partial<T>,
    params: TParams,
  ): Promise<T[]>;
  async update(valuesOrProjector: Partial<T> | LooseLambda, params?: object): Promise<T[]> {
    let assignments: UpdateAssignments;
    let bags = this.bags;

    if (typeof valuesOrProjector === 'function') {
      const bound = this.bind(valuesOrProjector, params);
      assignments = { kind: 'expression', projector: bound.expression };
      bags = bound.bags;
    } else {
      assignments = {
        kind: 'values',
        values: valuesOrProjector as Readonly<Record<string, unknown>>,
      };
    }

    const statement = printUpdate(
      compileUpdate(this.plan, assignments, this.compileOptions()),
      this.runtime.dialect,
    );

    const rows = await this.runStatement({
      text: statement.text,
      values: bindParameters(statement.parameters, bags),
    });

    return rows as T[];
  }

  /**
   * Removes the rows this query selects, and hands back what was removed.
   *
   * ```ts
   * const closed = await db.orders.where((o) => o.status === 'cancelled').delete();
   * ```
   *
   * This lives on a query for the reason `update` does: a delete has to say
   * which rows it means, and a query is how this library says that. The filter
   * is compiled by the same machinery that compiles it for a read, so anything
   * writable in a `where` is writable here, and the same clauses are refused by
   * the same names. A query that has grown a join, a projection, a grouping, an
   * ordering, or a page is no longer a set of rows in one table, and neither
   * write can be built from it.
   *
   * It is the write with nothing to set, which is what makes it the shortest
   * operator here and the one worth the most care. `update` refuses an empty
   * set of values because an update with nothing to say is unfinished; a delete
   * has nothing to say by nature, so there is no argument at all, and the query
   * in front of it is the entire safeguard.
   *
   * A query with no filter empties the table:
   *
   * ```ts
   * await db.sessions.delete(); // every row
   * ```
   *
   * That is a thing SQL can do and a thing this will do, so `db.users.delete()`
   * is not a mistake the library catches; it is a sentence that means what it
   * says, and a missing `where` is the only thing between the two readings.
   *
   * The removed rows are read back, which is worth more here than for the other
   * writes: once the statement has run there is nowhere else left to read them
   * from. Undoing one still needs a transaction, since what comes back can be
   * inspected but not put back. A filter that selected nothing removes nothing
   * and answers an empty array rather than faulting. A row another table
   * references is the database's to refuse, and its foreign key error arrives
   * untouched rather than being anticipated here.
   */
  async delete(): Promise<T[]> {
    const statement = printDelete(
      compileDelete(this.plan, this.compileOptions()),
      this.runtime.dialect,
    );

    const rows = await this.runStatement({
      text: statement.text,
      values: bindParameters(statement.parameters, this.bags),
    });

    return rows as T[];
  }

  /**
   * Carries a comment into the generated SQL, so a statement found in the
   * database's log can be traced back to the code that wrote it.
   *
   * ```ts
   * const rows = await db.users.where((u) => u.isActive).tag('nightly digest').toArray();
   * // The statement reaches the log with "nightly digest" in a leading comment.
   * ```
   *
   * The comment is the only thing this adds. Nothing about which rows are read
   * changes, which is why it can be written anywhere in a chain and why a write
   * accepts it where every other clause is refused: `update` and `delete` carry
   * their tags too, and a slow write is exactly the statement worth finding
   * again. Tag more than once and every tag is printed, keeping the order they were
   * written down the chain.
   *
   * The text reaches the statement as text, which nothing else a caller writes
   * does, so it is checked here rather than trusted. A tag holding a comment
   * delimiter is refused: `*` followed by `/` would close the comment and leave
   * the rest to be read as SQL, and PostgreSQL nests block comments, so the
   * opening pair is no safer. Describe the query rather than interpolating a
   * value into it, and there is nothing to escape.
   *
   * Where the tag lands is the statement rather than the clause. A query that is
   * later wrapped in a derived table, by a page or by `count`, still prints its
   * comment at the top rather than from inside the subquery, and a tag written
   * on one side of a `union` reaches the statement both sides compile into.
   *
   * One statement carries it. `include` reads its navigation with a second
   * statement, built from a plan of the library's own, and that one is untagged.
   */
  tag(text: string): Queryable<T> {
    return this.derive({ kind: 'tag', source: this.plan, text: checkedTag(text) });
  }

  /**
   * Renders the statement without running it.
   *
   * Useful in tests and when comparing generated SQL against another ORM, which
   * is why it is part of the public surface rather than an internal helper.
   */
  toSQL(): PreparedStatement {
    return this.prepare(compileQuery(this.plan, this.compileOptions()).select);
  }

  /**
   * Brings a navigation back with each row, in a statement of its own.
   *
   * ```ts
   * const withOrders = await db.users
   *   .where((u) => u.isActive)
   *   .include((u) => u.orders)
   *   .toArray();
   *
   * const withUser = await db.orders.include((o) => o.user).toArray();
   * ```
   *
   * Either end of a foreign key can be named. A `collection` reads as an array
   * of the rows pointing at this one, and a `reference` as the single row this
   * one points at, or null when the key is null or nothing is there.
   *
   * The row type already claims the property, because declaring the relation in
   * the metadata puts it there; what this does is make the claim true. A query
   * without it hands back rows whose navigation property is simply absent.
   *
   * Two statements are issued rather than one. The rows are read first, their
   * keys collected, and the related rows read with a single `IN` over those
   * keys, then handed to the rows they belong to. For a collection a
   * `LEFT JOIN` would have returned one row per child with the parent's columns
   * repeated across them, which is the cost `EXISTS` avoids for `some` and a
   * join cannot avoid here. A reference multiplies nothing, so the choice there
   * is between a second statement and a join that widens every row: this reads
   * the related table once however many rows share a key, where a join reads
   * and returns its columns per row. Where a projection is enough, prefer
   * `select((o) => ({ id: o.id, who: o.user.name }))`, which reads the columns
   * through the navigation in one round trip.
   *
   * This comes last, before a terminal: what it returns offers the operators
   * that read rows and not the ones that reshape them. A projection would leave
   * nothing for the related rows to attach to.
   *
   * The two statements are read at different moments, so a row written between
   * them is seen and one deleted is not; read inside a transaction when that
   * matters, as `chunk` asks. The children of a collection arrive in whatever
   * order the database returns them.
   */
  include<TTarget extends AnyEntity>(
    selector: (row: T) => readonly Related<TTarget>[] | Related<TTarget>,
    shape?: CollectionShape<NoInfer<TTarget>>,
  ): IncludedQueryable<T, TTarget>;
  include(selector: (row: T) => never, shape?: Shaper): IncludedQueryable<T, AnyEntity> {
    return new IncludedQueryable<T, AnyEntity>(this.runtime, this, [
      [rootInclusion(this.runtime, this.plan, selector, shape)],
    ]);
  }

  /** The plan, so `IncludedQueryable` can name the entity the rows came from. */
  get includePlan(): QueryPlan {
    return this.plan;
  }

  /**
   * The parameter bags, so an `include` can add its key list beside whatever a
   * filtered collection already bound.
   *
   * Beside `includePlan` for the same reason: an `IncludedQueryable` is not a
   * subclass of this and still has to build a statement out of one of these.
   */
  get includeBags(): ParameterBags {
    return this.bags;
  }

  async toArray(): Promise<T[]> {
    const { select, nested } = compileQuery(this.plan, this.compileOptions());
    const rows = await this.run(select);
    return this.materialize(rows, nested);
  }

  /**
   * Reads the query into a `Map`, keyed by a selector rather than by position.
   *
   * ```ts
   * const byId = await db.users.toDictionary((u) => u.id);
   * byId.get(7);
   * ```
   *
   * This is LINQ's `ToDictionary`, and it is `toArray` with one step added
   * rather than a clause of its own: the selector runs over rows already in
   * memory, so it is an ordinary JavaScript function rather than a lambda this
   * library parses into SQL, and nothing here touches a plan node, a compiler
   * method, or the AST, for the reason `toArray` needs none of them either.
   *
   * A key that names more than one row is a `SequenceError`, since the
   * selector is claiming exactly one row per key, the same claim `single`
   * makes about a whole query. Checking for it here is cheaper than a caller
   * finding out later from whichever row a plain `Map` build happened to
   * overwrite the rest with.
   */
  async toDictionary<TKey>(key: (row: T) => TKey): Promise<Map<TKey, T>> {
    const rows = await this.toArray();
    const map = new Map<TKey, T>();

    for (const row of rows) {
      const mapKey = key(row);
      if (map.has(mapKey)) {
        throw new SequenceError(
          '"toDictionary" found more than one row for one key, but the selector must name at ' +
            'most one row per key.',
        );
      }
      map.set(mapKey, row);
    }

    return map;
  }

  /**
   * Reads the query into a `Map` of arrays, keyed by a selector that need not
   * be unique.
   *
   * ```ts
   * const byCity = await db.users.toLookup((u) => u.cityId);
   * byCity.get(3); // every user in city 3, in the order toArray returned them
   * ```
   *
   * This is LINQ's `ToLookup`, and it is `toDictionary` with the one
   * restriction that lifts: more than one row can share a key, so a key holds
   * the rows that shared it, in the order `toArray` already read them in,
   * rather than the single row `toDictionary` demands. Nothing here reaches
   * SQL either, for `toDictionary`'s own reason: the selector runs over rows
   * already in memory.
   *
   * A key no row carried is simply absent from the `Map`, which is a `Map`'s
   * own contract rather than LINQ's: `Lookup` answers an empty sequence for a
   * key it has never seen, where `get` here answers `undefined`. Check with
   * `has`, or fall back with `?? []`, when that difference matters.
   */
  async toLookup<TKey>(key: (row: T) => TKey): Promise<Map<TKey, T[]>> {
    const rows = await this.toArray();
    const map = new Map<TKey, T[]>();

    for (const row of rows) {
      const mapKey = key(row);
      const group = map.get(mapKey);
      if (group) {
        group.push(row);
      } else {
        map.set(mapKey, [row]);
      }
    }

    return map;
  }

  /**
   * Reads the query into a `Set`, discarding any duplicate.
   *
   * ```ts
   * const cities = await db.users.select((u) => u.cityId).toHashSet();
   * ```
   *
   * This is LINQ's `ToHashSet`, and it needs nothing `toArray` does not
   * already give it: a `Set` built from the materialised rows is what a
   * caller would otherwise build by hand, so there is no plan node, compiler
   * method, or AST here, for `toDictionary`'s own reason.
   *
   * A `Set` compares by JavaScript's own equality, which is reference
   * equality for anything that is not a primitive: two rows with the same
   * columns are still two elements unless they are the same object, where
   * `distinctBy` and SQL's own `DISTINCT` compare the columns themselves.
   * This is therefore most useful over a scalar projection, whose values are
   * exactly what a `Set` knows how to tell apart.
   */
  async toHashSet(): Promise<Set<T>> {
    return new Set(await this.toArray());
  }

  /**
   * Folds the query into one value, seeded and accumulated in JavaScript over
   * the materialised rows.
   *
   * ```ts
   * const total = await db.orders.aggregate(0, (sum, order) => sum + order.total);
   * ```
   *
   * This is LINQ's `Aggregate`, in the overload that takes a seed. The
   * accumulator runs over rows already read back, the way `toDictionary`'s
   * selector does, so there is no plan node, compiler method, or AST here
   * either, and nothing about the fold is translated into SQL.
   *
   * Reach for `sum`, `average`, `min`, `max`, or a `groupBy` result selector
   * first when one of them already answers the question: those compile to one
   * aggregate the database computes, where this reads every row back and
   * folds them here instead.
   */
  async aggregate<TAccumulate>(
    seed: TAccumulate,
    accumulator: (accumulated: TAccumulate, row: T) => TAccumulate,
  ): Promise<TAccumulate> {
    const rows = await this.toArray();
    return rows.reduce(accumulator, seed);
  }

  /**
   * `aggregate`, run once per key rather than once for the whole query.
   *
   * ```ts
   * const spent = await db.orders.aggregateBy(
   *   (o) => o.userId,
   *   0,
   *   (total, order) => total + order.total,
   * );
   * spent.get(7); // that user's orders, folded together
   * ```
   *
   * This is .NET's `AggregateBy`, and it is `aggregate` widened the way
   * `toLookup` widens `toDictionary`: the accumulator still runs in
   * JavaScript over rows already read back, so there is no plan node,
   * compiler method, or AST here either, and grouping the rows first is one
   * pass over what `toArray` returned rather than a second read of the query.
   * Every key starts from the same `seed`, folded in the order `toArray`
   * already put its rows in.
   *
   * Reach for `groupBy` first when its result selector already answers the
   * question: `count`, `sum`, `average`, `min`, and `max` compile to one
   * aggregate per group the database computes, where this reads every row
   * back and folds them here instead, the same trade `aggregate` makes.
   */
  async aggregateBy<TKey, TAccumulate>(
    key: (row: T) => TKey,
    seed: TAccumulate,
    accumulator: (accumulated: TAccumulate, row: T) => TAccumulate,
  ): Promise<Map<TKey, TAccumulate>> {
    const rows = await this.toArray();
    const map = new Map<TKey, TAccumulate>();

    for (const row of rows) {
      const mapKey = key(row);
      const current = map.has(mapKey) ? map.get(mapKey)! : seed;
      map.set(mapKey, accumulator(current, row));
    }

    return map;
  }

  /**
   * Reads the query in batches of `size`, one round trip per batch.
   *
   * Where `toArray` builds the whole result in memory, this holds one batch at
   * a time, which is what makes a table too large to materialise still
   * processable:
   *
   * ```ts
   * for await (const batch of db.users.orderBy((u) => u.id).chunk(500)) {
   *   await send(batch);
   * }
   * ```
   *
   * Each batch is its own statement, paged with `LIMIT` and `OFFSET`, and the
   * two things that follow from that are worth knowing. Order the query, or the
   * pages are cut from a sequence the database is free to reorder between
   * statements, which can repeat a row in one batch and skip it in another. And
   * because the batches are read over time rather than from one snapshot, rows
   * written while the loop runs can shift the ones behind them; read inside a
   * transaction when that matters.
   */
  chunk(size: number): AsyncIterableIterator<T[]> {
    if (!Number.isInteger(size) || size < 1) {
      throw new InvalidQueryError(
        `"chunk" expects a positive integer batch size but received ${size}.`,
      );
    }
    // Validated here rather than inside the generator, whose body would not run
    // until the first batch was asked for, long after the mistake was made.
    return this.batches(size);
  }

  /**
   * How many rows the query has, counted by the database.
   *
   * ```ts
   * const users = await db.users.count();
   * const active = await db.users.count((u) => u.isActive);
   * ```
   *
   * A predicate counts only the rows matching it, which is LINQ's own
   * `Count(predicate)` and is exactly what `where(predicate).count()` already
   * compiled to: one `WHERE`, inside the same wrapping `SELECT COUNT(*)`. So
   * this adds a way to say it rather than a statement to generate, and it says
   * it in one thought where the pair says it in two.
   *
   * The filter is built here rather than by calling `where`, for the reason
   * `all` builds its own: an operator that takes a predicate of its own should
   * mean the same thing on an ordered query as on any other, and `where` on an
   * ordered one reads a second parameter as the row's position.
   */
  count(): Promise<number>;
  count(predicate: (row: T) => boolean): Promise<number>;
  count<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Promise<number>;
  async count(predicate?: LooseLambda, params?: object): Promise<number> {
    if (predicate !== undefined) {
      const bound = this.bind(predicate, params);
      const matching = new Queryable<T>(
        this.runtime,
        { kind: 'where', source: this.plan, predicate: bound.expression },
        bound.bags,
        this.scalar,
      );

      return matching.count();
    }

    const rows = await this.run(compileCount(this.plan, this.compileOptions()));
    // Several drivers return an exact-numeric COUNT as a string to avoid losing
    // precision, so the value is normalised here rather than in each provider.
    return Number(rows[0]?.['count'] ?? 0);
  }

  /**
   * `count`, read back as a `bigint` rather than a `number`.
   *
   * LINQ has both `Count`, which returns `int`, and `LongCount`, which returns
   * `long`, for a table too large for the first to hold; the statement neither
   * changes with, since `COUNT(*)` is already exact and it is only the type
   * the answer is read into that differs. So this is `count`'s own statement,
   * read back with `BigInt` in place of `Number` and nothing else new: no plan
   * node, no compiler method, no AST.
   */
  async longCount(): Promise<bigint> {
    const rows = await this.run(compileCount(this.plan, this.compileOptions()));
    const count = rows[0]?.['count'] as string | number | bigint | undefined;
    return BigInt(count ?? 0);
  }

  /**
   * Runs a statement that compiles to one boolean column named "value", such
   * as `sequenceEqual`'s, against a bag other than this query's own.
   *
   * `sequenceEqual` compiles a plan built from two merged queries, whose bags
   * belong to that merge rather than to either side alone, so `run` cannot be
   * reused as it stands: it always reads `this.bags`.
   */
  protected async booleanResult(select: SqlSelect, bags: ParameterBags): Promise<boolean> {
    const { text, parameters } = printSelect(select, this.runtime.dialect);
    const rows = await this.runStatement({ text, values: bindParameters(parameters, bags) });
    return Boolean(rows[0]?.['value']);
  }

  /**
   * How many different values a selector takes over the query.
   *
   * ```ts
   * const cities = await db.users.countDistinct((u) => u.cityId);
   * ```
   *
   * This is LINQ's `Select(f).Distinct().Count()`, and it needs no plan node
   * for the reason `sum` needs none: the selector is projected first and the
   * count taken over what it produced, so a navigation in the selector works
   * and `take(10).countDistinct(...)` counts within those ten rows.
   *
   * Null counts as a value, once, however many rows carry it. SQL's
   * `COUNT(DISTINCT ...)` skips nulls and LINQ does not, so the difference is
   * closed in the generated SQL rather than left in the caller's head, which is
   * the same reading `distinctBy` and `exceptBy` already take of a null key. A
   * column of ten rows holding three cities and some nulls therefore answers
   * four.
   *
   * There is no argument-less form. `count()` already answers how many rows
   * there are, and `COUNT(DISTINCT *)` is not something SQL can be asked.
   */
  countDistinct(value: (row: T) => unknown): Promise<number>;
  countDistinct<TParams extends object>(
    value: (row: T, params: TParams) => unknown,
    params: TParams,
  ): Promise<number>;
  async countDistinct(value: LooseLambda, params?: object): Promise<number> {
    const bound = this.bind(value, params);

    if (!isScalarProjection(bound.expression.body)) {
      throw new InvalidQueryError(
        '"countDistinct" expects a selector choosing one value to count, ' +
          'such as (u) => u.cityId.',
      );
    }

    const projected = new Queryable<unknown>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: bound.expression },
      bound.bags,
      true,
    );

    return projected.distinctCountOfProjection();
  }

  /** Runs the aggregate for `countDistinct` over a query already projecting it. */
  protected async distinctCountOfProjection(): Promise<number> {
    const rows = await this.run(compileCountDistinct(this.plan, this.compileOptions()));
    // Normalised for the reason `count` is: several drivers hand back an exact
    // numeric as a string.
    return Number(rows[0]?.['countDistinct'] ?? 0);
  }

  async any(): Promise<boolean> {
    return (await this.take(1).count()) > 0;
  }

  /**
   * Whether a sequence of scalars holds a given value.
   *
   * ```ts
   * const known = await db.users.select((u) => u.email).contains('ada@example.com');
   * ```
   *
   * This is LINQ's `Contains`, and like `order` it means something only over a
   * query that already projects one value. A row has no single value to
   * compare against, and comparing every column would need a value for each
   * navigation too, which is `append`'s own limit; so a query that still
   * projects a row is refused and pointed at `where` with `any`, which asks
   * the same question about whatever the caller can name.
   *
   * Null is a value here, as it is for `distinctBy`, `chunkBy`, and
   * `countDistinct`: `contains(null)` finds the rows a plain `= NULL` would
   * have left unknown, which is what LINQ answers and what the rest of the
   * library had already settled.
   *
   * The value travels in a parameter bag rather than in the statement, and the
   * question is `any`'s, so one statement is issued and it stops at the first
   * row that matches.
   */
  async contains(value: T): Promise<boolean> {
    this.requireScalar('contains', 'Filter with "where" and ask "any" instead.');

    const bagId = `p${Object.keys(this.bags).length}`;

    return new Queryable<T>(
      this.runtime,
      {
        kind: 'where',
        source: this.plan,
        predicate: overScalar(nullSafeEquals(SCALAR_VALUE, external([bagId]))),
      },
      { ...this.bags, [bagId]: value },
      this.scalar,
    ).any();
  }

  /**
   * Names this query as a set of values, so a lambda elsewhere can test
   * membership against it the way it already tests membership in an array:
   *
   * ```ts
   * const vip = db.orders.where((o) => o.total > 1000).select((o) => o.userId).asValues();
   * const customers = await db.users.where((u, p) => p.vip.includes(u.id), { vip }).toArray();
   * ```
   *
   * That compiles to `id IN (SELECT user_id FROM orders WHERE total > 1000)`,
   * built once and tested against every row rather than recomputed per row:
   * there is no captured variable to recover a correlation from, so `vip` is
   * fixed by the time `where` reads it, the same as any other parameter bag
   * value. A collection navigation's own `some`/`every` is the operator to
   * reach for when the question is instead about rows matching this one.
   *
   * The query still travels in the parameter bag exactly as any other
   * captured value does; this only changes what TypeScript sees it as once a
   * lambda reads it back through `p.someName`, the way `Group<T>`'s own
   * methods exist to be read rather than run. Like `contains`, it means
   * something only over a query that already projects one value.
   */
  asValues(): readonly T[] {
    this.requireScalar('asValues', 'Project one value with "select" first.');
    return this as unknown as readonly T[];
  }

  /**
   * The mean of one value over the query, reduced to a single number.
   *
   * ```ts
   * const meanAge = await db.users.where((u) => u.city === 'London').average((u) => u.age);
   * ```
   *
   * The selector is projected first and the mean taken over what it produced,
   * which is why the operator needs no plan node: `average(f)` is `select(f)`
   * read back as one row. A navigation in the selector therefore works here
   * exactly as it does in `select`, and so does averaging after paging, where
   * `take(10).average(...)` is the mean of those ten rows rather than of all
   * of them.
   *
   * A query with no rows is an error rather than zero, as it is in LINQ and as
   * `first` is here. SQL answers `AVG` over no rows with null, and reporting
   * that as a number would make an empty query indistinguishable from one that
   * genuinely averages to zero. Null values among the rows are skipped, which
   * is what `AVG` does and what LINQ does; a query whose every value is null is
   * its own error rather than the empty one, since the rows were there.
   *
   * The result is a `number`, which is what `AVG` means in SQL. Several drivers
   * hand it back as a string to protect the precision of an exact numeric, so
   * it is normalised here the way `count` is. That normalisation is the one
   * thing to know before averaging money: the mean of a `decimal` column is a
   * double by the time it arrives and can lose digits the column held. Sum the
   * column and divide by the count yourself when every digit has to survive.
   */
  average(value: (row: T) => number | string | null): Promise<number>;
  average<TParams extends object>(
    value: (row: T, params: TParams) => number | string | null,
    params: TParams,
  ): Promise<number>;
  async average(value: LooseLambda, params?: object): Promise<number> {
    const bound = this.bind(value, params);

    // Checked here rather than left to the compiler, which would fault the
    // `select` this becomes and name an operator the caller never wrote.
    if (!isScalarProjection(bound.expression.body)) {
      throw new InvalidQueryError(
        '"average" expects a selector choosing one value to average, such as (u) => u.age.',
      );
    }

    const projected = new Queryable<number>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: bound.expression },
      bound.bags,
      true,
    );

    return projected.meanOfProjection();
  }

  /**
   * The total of one value over the query, added up into a single number.
   *
   * ```ts
   * const payroll = await db.employees.where((e) => e.active).sum((e) => e.salary);
   * ```
   *
   * It is `average` in shape, projecting the selector first so the operator
   * needs no plan node and a navigation in it works as it does in `select`, and
   * wrapping the aggregate outside the query so `take(10).sum(...)` totals ten
   * rows rather than all of them.
   *
   * Where it parts company is the empty query, and the difference is not a
   * detail: this answers zero where `average` faults. That is what LINQ's `Sum`
   * does, and it is not what SQL does, so the `COALESCE` closing the gap is in
   * the generated statement. Rows whose value is null are skipped, and a query
   * whose every value is null totals zero as well, which is why `sum` needs
   * none of the machinery `average` uses to tell an empty query from a null
   * one: for a total they are the same answer.
   *
   * The result is a `number`, as it is for `count` and `average`. Two things
   * can be lost in that conversion, and both are worth knowing before summing
   * money. PostgreSQL widens a `SUM` over an `int` column to `bigint`, so a
   * total can outgrow what a double represents exactly even when no row could;
   * and a `SUM` over a `decimal` column is exact in the database, keeping the
   * scale that makes `4.50` different from `4.5`, which a double does not. Read
   * such a column back through a projection rather than this terminal when
   * every digit has to survive.
   */
  sum(value: (row: T) => number | string | null): Promise<number>;
  sum<TParams extends object>(
    value: (row: T, params: TParams) => number | string | null,
    params: TParams,
  ): Promise<number>;
  async sum(value: LooseLambda, params?: object): Promise<number> {
    const bound = this.bind(value, params);

    if (!isScalarProjection(bound.expression.body)) {
      throw new InvalidQueryError(
        '"sum" expects a selector choosing one value to add up, such as (u) => u.total.',
      );
    }

    const projected = new Queryable<number>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: bound.expression },
      bound.bags,
      true,
    );

    return projected.totalOfProjection();
  }

  /**
   * The smallest value of one column over the query.
   *
   * ```ts
   * const earliest = await db.users.min((u) => u.createdAt);
   * ```
   *
   * The projection and the wrapping are `sum`'s, so a navigation in the
   * selector works and `take(10).min(...)` is the smallest of those ten rows.
   * Two things about it are its own.
   *
   * It is not restricted to numbers, and it is the only one of these terminals
   * that is not. `MIN` orders whatever the column holds, so the smallest `text`
   * is the first alphabetically and the smallest `timestamp` is the earliest,
   * which is why the selector is generic where `sum` and `average` take a
   * number or a string. Note that a text ordering is the column's collation
   * rather than a JavaScript one, the same caveat `localeCompare` carries.
   *
   * Nothing is converted on the way back either. `MIN` returns a value that was
   * already in the column, so it arrives in the column's own representation and
   * is handed on untouched: a `timestamp` is a `Date`, a `decimal` is the exact
   * string it always was, and none of the rounding `sum` and `average` document
   * applies here.
   *
   * An empty query is a `SequenceError`, as LINQ's `Min` throws and as `average`
   * does here. A query that has rows whose values are all null is different, and
   * answers null: the smallest of nothing but nulls is null, which is what LINQ
   * answers and what this return type can carry where `average`'s `number`
   * could not.
   */
  min<TValue>(value: (row: T) => TValue): Promise<TValue>;
  min<TValue, TParams extends object>(
    value: (row: T, params: TParams) => TValue,
    params: TParams,
  ): Promise<TValue>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async min(value: LooseLambda, params?: object): Promise<any> {
    return this.extreme('min', value, params);
  }

  /**
   * The largest value of one column over the query.
   *
   * ```ts
   * const latest = await db.users.max((u) => u.createdAt);
   * ```
   *
   * Everything true of `min` is true here, read the other way, and that is a
   * measured claim rather than an assumption from the neighbouring case: `MAX`
   * returns the column's own type, arrives in the column's own representation,
   * answers null both for no rows and for a column of nulls, and orders text by
   * the column's collation. Nothing separated the two, so they share one
   * compilation and differ only in the aggregate's name.
   *
   * So an empty query is a `SequenceError` and a query whose every value is null
   * answers null, exactly as for `min`.
   */
  max<TValue>(value: (row: T) => TValue): Promise<TValue>;
  max<TValue, TParams extends object>(
    value: (row: T, params: TParams) => TValue,
    params: TParams,
  ): Promise<TValue>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async max(value: LooseLambda, params?: object): Promise<any> {
    return this.extreme('max', value, params);
  }

  /**
   * The whole row carrying the smallest of a key, rather than the key alone.
   *
   * ```ts
   * const youngest = await db.users.minBy((u) => u.age);
   * ```
   *
   * This is LINQ's `MinBy`, and it needs no plan node or compiler method of
   * its own: it is `orderBy` and `first`, the two operators that already
   * answer "the row sorted first". A key that is more than one expression
   * works exactly as it does for `orderBy`, by returning an object, since
   * `minBy` never reads the key back and has nothing of its own to name.
   *
   * An empty query is a `SequenceError`, as `first` already makes it and as
   * LINQ's own `MinBy` throws. Which row comes back among several tying on
   * the key is the database's choice, exactly as it is for `orderBy` alone;
   * `minBy` has nowhere to take a tiebreaking `thenBy` itself, so reach for
   * `orderBy(key).thenBy(...).first()` directly when that matters.
   */
  async minBy(key: (row: T) => unknown): Promise<T> {
    return this.orderByKey(key, false).first();
  }

  /**
   * The whole row carrying the largest of a key, rather than the key alone.
   *
   * Everything about `minBy` is true here read the other way: `orderByDescending`
   * and `first` in place of `orderBy` and `first`, the same tie behaviour, and
   * the same `SequenceError` for a query with no rows.
   */
  async maxBy(key: (row: T) => unknown): Promise<T> {
    return this.orderByKey(key, true).first();
  }

  /**
   * `min` and `max`, which measuring found to differ only in the name.
   *
   * Kept together rather than duplicated so the two cannot drift: the selector
   * check, the projection, and the reading of the result are one piece of code
   * for both.
   */
  private async extreme(
    operator: 'min' | 'max',
    value: LooseLambda,
    params: object | undefined,
  ): Promise<unknown> {
    const bound = this.bind(value, params);

    if (!isScalarProjection(bound.expression.body)) {
      throw new InvalidQueryError(
        `"${operator}" expects a selector choosing one value to compare, such as (u) => u.age.`,
      );
    }

    const projected = new Queryable<unknown>(
      this.runtime,
      { kind: 'select', source: this.plan, projector: bound.expression },
      bound.bags,
      true,
    );

    return projected.extremeOfProjection(operator);
  }

  /** Runs the aggregate for `min` or `max` over a query that already projects the value. */
  protected async extremeOfProjection(operator: 'min' | 'max'): Promise<unknown> {
    const options = this.compileOptions();
    const rows = await this.run(
      operator === 'min' ? compileMin(this.plan, options) : compileMax(this.plan, options),
    );
    const row = rows[0];

    if (Number(row?.['count'] ?? 0) === 0) {
      throw new SequenceError(
        `The query returned no rows but "${operator}" requires at least one.`,
      );
    }

    // Handed on as the driver gave it. Normalising here would turn the earliest
    // date into a number and the first name into NaN.
    return row?.[operator] ?? null;
  }

  /** Runs the aggregate for `sum` over a query that already projects the value. */
  protected async totalOfProjection(): Promise<number> {
    const rows = await this.run(compileSum(this.plan, this.compileOptions()));
    // The COALESCE has already turned both null cases into zero, so there is no
    // empty-query branch here of the kind `average` needs.
    return Number(rows[0]?.['sum'] ?? 0);
  }

  /** Runs the aggregate for `average` over a query that already projects the value. */
  protected async meanOfProjection(): Promise<number> {
    const rows = await this.run(compileAverage(this.plan, this.compileOptions()));
    const row = rows[0];

    if (Number(row?.['count'] ?? 0) === 0) {
      throw new SequenceError('The query returned no rows but "average" requires at least one.');
    }

    const mean = row?.['average'];
    if (mean === null || mean === undefined) {
      throw new SequenceError(
        'Every row the query returned had a null value, so "average" had nothing to average.',
      );
    }

    return Number(mean);
  }

  /**
   * Whether every row matches the predicate, answered in one statement.
   *
   * ```ts
   * const allAdults = await db.users.all((u) => u.age >= 18);
   * ```
   *
   * The question is turned inside out to ask it: SQL has no `ALL` over a table,
   * but a row that fails the predicate is a row like any other, so the query
   * looks for one and stops at the first it finds. Nothing is materialised and
   * no count is made of the rows that pass.
   *
   * A query with no rows is `true`, as the empty conjunction is everywhere.
   *
   * A predicate that is null rather than true counts as a failure, as it does
   * anywhere else in SQL and as it does in `takeWhile`. That keeps the operator
   * exactly as strict as the filter it is asking about: `all(p)` is true when
   * `where(p)` would have returned every row, comparisons against null and all.
   * Entity Framework Core answers the other way, letting a row whose predicate
   * is unknown pass.
   */
  all(predicate: (row: T) => boolean): Promise<boolean>;
  all<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Promise<boolean>;
  async all(predicate: LooseLambda, params?: object): Promise<boolean> {
    const bound = this.bind(predicate, params);
    const failing = new Queryable<T>(
      this.runtime,
      { kind: 'where', source: this.plan, predicate: negate(bound.expression) },
      bound.bags,
      this.scalar,
    );

    return !(await failing.any());
  }

  async first(): Promise<T> {
    const rows = await this.take(1).toArray();
    if (rows.length === 0) {
      throw new SequenceError('The query returned no rows but "first" requires at least one.');
    }
    return rows[0]!;
  }

  async firstOrDefault(): Promise<T | null> {
    const rows = await this.take(1).toArray();
    return rows.length === 0 ? null : rows[0]!;
  }

  /**
   * The row at a zero-based index, fetched with `OFFSET` and `LIMIT 1`.
   *
   * The database skips the rows ahead of it, so nothing before the index is
   * fetched or materialised. An index only names a row once the query has an
   * order, though: without `orderBy` a database is free to return rows however
   * it likes, and "the third row" is then whatever that run happened to
   * produce.
   *
   * A negative index is refused here and accepted on an `OrderedQueryable`,
   * where it counts from the end the way `Array.prototype.at` does: `-1` is
   * the last row. Counting backward needs the same ordering counting forward
   * does, which is why the two are not accepted in the same place.
   */
  async elementAt(index: number): Promise<T> {
    const rows = await this.at(index, 'elementAt');
    if (rows.length === 0) {
      throw new SequenceError(
        `The query returned no row at index ${index} but "elementAt" requires one.`,
      );
    }
    return rows[0]!;
  }

  /** As `elementAt`, but `null` rather than an error when the index is past the end. */
  async elementAtOrDefault(index: number): Promise<T | null> {
    return (await this.at(index, 'elementAtOrDefault'))[0] ?? null;
  }

  async single(): Promise<T> {
    const rows = await this.take(2).toArray();
    if (rows.length === 0) {
      throw new SequenceError('The query returned no rows but "single" requires exactly one.');
    }
    if (rows.length > 1) {
      throw new SequenceError(
        'The query returned more than one row but "single" requires exactly one.',
      );
    }
    return rows[0]!;
  }

  async singleOrDefault(): Promise<T | null> {
    const rows = await this.take(2).toArray();
    if (rows.length > 1) {
      throw new SequenceError(
        'The query returned more than one row but "singleOrDefault" allows at most one.',
      );
    }
    return rows[0] ?? null;
  }

  /** Walks the query one page at a time, stopping as soon as a page falls short. */
  protected async *batches(size: number): AsyncIterableIterator<T[]> {
    for (let offset = 0; ; offset += size) {
      const batch = await this.skip(offset).take(size).toArray();
      if (batch.length > 0) yield batch;

      // A full `size` was asked for, so a shorter page is the last one. An
      // exactly divisible result costs one more statement to learn that, which
      // is cheaper than carrying a count around to avoid it.
      if (batch.length < size) return;
    }
  }

  /**
   * The single-row window an index-based operator reads.
   *
   * The index is checked here rather than left to the compiler so that a bad
   * one names the operator the caller wrote, instead of the `skip` it became.
   */
  protected at(index: number, operator: string): Promise<T[]> {
    if (!Number.isInteger(index) || index < 0) {
      throw new InvalidQueryError(
        `"${operator}" expects a non-negative integer index but received ${index}.`,
      );
    }
    return this.skip(index).take(1).toArray();
  }

  protected orderByKey(key: (row: T) => unknown, descending: boolean): OrderedQueryable<T> {
    const expression = toExpression(key, { rowParameterCount: 1 });
    const keys: OrderKey[] = [{ key: expression, descending }];

    return new OrderedQueryable<T>(
      this.runtime,
      { kind: 'orderBy', source: this.plan, keys },
      this.bags,
      this.scalar,
      this.plan,
      keys,
    );
  }

  protected derive(plan: QueryPlan): Queryable<T> {
    return new Queryable<T>(this.runtime, plan, this.bags, this.scalar);
  }

  /**
   * Refuses an operator that reads the one value a scalar projection kept,
   * when the query still projects a row.
   *
   * `order` and `contains` share the precondition and differ only in what to
   * reach for instead, so they share the refusal and parameterise the
   * sentence, the way an update and a delete share `writableSource`'s.
   */
  protected requireScalar(operator: string, instead: string): void {
    if (this.scalar) return;

    throw new InvalidQueryError(
      `"${operator}" works over a query that projects one value, and this one still projects a ` +
        `row. ${instead}`,
    );
  }

  /**
   * Binds a lambda, registering its argument bag under a fresh identifier.
   *
   * Bag identifiers are derived from how many bags the chain already holds, so
   * two operators on the same query never collide.
   */
  protected bind(
    fn: AnyLambda,
    params: object | undefined,
  ): { expression: LambdaExpression; bags: ParameterBags } {
    if (params === undefined) {
      return { expression: toExpression(fn, { rowParameterCount: 1 }), bags: this.bags };
    }

    const { resolved, bags } = this.resolveQueryValues(params);
    const bagId = `p${Object.keys(bags).length}`;
    return {
      expression: toExpression(fn, { rowParameterCount: 1, bagId }),
      bags: { ...bags, [bagId]: resolved },
    };
  }

  /**
   * Folds a query passed as a parameter bag's value into this query's own
   * bags, the way `merge` already does for an operator taking another query
   * directly, so a lambda can name it through the bag without capturing it
   * from the enclosing scope. What is stored in its place is the renumbered
   * plan alone: by the time a lambda reads `p.someName` back, the query it
   * names has to already agree with this one on where every bag reference
   * points.
   *
   * An ordinary value has nothing to fold, and a query only ever reaches here
   * through `asValues`, so an `instanceof` check is enough to find one
   * without asking the caller to say so a second time.
   */
  private resolveQueryValues(params: object): { resolved: object; bags: ParameterBags } {
    let bags = this.bags;
    const resolved: Record<string, unknown> = { ...params };

    for (const [key, value] of Object.entries(params)) {
      if (!(value instanceof Queryable)) continue;

      if (
        value.runtime.driver !== this.runtime.driver ||
        value.runtime.dialect !== this.runtime.dialect
      ) {
        throw new InvalidQueryError(
          `The query passed as "${key}" must come from the same context as the query it is ` +
            'used in: one statement cannot span two databases.',
        );
      }

      const merged = this.mergeInto(bags, value);
      bags = merged.bags;
      resolved[key] = boundQuery(merged.plan);
    }

    return { resolved, bags };
  }

  /**
   * Shared by the four set operators, which differ only in which rows survive.
   *
   * `name` is the operator as the caller spelled it, so an error names the
   * method they called rather than the SQL keyword it would have become.
   */
  protected combine(
    other: Queryable<T>,
    operator: SetOperationNode['operator'],
    all: boolean,
    name: string,
  ): Queryable<T> {
    this.requireSameContext(other, name);

    const merged = this.merge(other);
    return new Queryable<T>(
      this.runtime,
      { kind: 'setOperation', source: this.plan, other: merged.plan, operator, all },
      merged.bags,
      this.scalar,
    );
  }

  /**
   * Rejects an operator whose two queries do not share a connection.
   *
   * One statement reaches one database, so combining queries built on separate
   * contexts could only ever produce SQL that names tables the connection
   * cannot see.
   */
  protected requireSameContext<TOther>(other: Queryable<TOther>, operator: string): void {
    if (
      other.runtime.driver !== this.runtime.driver ||
      other.runtime.dialect !== this.runtime.dialect
    ) {
      throw new InvalidQueryError(
        `Both sides of a "${operator}" must come from the same context: ` +
          'one statement cannot span two databases.',
      );
    }
  }

  /**
   * Folds another query's parameter bags into this query's.
   *
   * Both sides numbered their bags from zero, so the other query's are
   * renumbered past this one's and its plan rewritten to match. Without that
   * step two unrelated `p0` bags would collide the moment the maps are merged.
   */
  protected merge<TOther>(other: Queryable<TOther>): {
    plan: QueryPlan;
    bags: ParameterBags;
  } {
    return this.mergeInto(this.bags, other);
  }

  /**
   * `merge`'s own logic, taking the bags to renumber past as an argument
   * rather than reading `this.bags`, which is what lets a three-way `zip`
   * merge a third query against the bags the first merge already produced,
   * without a throwaway instance to call `merge` through a second time.
   */
  protected mergeInto<TOther>(
    bags: ParameterBags,
    other: Queryable<TOther>,
  ): { plan: QueryPlan; bags: ParameterBags } {
    return mergeBagsInto(bags, other.plan, other.bags);
  }

  protected compileOptions() {
    return { dialect: this.runtime.dialect, bags: this.bags };
  }

  /**
   * Another query compiled as the rows a write will read from, with the bags
   * its placeholders resolve against.
   *
   * Declared here rather than on `EntitySet`, where the only caller is, for a
   * rule of the language rather than a matter of taste: a plan and its bags are
   * this class's own, and TypeScript will not let a subclass read a protected
   * member off an instance typed as the base. `merge`, `mergeInto`, and
   * `requireSameContext` are all here for that reason, and this joins them.
   *
   * `merge` is reached for rather than the other query's own bags because both
   * sides numbered theirs from zero. An entity set holds none of its own, so
   * the renumbering changes nothing today; going around it would be a bug
   * waiting for the first entity filter that binds a value.
   *
   * `scalar` travels with the rest because a query projecting one unnamed value
   * has no column names to write into, and only the query itself knows it: the
   * compiled `SELECT` says `AS "value"` and looks like any other projection.
   */
  protected compiledSource<TOther>(other: Queryable<TOther>): {
    select: SqlSelect;
    nested: readonly NestedEmbed[];
    scalar: boolean;
    bags: ParameterBags;
  } {
    const { plan, bags } = this.merge(other);
    const { select, nested } = compileQuery(plan, { dialect: this.runtime.dialect, bags });
    return { select, nested, scalar: other.scalar, bags };
  }

  protected prepare(select: SqlSelect): PreparedStatement {
    const { text, parameters } = printSelect(select, this.runtime.dialect);
    return { text, values: bindParameters(parameters, this.bags) };
  }

  protected async run(select: SqlSelect): Promise<ResultRow[]> {
    return this.runStatement(this.prepare(select));
  }

  /**
   * Runs an already-prepared statement and logs it like any other.
   *
   * Split out for the writes, whose statement does not come from a plan and so
   * has nothing for `prepare` to compile, but which should still reach the
   * logger the reads reach.
   */
  protected async runStatement(statement: PreparedStatement): Promise<ResultRow[]> {
    const startedAt = Date.now();
    const rows = await this.runtime.driver.execute(statement);

    this.runtime.logger?.({
      ...statement,
      durationMs: Date.now() - startedAt,
      rowCount: rows.length,
    });

    return rows;
  }

  protected materialize(rows: ResultRow[], nested: readonly NestedEmbed[] = []): T[] {
    const folded = nested.length === 0 ? rows : rows.map((row) => foldNested(row, nested));
    return this.scalar ? folded.map((row) => row['value'] as T) : (folded as T[]);
  }
}

/**
 * Folds the flat, prefixed columns `project` renamed a nested embed's own
 * columns to back into the object a caller's projection named, the way
 * `{ order: o, user: u }` reads once the driver has answered.
 */
function foldNested(row: ResultRow, nested: readonly NestedEmbed[]): ResultRow {
  const result: ResultRow = { ...row };
  for (const { property, prefix } of nested) {
    const embedded: ResultRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith(prefix)) continue;
      embedded[key.slice(prefix.length)] = value;
      delete result[key];
    }
    result[property] = embedded;
  }
  return result;
}

/**
 * What a caller may do to a collection before a shaped `selectMany` reads it.
 *
 * `NoInfer` is what makes this usable beside the selector that names the
 * collection: the target entity is the selector's to name, and a shape
 * mentioning it in a parameter position would otherwise be inferred from too,
 * which leaves the type variable at its constraint rather than the entity the
 * selector actually named. `include`'s own `CollectionShape` exists for the
 * same reason.
 *
 * There is no dedicated wrapper type the way `include` has `IncludedCollection`:
 * an ordinary `Queryable`/`OrderedQueryable` already has exactly `where`,
 * `orderBy`, and (once ordered) `skip`/`take`, and each compiles to a plan node
 * the shaped join reads back directly rather than tracking a window
 * separately. What that does not exclude, such as `select` or a set operation,
 * is refused by the compiler instead, once it can see the shape's whole plan.
 */
type LateralShape<TTarget extends AnyEntity> = (
  rows: Queryable<EntityOf<TTarget>>,
) => Queryable<EntityOf<TTarget>>;

/**
 * The target entity of a collection navigation named directly off a query's
 * row, resolved eagerly because a shape is ordinary code invoked now, rather
 * than a lambda left for the compiler to resolve a navigation's metadata off
 * later.
 */
function collectionTarget(plan: QueryPlan, selector: LambdaExpression): AnyEntity {
  if (reshapes(plan)) {
    throw new InvalidQueryError(
      '"selectMany" needs rows that are still an entity to shape a collection before reading ' +
        'it. Read the collection without a shape instead.',
    );
  }

  const body = selector.body;
  if (body.kind !== 'member' || body.object.kind !== 'parameter') {
    throw new InvalidQueryError(
      '"selectMany" expects one of the row\'s own collections, such as (u) => u.orders.',
    );
  }

  const entity = rootEntity(plan);
  const relation = entity.relations[body.property];
  if (!relation || relation.kind !== 'collection') {
    throw new InvalidQueryError(
      `"${body.property}" is not a collection on entity "${entity.name}".`,
    );
  }

  return relation.target();
}

/**
 * The root query for one entity, and the only place a write starts.
 *
 * `insert` lives here rather than on `Queryable` because a query is a shape and
 * a table is a place: `db.users.where(...)` is still a query and inserting into
 * it means nothing. Keeping the two apart in the type is what makes that a thing
 * that cannot be written rather than a thing that has to be refused.
 */
export class EntitySet<TEntity extends AnyEntity> extends Queryable<EntityOf<TEntity>> {
  constructor(
    runtime: QueryRuntime,
    private readonly entity: TEntity,
  ) {
    const source: QueryPlan = { kind: 'source', entity };
    super(runtime, entity.filter ? { kind: 'where', source, predicate: entity.filter } : source);
  }

  /**
   * The same rows, without the entity's own query filter applied.
   *
   * ```ts
   * const everyone = await db.users.ignoreQueryFilters().toArray();
   * ```
   *
   * A soft-deleted row is exactly what a filter exists to hide from
   * `db.users` itself and from a reference or collection navigated to this
   * entity, so an administrative screen that has to show it anyway needs a
   * way to ask for the bare table back. There is nothing to bypass, and
   * nothing here does anything, for an entity that declared no filter.
   */
  ignoreQueryFilters(): Queryable<EntityOf<TEntity>> {
    return new Queryable<EntityOf<TEntity>>(this.runtime, { kind: 'source', entity: this.entity });
  }

  /**
   * Adds one row and hands back the row the database ended up with.
   *
   * ```ts
   * const ada = await db.users.insert({ name: 'Ada', email: 'ada@example.com', age: 36 });
   * ada.id; // the generated key
   * ```
   *
   * The argument asks for the columns that have no other source and accepts the
   * rest: anything `generated` comes from the database, and anything `nullable`
   * is the same row whether it is left out or written as null. Navigations are
   * not part of it, since inserting through one would be a second statement
   * into a second table and a decision this does not make for the caller.
   *
   * What comes back is read from the statement rather than assembled from the
   * argument, which is what makes a generated key, a column default, and a
   * trigger all visible. That needs the `RETURNING` clause, so a dialect whose
   * database spells it differently has more than a word to change.
   */
  async insert(values: InsertOf<TEntity>): Promise<EntityOf<TEntity>> {
    const [row] = await this.insertMany([values]);
    if (!row) {
      throw new SequenceError(
        '"insert" added a row and read none back. The dialect emitted no RETURNING clause.',
      );
    }
    return row;
  }

  /**
   * Adds several rows in one statement and hands them all back.
   *
   * ```ts
   * const added = await db.users.insertMany([
   *   { name: 'Ada', email: 'ada@example.com', age: 36 },
   *   { name: 'Grace', email: 'grace@example.com', age: 45 },
   * ]);
   * ```
   *
   * One statement rather than one per row, which is the whole reason to reach
   * for it. Every row therefore supplies the same columns: the list is the union
   * of what the rows mention, and a row that leaves out a column another one
   * named writes null there rather than the column default. Pass rows of the
   * same shape, or insert them separately.
   *
   * An empty list adds nothing and issues no statement, since `VALUES` with no
   * rows is not a statement any database accepts.
   */
  async insertMany(values: readonly InsertOf<TEntity>[]): Promise<EntityOf<TEntity>[]> {
    if (values.length === 0) return [];

    const columns = this.insertedColumns(values as readonly Record<string, unknown>[]);
    if (columns.length === 0) {
      throw new InvalidQueryError(
        `"insertMany" was given rows that name no column of entity "${this.entity.name}". ` +
          `Columns: ${Object.keys(this.entity.columns).join(', ')}.`,
      );
    }

    const statement = printInsert(
      compileInsert(this.entity, columns, values as readonly Record<string, unknown>[]),
      this.runtime.dialect,
    );

    const rows = await this.runStatement({
      text: statement.text,
      values: bindParameters(statement.parameters, {}),
    });

    return rows as EntityOf<TEntity>[];
  }

  /**
   * Fills the table from a query rather than from rows, and hands back
   * everything it wrote.
   *
   * ```ts
   * const archived = await db.archivedUsers.insertFrom(
   *   db.users
   *     .where((u) => !u.isActive)
   *     .select((u) => ({ name: u.name, email: u.email, age: u.age })),
   * );
   * ```
   *
   * ```sql
   * INSERT INTO "archived_users" ("name", "email", "age")
   * SELECT "t0"."name" AS "name", "t0"."email" AS "email", "t0"."age" AS "age"
   * FROM "users" AS "t0" WHERE NOT "t0"."is_active" RETURNING ...
   * ```
   *
   * That is `INSERT INTO ... SELECT`, and the difference between it and
   * `insertMany` is where the values come from rather than how many there are:
   * `insertMany` carries its rows to the database, and this one names a query
   * and lets the database find them. Nothing crosses the wire in either
   * direction, so it is the operator to reach for when the rows are already
   * there — copying a table, archiving what a filter selected, seeding one
   * table from another — and it stays one statement however many rows the
   * query turns out to match.
   *
   * The projection names the columns. Each of its properties has to be a column
   * of this entity, and what it leaves out takes the column default rather than
   * null, which is the one place this is kinder than `insertMany`: there is one
   * column list and the query supplies all of it. The order the projection
   * happens to be written in does not matter here even though it matters to
   * SQL, since the statement puts the two in step before printing.
   *
   * The query may read this very table, and it may be any query at all rather
   * than the bare filter `update` and `delete` insist on: a join, a grouping,
   * an ordering, and a page are all fine, because nothing here has to work out
   * which rows a statement is about. A projection down to one unnamed value is
   * the exception, since a value with no name cannot say which column it fills.
   *
   * Unlike `insertMany([])`, this always issues its statement. Whether the
   * query finds any rows is the database's to answer, and an empty array back
   * is that answer rather than a call that did nothing.
   */
  async insertFrom<TRow extends InsertOf<TEntity>>(
    source: Queryable<TRow>,
  ): Promise<EntityOf<TEntity>[]> {
    this.requireSameContext(source, 'insertFrom');

    const { select, nested, scalar, bags } = this.compiledSource(source);

    if (scalar) {
      throw new InvalidQueryError(
        `"insertFrom" was given a query projecting one unnamed value, which cannot say which ` +
          `column of entity "${this.entity.name}" it fills. Project an object naming the ` +
          'columns, such as (u) => ({ name: u.name }).',
      );
    }

    if (nested.length > 0) {
      throw new InvalidQueryError(
        `"insertFrom" was given a query projecting a nested row (${nested
          .map((embed) => embed.property)
          .join(', ')}), and a column holds one value rather than a row. Project the columns ` +
          'themselves.',
      );
    }

    const columns = this.writtenColumns(select.columns.map((projection) => projection.alias));
    if (columns.length === 0) {
      throw new InvalidQueryError(
        `"insertFrom" was given a query projecting no column of entity "${this.entity.name}". ` +
          `Columns: ${Object.keys(this.entity.columns).join(', ')}.`,
      );
    }

    const statement = printInsert(
      compileInsertFrom(this.entity, columns, select),
      this.runtime.dialect,
    );

    const rows = await this.runStatement({
      text: statement.text,
      values: bindParameters(statement.parameters, bags),
    });

    return rows as EntityOf<TEntity>[];
  }

  /**
   * Adds one row, or updates the one already there on a conflicting primary
   * key, and hands back the row the database ended up with either way.
   *
   * ```ts
   * const ada = await db.users.upsert({ id: 1, name: 'Ada', email: 'ada@example.com', age: 36 });
   * ```
   *
   * The conflict target is always the entity's own declared primary key,
   * mirroring `asSingleStatement`'s own default: naming a different column
   * to detect the conflict on is not part of this yet. Every other column the
   * argument names is overwritten with the proposed value when a conflicting
   * row is already there, which is `insert` and `where(...).update(values)`
   * combined into the one statement a database needs to do either without a
   * race between them.
   */
  async upsert(values: InsertOf<TEntity>): Promise<EntityOf<TEntity>> {
    const [row] = await this.upsertMany([values]);
    if (!row) {
      throw new SequenceError(
        '"upsert" wrote a row and read none back. The dialect emitted no RETURNING clause.',
      );
    }
    return row;
  }

  /**
   * Adds several rows in one statement, updating any that conflict with a row
   * already there, and hands them all back.
   *
   * The same one-statement, same-column-list rule `insertMany` follows
   * applies here too: every row supplies the same columns, and a row that
   * leaves one out writes null there rather than a column default.
   *
   * An empty list writes nothing and issues no statement, for `insertMany`'s
   * own reason.
   */
  async upsertMany(values: readonly InsertOf<TEntity>[]): Promise<EntityOf<TEntity>[]> {
    if (values.length === 0) return [];

    const primaryKey: readonly string[] = this.entity.primaryKey;
    if (primaryKey.length === 0) {
      throw new InvalidQueryError(
        `"upsert" needs entity "${this.entity.name}" to declare a primary key, to recognise ` +
          'which row conflicts with the one being written.',
      );
    }

    const columns = this.insertedColumns(values as readonly Record<string, unknown>[]);
    if (columns.length === 0) {
      throw new InvalidQueryError(
        `"upsertMany" was given rows that name no column of entity "${this.entity.name}". ` +
          `Columns: ${Object.keys(this.entity.columns).join(', ')}.`,
      );
    }

    const updated = columns.filter((property) => !primaryKey.includes(property));
    if (updated.length === 0) {
      throw new InvalidQueryError(
        `"upsert" was given rows that name only entity "${this.entity.name}"'s primary key ` +
          `(${primaryKey.join(', ')}). There would be nothing left to update on a conflict.`,
      );
    }

    const statement = printInsert(
      compileInsert(this.entity, columns, values as readonly Record<string, unknown>[], primaryKey),
      this.runtime.dialect,
    );

    const rows = await this.runStatement({
      text: statement.text,
      values: bindParameters(statement.parameters, {}),
    });

    return rows as EntityOf<TEntity>[];
  }

  /**
   * The same rows `db.users` itself would read, sourced from a raw SQL
   * fragment instead of a plain `SELECT * FROM users`.
   *
   * ```ts
   * const adults = await db.users.fromSql`SELECT * FROM users WHERE age >= ${18}`.toArray();
   * ```
   *
   * This is the escape hatch every translator eventually needs, for the
   * handful of statements no operator here builds: a CTE, a window this
   * library does not expose, a database-specific hint. Every value is a
   * tagged template placeholder rather than text spliced into the fragment,
   * so it travels as an ordinary bound parameter and a value carrying a
   * quote cannot become a second statement; write the fragment itself with a
   * template literal and this is the only thing that can go in the holes.
   *
   * The fragment has to answer with the same columns, under the same
   * physical names, that `db.users` would read: nothing here renames or
   * reshapes what comes back, so `where`, `select`, `include`, and everything
   * else layered on top keep working exactly as they do over the ordinary
   * source. What it returns is an ordinary `Queryable`, not an `EntitySet`,
   * since a fragment already chose how its own rows are found and does not
   * mean to be written back through with `insert`.
   *
   * This lives here rather than on `Queryable` for `insert`'s own reason: a
   * query has no fixed row shape to answer for, and only the entity set knows
   * what columns a fragment is on the hook to return.
   */
  fromSql(sql: TemplateStringsArray, ...values: readonly unknown[]): Queryable<EntityOf<TEntity>> {
    return new Queryable<EntityOf<TEntity>>(this.runtime, {
      kind: 'rawSource',
      entity: this.entity,
      sql: [...sql],
      values: values.map(constant),
    });
  }

  /**
   * The columns the rows between them named, which is the union of their
   * properties: one statement has one column list, so a column only the second
   * row named is one the first writes null into.
   */
  private insertedColumns(values: readonly Record<string, unknown>[]): string[] {
    return this.writtenColumns(values.flatMap((row) => Object.keys(row)));
  }

  /**
   * The properties named, checked against the entity and put back into the
   * order the entity declares them.
   *
   * Taken from the entity rather than from the order they arrived in, so the
   * order is the same for every statement and a caller who happened to list
   * them differently still lines up. A property the entity does not declare is
   * refused rather than ignored, since silently dropping it would write a row
   * the caller did not ask for.
   *
   * Shared by the two ways of naming columns, which differ only in where the
   * names came from: `insertMany` reads them off the rows it was handed, and
   * `insertFrom` off what the query projects. Naming none of them is left to
   * each caller to refuse, since what to suggest instead is the one thing the
   * two do not share.
   */
  private writtenColumns(named: Iterable<string>): string[] {
    const declared = new Set(Object.keys(this.entity.columns));
    const seen = new Set<string>();

    for (const property of named) {
      if (!declared.has(property)) {
        throw new InvalidQueryError(
          `"${property}" is not a column of entity "${this.entity.name}". ` +
            `Columns: ${[...declared].join(', ')}.`,
        );
      }
      seen.add(property);
    }

    return Object.keys(this.entity.columns).filter((property) => seen.has(property));
  }
}

/** One navigation to bring back, and the two properties that pair it with its rows. */
interface Inclusion {
  /**
   * Which end of a foreign key was named, which is the only thing that differs
   * once the two properties below are worked out.
   *
   * A collection is handed an array and a reference one row or null, and both
   * are read by the same statement over the same pair of keys. Keeping the kind
   * rather than two shapes of inclusion is what stops the second statement,
   * the key collection, and the empty case from being written twice.
   */
  readonly kind: RelationDefinition['kind'];
  /** Property on the row the related rows are handed to. */
  readonly property: string;
  readonly entity: AnyEntity;
  /** Property on the row whose value the related rows carry. */
  readonly parentKey: string;
  /** Property on the related row holding that value. */
  readonly childKey: string;
  /**
   * The statement to read the related rows with, before the keys are known.
   *
   * A plain `include` reads the whole table and this is the bare source; a
   * filtered one is whatever its operators built. The key list is added on top
   * either way, which is why the plan stops short of it.
   */
  readonly plan: QueryPlan;
  readonly bags: ParameterBags;
  /** How many rows of each parent's key to pass over, and how many to keep. */
  readonly skip: number;
  readonly take: number | null;
}

/**
 * The collection an `include` is about to read, and the operators that narrow
 * it.
 *
 * A type of its own rather than a `Queryable`, because the operators mean
 * something different here. This stands for the related rows of *one* row of the
 * outer query, so `take` is per outer row rather than per statement: ten orders
 * each, not ten orders between them. One statement still reads them all, with a
 * window that numbers each parent's rows separately, which is `distinctBy`'s
 * window asked for more than one row.
 *
 * What it leaves out is as deliberate as what it offers. There is no `select`,
 * because the rows have to stay the entity the navigation claims; no terminal,
 * because the `include` is what reads them; and no plain `take`, because a limit
 * on the statement would hand the first ten rows to whichever parents they
 * happened to belong to.
 */
export class IncludedCollection<TRow> {
  constructor(
    protected readonly query: Queryable<TRow>,
    /** Rows of each parent's key to pass over and to keep, once ordered. */
    protected readonly window: { readonly skip: number; readonly take: number | null } = {
      skip: 0,
      take: null,
    },
  ) {}

  /** Keeps the related rows matching the predicate, and drops the rest. */
  where(predicate: (row: TRow) => boolean): IncludedCollection<TRow>;
  where<TParams extends object>(
    predicate: (row: TRow, params: TParams) => boolean,
    params: TParams,
  ): IncludedCollection<TRow>;
  where(predicate: LooseLambda, params?: object): IncludedCollection<TRow> {
    return new IncludedCollection<TRow>(this.filtered(predicate, params), this.window);
  }

  /**
   * Orders the related rows, which is also what makes `take` meaningful.
   *
   * The order is the order they arrive in, so the rows of each parent are in it
   * too. A collection read without one arrives in whatever order the database
   * chose, as a plain `include` does.
   */
  orderBy(key: (row: TRow) => unknown): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.query.orderBy(key), this.window);
  }

  orderByDescending(key: (row: TRow) => unknown): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.query.orderByDescending(key), this.window);
  }

  /** What the `include` takes from this: the statement so far, and the window. */
  get shaped(): Pick<Inclusion, 'plan' | 'bags' | 'skip' | 'take'> {
    return {
      plan: this.query.includePlan,
      bags: this.query.includeBags,
      skip: this.window.skip,
      take: this.window.take,
    };
  }

  /** The filter, applied through the query so the parameter bags are numbered. */
  protected filtered(predicate: LooseLambda, params?: object): Queryable<TRow> {
    return params === undefined
      ? this.query.where(predicate as (row: TRow) => boolean)
      : this.query.where(predicate as (row: TRow, bag: object) => boolean, params);
  }
}

/**
 * An ordered collection to include, which is the only state in which taking
 * some of each parent's rows means anything.
 *
 * The same reasoning that puts `takeWhile` on `OrderedQueryable`: which ten
 * rows are the first ten is a question only an ordering answers, so the type
 * asks for one rather than a runtime check reporting its absence.
 */
export class OrderedIncludedCollection<TRow> extends IncludedCollection<TRow> {
  constructor(
    private readonly ordered: OrderedQueryable<TRow>,
    window: { readonly skip: number; readonly take: number | null } = { skip: 0, take: null },
  ) {
    super(ordered, window);
  }

  /**
   * A further sort key, applied where the ones before it tie.
   *
   * There is no `where` here, and the omission is inherited rather than chosen:
   * a filter on an `OrderedQueryable` returns an ordinary query in this library
   * too, so `where` after `orderBy` gives up `take` and the fix is to filter
   * first. Claiming otherwise would mean handing back a type whose `thenBy` the
   * object does not have.
   */
  thenBy(key: (row: TRow) => unknown): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.ordered.thenBy(key), this.window);
  }

  thenByDescending(key: (row: TRow) => unknown): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.ordered.thenByDescending(key), this.window);
  }

  /**
   * At most `count` rows for each row of the outer query, in this order.
   *
   * This is the ten most recent orders per user rather than the ten most recent
   * orders. It compiles to a window that numbers each parent's rows and keeps
   * the ones numbered at or below the count, so it is still one statement.
   */
  take(count: number): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.ordered, {
      skip: this.window.skip,
      take: nonNegative(count, '"take" on an included collection'),
    });
  }

  /** The rows after the first `count` of each row of the outer query. */
  skip(count: number): OrderedIncludedCollection<TRow> {
    return new OrderedIncludedCollection<TRow>(this.ordered, {
      skip: nonNegative(count, '"skip" on an included collection'),
      take: this.window.take,
    });
  }
}

/**
 * A count that has to be a whole number of rows.
 *
 * Checked where the caller wrote it, as `elementAt` checks its index, so the
 * error names the operator the caller reached for rather than the window it
 * became.
 *
 * The subject is passed in whole rather than assembled here. This helper began
 * with two callers, both on an included collection, and said so in its message;
 * `takeBy` and `skipBy` made that sentence a lie for half its callers, which is
 * `matchKeys` arriving a second time. A message about a shared thing has to be
 * told what it is talking about.
 */
function nonNegative(count: number, subject: string): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidQueryError(`${subject} expects a non-negative integer but received ${count}.`);
  }
  return count;
}

/** Plan nodes after which the rows are no longer the root entity's. */
const RESHAPING = new Set([
  'select',
  'groupBy',
  'join',
  'groupJoin',
  'selectMany',
  'zip',
  'pairwise',
  'windowed',
  'expanding',
  'index',
  'rank',
]);

/**
 * Whether any node in a plan has changed the shape of its rows.
 *
 * `literalRow` is a base case alongside `source` rather than reshaping or not,
 * since it is never actually reached this way: it has no rows of a root
 * entity's shape to keep or lose, and only ever sits on the far side of the
 * `UNION ALL` `append` builds, which nothing here recurses into. `rawSource`
 * is a genuine base case rather than an exemption: its rows are read through
 * the same `EntityScope` a plain `source` builds, so a navigation off it
 * resolves exactly as it would off `db.users` itself.
 */
function reshapes(plan: QueryPlan): boolean {
  if (RESHAPING.has(plan.kind)) return true;
  if (plan.kind === 'source' || plan.kind === 'literalRow' || plan.kind === 'rawSource') {
    return false;
  }
  return reshapes(plan.source);
}

/**
 * The first navigation of a chain, which is the one read off the query's rows.
 *
 * A function rather than a method because both `Queryable.include` and
 * `IncludedQueryable.include` resolve one, and the second is not a subclass of
 * the first. The selector is typed by its parameter alone, as `never`, so a
 * lambda over any row type is accepted here while the public overloads remain
 * the only thing a caller can satisfy.
 */
function rootInclusion(
  runtime: QueryRuntime,
  plan: QueryPlan,
  selector: (row: never) => unknown,
  shape?: Shaper,
): Inclusion {
  // Asked before the selector is looked at, because a reshaped query has no
  // entity for a selector to name a navigation on, whatever it says. Only the
  // first navigation of a chain can hit this: a later one is read off an entity
  // that a plan had nothing to do with.
  if (reshapes(plan)) {
    throw new InvalidQueryError(
      '"include" needs rows that are still an entity, and this query has reshaped them. ' +
        'Apply it before the projection, or read the navigation with selectMany or a join ' +
        'instead.',
    );
  }

  return resolveInclusion(runtime, rootEntity(plan), selector, 'include', shape);
}

/** What a caller may do to the collection an `include` is about to read. */
type Shaper = (rows: IncludedCollection<never>) => IncludedCollection<never>;

/**
 * The same thing said in terms of the entity a selector named.
 *
 * `NoInfer` is what makes it usable in a signature beside that selector. The
 * entity is the selector's to name, and a shaper mentioning it in a parameter
 * position would otherwise be inferred from too, which leaves the type variable
 * at its constraint and the collection's rows typed as any entity's.
 */
type CollectionShape<TTarget> = (
  rows: IncludedCollection<EntityOf<TTarget>>,
) => IncludedCollection<EntityOf<TTarget>>;

/**
 * The navigation a selector names on one entity, and the two properties that
 * pair it with that entity's rows.
 *
 * The operator's name is threaded through rather than hardcoded, because the
 * same resolution serves `include` and `thenInclude` and an error that named
 * the wrong one would send a reader to the wrong line of their query.
 */
function resolveInclusion(
  runtime: QueryRuntime,
  entity: AnyEntity,
  selector: (row: never) => unknown,
  operator: 'include' | 'thenInclude',
  shape?: Shaper,
): Inclusion {
  const body = toExpression(selector, { rowParameterCount: 1 }).body;
  if (body.kind !== 'member' || body.object.kind !== 'parameter') {
    throw new InvalidQueryError(
      `"${operator}" expects one of the row navigations, such as (u) => u.orders or ` +
        '(o) => o.user.',
    );
  }

  const relation: RelationDefinition | undefined = entity.relations[body.property];

  if (!relation) {
    const navigations = Object.keys(entity.relations);
    throw new InvalidQueryError(
      `"${body.property}" is not a collection or a reference on entity "${entity.name}". ` +
        `Navigations: ${navigations.length > 0 ? navigations.join(', ') : 'none'}.`,
    );
  }

  // Which side holds the key is the whole difference between the two. A
  // collection is pointed at by the rows on the other end, so the key is read
  // off this row and matched against theirs; a reference points the other way,
  // so the key is the column this row carries and it is matched against the
  // target's own. Both defaults fall back to a primary key, and to the
  // primary key of a different entity.
  if (relation.kind === 'collection') {
    const target = relation.target();
    return {
      kind: 'collection',
      property: body.property,
      entity: target,
      parentKey: relation.to ?? onlyKey(entity, body.property, 'collection'),
      childKey: relation.from,
      ...shapedStatement(runtime, target, shape),
    };
  }

  const target = relation.target();
  return {
    kind: 'reference',
    property: body.property,
    entity: target,
    parentKey: relation.from,
    childKey: relation.to ?? onlyKey(target, body.property, 'reference'),
    ...shapedStatement(runtime, target, shape),
  };
}

/**
 * The statement the related rows will be read with, before the keys are added.
 *
 * With no shaper this is the bare table, which is what a plain `include` reads.
 * With one, the operators the caller wrote have already been applied to a query
 * over the same entity, so nothing here has to know what they were.
 *
 * The target's own query filter, if it declared one, is applied here the same
 * way `EntitySet`'s constructor applies it to `db.users`: underneath whatever
 * the shaper adds, so a caller's own `where` narrows further rather than
 * replacing it, and a soft-deleted row stays hidden behind `include` too.
 */
function shapedStatement(
  runtime: QueryRuntime,
  target: AnyEntity,
  shape?: Shaper,
): Pick<Inclusion, 'plan' | 'bags' | 'skip' | 'take'> {
  const table: QueryPlan = { kind: 'source', entity: target };
  const source: QueryPlan = target.filter
    ? { kind: 'where', source: table, predicate: target.filter }
    : table;
  if (!shape) return { plan: source, bags: {}, skip: 0, take: null };

  return shape(new IncludedCollection(new Queryable<never>(runtime, source, {}))).shaped;
}

/**
 * The one primary key a navigation matches against when none was named.
 *
 * Which entity that key belongs to depends on which end was declared, so the
 * caller passes it: a collection defaults to the primary key of the entity
 * holding it, and a reference to the primary key of the entity it points at.
 * The relation's own kind is threaded through for the message, since a sentence
 * naming a collection was true while collections were all this had to report.
 */
function onlyKey(entity: AnyEntity, property: string, kind: RelationDefinition['kind']): string {
  const [key, ...rest] = entity.primaryKey;
  if (!key || rest.length > 0) {
    throw new ModelError(
      `${kind === 'collection' ? 'Collection' : 'Reference'} "${property}" has no "to" option, ` +
        `and the primary key of entity "${entity.name}" is ` +
        `${key ? 'made of several columns' : 'not declared'}. ` +
        'Name the column to match with the "to" option.',
    );
  }
  return key;
}

/**
 * The one inclusion `asSingleStatement` can build a join for.
 *
 * A further `thenInclude` needs a join of its own, and a second chain beside
 * this one needs a second `FROM` item its own key would have to correlate
 * against; both are follow-ups this does not attempt. A shape that orders or
 * limits its rows needs a `LATERAL` join for `selectMany`'s own reason, so
 * only an unshaped or plainly filtered one is let through.
 */
function onlyInclusion(chains: readonly (readonly Inclusion[])[], operator: string): Inclusion {
  if (chains.length !== 1) {
    throw new InvalidQueryError(
      `"${operator}" works over exactly one "include", and this query has ${chains.length}. ` +
        'Read the rest with their own second statement instead.',
    );
  }

  const [chain] = chains;
  if (chain!.length !== 1) {
    throw new InvalidQueryError(
      `"${operator}" works over one "include" with no "thenInclude" written after it: that hop ` +
        'needs a join of its own this does not build yet, and stays a second statement.',
    );
  }

  const inclusion = chain![0]!;
  if (inclusion.skip > 0 || inclusion.take !== null) {
    throw new InvalidQueryError(
      `"${operator}" cannot shape "${inclusion.property}" with an order or a limit: that needs a ` +
        'LATERAL join this does not build yet. Read it without one, or keep the second statement.',
    );
  }

  return inclusion;
}

/**
 * A query with navigations to bring back, and the terminals that can do it.
 *
 * This offers the operators that read rows and not the ones that reshape them,
 * which is what makes `include` an operator to reach for last. The alternative,
 * carrying the inclusions through every operator, would have to answer what a
 * projection does to one, and the honest answer is that it drops it.
 *
 * `TLast` is the entity the most recent navigation landed on, which is what
 * `thenInclude` reads its own navigation off. Before any `include` it is
 * `never`, so a `thenInclude` with nothing to follow cannot be written: its
 * lambda would have to take a parameter of type `never`, which has no
 * properties to name.
 */
export class IncludedQueryable<T, TLast extends AnyEntity = never> {
  constructor(
    private readonly runtime: QueryRuntime,
    private readonly source: Queryable<T>,
    /**
     * One entry per `include`, each holding that navigation and every
     * `thenInclude` written after it, outermost first.
     *
     * A chain rather than a tree, which is the cheaper structure and the one
     * that costs something: two chains through the same navigation read it
     * twice. Write one chain per navigation and there is nothing to pay.
     */
    private readonly chains: readonly (readonly Inclusion[])[],
  ) {}

  /** Another navigation of the query's own rows, read in a statement of its own. */
  include<TTarget extends AnyEntity>(
    selector: (row: T) => readonly Related<TTarget>[] | Related<TTarget>,
    shape?: CollectionShape<NoInfer<TTarget>>,
  ): IncludedQueryable<T, TTarget>;
  include(selector: (row: T) => never, shape?: Shaper): IncludedQueryable<T, AnyEntity> {
    return new IncludedQueryable<T, AnyEntity>(this.runtime, this.source, [
      ...this.chains,
      [rootInclusion(this.runtime, this.source.includePlan, selector, shape)],
    ]);
  }

  /**
   * A navigation of the rows the last `include` or `thenInclude` brought back,
   * read one hop further out.
   *
   * ```ts
   * const graph = await db.orders
   *   .include((o) => o.user)
   *   .thenInclude((u) => u.city)
   *   .toArray();
   *
   * graph[0]!.user.city.name; // string | null
   * ```
   *
   * One statement per hop, not one per row: the keys of every row a hop
   * produced are collected before the next statement runs, so a chain of two
   * navigations over a thousand rows is three statements. That is what makes
   * this worth having over a loop calling `include` per row, which is the
   * N + 1 queries an ORM is supposed to spare its caller.
   *
   * The hop it follows is the last one written, as `thenBy` sorts by the last
   * key written. Start a second chain with `include` and `thenInclude` follows
   * that one instead.
   */
  thenInclude<TNext extends AnyEntity>(
    selector: (row: EntityOf<TLast>) => readonly Related<TNext>[] | Related<TNext>,
    shape?: CollectionShape<NoInfer<TNext>>,
  ): IncludedQueryable<T, TNext>;
  thenInclude(selector: (row: never) => never, shape?: Shaper): IncludedQueryable<T, AnyEntity> {
    const chains = [...this.chains];
    // Non-empty because `TLast` is `never` until an `include` has put a chain
    // here, and a lambda taking `never` cannot name a navigation to follow.
    const chain = chains.pop()!;
    const entity = chain[chain.length - 1]!.entity;

    return new IncludedQueryable<T, AnyEntity>(this.runtime, this.source, [
      ...chains,
      [...chain, resolveInclusion(this.runtime, entity, selector, 'thenInclude', shape)],
    ]);
  }

  /**
   * The single-statement alternative to reading this navigation over a
   * second one: a `LEFT JOIN`, its rows recognised as the same parent by
   * primary key and folded back into the graph `toArray` already builds,
   * rather than one row per match reaching the caller flat.
   *
   * ```ts
   * const graph = await db.users.include((u) => u.orders).asSingleStatement().toArray();
   * ```
   *
   * Only one `include`, with no `thenInclude` written after it and no second
   * chain beside it, and no shape ordering or limiting its rows: a further
   * hop is a join of its own this does not build yet, and an ordered or
   * limited shape needs a `LATERAL` join for the reason `selectMany`'s own
   * shape does. Both stay a second statement; this is for the plain
   * navigation beneath them.
   *
   * The parent's own columns repeat once per match, which is `groupJoin`'s
   * own trade in the other direction: ask for this over a query with few
   * matches per row and a parent row that is not too wide, and reach for
   * `include`'s ordinary second statement, or `groupJoin`'s `toArray`, when
   * that trade stops paying for itself.
   */
  asSingleStatement(): SingleStatementInclude<T> {
    const inclusion = onlyInclusion(this.chains, 'asSingleStatement');
    const entity = rootEntity(this.source.includePlan);

    if (entity.primaryKey.length === 0) {
      throw new InvalidQueryError(
        `"asSingleStatement" needs entity "${entity.name}" to declare a primary key, to ` +
          "recognise which of the join's rows are the same parent.",
      );
    }

    return new SingleStatementInclude<T>(
      this.runtime,
      this.source.includePlan,
      this.source.includeBags,
      inclusion,
      Object.keys(entity.columns),
      entity.primaryKey,
    );
  }

  /** The statement that reads the rows. The related rows are read after it. */
  toSQL(): PreparedStatement {
    return this.source.toSQL();
  }

  async toArray(): Promise<IncludedRow<T>[]> {
    const rows = (await this.source.toArray()) as ResultRow[];

    for (const chain of this.chains) {
      await this.attachChain(rows, chain);
    }

    return rows as IncludedRow<T>[];
  }

  async first(): Promise<IncludedRow<T>> {
    const row = await this.firstOrDefault();
    if (row === null) {
      throw new SequenceError('"first" found no rows. Use "firstOrDefault" to allow none.');
    }
    return row;
  }

  async firstOrDefault(): Promise<IncludedRow<T> | null> {
    const rows = await this.take(1).toArray();
    return rows[0] ?? null;
  }

  async single(): Promise<IncludedRow<T>> {
    const rows = await this.take(2).toArray();
    if (rows.length === 0) throw new SequenceError('"single" found no rows.');
    if (rows.length > 1) throw new SequenceError('"single" found more than one row.');
    return rows[0]!;
  }

  async singleOrDefault(): Promise<IncludedRow<T> | null> {
    const rows = await this.take(2).toArray();
    if (rows.length > 1) throw new SequenceError('"singleOrDefault" found more than one row.');
    return rows[0] ?? null;
  }

  /** The same inclusions over a limited query, which is how the firsts read. */
  private take(count: number): IncludedQueryable<T, TLast> {
    return new IncludedQueryable<T, TLast>(this.runtime, this.source.take(count), this.chains);
  }

  /**
   * One chain of navigations, each hop read from the rows the last one produced.
   *
   * The rows of a hop are gathered before the next statement is built, so the
   * count of statements is the length of the chain and not the count of rows.
   * A hop that found nothing ends the chain, since there is nothing left to read
   * a key off.
   */
  private async attachChain(rows: ResultRow[], chain: readonly Inclusion[]): Promise<void> {
    let current = rows;
    for (const inclusion of chain) {
      if (current.length === 0) return;
      current = await this.attach(current, inclusion);
    }
  }

  /**
   * Reads one navigation and hands each row the related rows it is paired with.
   *
   * The two kinds part company only at the edges: what an unmatched row is
   * given, and whether the matches arrive as a list or as one row. Everything
   * between — the keys, the single statement, the grouping — is the same work,
   * since a reference and a collection are the two ends of one foreign key read
   * from different sides.
   *
   * The related rows are handed back as well as handed out, which is what lets
   * a `thenInclude` read the next hop off them. They are the same objects the
   * rows now hold, so attaching to them attaches to the graph.
   */
  private async attach(rows: ResultRow[], inclusion: Inclusion): Promise<ResultRow[]> {
    const collection = inclusion.kind === 'collection';

    // Set first, so a row the second statement finds nothing for still answers
    // something rather than leaving the property absent: an empty array for a
    // collection, and null for a reference, which is also what a row whose key
    // is null gets.
    for (const row of rows) row[inclusion.property] = collection ? [] : null;

    const present = rows
      .map((row) => row[inclusion.parentKey])
      .filter((key) => key !== null && key !== undefined);
    const keys = [...new Set(present)];

    // No keys is no statement: an `IN` over nothing would have to be written as
    // a constant false, and the answer is already known.
    if (keys.length === 0) return [];

    const related = (await this.relatedRows(inclusion, keys)) as ResultRow[];

    const byKey = new Map<string, ResultRow[]>();
    for (const other of related) {
      const key = String(other[inclusion.childKey]);
      const group = byKey.get(key);
      if (group) group.push(other);
      else byKey.set(key, [other]);
    }

    for (const row of rows) {
      const key = row[inclusion.parentKey];
      if (key === null || key === undefined) continue;
      const matched = byKey.get(String(key));
      // A reference takes the first match rather than refusing several. More
      // than one row on the other end means the column it matches is not
      // unique, which is the database's to say and not this operator's to
      // discover halfway through handing out rows.
      row[inclusion.property] = collection ? (matched ?? []) : (matched?.[0] ?? null);
    }

    return related;
  }

  /** Every related row whose key is one the rows hold, in a single statement. */
  private relatedRows(inclusion: Inclusion, keys: readonly unknown[]): Promise<unknown[]> {
    // Numbered past whatever a filtered collection bound, the way every other
    // bag in a chain is: two bags called `p0` would collide the moment they were
    // merged.
    const bagId = `p${Object.keys(inclusion.bags).length}`;

    // Built as expression IR rather than parsed from a lambda written here,
    // because the property to compare is only known at runtime and a lambda
    // becomes an expression by way of its own source text.
    const predicate: LambdaExpression = {
      kind: 'lambda',
      parameters: ['row'],
      body: call(external([bagId, 'keys']), 'includes', [
        member(parameter('row'), inclusion.childKey),
      ]),
    };

    // The keys go on top of whatever the caller's operators built, so a filter
    // of theirs is applied to the same statement and the window below counts
    // only the rows that survived both.
    let plan: QueryPlan = { kind: 'where', source: inclusion.plan, predicate };

    if (inclusion.skip > 0 || inclusion.take !== null) {
      // Per parent rather than per statement, which is the whole point of the
      // window: a `LIMIT` here would hand the first rows to whichever parents
      // they happened to belong to.
      plan = {
        kind: 'perKey',
        source: plan,
        key: {
          kind: 'lambda',
          parameters: ['row'],
          body: member(parameter('row'), inclusion.childKey),
        },
        skip: inclusion.skip,
        take: inclusion.take,
        operator: 'include',
      };
    }

    return new Queryable<unknown>(this.runtime, plan, {
      ...inclusion.bags,
      [bagId]: { keys },
    }).toArray();
  }
}

/**
 * What a single-statement include's own columns are renamed to on the way
 * out, so a caller's own column named `id` on the parent side and `id` on
 * the child side never collide in the one flat row the join hands back.
 */
const INCLUDE_PREFIX = '__sqlinqo_include_';

/** The `LEFT JOIN`'s own key selector, built rather than parsed for the reason `relatedRows`'s is. */
function joinKey(paramName: string, property: string): LambdaExpression {
  return {
    kind: 'lambda',
    parameters: [paramName],
    body: member(parameter(paramName), property),
  };
}

/**
 * The `LEFT JOIN`'s own result selector: every column of the outer row under
 * its own name, and every column of the inclusion's entity beside it under
 * `INCLUDE_PREFIX`, so `nestJoinedRows` can tell the two halves of one flat
 * row apart once it reads them back.
 */
function joinedIncludeProjector(
  parentColumns: readonly string[],
  inclusion: Inclusion,
): LambdaExpression {
  const outer = parentColumns.map((name) => ({ name, value: member(parameter('u'), name) }));
  const inner = Object.keys(inclusion.entity.columns).map((name) => ({
    name: `${INCLUDE_PREFIX}${name}`,
    value: member(parameter('o'), name),
  }));

  return {
    kind: 'lambda',
    parameters: ['u', 'o'],
    body: object([...outer, ...inner]),
  };
}

/**
 * Splits a single-statement include's flat, joined rows back into a graph.
 *
 * `IncludedQueryable.attach` needs no primary key of its own to group by,
 * since its outer rows already arrive one per parent, from a statement of
 * their own; a join is what repeats them here, so recognising two flat rows
 * as the same parent is this function's own job, and only the primary key
 * answers it correctly regardless of what column the inclusion itself is
 * keyed by. An unmatched row is the left join's own null in every column
 * `INCLUDE_PREFIX` carries, read off the one the inclusion is keyed by.
 */
function nestJoinedRows(
  rows: readonly ResultRow[],
  inclusion: Inclusion,
  primaryKey: readonly string[],
): ResultRow[] {
  const collection = inclusion.kind === 'collection';
  const parents = new Map<string, ResultRow>();
  const order: ResultRow[] = [];

  for (const row of rows) {
    const parent: ResultRow = {};
    const child: ResultRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(INCLUDE_PREFIX)) child[key.slice(INCLUDE_PREFIX.length)] = value;
      else parent[key] = value;
    }

    const identity = primaryKey.map((column) => String(parent[column])).join(' ');
    let target = parents.get(identity);
    if (!target) {
      target = parent;
      target[inclusion.property] = collection ? [] : null;
      parents.set(identity, target);
      order.push(target);
    }

    const childKey = child[inclusion.childKey];
    if (childKey === null || childKey === undefined) continue;

    if (collection) (target[inclusion.property] as ResultRow[]).push(child);
    // A reference takes the first match rather than refusing several, the
    // same trade `attach` already makes: which column is not unique is the
    // database's to say, not this function's to discover halfway through.
    else if (target[inclusion.property] === null) target[inclusion.property] = child;
  }

  return order;
}

/**
 * The single-statement `LEFT JOIN` `IncludedQueryable.asSingleStatement`
 * builds, and the terminals that read it.
 *
 * A separate type from `IncludedQueryable` rather than a mode switch on it,
 * since the two no longer share how they read a row: nothing here issues a
 * second statement, and there is no further `include` or `thenInclude` to
 * chain, which `onlyInclusion` already required before one of these could
 * be built at all.
 */
class SingleStatementInclude<T> {
  constructor(
    private readonly runtime: QueryRuntime,
    private readonly outerPlan: QueryPlan,
    private readonly outerBags: ParameterBags,
    private readonly inclusion: Inclusion,
    private readonly parentColumns: readonly string[],
    private readonly primaryKey: readonly string[],
  ) {}

  toSQL(): PreparedStatement {
    return this.query().toSQL();
  }

  async toArray(): Promise<IncludedRow<T>[]> {
    const rows = (await this.query().toArray()) as ResultRow[];
    return nestJoinedRows(rows, this.inclusion, this.primaryKey) as IncludedRow<T>[];
  }

  async first(): Promise<IncludedRow<T>> {
    const row = await this.firstOrDefault();
    if (row === null) {
      throw new SequenceError('"first" found no rows. Use "firstOrDefault" to allow none.');
    }
    return row;
  }

  async firstOrDefault(): Promise<IncludedRow<T> | null> {
    const rows = await this.take(1).toArray();
    return rows[0] ?? null;
  }

  async single(): Promise<IncludedRow<T>> {
    const rows = await this.take(2).toArray();
    if (rows.length === 0) throw new SequenceError('"single" found no rows.');
    if (rows.length > 1) throw new SequenceError('"single" found more than one row.');
    return rows[0]!;
  }

  async singleOrDefault(): Promise<IncludedRow<T> | null> {
    const rows = await this.take(2).toArray();
    if (rows.length > 1) throw new SequenceError('"singleOrDefault" found more than one row.');
    return rows[0] ?? null;
  }

  /**
   * The same join over a limited outer side, which is how the firsts read.
   *
   * The limit belongs on the outer plan, before the join, and not on the
   * joined result: a `LIMIT` there would count flat rows, cutting a parent's
   * own matches off partway through rather than keeping whole parents.
   */
  private take(count: number): SingleStatementInclude<T> {
    return new SingleStatementInclude<T>(
      this.runtime,
      { kind: 'take', source: this.outerPlan, count },
      this.outerBags,
      this.inclusion,
      this.parentColumns,
      this.primaryKey,
    );
  }

  private query(): Queryable<unknown> {
    const merged = mergeBagsInto(this.outerBags, this.inclusion.plan, this.inclusion.bags);

    const plan: JoinNode = {
      kind: 'join',
      joinKind: 'left',
      source: this.outerPlan,
      inner: merged.plan,
      outerKey: joinKey('u', this.inclusion.parentKey),
      innerKey: joinKey('o', this.inclusion.childKey),
      projector: joinedIncludeProjector(this.parentColumns, this.inclusion),
    };

    return new Queryable<unknown>(this.runtime, plan, merged.bags);
  }
}

/**
 * A query that already has at least one sort key, which is the only state in
 * which `thenBy` is meaningful. Modelling that in the type system removes a
 * whole class of runtime error, exactly as `IOrderedQueryable` does in LINQ.
 */
/**
 * The text of a tag, refused rather than escaped when it could end the comment.
 *
 * Checked in the operator rather than in the printer, as `countBy` checks its
 * key, so the error names `tag` and the stack points at the call that wrote it.
 * An empty tag is refused for a plainer reason than safety: a comment with
 * nothing in it traces nothing, and writing one is a mistake rather than a
 * choice.
 */
function checkedTag(text: string): string {
  if (text.trim().length === 0) {
    throw new InvalidQueryError('"tag" expects text to carry into the SQL, and this tag is empty.');
  }

  if (text.includes('/*') || text.includes('*/')) {
    throw new InvalidQueryError(
      `"tag" cannot carry a comment delimiter, and this tag contains one: ${text}. ` +
        'A tag is printed as a block comment, so a delimiter inside it would end the comment ' +
        'early and leave the rest of the tag to be read as SQL.',
    );
  }

  return text;
}

export class OrderedQueryable<T> extends Queryable<T> {
  constructor(
    runtime: QueryRuntime,
    plan: QueryPlan,
    bags: ParameterBags,
    scalar: boolean,
    /** The plan the ordering was applied to, so extra keys can be appended. */
    private readonly orderSource: QueryPlan,
    private readonly keys: readonly OrderKey[],
  ) {
    super(runtime, plan, bags, scalar);
  }

  /**
   * The rows from the start of the sequence up to the first that fails the
   * predicate, which is then dropped along with everything behind it.
   *
   * This is not `where`. A filter keeps every matching row wherever it sits;
   * this one stops. Over `[1, 2, 5, 1, 2]` and `x < 3`, `where` keeps four rows
   * and `takeWhile` keeps two.
   *
   * That difference is positional, so it only means anything over an ordering,
   * which is why this lives here rather than on every query. It compiles to a
   * running count of failures in a window over that same ordering, and keeps
   * the rows the count has not reached yet. A predicate that is `NULL` rather
   * than true counts as a failure, as it does anywhere else in SQL.
   */
  takeWhile(predicate: (row: T) => boolean): Queryable<T>;
  takeWhile<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Queryable<T>;
  takeWhile(predicate: LooseLambda, params?: object): Queryable<T> {
    return this.cutAt(predicate, params, true);
  }

  /**
   * The rows that come after one already read, in this query's own ordering.
   *
   * ```ts
   * const first = await db.users.orderBy((u) => u.id).take(20).toArray();
   * const next = await db.users
   *   .orderBy((u) => u.id)
   *   .after(first.at(-1)!)
   *   .take(20)
   *   .toArray();
   * ```
   *
   * ```sql
   * SELECT ... FROM "users" AS "t0" WHERE "t0"."id" > $1 ORDER BY "t0"."id" ASC LIMIT 20
   * ```
   *
   * This is keyset paging, and what it is worth is visible in that statement:
   * a page is found by seeking straight to a key, where `skip` and the `chunk`
   * built on it count off every row before it and throw them away. The
   * difference is not constant. `OFFSET 100000` reads and discards a hundred
   * thousand rows on every request, so the last page of a table costs the most
   * and a long walk costs quadratic work; this page costs an index seek
   * whichever page it is. It is also stable under writes, which `skip` is not:
   * a row inserted ahead of the cursor shifts every offset by one and makes a
   * paging loop show a row twice or skip one, while a key that has already been
   * passed stays passed.
   *
   * What it cannot do is jump. A cursor names the row to continue from, so
   * pages come one after another and there is no page seven to ask for
   * directly; reach for `skip` when a caller can name an arbitrary page, and
   * for this when they are walking. `before` is the complement, stepping back
   * a page rather than on.
   *
   * The cursor is the last row of the page before, and only the sort keys are
   * read off it, so an object carrying just those is accepted too — which is
   * what a cursor round-tripped through a URL comes back as. A key the cursor
   * has no value for is refused rather than compared against `undefined`.
   *
   * Every sort key has to be a plain property of the row —
   * `orderBy((u) => u.id)` and
   * `thenByDescending((u) => u.name)`, not `orderBy((u) => u.name.length)` or a
   * key reached through a navigation. That is not a limit of the comparison but
   * of the cursor: the value is read off the row the caller hands back, and a
   * computed key was never on it to read. A key that is not a plain property is
   * refused by name rather than translated into a comparison against a value
   * this would have had to invent.
   *
   * Several keys compare the way SQL and a dictionary both do, each one only
   * settling the rows its predecessors tied on, so
   * `orderBy(name).thenBy(id).after(row)` is `name > $1 OR (name = $1 AND id > $2)`
   * rather than two independent comparisons. A descending key reverses its own
   * comparison and nothing else, which is what keeps the predicate in step with
   * the `ORDER BY` it mirrors.
   *
   * A null in the cursor's key is refused. SQL orders nulls but does not
   * compare them: `name > NULL` is unknown rather than true or false, so every
   * remaining row would fail the predicate and the walk would end early and
   * silently, one page short. Page by a key that cannot be null, which a cursor
   * key should be anyway, since two rows tied on every key have no order
   * between them for a cursor to sit in.
   *
   * What comes back is an ordinary `Queryable` rather than an ordered one, and
   * deliberately: the predicate was built against the keys the query has now,
   * so a `thenBy` added afterwards would order by something the cursor never
   * accounted for. The ordering is already in the plan and survives untouched.
   */
  after(cursor: T | Partial<T>): Queryable<T> {
    return this.seek(cursor, 'after');
  }

  /**
   * The rows that come before one already read, nearest the cursor first.
   *
   * ```ts
   * const page = await db.users
   *   .orderBy((u) => u.id)
   *   .before(firstRowOfThePageInHand)
   *   .take(20)
   *   .toArray();
   *
   * const inOrder = page.reverse();
   * ```
   *
   * ```sql
   * SELECT ... FROM "users" AS "t0" WHERE "t0"."id" < $1 ORDER BY "t0"."id" DESC LIMIT 20
   * ```
   *
   * The complement of `after`: between them they partition the sequence at the
   * cursor, and that row belongs to neither side, both comparisons being
   * strict. Together they are what lets a caller walking a list step back a
   * page as well as on, from the first row of the page they are holding rather
   * than from a count of the pages behind it.
   *
   * This is `after` over the reversed ordering, and that is the meaning rather
   * than merely the implementation: the rows come back ordered from the cursor
   * outward, so a `take` of twenty is the twenty rows immediately before it.
   * Leaving the ordering as written would have given the right predicate and
   * the wrong page, since `WHERE id < $1 ORDER BY id ASC LIMIT 20` is the first
   * twenty rows of the table and not the twenty behind the cursor, and it would
   * have been wrong silently. SQL pages from the front only, so reaching
   * backwards means reading backwards, and the ordering turns here rather than
   * being left for the caller to remember to turn.
   *
   * The page therefore arrives backwards, and putting it right is the caller's:
   * `.reverse()` on the array, once, over the one page just read. That is the
   * trade `takeLast` names from the other end — `reverse().take(n)` is the
   * cheaper query and answers backwards, `takeLast(n)` costs a derived table
   * and answers in order — settled here in favour of the seek, because a
   * `LIMIT` over a reversed ordering is what paging by key is for and a page is
   * short enough that turning it in memory costs nothing.
   *
   * Everything `after` refuses this refuses too, and names itself doing it: a
   * sort key that is not a plain property of the row, a cursor carrying no
   * value for a key the ordering names, and a null in one, which SQL orders
   * without being able to compare. What comes back is an ordinary `Queryable`
   * for `after`'s reason as well, a `thenBy` added behind the cursor being no
   * safer in this direction than in that one.
   */
  before(cursor: T | Partial<T>): Queryable<T> {
    // Reversing is the whole of the difference. Every sort key flips, so each
    // comparison flips with it and the lexicographic shape underneath is
    // untouched, which is why there is one predicate builder rather than two.
    // It is also free: `reverse` rewrites the `ORDER BY` and adds no window,
    // subquery, or second sort for the seek to sit on top of.
    return this.reverse().seek(cursor, 'before');
  }

  /**
   * Shared by the two, which by the time they arrive here differ only in which
   * way the ordering runs.
   *
   * The operator's name is threaded through rather than written into the
   * messages, so a refusal names the one the caller actually wrote. That is
   * `countBy`'s rule and the reason these are checked in the operator at all:
   * naming the `where` this becomes, or naming `after` to someone who wrote
   * `before`, would point at the wrong line twice over.
   */
  private seek(cursor: T | Partial<T>, operator: string): Queryable<T> {
    const bagId = `p${Object.keys(this.bags).length}`;

    const parts = this.keys.map((sortKey, index) => {
      const property = seekableKey(sortKey, index, operator);
      // A scalar query's row *is* the value, since `materialize` unwraps it out
      // of the `value` column the projection named. There is no object to read
      // a property off, and the one key `order()` built is that column.
      const value = this.scalar ? cursor : (cursor as Record<string, unknown>)[property];

      if (value === undefined) {
        throw new InvalidQueryError(
          `"${operator}" was given a cursor carrying no "${property}", which sort key ` +
            `${index + 1} orders by. A cursor needs a value for every key the ordering names, ` +
            'since a page boundary is where all of them together fall.',
        );
      }

      if (value === null) {
        throw new InvalidQueryError(
          `"${operator}" was given a cursor whose "${property}" is null, and SQL orders nulls ` +
            'without being able to compare them: every row on the far side of the cursor would ' +
            'fail the comparison and the walk would stop a page early. Page by a key that ' +
            'cannot be null.',
        );
      }

      return { property, value, descending: sortKey.descending };
    });

    return new Queryable<T>(
      this.runtime,
      {
        kind: 'where',
        source: this.plan,
        predicate: {
          kind: 'lambda',
          parameters: [CURSOR_ROW],
          body: seekPredicate(parts, bagId),
        },
      },
      { ...this.bags, [bagId]: Object.fromEntries(parts.map((p) => [p.property, p.value])) },
      this.scalar,
    );
  }

  /**
   * The rows from the first one that fails the predicate onward, dropping the
   * run that preceded it.
   *
   * The complement of `takeWhile`: between them they partition the sequence at
   * the first failure, and that row belongs to this side. Over `[1, 2, 5, 1, 2]`
   * and `x < 3`, `takeWhile` keeps `[1, 2]` and this keeps `[5, 1, 2]`.
   *
   * A predicate no row fails leaves nothing to return, and one the first row
   * fails returns everything.
   */
  skipWhile(predicate: (row: T) => boolean): Queryable<T>;
  skipWhile<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Queryable<T>;
  skipWhile(predicate: LooseLambda, params?: object): Queryable<T> {
    return this.cutAt(predicate, params, false);
  }

  /**
   * The last `count` rows, handed back in the order the query is already in.
   *
   * ```ts
   * db.users.orderBy((u) => u.createdAt).takeLast(3);
   * ```
   *
   * That is the three newest users, oldest of the three first, which is LINQ's
   * `TakeLast`. Which rows are last is a question the ordering answers, which is
   * why this lives here rather than on every query.
   *
   * `skipLast` is the complement, keeping everything this drops.
   *
   * `reverse().take(3)` selects the same three rows and is the cheaper query,
   * but it answers with them backwards. Use it when the order of the answer does
   * not matter; use this when it does. The difference costs one derived table:
   * the rows are read backwards so the database can stop at `count` rather than
   * sort the table, then sorted forwards again, which is a sort of `count` rows.
   *
   * Rows that tie on every sort key make which of them is "last" the database's
   * choice, as it is for `reverse`. Add a tiebreaking key with `thenBy` when
   * that matters. A count past the end of the sequence returns everything, as
   * `take` does.
   */
  takeLast(count: number): Queryable<T> {
    return this.lastRows(count, true);
  }

  /**
   * Everything but the last `count` rows, in the order they were already in.
   *
   * ```ts
   * db.readings.orderBy((r) => r.takenAt).skipLast(1);
   * ```
   *
   * That drops the most recent reading, which is the usual reason to want this:
   * a trailing row that is still being written, or a running total whose last
   * bucket is not closed yet. It is LINQ's `SkipLast`.
   *
   * The complement of `takeLast`: between them they partition the sequence
   * `count` rows from its end, and those rows belong to that side. Over
   * `[1, 2, 5, 1, 2]` and a count of two, `takeLast` keeps `[1, 2]` and this
   * keeps `[1, 2, 5]`.
   *
   * A count past the start of the sequence leaves nothing, and a count of none
   * leaves everything. Rows that tie on every sort key make which of them is
   * last the database's choice, as they do for `takeLast`; add a tiebreaking
   * key with `thenBy` when that matters.
   *
   * Unlike `takeLast`, this cannot stop early. The rows to keep are the ones
   * past a count taken from the end, so every row has to be ordered before any
   * of them is known, where `takeLast` reaches its answer under a `LIMIT`.
   */
  skipLast(count: number): Queryable<T> {
    return this.lastRows(count, false);
  }

  /** Shared by the two, which differ only in which side of the cut they keep. */
  private lastRows(count: number, take: boolean): Queryable<T> {
    return this.derive({ kind: 'last', source: this.plan, count, take });
  }

  /** Shared by the two, which differ only in which side of the cut they keep. */
  private cutAt(predicate: LooseLambda, params: object | undefined, take: boolean): Queryable<T> {
    const bound = this.bind(predicate, params);
    return new Queryable<T>(
      this.runtime,
      { kind: 'while', source: this.plan, predicate: bound.expression, take },
      bound.bags,
      this.scalar,
    );
  }

  /**
   * Pairs this query's rows with another's by position: first with first,
   * second with second, stopping wherever the shortest one runs out.
   *
   * A position only exists once a sequence has an order, so every side must be
   * ordered and the argument is an `OrderedQueryable` rather than a plain one.
   * That makes the requirement a compile error rather than a surprise.
   *
   * ```ts
   * db.users
   *   .orderBy((u) => u.id)
   *   .zip(db.cities.orderBy((c) => c.id), (u, c) => ({ who: u.name, city: c.name }));
   * ```
   *
   * Each side is numbered over its own ordering and matched on that number, so
   * the pairing has nothing to do with any key the rows share.
   */
  zip<TOther, TResult>(
    other: OrderedQueryable<TOther>,
    result: (row: T, otherRow: TOther) => TResult,
  ): Queryable<TResult>;
  /**
   * `zip`, with a third ordered query paired in alongside the other two.
   *
   * ```ts
   * db.users
   *   .orderBy((u) => u.id)
   *   .zip(
   *     db.cities.orderBy((c) => c.id),
   *     db.orders.orderBy((o) => o.id),
   *     (u, c, o) => ({ who: u.name, city: c.name, order: o.id }),
   *   );
   * ```
   *
   * This is LINQ's three-sequence `Zip`, which is where the family stops: .NET
   * has no overload past it, and neither does this one. The third side costs a
   * second join on the same position every side is already numbered by,
   * rather than a different shape, and the pairing stops at whichever of the
   * three sequences runs out first.
   */
  zip<TOther, TThird, TResult>(
    other: OrderedQueryable<TOther>,
    third: OrderedQueryable<TThird>,
    result: (row: T, otherRow: TOther, thirdRow: TThird) => TResult,
  ): Queryable<TResult>;
  zip(
    other: OrderedQueryable<unknown>,
    thirdOrResult: OrderedQueryable<unknown> | AnyLambda,
    maybeResult?: AnyLambda,
  ): Queryable<unknown> {
    this.requireSameContext(other, 'zip');
    const merged = this.merge(other);

    if (typeof thirdOrResult === 'function') {
      const projector = toExpression(thirdOrResult, { rowParameterCount: 2 });
      return new Queryable(
        this.runtime,
        { kind: 'zip', source: this.plan, other: merged.plan, third: null, projector },
        merged.bags,
        isScalarProjection(projector.body),
      );
    }

    this.requireSameContext(thirdOrResult, 'zip');
    // Merged against the bags `other` already landed in, via `mergeInto`
    // rather than `merge`, so a bag the third query carries is renumbered
    // past both of the first two rather than colliding with either.
    const mergedThird = this.mergeInto(merged.bags, thirdOrResult);
    const projector = toExpression(maybeResult!, { rowParameterCount: 3 });

    return new Queryable(
      this.runtime,
      { kind: 'zip', source: this.plan, other: merged.plan, third: mergedThird.plan, projector },
      mergedThird.bags,
      isScalarProjection(projector.body),
    );
  }

  /**
   * Whether this query and another produce the same rows in the same order,
   * answered in one statement.
   *
   * ```ts
   * const inSync = await db.users
   *   .orderBy((u) => u.id)
   *   .sequenceEqual(replica.users.orderBy((u) => u.id));
   * ```
   *
   * This is LINQ's `SequenceEqual`, and like `zip` it needs both sides ordered:
   * a position only exists once a sequence has one, so the operator lives here
   * rather than on every query and takes an `OrderedQueryable` rather than a
   * plain one.
   *
   * Both sides are numbered by position exactly as `zip` numbers them and
   * compared with a `FULL JOIN` on that number, so a sequence with an extra
   * row at the end fails the comparison the same way one whose rows merely
   * differ does, and no row of either side is read back to find out. Two
   * empty queries are equal, as they are in LINQ.
   */
  sequenceEqual(other: OrderedQueryable<T>): Promise<boolean> {
    this.requireSameContext(other, 'sequenceEqual');

    const merged = this.merge(other);
    const { select } = compileQuery(
      { kind: 'sequenceEqual', source: this.plan, other: merged.plan },
      { dialect: this.runtime.dialect, bags: merged.bags },
    );

    return this.booleanResult(select, merged.bags);
  }

  /**
   * Each row paired with the one before it, both handed to one projector.
   *
   * ```ts
   * db.readings
   *   .orderBy((r) => r.takenAt)
   *   .pairwise((before, now) => ({ at: now.takenAt, change: now.value - before.value }));
   * ```
   *
   * That is a sequence read as its own differences, which is the thing SQL can
   * do and a row-at-a-time loop in the application cannot do cheaply. The
   * earlier row comes first, as in LINQ's `Pairwise`.
   *
   * The first row has nothing before it and makes no pair, so a query of `n`
   * rows returns `n - 1` and an empty or single-row query returns nothing. That
   * is a deliberate reading rather than an accident of the translation: the
   * alternative, pairing the first row with a row of nulls, cannot be told apart
   * from a real earlier row whose columns happened to be null.
   *
   * Which row is "before" is what the ordering decides, which is why this lives
   * here rather than on every query, and why reversing the order pairs each row
   * with the one after it instead. A pair has no shape of its own, so the
   * projector says what a pair is, as it does for `join` and `zip`, and
   * `(before, now) => before` is simply the query shifted by one.
   *
   * Neither row can be navigated off, and this is now the operator that cannot
   * where its neighbours can. Both rows are two views of one derived table over
   * the same columns, and a join is reused per row and property, so one cached
   * join could not tell the earlier view from the later one and both rows would
   * quietly get the same related row. That is a wrong answer rather than a
   * missing capability, so it stays refused. It is the limit
   * `zip`'s projector has for the same reason. Project the navigation before
   * pairing and the pair sees it as an ordinary column.
   *
   * The table is read once. Each column is carried alongside a copy of itself
   * from the row before, so nothing is joined and nothing is scanned twice.
   */
  pairwise<TResult>(result: (previous: T, row: T) => TResult): Queryable<TResult> {
    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<TResult>(
      this.runtime,
      { kind: 'pairwise', source: this.plan, projector },
      this.bags,
      isScalarProjection(projector.body),
    );
  }

  /**
   * Every run of `size` consecutive rows, each handed to one projector beside
   * the row it ends at.
   *
   * ```ts
   * db.readings
   *   .orderBy((r) => r.takenAt)
   *   .windowed(7, (week, now) => ({ at: now.takenAt, mean: week.average((r) => r.value) }));
   * ```
   *
   * That is a seven-day moving average as one statement, which is the thing
   * this exists for: a smoothed series is a property of a row's neighbours
   * rather than of the row, so nothing in the table can answer it and reading
   * the rows back to average them in the application costs the whole table.
   *
   * This is `pairwise` widened, and the receiver widens with it. `pairwise`
   * names both of its rows because there are exactly two; a run of `size` rows
   * has no name for each member and no fixed count to give one to, so it
   * arrives as the same aggregate receiver `groupBy` hands a group and is read
   * with `average`, `sum`, `min`, `max`, `count`, and `toArray`. `countDistinct`
   * is the one a group has and a run does not, because SQL does not define
   * `DISTINCT` over a window; the type says so rather than the database.
   *
   * A run needs `size` rows to be a run, so the first `size - 1` rows produce
   * none and a query of `n` rows returns `n - size + 1`, with fewer than `size`
   * rows returning nothing at all. That is `pairwise`'s own reading widened:
   * pairing the first row with a shorter run cannot be told apart from a full
   * run whose values happened to be null, so the short ones are dropped by
   * position instead. `count()` therefore answers `size` for every row that
   * comes back, which is worth knowing before reaching for it.
   *
   * Which rows are consecutive is what the ordering decides, which is why this
   * lives here rather than on every query. A run trails the row it ends at, so
   * reversing the order makes it lead instead, and the run is the last `size`
   * rows in whichever direction the ordering runs.
   *
   * Unlike `pairwise`, the row can be navigated off: both the run and the row
   * read the query's own rows rather than a derived table's columns, so
   * `(w, r) => r.user.name` resolves the way it would in `select`.
   */
  windowed<TResult>(size: number, result: (run: Run<T>, row: T) => TResult): Queryable<TResult> {
    return this.framedRun('windowed', size, null, result);
  }

  /**
   * Every run of `size` consecutive rows sharing a key, each handed to one
   * projector beside the row it ends at.
   *
   * ```ts
   * db.readings
   *   .orderBy((r) => r.takenAt)
   *   .windowedBy((r) => r.sensorId, 7, (week, now) => ({
   *     at: now.takenAt,
   *     mean: week.average((r) => r.value),
   *   }));
   * ```
   *
   * That is a moving average per sensor rather than across all of them, which
   * is `windowed` with the one thing it cannot say added: its runs reach back
   * over the whole ordering, so a reading from one sensor would be averaged
   * with the six readings before it whoever they belong to. A `groupBy` cannot
   * say it either, since grouping collapses the very rows a frame has to still
   * find behind each one.
   *
   * The runs restart at each key, so the first `size - 1` rows *of every key*
   * produce none rather than only the first `size - 1` of the query. A key with
   * fewer than `size` rows contributes nothing at all, which is `windowed`'s
   * own reading applied per key and is worth knowing when the keys are uneven.
   *
   * The rows come back in the ordering they were in, not grouped by key: a
   * partition decides which rows are behind a row, and the ordering decides
   * where the row itself sits. Return an object from the key selector to
   * partition on more than one expression, as `groupBy` does.
   */
  windowedBy<TResult>(
    key: (row: T) => unknown,
    size: number,
    result: (run: Run<T>, row: T) => TResult,
  ): Queryable<TResult> {
    return this.framedRun('windowedBy', size, key, result);
  }

  /**
   * Every row beside the run of every row up to it, both handed to one
   * projector.
   *
   * ```ts
   * db.readings
   *   .orderBy((r) => r.takenAt)
   *   .expanding((sofar, now) => ({ at: now.takenAt, total: sofar.sum((r) => r.value) }));
   * ```
   *
   * That is a running total as one statement, which is the thing this exists
   * for: a running total is a property of every row up to a row rather than of
   * the row, so nothing in the table holds it and adding the rows up in the
   * application costs the whole table.
   *
   * This is `windowed` with the far end of the run let go, and the run is read
   * exactly as `windowed` reads its own: it arrives as the aggregate receiver
   * `groupBy` hands a group, so `average`, `sum`, `min`, `max`, `count`, and
   * `toArray` all answer over it, and `countDistinct` is the one that does not
   * because SQL defines no `DISTINCT` over a window.
   *
   * Taking no size is what makes it drop no rows, and that is the difference
   * from `windowed` to know before reaching for either. `windowed(n, ...)`
   * discards the first `n - 1` rows for want of a full run; here every row has
   * a run up to it, the first row's being that row alone, so a query of `n`
   * rows returns `n` and an empty one returns nothing. `count()` over the run
   * is then the row's own position counted from one, where over a fixed run it
   * is always the size.
   *
   * Which rows come before is what the ordering decides, which is why this
   * lives here rather than on every query. Reversing the order accumulates
   * from the other end, so the first row handed back carries every row of the
   * query and the last carries itself alone.
   *
   * As with `windowed`, the row can be navigated off: both the run and the row
   * read the query's own rows rather than a derived table's columns, so
   * `(s, r) => r.user.name` resolves the way it would in `select`.
   */
  expanding<TResult>(result: (run: Run<T>, row: T) => TResult): Queryable<TResult> {
    return this.framedRun('expanding', null, null, result);
  }

  /**
   * Every row beside the run of every row up to it sharing a key, both handed
   * to one projector.
   *
   * ```ts
   * db.entries
   *   .orderBy((e) => e.postedAt)
   *   .expandingBy((e) => e.accountId, (sofar, now) => ({
   *     at: now.postedAt,
   *     balance: sofar.sum((e) => e.amount),
   *   }));
   * ```
   *
   * That is a running balance per account read off one statement, which is the
   * reason this exists beside `expanding`: a ledger holding several accounts
   * has no single running total worth reading, and `expanding` can only give
   * the one that adds every account together.
   *
   * The accumulation restarts at each key, so every key gets its own series
   * beginning at its own first row. Unlike `windowedBy` nothing is dropped for
   * it: a run up to a row is never short, so a key with one row still returns
   * that row with itself as its whole run, and `count()` over the run is the
   * position within the key rather than within the query.
   *
   * The rows come back in the ordering they were in, not grouped by key, as
   * `windowedBy`'s do. Return an object from the key selector to partition on
   * more than one expression, as `groupBy` does.
   */
  expandingBy<TResult>(
    key: (row: T) => unknown,
    result: (run: Run<T>, row: T) => TResult,
  ): Queryable<TResult> {
    return this.framedRun('expandingBy', null, key, result);
  }

  /**
   * The plan node the four framed operators share.
   *
   * `windowed` and `expanding` differ from each other in the frame the
   * compiler writes, and each differs from its `*By` spelling in one key, so
   * all four are one node kind carrying an optional partition rather than four
   * nodes or two. What is left to do here is the same for all of them: parse
   * the lambdas, check the size where the caller wrote it, and say whether the
   * projection is a single value.
   *
   * The size is checked here rather than left to the frame it becomes, so a
   * size of zero or a half faults the operator that was written and the stack
   * points at the call site, the way `chunk` and `elementAt` check the numbers
   * they are given. `expanding` and `expandingBy` pass none, having none to get
   * wrong.
   */
  private framedRun<TResult>(
    operator: 'windowed' | 'windowedBy' | 'expanding' | 'expandingBy',
    size: number | null,
    key: ((row: T) => unknown) | null,
    result: (run: Run<T>, row: T) => TResult,
  ): Queryable<TResult> {
    if (size !== null && (!Number.isInteger(size) || size < 1)) {
      throw new InvalidQueryError(
        `"${operator}" expects a positive integer run size but received ${size}.`,
      );
    }

    const projector = toExpression(result, { rowParameterCount: 2 });
    const partition = key ? toExpression(key, { rowParameterCount: 1 }) : null;

    return new Queryable<TResult>(
      this.runtime,
      size === null
        ? { kind: 'expanding', source: this.plan, partition, projector }
        : { kind: 'windowed', source: this.plan, size, partition, projector },
      this.bags,
      isScalarProjection(projector.body),
    );
  }

  /**
   * Each row beside its position in the ordering, both handed to one projector.
   *
   * ```ts
   * db.users
   *   .orderBy((u) => u.score)
   *   .reverse()
   *   .index((u, rank) => ({ name: u.name, rank }));
   * ```
   *
   * That is a leaderboard, which is the usual reason to want a position: it is
   * a property of where a row sits rather than of anything in it, so nothing in
   * the table can answer it and the database has to count.
   *
   * The position counts from zero, as LINQ's `Index` and JavaScript's own
   * iteration do. `ROW_NUMBER` counts from one, and the difference is closed
   * here rather than left for every caller to remember, so `index((u, i) => i)`
   * over three rows gives 0, 1, 2 and a rank displayed to a person wants
   * `rank + 1`. The row comes first and the position second, as they do in
   * JavaScript's `map` and in LINQ's `Select` overload that takes an index.
   *
   * Which position a row has is what the ordering decides, which is why this
   * lives here rather than on every query, and why reversing the order numbers
   * from the other end. A row and a number have no shape between them, so the
   * projector says what the pair is, as it does for `zip` and `pairwise`.
   *
   * The row can be navigated off. It is read back out of a derived table, and
   * the scope over that table stands for the entity rather than for a bag of
   * column names: a foreign key comes out under its own name, so the join is
   * emitted against the derived table instead of the one inside it.
   */
  index<TResult>(result: (row: T, position: number) => TResult): Queryable<TResult> {
    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<TResult>(
      this.runtime,
      { kind: 'index', source: this.plan, projector },
      this.bags,
      isScalarIndexProjection(projector),
    );
  }

  /**
   * Each row beside its standing in the ordering, where tied rows share it.
   *
   * ```ts
   * db.users
   *   .orderByDescending((u) => u.score)
   *   .rank((u, place) => ({ name: u.name, place }));
   * ```
   *
   * That is a leaderboard, which is what `index` looks like it gives and does
   * not. `index` is a position: two users on the same score get different
   * numbers and which of them comes first is whatever the database reached
   * first. This calls them equal, which is the only reading a standing shown to
   * a person can have.
   *
   * The place counts from **one**, unlike `index`, which counts from zero. That
   * is deliberate rather than an inconsistency: `index` is LINQ's `Index` and a
   * position among rows, where every zero-based thing in JavaScript agrees, and
   * a standing is read by someone for whom the first place is first. So this is
   * the operator to reach for instead of `index((u, i) => i + 1)`, and the
   * addition goes away with it.
   *
   * A tie consumes the places it spans, so three users tied for second are all
   * second and the next is fifth: 1, 2, 2, 2, 5. That is what a competition
   * means by a place. Reach for `denseRank` to count 1, 2, 2, 2, 3 instead,
   * which is what a list of distinct scores means.
   *
   * What counts as a tie is what the ordering says, and only that. Two rows tie
   * when they agree on every sort key, so adding a key that separates them —
   * `thenBy((u) => u.id)` — is how a query asks for no ties at all, at which
   * point this and `index((u, i) => i + 1)` answer the same thing.
   *
   * The place is filterable, which is what a leaderboard is usually for:
   * `rank(...).where((r) => r.place <= 10)` is an ordinary query, because the
   * window is computed a level down rather than in the select that reads it.
   *
   * The row can be navigated off, as `index`'s can: it comes back out of a
   * derived table whose columns carry their own names, so the join is emitted
   * against that table rather than the one inside it.
   */
  rank<TResult>(result: (row: T, place: number) => TResult): Queryable<TResult> {
    return this.ranked(false, result);
  }

  /**
   * Each row beside its standing, counting the places without gaps.
   *
   * ```ts
   * db.products
   *   .orderByDescending((p) => p.price)
   *   .denseRank((p, tier) => ({ name: p.name, tier }));
   * ```
   *
   * This is `rank` with the one thing they disagree about changed: a tie does
   * not consume the places it spans, so three products at the same price are
   * all tier 2 and the next is tier 3 rather than tier 5. Where `rank` answers
   * "what place did this come in", this answers "how many distinct values are
   * this one and above", which is why it is the one to reach for when the number
   * is a band rather than a placing.
   *
   * Everything else is `rank`'s: the places count from one, a tie is agreement
   * on every sort key and nothing else, and the number stays filterable.
   */
  denseRank<TResult>(result: (row: T, tier: number) => TResult): Queryable<TResult> {
    return this.ranked(true, result);
  }

  /**
   * The plan node `rank` and `denseRank` share.
   *
   * The two differ by which SQL function is named and by nothing else, so this
   * is one node carrying a flag rather than two nodes whose compile methods
   * would be a copy with a word changed, the way `takeWhile` and `skipWhile`
   * share `WhileNode`.
   */
  private ranked<TResult>(
    dense: boolean,
    result: (row: T, place: number) => TResult,
  ): Queryable<TResult> {
    const projector = toExpression(result, { rowParameterCount: 2 });

    return new Queryable<TResult>(
      this.runtime,
      { kind: 'rank', source: this.plan, dense, projector },
      this.bags,
      // `(u, place) => place` projects the number rather than the row, which is
      // `index`' own question and answered by the same helper.
      isScalarIndexProjection(projector),
    );
  }

  /**
   * `select`, with the row's position among the ordering as a second lambda
   * parameter, the same position `index` computes.
   *
   * ```ts
   * db.users
   *   .orderBy((u) => u.score)
   *   .reverse()
   *   .select((u, rank) => ({ name: u.name, rank }));
   * ```
   *
   * This is LINQ's `Select` overload that takes an index, and it is a second
   * name for `index`'s own statement rather than a second translation of a
   * position: everything `index` documents about where the number comes from,
   * and what it costs applies here unchanged.
   *
   * A lambda is routed here by its own shape, the number of parameters it
   * declares, rather than by anything the caller passes to `select` itself:
   * `(u) => ...` still means what it always has, and only a second parameter
   * asks for a position. That reads unambiguously against the overload taking
   * a params object, since a params object is a second argument to `select`,
   * not a second parameter of the lambda; the two are never in the same call.
   */
  override select<TResult>(projector: (row: T, position: number) => TResult): Queryable<TResult>;
  override select<TResult>(projector: (row: T) => TResult): Queryable<TResult>;
  override select<TResult, TParams extends object>(
    projector: (row: T, params: TParams) => TResult,
    params: TParams,
  ): Queryable<TResult>;
  override select(projector: LooseLambda, params?: object): Queryable<unknown> {
    if (params === undefined && parseLambda(projector).params.length >= 2) {
      return this.index(projector as (row: T, position: number) => unknown);
    }
    return super.select(projector, params);
  }

  /**
   * `where`, with the row's position among the ordering as a second lambda
   * parameter, the same position `index` computes.
   *
   * ```ts
   * db.users
   *   .orderBy((u) => u.score)
   *   .reverse()
   *   .where((u, rank) => rank < 3);
   * ```
   *
   * A window function cannot appear inside the `WHERE` that would read it, so
   * this is its own statement rather than a plain `WHERE` over `index`'s own:
   * the position is numbered in a derived table first, the same one `index`
   * numbers, and the outer statement filters against that column.
   *
   * Routed here the same way `select`'s own position form is, by how many
   * parameters the lambda declares rather than by anything passed to `where`
   * itself, which is what keeps it unambiguous against the params-object
   * overload: a params object is a second argument to `where`, never a
   * second parameter of the lambda.
   */
  override where(predicate: (row: T, position: number) => boolean): Queryable<T>;
  override where(predicate: (row: T) => boolean): Queryable<T>;
  override where<TParams extends object>(
    predicate: (row: T, params: TParams) => boolean,
    params: TParams,
  ): Queryable<T>;
  override where(predicate: LooseLambda, params?: object): Queryable<T> {
    if (params === undefined && parseLambda(predicate).params.length >= 2) {
      const projector = toExpression(predicate, { rowParameterCount: 2 });
      return new Queryable<T>(
        this.runtime,
        { kind: 'wherePosition', source: this.plan, predicate: projector },
        this.bags,
        this.scalar,
      );
    }
    return super.where(predicate, params);
  }

  /**
   * One row per distinct key, keeping the first of each in this order.
   *
   * `distinct` compares whole rows, so two people with the same name are both
   * kept when anything else about them differs. This compares only the key and
   * still returns the whole row:
   *
   * ```ts
   * db.users.orderBy((u) => u.joinedAt).distinctBy((u) => u.cityId);
   * ```
   *
   * That leaves the earliest joiner from each city. Which row survives is a
   * question the ordering answers, which is why this lives here rather than on
   * every query, and why reversing the order gives the latest joiner instead.
   * Return an object from the key selector to make the key more than one
   * expression, as `groupBy` does.
   */
  distinctBy(key: (row: T) => unknown): Queryable<T> {
    return this.perKeyWindow('distinctBy', key, 0, 1);
  }

  /**
   * The first `count` rows of each key, in this order.
   *
   * ```ts
   * db.products.orderByDescending((p) => p.price).takeBy((p) => p.categoryId, 3);
   * ```
   *
   * That is the three most expensive products of every category, as one
   * statement over one pass of the table. `take(3)` is the query that looks
   * like this and is not: it keeps three rows in total and hands them to
   * whichever categories they happened to belong to. The rows are numbered
   * within each key instead, which is `distinctBy`'s window with its `= 1`
   * widened into a range.
   *
   * Which rows survive is a question the ordering answers, which is why this
   * lives here rather than on every query, and why reversing the order takes
   * the cheapest three of each category instead. Return an object from the key
   * selector to make the key more than one expression, as `groupBy` does.
   *
   * A key with fewer than `count` rows keeps all of them rather than being
   * dropped, so this narrows each key and never removes one. The rows are whole
   * rows and can be navigated off, `distinctBy`'s own rows having learnt the
   * same trick: they come back out of a derived table carrying their columns
   * under their own names, so a navigation joins against that table. The join
   * therefore runs after the window rather than before it, which is the useful
   * order — the three most expensive products of each category, and then their
   * category's name.
   */
  takeBy(key: (row: T) => unknown, count: number): Queryable<T> {
    return this.perKeyWindow('takeBy', key, 0, nonNegative(count, '"takeBy"'));
  }

  /**
   * Everything but the first `count` rows of each key, in this order.
   *
   * ```ts
   * db.backups.orderByDescending((b) => b.takenAt).skipBy((b) => b.databaseId, 3);
   * ```
   *
   * That is every backup except the three most recent of each database, which
   * is the usual shape of a retention query and the usual reason to want this:
   * the rows to delete are the ones a `takeBy` would have kept the complement
   * of. It is the same cut read from the other side, so the two share a
   * compilation and differ in which end of the window is open, exactly as
   * `takeWhile` and `skipWhile` differ in a comparison.
   *
   * A key with `count` rows or fewer contributes nothing, which is the mirror
   * of `takeBy` keeping a short key whole. Skipping zero is every row, as
   * `skip(0)` is.
   *
   * Which rows are first is the ordering's decision, as it is for `takeBy`, so
   * this lives here rather than on every query.
   */
  skipBy(key: (row: T) => unknown, count: number): Queryable<T> {
    return this.perKeyWindow('skipBy', key, nonNegative(count, '"skipBy"'), null);
  }

  /**
   * The plan node `distinctBy`, `takeBy`, and `skipBy` share.
   *
   * Three operators and one window, differing in two numbers: `distinctBy` is
   * the first row of each key, `takeBy` the first `count`, `skipBy` everything
   * past them. A filtered `include` builds the same node for its own window,
   * which is why the node exists rather than a `DistinctByNode` would.
   *
   * The name travels with it because the node cannot infer which spelling was
   * written from the numbers alone — `takeBy(key, 1)` and `distinctBy(key)`
   * build the same window — and an error about a missing ordering has to name
   * what the caller actually wrote.
   */
  private perKeyWindow(
    operator: string,
    key: (row: T) => unknown,
    skip: number,
    take: number | null,
  ): Queryable<T> {
    return new Queryable<T>(
      this.runtime,
      {
        kind: 'perKey',
        source: this.plan,
        key: toExpression(key, { rowParameterCount: 1 }),
        skip,
        take,
        operator,
      },
      this.bags,
      this.scalar,
    );
  }

  /**
   * The rows in runs, cut wherever the key changes from one row to the next.
   *
   * ```ts
   * for await (const run of db.readings.orderBy((r) => r.takenAt).chunkBy((r) => r.status)) {
   *   await report(run[0]!.status, run.length);
   * }
   * ```
   *
   * This is not `groupBy`, which collects every row of a key wherever it sits.
   * Over statuses reading `ok, ok, failed, ok` this yields three runs and
   * `groupBy` gives two groups, and the runs are what say the failure was one
   * episode rather than a share of the day. Being positional, it needs an
   * ordering to say which rows are next to each other, which is why it lives
   * here rather than on every query.
   *
   * Each run is its own statement, so this holds one run in memory rather than
   * the whole result, as `chunk` does for a fixed batch size. The runs are
   * numbered in the database over the same ordering the query already carries,
   * which is what lets the loop ask for one without reading the ones ahead of
   * it. Two things follow, both of them `chunk`'s. Rows written while the loop
   * runs can move a boundary and renumber everything behind it, so read inside
   * a transaction when that matters. And a run is bounded by the key rather
   * than by a size the caller chose: a key that never changes is one run and
   * one statement returning every row.
   *
   * A key that is null matches a key that is null, as it does in LINQ and not
   * in SQL, so consecutive rows missing the key form one run rather than one
   * each. Return an object from the key selector to make the key more than one
   * expression, as `groupBy` does; a run then continues only while every part
   * of it does.
   */
  chunkBy(key: (row: T) => unknown): AsyncIterableIterator<T[]> {
    // Parsed here rather than inside the generator, whose body would not run
    // until the first run was asked for, long after a bad selector was written.
    // This is `chunk` checking its batch size eagerly, for the same reason.
    return this.runs(toExpression(key, { rowParameterCount: 1 }));
  }

  /** Walks the runs one statement at a time, stopping at the first empty one. */
  private async *runs(key: LambdaExpression): AsyncIterableIterator<T[]> {
    for (let index = 0; ; index += 1) {
      const rows = await this.derive({
        kind: 'chunkBy',
        source: this.plan,
        key,
        index,
      }).toArray();

      // The runs are numbered without gaps, so the first empty answer is past
      // the end rather than a hole to read through. That is what `chunk` cannot
      // assume of a short page, and it is why this needs no extra statement to
      // learn it has finished.
      if (rows.length === 0) return;
      yield rows;
    }
  }

  /**
   * The same rows in the opposite order.
   *
   * ```ts
   * db.users.orderBy((u) => u.joinedAt).reverse().take(3);
   * ```
   *
   * That is the three newest users, which is what makes this the cheap way to
   * reach the end of a sequence: SQL can only page from the front.
   *
   * Reversing an order is not the same as reversing a sequence, and this is the
   * first: every sort key flips direction, so no window, subquery, or second
   * sort is involved and `reverse().reverse()` is the query it started as. The
   * difference shows only among rows that tie on every key, which SQL leaves in
   * whatever order it likes either way, where LINQ's `Reverse` over a list in
   * memory would swap them.
   *
   * An order is what there is to reverse, so this lives here rather than on
   * every query, the way `thenBy` does.
   */
  reverse(): OrderedQueryable<T> {
    return this.reordered(
      this.keys.map((entry) => ({ key: entry.key, descending: !entry.descending })),
    );
  }

  /**
   * The final row of an ordered query, the complement of `first`.
   *
   * ```ts
   * db.users.orderBy((u) => u.joinedAt).last();
   * ```
   *
   * SQL pages from the front only, so this reaches the end the way `reverse`
   * does: every sort key flipped, then the first row of that. No plan node, no
   * derived table, and no window, since `reverse` already reduces the question
   * to one `first` already answers.
   *
   * Which row is last is a question the ordering answers, which is why this
   * lives here rather than on every query. Rows that tie on every sort key
   * make that the database's choice, as it is for `reverse` and `takeLast`;
   * add a tiebreaking key with `thenBy` when that matters. An empty query is a
   * `SequenceError`, as `first` already makes it.
   */
  async last(): Promise<T> {
    const rows = await this.reverse().take(1).toArray();
    if (rows.length === 0) {
      throw new SequenceError('The query returned no rows but "last" requires at least one.');
    }
    return rows[0]!;
  }

  /** As `last`, but `null` rather than an error when the query has no rows. */
  async lastOrDefault(): Promise<T | null> {
    const rows = await this.reverse().take(1).toArray();
    return rows.length === 0 ? null : rows[0]!;
  }

  /**
   * `elementAt` and `elementAtOrDefault`'s own window, widened to accept a
   * negative index the way `Array.prototype.at` reads one: `-1` is the last
   * row, `-2` the one before it.
   *
   * A negative index only names a row once there is an ordering to count
   * backward from, which is why this lives here rather than on every query,
   * the same reason `last` does. Reaching it is `reverse`'s own trick, one
   * step further: flip the ordering and skip to the position counted from the
   * front of that. `elementAt(-1)` is `skip(0)` of the reversed query, which
   * is `last`'s own statement exactly.
   *
   * Rows that tie on every sort key make which one a given negative index
   * lands on the database's choice, as they do for `reverse` and `last`; add
   * a tiebreaking key with `thenBy` when that matters.
   */
  protected override at(index: number, operator: string): Promise<T[]> {
    if (!Number.isInteger(index)) {
      throw new InvalidQueryError(`"${operator}" expects an integer index but received ${index}.`);
    }
    if (index >= 0) return super.at(index, operator);

    return this.reverse()
      .skip(-index - 1)
      .take(1)
      .toArray();
  }

  thenBy(key: (row: T) => unknown): OrderedQueryable<T> {
    return this.appendKey(key, false);
  }

  thenByDescending(key: (row: T) => unknown): OrderedQueryable<T> {
    return this.appendKey(key, true);
  }

  /**
   * A tag on an ordered query, which stays an ordered query.
   *
   * The tag goes under the ordering rather than over it, which is what lets
   * `thenBy` still find it. A further sort key rebuilds the `orderBy` node from
   * the plan it was applied to, so a tag wrapped around that node would be the
   * one thing a later `thenBy` threw away. Putting it underneath costs nothing:
   * a tag is transparent to compilation, and every tag prints at the top of the
   * statement wherever in the plan it sits.
   */
  override tag(text: string): OrderedQueryable<T> {
    const tagged: QueryPlan = { kind: 'tag', source: this.orderSource, text: checkedTag(text) };

    return new OrderedQueryable<T>(
      this.runtime,
      { kind: 'orderBy', source: tagged, keys: this.keys },
      this.bags,
      this.scalar,
      tagged,
      this.keys,
    );
  }

  private appendKey(key: (row: T) => unknown, descending: boolean): OrderedQueryable<T> {
    return this.reordered([
      ...this.keys,
      { key: toExpression(key, { rowParameterCount: 1 }), descending },
    ]);
  }

  /** Rebuilds the query over a new list of sort keys, replacing the old one. */
  private reordered(keys: readonly OrderKey[]): OrderedQueryable<T> {
    return new OrderedQueryable<T>(
      this.runtime,
      { kind: 'orderBy', source: this.orderSource, keys },
      this.bags,
      this.scalar,
      this.orderSource,
      keys,
    );
  }
}

/**
 * The result selector `countBy` is `groupBy` with.
 *
 * Built as expression IR rather than parsed from an arrow function written
 * here, because a lambda only becomes an expression by way of its own source
 * text, and the source text of one belonging to this library is whatever the
 * bundler left behind.
 */
const COUNT_BY: LambdaExpression = {
  kind: 'lambda',
  parameters: ['key', 'group'],
  body: object([
    { name: 'key', value: parameter('key') },
    { name: 'count', value: call(parameter('group'), 'count', []) },
  ]),
};

/**
 * The result selector `sumBy` is `groupBy` with, over the value selector it
 * was handed.
 *
 * `COUNT_BY` is a constant and this is a function, which is the whole
 * difference between the two operators: a count has nothing to say about the
 * rows beyond how many there are, and a total has to name the value. The
 * caller's lambda is dropped in as the argument to `group.sum(...)` rather
 * than re-parsed, since it arrived here already an expression.
 *
 * Built as IR rather than parsed from an arrow function written here, for
 * `COUNT_BY`'s reason: a lambda only becomes an expression by way of its own
 * source text, and the source text of one belonging to this library is
 * whatever the bundler left behind. That reason applies with more force here,
 * because there would be no way to splice a caller's lambda into source text
 * at all.
 *
 * A value selector whose parameter is itself named `key` or `group` shadows
 * the two above, which is what the same lambda written out by hand inside a
 * `groupBy` would do, and what JavaScript's own scoping would do. The
 * compiler binds the selector's parameter to the pre-group rows either way.
 */
function sumBySelector(value: LambdaExpression): LambdaExpression {
  return {
    kind: 'lambda',
    parameters: ['key', 'group'],
    body: object([
      { name: 'key', value: parameter('key') },
      { name: 'sum', value: call(parameter('group'), 'sum', [value]) },
    ]),
  };
}

/**
 * The row parameter `after` and `before` build their predicate over.
 *
 * The sort keys it rebuilds each carry a parameter name of their own, whatever
 * the caller happened to write in `orderBy` and in every `thenBy` after it, and
 * one predicate has one parameter. Naming it here rather than borrowing the
 * first key's is what keeps the rebuilt accesses agreeing with each other when
 * the keys did not agree among themselves.
 */
const CURSOR_ROW = 'cursor';

/**
 * The property a sort key reads, or a refusal naming the key that does not
 * read one.
 *
 * `after` and `before` compare against a value taken off the row the caller
 * hands back, so a key has to be something that row actually carries. `(u) => u.id` is; a
 * computed key such as `(u) => u.name.length` is not, and neither is one
 * reached through a navigation, since the related row is not on the cursor
 * either unless it was included and is not a column the comparison could name
 * regardless. The check is against the key's own parameter rather than any
 * member access, so `(u) => u.id` passes and `(u) => p.id` — a params
 * reference that happens to be a member — does not.
 *
 * Refused here, when the operator is called, rather than left to the compiler,
 * for `countBy`'s reason: the caller wrote the `orderBy`, and the message
 * should name the key rather than the `where` this would have become. Which
 * operator it names is passed in for the same reason, `before` being as able
 * to be handed a computed key as `after` is.
 */
function seekableKey(sortKey: OrderKey, index: number, operator: string): string {
  const body = sortKey.key.body;

  if (
    body.kind === 'member' &&
    body.object.kind === 'parameter' &&
    body.object.name === sortKey.key.parameters[0]
  ) {
    return body.property;
  }

  throw new InvalidQueryError(
    `"${operator}" needs every sort key to be a plain property of the row, since the cursor's ` +
      `value for it is read off the row the caller was handed, but sort key ${index + 1} is an ` +
      'expression. Order by the column itself, or page with "skip".',
  );
}

/**
 * The lexicographic "comes after the cursor" comparison over a list of sort
 * keys.
 *
 * One comparison per key, each guarded by the keys before it having tied:
 * `a > $a OR (a = $a AND b > $b)`. That is how SQL orders a row and how a
 * dictionary orders a word, and it is why this cannot be a conjunction of
 * independent comparisons — `a > $a AND b > $b` would drop every row that
 * genuinely comes after on `a` while sitting below the cursor on `b`, which is
 * most of them.
 *
 * A descending key flips its own comparison and nothing else, since "after" in
 * a descending ordering means a smaller value. The equality guarding the keys
 * behind it is unaffected either way: a tie is a tie in both directions. That
 * is also the whole of what `before` needs, which reverses the ordering and
 * arrives here with every key already flipped.
 */
function seekPredicate(
  parts: readonly { property: string; descending: boolean }[],
  bagId: string,
): ExpressionNode {
  const read = (property: string): ExpressionNode => member(parameter(CURSOR_ROW), property);
  const bound = (property: string): ExpressionNode => external([bagId, property]);

  const clauses = parts.map((part, index) => {
    const ties = parts
      .slice(0, index)
      .map((earlier) => binary('==', read(earlier.property), bound(earlier.property)));

    const advance = binary(part.descending ? '<' : '>', read(part.property), bound(part.property));

    return [...ties, advance].reduce((left, right) => binary('&&', left, right));
  });

  return clauses.reduce((left, right) => binary('||', left, right));
}

/**
 * The predicate matching a row the given one did not accept.
 *
 * `NOT p` alone does not describe that row. A predicate that is null rather
 * than true is unknown, and `NOT` of unknown is unknown too, so a row a
 * comparison against null landed on would answer neither the predicate nor its
 * negation and quietly count as a match. Asking for the null as well is what
 * makes such a row a failure, which is what the filter it mirrors makes of it.
 *
 * The body is mentioned twice, which costs nothing where placeholders are
 * numbered: the printer binds one value and repeats its placeholder.
 */
function negate(predicate: LambdaExpression): LambdaExpression {
  return {
    ...predicate,
    body: binary('||', unary('!', predicate.body), binary('==', predicate.body, constant(null))),
  };
}

/**
 * The predicate that matches a row against a key captured by `groupBy`, part
 * by part.
 *
 * A composite key is one written as an object literal and is matched only
 * when every part agrees, the rule `chunkBy`'s own key comparison applies at
 * the SQL level. Comparing with `==` alone would miss a null key: SQL's `=`
 * against a null parameter is unknown rather than true, so a row is also
 * compared against a literal null on both sides, which is what turns an
 * ordinary comparison into one a null key survives, the way `negate` already
 * treats a predicate that is null as a match for its own complement.
 */
function matchesKey(keyBody: ExpressionNode, bagId: string): ExpressionNode {
  if (keyBody.kind === 'object') {
    return keyBody.properties
      .map((property) => nullSafeEquals(property.value, external([bagId, property.name])))
      .reduce((left, right) => binary('&&', left, right));
  }
  return nullSafeEquals(keyBody, external([bagId]));
}

/**
 * A comparison a null on either side survives, rather than one it turns
 * unknown.
 *
 * SQL's `=` against a null answers unknown rather than true, so an operator
 * that treats null as a value of its own has to say the second half out loud.
 * Both callers do: `groupBy` collects the rows sharing a null key into one
 * group, and `contains(null)` finds them, which is the reading `distinctBy`,
 * `chunkBy`, and `countDistinct` had already settled on.
 */
function nullSafeEquals(value: ExpressionNode, other: ExpressionNode): ExpressionNode {
  return binary(
    '||',
    binary('==', value, other),
    binary('&&', binary('==', value, constant(null)), binary('==', other, constant(null))),
  );
}

/**
 * The one column a scalar projection kept, under the alias it kept it as.
 *
 * `value` is what the compiler names a projection of a single expression and
 * what the materializer unwraps a row down to, so it is also the name an
 * operator reads that value back through. Naming it is what `order` and
 * `contains` do instead of taking a `(x) => x` from the caller: a lambda
 * handing its parameter straight back says the same thing and cannot be
 * translated at all, since a bare row parameter is not a value the compiler
 * will resolve.
 */
const SCALAR_VALUE: ExpressionNode = member(parameter('value'), 'value');

/** A lambda whose one parameter is a scalar-shaped row, built rather than parsed. */
function overScalar(body: ExpressionNode): LambdaExpression {
  return { kind: 'lambda', parameters: ['value'], body };
}

/**
 * Whether a projection body yields a single unnamed value.
 *
 * A row parameter and an object literal both produce named columns; anything
 * else is one expression, which the compiler aliases as `value` and the
 * materializer unwraps.
 */
function isScalarProjection(body: ExpressionNode): boolean {
  return body.kind !== 'object' && body.kind !== 'parameter';
}

/**
 * The same question for an `index` projector, whose second parameter is a value.
 *
 * A bare parameter is normally the row, and a row keeps its columns; here it may
 * be the position instead, which is one value and is unwrapped like any other
 * scalar. The compiler had always read `(u, i) => i` that way and aliased the
 * column `value`; asking the general question here answered "not a scalar" and
 * left the caller a row with one property called `value` in it. Where two
 * places decide the same thing, a projector that binds something other than a
 * row needs its own reading in both.
 */
function isScalarIndexProjection(projector: LambdaExpression): boolean {
  const body = projector.body;
  if (body.kind === 'parameter') return body.name === projector.parameters[1];
  return isScalarProjection(body);
}

/**
 * The same question for a `groupBy` result selector.
 *
 * A bare parameter is normally a row, and rows keep their columns. The
 * exception is `(key, group) => key` over a key that is a single expression:
 * that projects one value, and is unwrapped like any other scalar.
 */
function isScalarGroupProjection(projector: LambdaExpression, key: LambdaExpression): boolean {
  const body = projector.body;
  if (body.kind === 'parameter') {
    return body.name === projector.parameters[0] && key.body.kind !== 'object';
  }
  return isScalarProjection(body);
}

/** Builds the root query for an entity. Used by `createDbContext`. */
export function queryableFor<TEntity extends AnyEntity>(
  runtime: QueryRuntime,
  entity: TEntity,
): EntitySet<TEntity> {
  return new EntitySet<TEntity>(runtime, entity);
}
