import { ModelError } from '../errors.js';
import type { ExpressionNode, LambdaExpression } from '../expression/nodes.js';
import type { EntityDefinition } from '../metadata/entity.js';

/** One sort key of an `ORDER BY`, in the order the caller declared it. */
export interface OrderKey {
  readonly key: LambdaExpression;
  readonly descending: boolean;
}

export interface SourceNode {
  readonly kind: 'source';
  readonly entity: EntityDefinition;
}

/**
 * A source read from a raw SQL fragment rather than the table `SourceNode`
 * reads, the escape hatch for the handful of statements no translator here
 * builds: a CTE, a window this library does not expose, a database-specific
 * hint.
 *
 * `sql` is the tagged template's literal parts and `values` the expressions
 * between them, one fewer, so `sql[i]` is followed by `values[i]` for every
 * `i` up to `values.length`. Every value is built with `constant`, never
 * anything read off a row, since a raw source is written before there is a
 * row to read one off; it travels as an ordinary bound parameter rather than
 * text spliced into the fragment, which is what keeps a value carrying a
 * quote from becoming a second statement.
 *
 * A leaf for `SourceNode`'s own reason, and it carries an entity for the same
 * reason that one does: the fragment has to answer with the same columns,
 * under the same physical names, that reading the table plainly would, so
 * whatever composes on top still knows what it is reading.
 */
export interface RawSourceNode {
  readonly kind: 'rawSource';
  readonly entity: EntityDefinition;
  readonly sql: readonly string[];
  readonly values: readonly ExpressionNode[];
}

/**
 * A single row with no table behind it, built from a value handed to `append`
 * rather than read off one.
 *
 * A leaf for the reason `SourceNode` is one: it has no source of its own to
 * recurse into, and is never asked for its root entity, since it only ever
 * appears as the far side of the `UNION ALL` `append` compiles to, never as
 * the query being written through.
 *
 * `row` is an object literal expression when the row has named columns, and a
 * bare expression when the query it joins projects a single scalar value, the
 * same distinction `select`'s own projector makes.
 */
export interface LiteralRowNode {
  readonly kind: 'literalRow';
  readonly row: ExpressionNode;
}

export interface WhereNode {
  readonly kind: 'where';
  readonly source: QueryPlan;
  readonly predicate: LambdaExpression;
}

/**
 * A comment to carry into the generated SQL, so a statement in the database's
 * log can be traced back to the code that wrote it.
 *
 * This is the one node that changes nothing about what the query means. It is a
 * node all the same, because the text has to survive every operator written
 * after it and the plan is the only thing that does; and because a tag written
 * inside a query that is later combined with another still belongs to the
 * statement they compile to, which only something the compiler walks can know.
 */
export interface TagNode {
  readonly kind: 'tag';
  readonly source: QueryPlan;
  readonly text: string;
}

export interface SelectNode {
  readonly kind: 'select';
  readonly source: QueryPlan;
  readonly projector: LambdaExpression;
}

export interface OrderByNode {
  readonly kind: 'orderBy';
  readonly source: QueryPlan;
  readonly keys: readonly OrderKey[];
}

export interface SkipNode {
  readonly kind: 'skip';
  readonly source: QueryPlan;
  readonly count: number;
}

export interface TakeNode {
  readonly kind: 'take';
  readonly source: QueryPlan;
  readonly count: number;
}

/**
 * An ordered sequence cut `count` rows from its end, keeping one side:
 * `takeLast` those rows, `skipLast` everything before them.
 *
 * Which rows are last is what an ordering decides, so these are positional
 * where `take` and `skip` are not, and both live on `OrderedQueryable`. They
 * share a node for the reason `takeWhile` and `skipWhile` do: one compilation
 * answers both. The order is flipped so the end of the sequence comes first,
 * and what separates the two is then a `LIMIT` against an `OFFSET`.
 *
 * Neither is sugar over `reverse().take(n)` or `reverse().skip(n)`, which
 * answer with the rows backwards. Putting them back the way the caller asked
 * for them is the other half of the operator rather than a detail of reading it.
 */
export interface LastNode {
  readonly kind: 'last';
  readonly source: QueryPlan;
  readonly count: number;
  /** True keeps the last `count` rows, false keeps everything before them. */
  readonly take: boolean;
}

export interface DistinctNode {
  readonly kind: 'distinct';
  readonly source: QueryPlan;
}

/**
 * Two plans combined as sets: their union, their intersection, or their
 * difference.
 *
 * `all` decides whether duplicate rows survive, which is what separates LINQ's
 * `Union` from its `Concat`.
 */
export interface SetOperationNode {
  readonly kind: 'setOperation';
  readonly source: QueryPlan;
  readonly other: QueryPlan;
  readonly operator: 'union' | 'intersect' | 'except';
  readonly all: boolean;
}

/**
 * An ordered sequence cut in two at the first row to fail a predicate, keeping
 * one side: `takeWhile` the leading run, `skipWhile` everything from the
 * failure onward.
 *
 * Unlike `where`, which keeps every matching row wherever it sits, these are
 * positional. That only means anything over an ordering, which is why they live
 * on `OrderedQueryable` rather than on every query. Both sides of the cut fall
 * out of one compilation, so they share a node and differ by `take`.
 */
export interface WhileNode {
  readonly kind: 'while';
  readonly source: QueryPlan;
  readonly predicate: LambdaExpression;
  /** True keeps the rows before the first failure, false keeps the rest. */
  readonly take: boolean;
}

/**
 * A window of the rows of each key, taken in the query's own order.
 *
 * Four operators are this node, and they differ in two numbers and nothing
 * else. `distinctBy` keeps one row of each key, which is where the shape came
 * from; `takeBy` keeps the first `take`, which is what "the top three products
 * per category" means; `skipBy` keeps everything past the first `skip`, which
 * is the same cut read from the other side; and a filtered `include` keeps a
 * window the caller chose, which is what "the ten most recent orders per user"
 * means. One compilation answers all four rather than four copies of it, and
 * the node carries the operator's name so an error can say which one the
 * caller wrote.
 *
 * `take` being nullable is what lets `skipBy` cost nothing: a window open at
 * the far end is "the rest of this key", so the same two numbers describe a
 * head, a tail, and a range without a third field.
 *
 * Unlike `distinct`, which compares whole rows, this compares only the key and
 * still returns the whole row, so the question of *which* rows survive is
 * positional and an ordering is part of the operator rather than a garnish on
 * it.
 */
export interface PerKeyNode {
  readonly kind: 'perKey';
  readonly source: QueryPlan;
  readonly key: LambdaExpression;
  /** How many rows of each key to pass over before keeping any. */
  readonly skip: number;
  /** How many to keep after that, or `null` for the rest of the key. */
  readonly take: number | null;
  /** The operator as the caller spelled it, for the errors it may raise. */
  readonly operator: string;
}

/**
 * One run of consecutive rows sharing a key, chosen by its position among the
 * runs.
 *
 * This is not `groupBy`, which collects every row of a key wherever it sits. A
 * key that appears, gives way to another, and comes back makes two runs here
 * and one group there. That difference is positional, so an ordering is part of
 * the operator rather than a garnish on it, as it is for `distinctBy`.
 *
 * The node carries which run to return because the runs are numbered in the
 * database and one statement reads one of them. That is what lets a table too
 * large to materialise still be walked a run at a time, the way `chunk` pages
 * with `LIMIT` and `OFFSET`.
 */
export interface ChunkByNode {
  readonly kind: 'chunkBy';
  readonly source: QueryPlan;
  readonly key: LambdaExpression;
  /** Which run to return, counted from zero over the query's ordering. */
  readonly index: number;
}

/**
 * The rows of one plan whose key does, or does not, appear in another:
 * `intersectBy` keeps the matches, `exceptBy` keeps the rest.
 *
 * These are not `intersect` and `except`, which compare whole rows and can only
 * meet a query of the same shape. Comparing a key alone lets the two sides be
 * different entities, which is the usual case: the rows being named are named
 * by something narrow, and the rows to return are wide.
 *
 * Both keys are held rather than one because SQL has no notion of a sequence of
 * bare keys; the other side is a query like any other, and how to read a key off
 * it is its own question. Nothing here is positional, so unlike `distinctBy`
 * this needs no ordering: whether a key appears somewhere is a question about a
 * set, and every row that survives would have survived in any order.
 *
 * The two share a node for the reason `takeWhile` and `skipWhile` do: one
 * compilation answers both, a correlated `EXISTS` that `exceptBy` negates.
 * `union` has no place in the field, because uniting by key is not a question
 * about whether a row belongs but about which of two rows carrying one key to
 * keep, which no `EXISTS` can say.
 */
export interface SetOperationByNode {
  readonly kind: 'setOperationBy';
  readonly source: QueryPlan;
  readonly other: QueryPlan;
  readonly key: LambdaExpression;
  readonly otherKey: LambdaExpression;
  /** `intersect` keeps a row whose key appears, `except` keeps one whose does not. */
  readonly operator: 'intersect' | 'except';
}

/**
 * At most `count` rows drawn at random from the source.
 *
 * This is a node of its own rather than sugar over `orderBy(random).take(n)`
 * because the random value is the dialect's to choose, and because ordering by
 * it is an implementation detail: a sample has no order a caller can rely on.
 */
export interface SampleNode {
  readonly kind: 'sample';
  readonly source: QueryPlan;
  readonly count: number;
}

/**
 * A join of two plans, matched on one key drawn from each side.
 *
 * `source` is the outer sequence and `inner` the joined one, mirroring LINQ's
 * `Join`. The projector takes both rows and produces the single flat row the
 * rest of the pipeline keeps filtering, ordering, and paging.
 *
 * `joinKind` decides which side survives a row with no match on the other:
 * `inner` drops it, `left` keeps the outer row with the joined side's columns
 * null, `right` keeps the joined row with the outer side's columns null, and
 * `full` keeps both. The field is named apart from `kind` because that one
 * already discriminates this node from every other kind of plan.
 */
export interface JoinNode {
  readonly kind: 'join';
  readonly joinKind: 'inner' | 'left' | 'right' | 'full';
  readonly source: QueryPlan;
  readonly inner: QueryPlan;
  readonly outerKey: LambdaExpression;
  readonly innerKey: LambdaExpression;
  readonly projector: LambdaExpression;
}

/**
 * A join that hands each outer row the rows matching it, rather than one row
 * per match.
 *
 * This is LINQ's `GroupJoin`, and the shape SQL cannot return directly: a row
 * has columns, not a nested sequence. What it can answer is a question *about*
 * those rows, so the projector receives a `Group<TInner>` and reads aggregates
 * off it, exactly as `groupBy`'s result selector does.
 *
 * Each aggregate becomes a correlated subquery over the matching rows rather
 * than a `LEFT JOIN` with a `GROUP BY` around it. The join would have to group
 * by every column of the outer row to put it back together, which merges two
 * outer rows that happen to be identical and answers one row where `GroupJoin`
 * answers two. A subquery leaves the outer query untouched, so the result is
 * one row per outer row however the outer rows are shaped.
 */
export interface GroupJoinNode {
  readonly kind: 'groupJoin';
  readonly source: QueryPlan;
  readonly inner: QueryPlan;
  readonly outerKey: LambdaExpression;
  readonly innerKey: LambdaExpression;
  readonly projector: LambdaExpression;
}

/**
 * Two or three ordered plans paired off by position: first with first, second
 * with second, stopping wherever the shortest one runs out.
 *
 * SQL has no notion of a row's position, so each side is numbered over its own
 * ordering and every side is matched on that number. All of them must
 * therefore be ordered, which is why the operator lives on `OrderedQueryable`
 * and takes one. `third` is null for the two-sequence overload, LINQ's own
 * stopping point: there is no `Zip` past three.
 */
export interface ZipNode {
  readonly kind: 'zip';
  readonly source: QueryPlan;
  readonly other: QueryPlan;
  readonly third: QueryPlan | null;
  readonly projector: LambdaExpression;
}

/**
 * Whether two ordered plans produce the same rows in the same order,
 * answered in one statement rather than by reading both back and comparing
 * them in memory.
 *
 * Both sides are numbered by position exactly as `zip` numbers them, and this
 * is a plan node for the reason `zip` is one and `countBy` is not: a length
 * mismatch has to show up as a row rather than as something read after the
 * fact, which is what pairing the two numberings with a `FULL JOIN` gives —
 * a position only one side reaches joins against nothing and comes back null
 * on the other. One statement then asks whether any position disagrees,
 * without a row of either side ever leaving the database.
 */
export interface SequenceEqualNode {
  readonly kind: 'sequenceEqual';
  readonly source: QueryPlan;
  readonly other: QueryPlan;
}

/**
 * Each row of an ordered sequence paired with the one before it.
 *
 * The first row has nothing before it and produces no pair, so a query of `n`
 * rows becomes `n - 1`, which is what LINQ's `Pairwise` answers and what makes
 * this the operator for reading a sequence as its own differences.
 *
 * The projector takes both rows and produces the single flat row the rest of the
 * pipeline keeps filtering, ordering, and paging, as `join` and `zip` do, since
 * a pair has no shape of its own here.
 *
 * Which row is "before" is what an ordering decides, so the operator lives on
 * `OrderedQueryable` and reverses with the order it was given.
 */
export interface PairwiseNode {
  readonly kind: 'pairwise';
  readonly source: QueryPlan;
  readonly projector: LambdaExpression;
}

/**
 * Every run of `size` consecutive rows of an ordered sequence, each run handed
 * to a projector beside the row it ends at.
 *
 * This is `pairwise` widened from two rows to any number, and it widens the
 * receiver with it. `pairwise` can name both of its rows because there are two
 * of them; a run of `size` rows has no name for each member and no fixed count
 * to give one to, so it arrives as the same aggregate receiver a group does and
 * is read with `average`, `sum`, `min`, `max`, and `count`. That is what makes
 * a moving average one statement rather than a loop.
 *
 * A run needs `size` rows to be a run, so the first `size - 1` rows produce
 * none and a query of `n` rows becomes `n - size + 1`, which is `pairwise`'s
 * own `n - 1` at `size` of two. The rows are dropped by position rather than by
 * testing the aggregate for null, for `pairwise`'s reason: an incomplete run
 * over a column of nulls is indistinguishable from a complete one.
 *
 * Which rows are consecutive is what an ordering decides, so the operator lives
 * on `OrderedQueryable` and reverses with the order it was given: a run trails
 * the row it ends at, and reversing the order makes it lead instead.
 *
 * A `partition` restarts the runs per key, which is what `windowedBy` adds and
 * `windowed` leaves null. It is a key rather than a node of its own because a
 * frame already knows how to be partitioned: `SqlOver` has carried
 * `partitionBy` since it was written, so the whole of the difference is which
 * expressions go in it and which rows the short-run test counts within.
 */
export interface WindowedNode {
  readonly kind: 'windowed';
  readonly source: QueryPlan;
  /** How many consecutive rows make a run. Checked by the operator, never bound. */
  readonly size: number;
  /** The key the runs restart per, or null to run over the whole ordering. */
  readonly partition: LambdaExpression | null;
  readonly projector: LambdaExpression;
}

/**
 * Every row of an ordered sequence beside the run of every row up to and
 * including it, handed to a projector the way `windowed` hands it a run.
 *
 * This is `windowed` with the near end of the frame let go. A run of `size`
 * rows reaches back `size - 1` rows; this reaches back to wherever the
 * ordering starts, so the aggregates over it are running ones and a running
 * total is one statement rather than a scan the application re-adds row by row.
 *
 * Taking no size is what makes it drop no rows, which is the difference from
 * `windowed` worth knowing. Every row has a run up to it, the first row's
 * being itself alone, so `n` rows stay `n` where `windowed` returns
 * `n - size + 1` and there is no position left to test. `count()` over the
 * run is therefore the row's own position counted from one, where over a fixed
 * run it is always the size.
 *
 * Which rows come before is what an ordering decides, so the operator lives on
 * `OrderedQueryable` and reverses with the order it was given: reversed, the
 * run accumulates from the other end.
 *
 * A `partition` restarts the accumulation per key, which is what `expandingBy`
 * adds and `expanding` leaves null. It is the same key `windowed` carries and
 * reaches the same `SqlOver.partitionBy`; unlike there it costs nothing else,
 * since a run up to a row is never short and there is no test to narrow.
 */
export interface ExpandingNode {
  readonly kind: 'expanding';
  readonly source: QueryPlan;
  /** The key the runs restart per, or null to accumulate over the whole ordering. */
  readonly partition: LambdaExpression | null;
  readonly projector: LambdaExpression;
}

/**
 * Each row of an ordered sequence beside its position in that order.
 *
 * SQL has no notion of a row's position, so it is numbered over the query's own
 * ordering, which is why the operator lives on `OrderedQueryable` and why
 * reversing the order renumbers from the other end. This is the same numbering
 * `zip` matches two sequences on, handed to a projector instead.
 *
 * The position is counted from zero, as LINQ's `Index` and JavaScript's own
 * iteration do, where `ROW_NUMBER` counts from one. That gap is closed in the
 * compilation rather than in the caller's head, the way `getMonth` closes the
 * one between JavaScript's months and `EXTRACT`'s.
 *
 * A row and a number have no shape between them, so the projector says what the
 * pair is, as it does for `join`, `zip`, and `pairwise`.
 */
export interface IndexNode {
  readonly kind: 'index';
  readonly source: QueryPlan;
  readonly projector: LambdaExpression;
}

/**
 * Each row of an ordered sequence beside its standing in that order, where
 * rows tying on every sort key share a number.
 *
 * This is what `index` is not, and the difference is ties. `index` is
 * `ROW_NUMBER`, which numbers two tied rows differently and decides which of
 * them goes first by whatever the database reached first; a standing shown to
 * a person has to call them equal. SQL spells that two ways and they disagree
 * about what follows a tie, so `dense` chooses between them: `RANK` skips the
 * numbers a tie consumed, leaving 1, 2, 2, 4, and `DENSE_RANK` does not,
 * leaving 1, 2, 2, 3. Both are one node with a flag rather than two nodes,
 * since the compilation differs by the function name alone.
 *
 * The number is counted from one, where `index` counts from zero. That is a
 * deliberate divergence and not an oversight: `index` is LINQ's `Index` and a
 * position among rows, which every zero-based thing in JavaScript agrees
 * about, while a standing has no LINQ operator behind it and is read by a
 * person who calls the first place first. `EXTRACT`'s months and days settled
 * the same way — one adjusted and its neighbour did not, because the two
 * fields mean different things — so two positional operators counting from
 * different places is the honest answer rather than an inconsistency to tidy
 * away.
 *
 * A row and a number have no shape between them, so the projector says what
 * the pair is, as it does for `index`, `join`, `zip`, and `pairwise`.
 */
export interface RankNode {
  readonly kind: 'rank';
  readonly source: QueryPlan;
  /** Whether a tie consumes the numbers it spans: `DENSE_RANK` when true, `RANK` when false. */
  readonly dense: boolean;
  readonly projector: LambdaExpression;
}

/**
 * `where` with the row's position among the ordering as a second parameter,
 * the same position `index` computes and `select` already reads a second
 * parameter as.
 *
 * `where` keeps its own node for a predicate over one row, since a window
 * function cannot appear inside the `WHERE` it becomes; this is a different
 * node rather than a wider `WhereNode` for the same reason `index` is not a
 * wider `SelectNode`, and it lives on `OrderedQueryable` for `index`'s own
 * reason: the position is only meaningful over an ordering.
 *
 * The row this reads back cannot be navigated off, `index`'s own limit and
 * for the same cause: the position has to be computed in a derived table
 * before a `WHERE` can read it, so by the time the predicate runs the row is
 * already one read out of that table rather than the entity it came from.
 */
export interface WherePositionNode {
  readonly kind: 'wherePosition';
  readonly source: QueryPlan;
  readonly predicate: LambdaExpression;
}

/**
 * A query guaranteed to yield at least one row: its own, or a default one.
 *
 * SQL has no operator for this, but it falls out of a join: a source of exactly
 * one row, left-joined onto the query, keeps that row when the query matches
 * nothing and is otherwise multiplied away by the rows it does match. That is
 * why there is no count here and nothing positional about it, unlike every
 * other operator that adds a row.
 *
 * `defaultRow` is null for the plain `defaultIfEmpty()`, whose default is
 * nulls, what SQL supplies for an absent join side and what makes the result
 * a `NullableRow<T>`, as `leftJoin`'s inner side is. It holds an expression,
 * shaped exactly as `LiteralRowNode.row` is, when the caller supplied a
 * default row of their own instead: an object literal for a query still
 * projecting a row, and a bare expression for a scalar one.
 */
export interface DefaultIfEmptyNode {
  readonly kind: 'defaultIfEmpty';
  readonly source: QueryPlan;
  readonly defaultRow: ExpressionNode | null;
}

/**
 * A flattening of many rows per source row into one sequence.
 *
 * `over` says where the many come from: another query, which pairs every row
 * with every row of the source, or one of the source's collection navigations,
 * which pairs each row only with the rows keyed back to it. Either way the
 * result multiplies, so a source row with no matches disappears and one with
 * several appears that many times.
 *
 * A collection's `shape` is absent for the plain `(row) => row.orders` form,
 * which reads the collection whole. Present, it is a caller's own
 * `where`/`orderBy`/`skip`/`take` over that same collection, already compiled
 * into an ordinary plan the way any other query is, `skip`/`take` included as
 * the ordinary nodes those produce; what makes it a `LATERAL` join rather
 * than a second statement is only that it is compiled here, correlated,
 * instead of read separately the way `include` reads one.
 */
export interface SelectManyNode {
  readonly kind: 'selectMany';
  readonly source: QueryPlan;
  readonly over:
    | { readonly kind: 'query'; readonly plan: QueryPlan }
    | {
        readonly kind: 'collection';
        readonly selector: LambdaExpression;
        readonly shape?: { readonly plan: QueryPlan };
      };
  readonly projector: LambdaExpression;
}

/**
 * A grouping together with the projection that collapses each group to a row.
 *
 * `key` becomes the `GROUP BY` list: an object literal groups by several
 * expressions, anything else by one. The projector receives the key and the
 * group, and is where aggregates appear. The two are one node rather than two
 * because a `GROUP BY` with no projection over it has no shape to compile.
 */
export interface GroupByNode {
  readonly kind: 'groupBy';
  readonly source: QueryPlan;
  readonly key: LambdaExpression;
  readonly projector: LambdaExpression;
}

/**
 * The immutable operator tree a `Queryable` accumulates.
 *
 * Every operator returns a new plan rather than mutating the previous one, so a
 * partially built query can be shared and branched safely, which is what makes
 * `const base = db.users.where(...)` reusable across call sites.
 */
export type QueryPlan =
  | SourceNode
  | RawSourceNode
  | WhereNode
  | TagNode
  | SelectNode
  | OrderByNode
  | SkipNode
  | TakeNode
  | LastNode
  | DistinctNode
  | SampleNode
  | WhileNode
  | PerKeyNode
  | ChunkByNode
  | SetOperationByNode
  | PairwiseNode
  | WindowedNode
  | ExpandingNode
  | IndexNode
  | RankNode
  | WherePositionNode
  | DefaultIfEmptyNode
  | SetOperationNode
  | JoinNode
  | GroupJoinNode
  | SelectManyNode
  | ZipNode
  | SequenceEqualNode
  | GroupByNode
  | LiteralRowNode;

/**
 * The entity a plan ultimately reads from. Used for diagnostics.
 *
 * A `literalRow` has none, since it reads from no table at all, and never
 * reaches here as the plan being asked about: it only ever sits on the far
 * side of the `UNION ALL` `append` builds, which this never recurses into.
 */
export function rootEntity(plan: QueryPlan): EntityDefinition {
  if (plan.kind === 'source' || plan.kind === 'rawSource') return plan.entity;
  if (plan.kind === 'literalRow') {
    throw new ModelError('A literal row appended to a query has no entity of its own.');
  }
  return rootEntity(plan.source);
}
