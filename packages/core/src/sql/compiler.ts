import { InvalidQueryError, ModelError, UnsupportedExpressionError } from '../errors.js';
import type {
  ExpressionNode,
  ExternalExpression,
  LambdaExpression,
  RegexExpression,
} from '../expression/nodes.js';
import { constant } from '../expression/nodes.js';
import type {
  CollectionDefinition,
  ColumnType,
  EntityDefinition,
  ReferenceDefinition,
} from '../metadata/entity.js';
import { physicalName } from '../metadata/entity.js';
import type {
  ChunkByNode,
  PerKeyNode,
  DefaultIfEmptyNode,
  ExpandingNode,
  SetOperationByNode,
  GroupByNode,
  GroupJoinNode,
  IndexNode,
  RankNode,
  JoinNode,
  LastNode,
  PairwiseNode,
  LiteralRowNode,
  QueryPlan,
  RawSourceNode,
  SelectManyNode,
  SequenceEqualNode,
  SetOperationNode,
  TagNode,
  WherePositionNode,
  ZipNode,
  WhileNode,
  WindowedNode,
} from '../query/plan.js';
import { rootEntity } from '../query/plan.js';
import type { BoundQuery } from '../query/bound-query.js';
import { isBoundQuery } from '../query/bound-query.js';
import type { SqlDialect } from './dialect.js';
import type {
  SqlAggregate,
  SqlDelete,
  SqlExpression,
  SqlFrom,
  SqlFunctionCall,
  SqlInsert,
  SqlUpdate,
  SqlJoin,
  SqlOrdering,
  SqlProjection,
  SqlSelect,
  SqlSetOperation,
} from './nodes.js';
import {
  column,
  conjoin,
  externalParameter,
  sqlBinary,
  sqlFunction,
  sqlLiteral,
  SQL_NULL,
  valueParameter,
} from './nodes.js';
import { readPath } from './printer.js';

export interface CompileOptions {
  readonly dialect: SqlDialect;
  /**
   * Parameter bags keyed by bag identifier.
   *
   * The compiler only reads them for constructs whose shape depends on the
   * value, such as expanding an array into an `IN` list. Ordinary values stay
   * symbolic so the statement can be reused.
   */
  readonly bags: Readonly<Record<string, unknown>>;
}

/**
 * Resolves a row property to a SQL expression valid in the current query scope.
 *
 * Two implementations cover every case the engine needs: one backed by entity
 * metadata, and one backed by an explicit map, used after a projection and
 * after a query is pushed into a derived table.
 */
interface RowScope {
  resolve(property: string): SqlExpression | null;
  /**
   * The properties that resolve to a value. An identity projection selects
   * exactly these, so a name that resolves to nothing must not appear.
   */
  names(): readonly string[];
  describe(): string;
  /** Navigations the scope offers, listed only to make an error message useful. */
  references?(): readonly string[];
  /**
   * The reference a property names, when it stands for a related row rather
   * than a column. Only a scope backed by entity metadata has any.
   */
  navigate?(property: string): ResolvedRelation | null;
  /**
   * The declared type of a property, when the scope knows one.
   *
   * A dialect is handed an expression and not a type, so a translation that
   * depends on the difference — `length` over text against `length` over an
   * array — can only be chosen if the compiler looks the type up first. Only a
   * scope backed by entity metadata has types; a projection has forgotten them.
   */
  columnType?(property: string): ColumnType | null;
  /**
   * A more specific reason a name that resolved to nothing did, when the
   * scope knows one beyond "it is not here": a nested embed a further
   * operator cannot read a property of, say. `null` falls back to the
   * ordinary "not a property, available: ..." message.
   */
  describeUnresolved?(property: string): string | null;
}

/**
 * A navigation the compiler has been asked to follow, and the key it follows.
 *
 * `key` is always the column on *this* side of the relationship: the foreign
 * key for a reference, the key it points back at for a collection.
 */
type ResolvedRelation = {
  /** Alias of the row the navigation starts from, used to reuse one join. */
  readonly from: string;
  readonly property: string;
  /** Property here that the key is read from, so another scope can resolve it too. */
  readonly keyProperty: string;
  readonly key: SqlExpression;
} & (
  | { readonly kind: 'reference'; readonly relation: ReferenceDefinition }
  | { readonly kind: 'collection'; readonly relation: CollectionDefinition }
);

class EntityScope implements RowScope {
  constructor(
    private readonly alias: string,
    private readonly entity: EntityDefinition,
  ) {}

  resolve(property: string): SqlExpression | null {
    if (!(property in this.entity.columns)) return null;
    return column(this.alias, physicalName(this.entity.columns, property));
  }

  names(): readonly string[] {
    return Object.keys(this.entity.columns);
  }

  describe(): string {
    return `entity "${this.entity.name}"`;
  }

  references(): readonly string[] {
    return Object.keys(this.entity.relations);
  }

  columnType(property: string): ColumnType | null {
    return this.entity.columns[property]?.type ?? null;
  }

  navigate(property: string): ResolvedRelation | null {
    const relation = this.entity.relations[property];
    if (!relation) return null;

    // A reference holds the key here and points away; a collection is pointed
    // at, so the key on this side is whatever the other side matches against.
    const here =
      relation.kind === 'collection'
        ? (relation.to ?? onlyPrimaryKey(this.entity, property))
        : relation.from;

    const key = this.resolve(here);
    if (!key) {
      throw new ModelError(
        `Relation "${property}" on entity "${this.entity.name}" reads from "${here}", ` +
          'which is not one of its columns.',
      );
    }

    const from = this.alias;
    return relation.kind === 'collection'
      ? { kind: 'collection', from, property, keyProperty: here, relation, key }
      : { kind: 'reference', from, property, keyProperty: here, relation, key };
  }
}

class MapScope implements RowScope {
  constructor(
    private readonly entries: ReadonlyMap<string, SqlExpression>,
    private readonly label: string,
    /**
     * What this scope was built over: the scope itself, or a function that
     * answers types alone.
     *
     * Passing the wrapped scope is the way to say "a derived table over the
     * same names". Its types come through, since the columns are that scope's
     * columns under the same names, and so do its navigations, since a foreign
     * key carried out of a derived table under its own name still points at the
     * same row. That is what lets `u.city.name` be read after a `take` or a
     * `distinctBy`, where it used to be refused for want of an entity.
     *
     * Passing a function says types only, and there are two reasons to. A
     * projection has forgotten which of its expressions were columns of what,
     * so it has no navigation to offer and must not invent one. And a scope
     * whose rows are not quite the wrapped scope's — `defaultIfEmpty`, whose
     * extra row is all nulls — has to withhold them even though it could
     * technically answer.
     *
     * Either way a scope with nothing to say leaves the dialect to work without
     * a type, which is what every one of these did before.
     */
    private readonly source?: RowScope | ((property: string) => ColumnType | null),
    /** A reason to give instead, for a name this scope recognises but will not resolve. */
    private readonly unresolved?: (property: string) => string | null,
  ) {}

  columnType(property: string): ColumnType | null {
    const source = this.source;
    if (!source) return null;
    return (
      (typeof source === 'function' ? source(property) : source.columnType?.(property)) ?? null
    );
  }

  references(): readonly string[] {
    return typeof this.source === 'object' ? (this.source.references?.() ?? []) : [];
  }

  /**
   * The navigation a name stands for, read off the scope this one was built
   * over and repointed at this one.
   *
   * Which relation a property names is the wrapped scope's to say: it holds
   * the entity metadata and nothing about a derived table changes what
   * `user` means. Where the key is *read from* is this scope's to say, and
   * that is the whole of the translation here — the wrapped scope would
   * resolve it to `"t0"."user_id"`, a column no longer in scope out here,
   * where this one resolves the same property to `"t1"."userId"` and the
   * join is emitted against the derived table instead. `keyProperty` exists
   * on `ResolvedRelation` precisely so another scope can resolve it, which
   * is what this is.
   *
   * A key that did not survive means no navigation, which is the honest
   * answer rather than a failure: a query that projected its foreign key
   * away has nothing left to join on.
   */
  navigate(property: string): ResolvedRelation | null {
    if (typeof this.source !== 'object') return null;

    const declared = this.source.navigate?.(property);
    if (!declared) return null;

    const key = this.resolve(declared.keyProperty);
    if (!key) return null;

    // `from` names the row the navigation starts from and is what lets one
    // join be reused. That row is this derived table, so it is read off the
    // key rather than inherited: keeping the wrapped scope's alias would let
    // two levels share a cached join whose `ON` names a table only one of
    // them can see.
    return {
      ...declared,
      from: key.kind === 'column' && key.table ? key.table : declared.from,
      key,
    };
  }

  resolve(property: string): SqlExpression | null {
    return this.entries.get(property) ?? null;
  }

  names(): readonly string[] {
    return [...this.entries.keys()];
  }

  describe(): string {
    return this.label;
  }

  describeUnresolved(property: string): string | null {
    return this.unresolved?.(property) ?? null;
  }
}

/**
 * What one lambda parameter stands for while its lambda is translated.
 *
 * `where` and `select` only ever bind a row, but `join` binds two of them and
 * `groupBy` binds a key beside a group, so a parameter cannot be assumed to be
 * a row and each kind carries what it needs to be translated.
 */
type RowBinding =
  /** A row whose properties resolve through a scope, such as `u` in `u => u.age`. */
  | { readonly kind: 'row'; readonly scope: RowScope }
  /** A single value, which is what a `groupBy` key is unless it is an object. */
  | { readonly kind: 'value'; readonly expression: SqlExpression }
  /**
   * A group, valid only as the receiver of an aggregate; `rows` backs its
   * selectors.
   *
   * `window` is what the framed operators add: the same aggregates over a
   * frame of the query's own rows rather than over a `GROUP BY`, which is one
   * flag here instead of a second kind of binding because everything else
   * about reading `run.average((r) => r.value)` is what reading
   * `group.average(...)` already was. `windowed` frames a fixed number of
   * rows and `expanding` every row up to the current one; neither is a
   * difference this binding can see.
   */
  | { readonly kind: 'group'; readonly rows: RowScope; readonly window: WindowFrame | null }
  /**
   * A group whose rows are not in the query around it but in another, reached
   * by correlating on a key. Valid only as the receiver of an aggregate, which
   * becomes a subquery over `from` filtered by `on`.
   */
  | {
      readonly kind: 'matches';
      readonly rows: RowScope;
      readonly from: SqlFrom;
      readonly on: SqlExpression;
    };

/**
 * Passes a scope's declared types on, and deliberately not its navigations.
 *
 * Handing `MapScope` the wrapped scope itself carries both. This is for the
 * places that want the types and must withhold the navigations, and each one
 * says at the call site why.
 */
const inherited =
  (scope: RowScope) =>
  (property: string): ColumnType | null =>
    scope.columnType?.(property) ?? null;

const asRow = (scope: RowScope): RowBinding => ({ kind: 'row', scope });

const asValue = (expression: SqlExpression): RowBinding => ({ kind: 'value', expression });

/**
 * The window an aggregate over a run of rows is taken across, which is the
 * query's own ordering narrowed to the rows ending at each one.
 *
 * The frame is a spelling the compiler writes from a size it has already
 * checked to be a positive integer, or from no size at all where the run
 * reaches back to the start of the ordering. Either way it is on the footing
 * every other `SqlOver.frame` in this file is on: nothing the caller wrote
 * reaches it.
 */
interface WindowFrame {
  /** The key the frame restarts per, empty where it runs over the whole ordering. */
  readonly partitionBy: readonly SqlExpression[];
  readonly orderBy: readonly SqlOrdering[];
  readonly frame: string;
}

/**
 * What separates `windowed` from `expanding`, which is all a shared
 * compilation of the two needs to be told.
 *
 * Three fields, and the middle one is the only behavioural difference: a run
 * of fixed size needs `size` rows behind it and the rows without them are
 * dropped, where a run reaching back to the start of the ordering is never
 * short and nothing is dropped at all.
 */
interface Framing {
  /** The `SqlOver.frame` text every aggregate over the run is taken across. */
  readonly frame: string;
  /** How many rows a run needs, or null when every row has one. */
  readonly minimum: number | null;
  /** What to say when the query has no ordering to frame over. */
  readonly unordered: string;
}

const asGroup = (rows: RowScope): RowBinding => ({ kind: 'group', rows, window: null });

/** A group whose aggregates are taken over a window frame rather than over a `GROUP BY`. */
const asRun = (rows: RowScope, window: WindowFrame): RowBinding => ({
  kind: 'group',
  rows,
  window,
});

/**
 * One function evaluated over a window frame.
 *
 * A windowed aggregate is `SqlOver` and not a `SqlAggregate` carrying a window,
 * which is the spelling `chunkBy` already reached for when it summed its breaks
 * and is what let this be written without touching the AST or the printer. It
 * costs one thing: `SqlOver` prints exactly the arguments it is given, so
 * `COUNT(*)` has to pass the star as one where `SqlAggregate` spells an absent
 * argument that way itself.
 */
const over = (
  name: string,
  args: readonly SqlExpression[],
  window: WindowFrame,
): SqlExpression => ({
  kind: 'over',
  name,
  args,
  partitionBy: window.partitionBy,
  orderBy: window.orderBy,
  frame: window.frame,
});

const asMatches = (rows: RowScope, from: SqlFrom, on: SqlExpression): RowBinding => ({
  kind: 'matches',
  rows,
  from,
  on,
});

/**
 * The parameters visible while one lambda is translated.
 *
 * Lookup is by the parameter name the lambda gave it rather than by position,
 * which is what lets a lambda with more than one parameter resolve each of them
 * to a different thing.
 */
class LambdaScope {
  private constructor(private readonly bindings: ReadonlyMap<string, RowBinding>) {}

  /** Pairs a lambda's parameters with what they stand for, in declaration order. */
  static bind(lambda: LambdaExpression, bindings: readonly RowBinding[]): LambdaScope {
    const named = new Map<string, RowBinding>();
    for (const [index, name] of lambda.parameters.entries()) {
      const binding = bindings[index];
      if (binding) named.set(name, binding);
    }
    return new LambdaScope(named);
  }

  binding(name: string): RowBinding {
    const binding = this.bindings.get(name);
    if (!binding) {
      throw new InvalidQueryError(
        `"${name}" is not a parameter of this query. In scope: ${[...this.bindings.keys()].join(', ')}.`,
      );
    }
    return binding;
  }
}

interface CompiledQuery {
  readonly select: SqlSelect;
  readonly scope: RowScope;
}

/**
 * One row nested as a property of a projection, as `(o, u) => ({ order: o, user: u })` embeds `u`
 * under `user` rather than reading one of its columns.
 *
 * `prefix` is what `project` renamed every column of the embedded row to, so the materializer can
 * find them again in the flat row a driver hands back and fold them under `property`. Nothing else
 * ever reads a column starting this way, which is what makes stripping the prefix enough: there is
 * no need to parse `property` back out of it, since this is handed back already knowing what it is.
 */
export interface NestedEmbed {
  readonly property: string;
  readonly prefix: string;
}

/** What `project` renames an embedded row's own columns to, ahead of the property's own name. */
const NESTED_MARKER = '__sqlinqo_nested_';

/** A collection navigation lowered into the join that flattens it. */
interface ExpandedCollection {
  readonly join: SqlJoin;
  readonly scope: RowScope;
}

/** A compiled query in the form a `JOIN` clause can consume. */
interface JoinSource {
  readonly from: SqlFrom;
  readonly scope: RowScope;
}

/**
 * Compiles rows into an `INSERT`, with every column read back.
 *
 * There is no plan and no scope here, which is what separates a write from a
 * query: nothing has to be resolved against a row, because the values arrived
 * as values rather than as a lambda over one. What the entity supplies is the
 * table, the physical name of each column, and the list to read back.
 *
 * Every column is returned, not only the generated ones. A default and a
 * trigger are as invisible to the caller as a sequence is, and asking for all
 * of them costs nothing once the statement is already reading some.
 *
 * `conflictKey` turns the statement into an upsert: every property in
 * `properties` other than the key columns themselves is overwritten with the
 * proposed value on a conflict. The caller has already checked that this
 * leaves at least one column to update, since a plan node has no way to
 * refuse a statement and name `upsert` in the message.
 */
export function compileInsert(
  entity: EntityDefinition,
  properties: readonly string[],
  rows: readonly Record<string, unknown>[],
  conflictKey?: readonly string[],
): SqlInsert {
  return {
    kind: 'insert',
    into: entity.schema ? { schema: entity.schema, name: entity.table } : { name: entity.table },
    columns: properties.map((property) => physicalName(entity.columns, property)),
    source: {
      kind: 'values',
      // A property a row left out is written as null rather than skipped, since
      // one statement has one column list and a shorter row would not line up.
      rows: rows.map((row) =>
        properties.map((property) => translateConstant(row[property] ?? null)),
      ),
    },
    returning: returningEveryInsertedColumn(entity),
    ...(conflictKey && {
      onConflict: {
        columns: conflictKey.map((property) => physicalName(entity.columns, property)),
        update: properties
          .filter((property) => !conflictKey.includes(property))
          .map((property) => physicalName(entity.columns, property)),
      },
    }),
  };
}

/**
 * Compiles an already-compiled query into the rows an `INSERT` adds, in place
 * of a `VALUES` list.
 *
 * The `SELECT` arrives built rather than as a plan, which is the one thing
 * separating this from every other entry point here. Its caller had to compile
 * it first for a reason that only shows up in this statement: the column list
 * an `INSERT` names is decided by what the query projects, so the projection
 * has to exist before there is anything to check it against or to put in order.
 * Compiling it a second time here would be the same work twice and a second
 * chance for the two to disagree.
 *
 * `properties` is that checked, ordered list. The projection is put back into
 * its order rather than trusted to have arrived in it, because
 * `INSERT ... SELECT` lines the two up by position: the aliases a projection
 * carries are visible in the printed statement and mean nothing to the
 * database, so a query that named the right columns in the wrong order would
 * write each value into its neighbour's column and no error would be raised.
 *
 * Every column is read back, as it is for a `VALUES` insert and for the same
 * reason. There is no upsert form: a conflict target is the caller's to choose
 * per row, and a query is not a row.
 */
export function compileInsertFrom(
  entity: EntityDefinition,
  properties: readonly string[],
  select: SqlSelect,
): SqlInsert {
  const projected = new Map(select.columns.map((projection) => [projection.alias, projection]));

  // The tags come off the query and go onto the statement, so a tag written on
  // the query reads at the top of the log line rather than from the middle of
  // the statement it ended up inside, exactly as an UPDATE's does.
  const { tags, ...query } = select;

  const reordered: SqlSelect = {
    ...query,
    columns: properties.map((property) => projected.get(property)!),
  };

  return {
    kind: 'insert',
    into: entity.schema ? { schema: entity.schema, name: entity.table } : { name: entity.table },
    columns: properties.map((property) => physicalName(entity.columns, property)),
    source: {
      kind: 'query',
      select: {
        ...reordered,
        // The reorder has to reach the branches of a set operation as well, and
        // this is the whole reason it is a separate step rather than a spread.
        // A `UNION` pairs its branches by position for exactly the reason an
        // `INSERT ... SELECT` pairs the column list with the projection, and
        // each branch was already aligned against the projection in the order
        // it was *written*. Moving the outer columns and leaving the branches
        // therefore breaks an alignment that was correct a moment ago, and
        // breaks it silently wherever the swapped columns share a type. This is
        // the same failure the reorder above exists to prevent, one level down.
        setOperations: reordered.setOperations.map((operation) => ({
          ...operation,
          select: alignColumns(operation.select, reordered),
        })),
      },
    },
    returning: returningEveryInsertedColumn(entity),
    ...(tags && tags.length > 0 && { tags }),
  };
}

/**
 * Every column of the entity, read back unqualified.
 *
 * Unqualified because an `INSERT` has one table and no alias for it, which is
 * what separates this from `returningEveryColumn`: an `UPDATE` and a `DELETE`
 * both carry an alias their `WHERE` already leans on.
 */
function returningEveryInsertedColumn(entity: EntityDefinition): readonly SqlProjection[] {
  return Object.keys(entity.columns).map((property) => ({
    expression: { kind: 'column', table: null, name: physicalName(entity.columns, property) },
    alias: property,
  }));
}

/**
 * What to call each plan node when refusing to write through it.
 *
 * Named rather than numbered because the caller wrote the clause that caused
 * the refusal, and the fix is to remove that clause. `where` and `source` are
 * absent on purpose: those are the two a write is made of.
 */
const WRITABLE_CLAUSES: Partial<Record<QueryPlan['kind'], string>> = {
  select: 'a projection',
  join: 'a join',
  groupJoin: 'a groupJoin',
  groupBy: 'a grouping',
  orderBy: 'an ordering',
  skip: 'a page',
  take: 'a page',
  last: 'a takeLast or skipLast',
  sample: 'a sample',
  distinct: 'a DISTINCT',
  perKey: 'a distinctBy, takeBy or skipBy',
  while: 'a takeWhile or skipWhile',
  chunkBy: 'a chunkBy',
  setOperation: 'a set operation',
  setOperationBy: 'an intersectBy or exceptBy',
  selectMany: 'a flattening',
  zip: 'a zip',
  pairwise: 'a pairwise',
  windowed: 'a windowed or windowedBy',
  expanding: 'an expanding or expandingBy',
  index: 'an index',
  rank: 'a rank or denseRank',
  wherePosition: 'a where with a position',
  defaultIfEmpty: 'a defaultIfEmpty',
};

/** How each write names itself when refusing a query that is more than a filter. */
const WRITE_PHRASING = {
  update: { acts: 'writes rows of', rows: 'update' },
  delete: { acts: 'removes rows of', rows: 'delete' },
} as const;

/**
 * The one table and one predicate a write is made of, or a refusal naming the
 * clause that made the query more than that.
 *
 * The predicate is not compiled here. It is compiled by `compileQuery`, exactly
 * as it would be for a read, and what comes back is taken apart: SQL puts the
 * same condition after `WHERE` in all three statements, so writing a second
 * translation for it would be two things to keep in step and one of them
 * eventually wrong.
 *
 * That reuse is also what settles which queries can be written through. A
 * `SELECT` that has grown a join, a projection, a grouping, an ordering, or a
 * page is not a set of rows in one table any more, and there is nothing sound
 * to write. Each of those is refused by name rather than by a general
 * complaint, because the caller wrote the clause that caused it and the fix is
 * to remove that clause.
 *
 * `update` and `delete` share every one of those checks, which is why they
 * share this: the two statements differ in what they do to a row once it is
 * found and not at all in how they find it, so a refusal one made and the other
 * did not would be a bug rather than a distinction.
 */
function writableSource(
  plan: QueryPlan,
  options: CompileOptions,
  operator: keyof typeof WRITE_PHRASING,
): {
  entity: EntityDefinition;
  select: SqlSelect;
  table: Extract<SqlFrom, { kind: 'table' }>;
  /**
   * The compiler that built `select`, handed back so `compileUpdate` can
   * translate a relative-value lambda through the same instance: its alias
   * counter has already spent whatever `select` and its `WHERE` used, and a
   * second, freshly constructed compiler would hand out the same aliases
   * again and collide with them.
   */
  compiler: Compiler;
} {
  const entity = rootEntity(plan);
  const compiler = new Compiler(options);
  const select = tagged(compiler.compile(plan).select, compiler.tags);
  const phrasing = WRITE_PHRASING[operator];

  // Annotated on the const rather than only on the arrow, which is what lets
  // TypeScript treat each call below as unreachable and narrow the `from`.
  const refuse: (clause: string) => never = (clause) => {
    throw new InvalidQueryError(
      `"${operator}" ${phrasing.acts} one table, and this query has ${clause}. ` +
        `Filter the rows to ${phrasing.rows} and nothing else.`,
    );
  };

  // The plan is walked as well as the statement it compiled to, because not
  // every operator leaves a mark on the `SELECT`: a projection over a bare
  // source only changes the column list, which neither write ever had.
  // A tag passes as readily as a filter: it says nothing about which rows are
  // meant, and a write is exactly the statement worth finding in a log again.
  for (let node: QueryPlan = plan; node.kind !== 'source'; node = node.source) {
    if (node.kind !== 'where' && node.kind !== 'tag') {
      refuse(WRITABLE_CLAUSES[node.kind] ?? `a "${node.kind}" step`);
    }
  }

  // The statement is checked too, and catches what the plan cannot: a
  // navigation inside the predicate is a join by the time it is compiled, and
  // reads as an ordinary `where` in the plan.
  if (select.from.kind !== 'table') refuse('been pushed into a derived table');
  if (select.joins.length > 0) refuse('a navigation in its filter, which becomes a join');
  if (select.groupBy.length > 0) refuse('a grouping');
  if (select.setOperations.length > 0) refuse('a set operation');
  if (select.orderBy.length > 0) refuse('an ordering');
  if (select.limit !== null || select.offset !== null) refuse('a page');
  if (select.distinct) refuse('a DISTINCT');

  return { entity, select, table: select.from, compiler };
}

/**
 * Every column of an entity, read back through the alias the statement gave it.
 *
 * Every column and not only the ones the caller named, for the reason an insert
 * returns every column: a default, a computed column, and a trigger are as
 * invisible as the assignment is visible, and asking for all of them costs
 * nothing once the statement is already reading some.
 */
function returningEveryColumn(entity: EntityDefinition, alias: string): readonly SqlProjection[] {
  return Object.keys(entity.columns).map((property) => ({
    expression: column(alias, physicalName(entity.columns, property)),
    alias: property,
  }));
}

/**
 * Turns `update`'s plain-values form into assignments, each one bound as a
 * parameter the way an insert's own values are.
 */
function valueAssignments(
  entity: EntityDefinition,
  values: Readonly<Record<string, unknown>>,
): readonly { readonly column: string; readonly value: SqlExpression }[] {
  const properties = Object.keys(values);
  if (properties.length === 0) {
    throw new InvalidQueryError(
      `"update" was given no columns to set on entity "${entity.name}". ` +
        `Columns: ${Object.keys(entity.columns).join(', ')}.`,
    );
  }

  for (const property of properties) {
    if (!(property in entity.columns)) {
      throw new InvalidQueryError(
        `"${property}" is not a column of entity "${entity.name}". ` +
          `Columns: ${Object.keys(entity.columns).join(', ')}.`,
      );
    }
  }

  return properties.map((property) => ({
    column: physicalName(entity.columns, property),
    value: translateConstant(values[property] ?? null),
  }));
}

/**
 * What `update` was given: plain values, bound the way an insert's are, or a
 * lambda whose object literal can read the row it is about to overwrite.
 *
 * The two are told apart by the caller before either reaches here, in
 * `Queryable.update` itself, rather than by inspecting the shape of `values`:
 * `typeof` a function is unambiguous where a plain object never is, since an
 * entity could as easily declare a column literally named `kind`.
 */
export type UpdateAssignments =
  | { readonly kind: 'values'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'expression'; readonly projector: LambdaExpression };

/**
 * Compiles a filtered query and a set of values into an `UPDATE`.
 *
 * Which queries this accepts, and why the predicate is not compiled here, are
 * `writableSource`'s to explain: everything about finding the rows is shared
 * with `compileDelete`, and the assignments below are the whole of what is not.
 */
export function compileUpdate(
  plan: QueryPlan,
  assignments: UpdateAssignments,
  options: CompileOptions,
): SqlUpdate {
  const { entity, select, table, compiler } = writableSource(plan, options, 'update');

  const compiledAssignments =
    assignments.kind === 'expression'
      ? compiler.updateAssignments(entity, table.alias, assignments.projector)
      : valueAssignments(entity, assignments.values);

  return {
    kind: 'update',
    table: table.schema
      ? { schema: table.schema, name: table.name, alias: table.alias }
      : { name: table.name, alias: table.alias },
    assignments: compiledAssignments,
    where: select.where,
    returning: returningEveryColumn(entity, table.alias),
    // Gathered by `compileQuery` inside `writableSource`, so a tag reaches an
    // UPDATE by the same route it reaches the SELECT it was written on.
    tags: select.tags,
  };
}

/**
 * Compiles a filtered query into a `DELETE`.
 *
 * This is `compileUpdate` with the assignments taken out, and that is the whole
 * of it: a delete has nothing to set, so the two checks an update makes about
 * its values have no counterpart here, while every check about which rows are
 * meant is shared. There is no empty-argument case to refuse either. An update
 * with nothing to set is a sentence that does not finish, where a delete with
 * nothing but a filter is the entire statement.
 *
 * The rows are still read back, which is worth more here than anywhere else:
 * once the statement has run, what it removed can be named from nothing but
 * what it returned.
 */
export function compileDelete(plan: QueryPlan, options: CompileOptions): SqlDelete {
  const { entity, select, table } = writableSource(plan, options, 'delete');

  return {
    kind: 'delete',
    from: table.schema
      ? { schema: table.schema, name: table.name, alias: table.alias }
      : { name: table.name, alias: table.alias },
    where: select.where,
    returning: returningEveryColumn(entity, table.alias),
    tags: select.tags,
  };
}

/**
 * Puts the tags a compiler gathered onto the statement being handed back.
 *
 * Applied by each entry point rather than inside the compiler, because the
 * statement the caller runs is not always the one the plan compiled to: a
 * counting or aggregating terminal wraps that `SELECT` in another, and the
 * comment belongs to the statement rather than to the subquery.
 */
function tagged<TStatement extends { readonly tags?: readonly string[] }>(
  statement: TStatement,
  tags: readonly string[],
): TStatement {
  return tags.length === 0 ? statement : { ...statement, tags: [...tags] };
}

/**
 * Compiles a query plan into a single `SELECT` statement tree, and the
 * nested embeds its outermost projection produced, if any, so a caller
 * reading rows back can fold them into objects.
 */
export function compileQuery(
  plan: QueryPlan,
  options: CompileOptions,
): { select: SqlSelect; nested: readonly NestedEmbed[] } {
  const compiler = new Compiler(options);
  const select = tagged(compiler.compile(plan).select, compiler.tags);
  return { select, nested: compiler.nested };
}

/**
 * Compiles a plan into `SELECT COUNT(*) FROM (<plan>)`.
 *
 * Wrapping unconditionally keeps the result correct in the presence of
 * `DISTINCT`, `LIMIT`, and `OFFSET`, where counting the inner rows directly
 * would give a different answer.
 */
export function compileCount(plan: QueryPlan, options: CompileOptions): SqlSelect {
  const compiler = new Compiler(options);
  const inner = compiler.compile(plan).select;
  const alias = compiler.nextAlias();

  const counted: SqlSelect = {
    kind: 'select',
    distinct: false,
    columns: [
      {
        expression: { kind: 'aggregate', name: 'count', argument: null, distinct: false },
        alias: 'count',
      },
    ],
    from: { kind: 'derived', select: stripOrdering(inner), alias },
    joins: [],
    where: null,
    groupBy: [],
    having: null,
    setOperations: [],
    orderBy: [],
    limit: null,
    offset: null,
  };

  return tagged(counted, compiler.tags);
}

/**
 * The shape every aggregate terminal compiles to.
 *
 * The plan handed in already projects the one value being aggregated, which is
 * what lets these operators reuse `select` instead of carrying a plan node
 * each. Everything a projection settles is therefore settled before this runs:
 * a navigation in the selector has become a join, and a projection over a paged
 * or distinct query has already been pushed into its own derived table.
 *
 * The wrapping is unconditional, for the reason `compileCount` wraps. An
 * aggregate folded into a query that is already paged would be taken over the
 * wrong rows, since `LIMIT` applies to the aggregated result rather than to the
 * rows going into it, and `take(10).average(...)` means the mean of ten rows.
 *
 * What each terminal decides for itself is the column list, which is where the
 * three genuinely differ rather than merely spelling one aggregate apiece.
 */
function aggregateOver(
  plan: QueryPlan,
  options: CompileOptions,
  columns: (value: SqlExpression) => readonly SqlProjection[],
): SqlSelect {
  const compiler = new Compiler(options);
  const inner = compiler.compile(plan).select;
  const alias = compiler.nextAlias();
  const value = inner.columns[0]!;

  const aggregated: SqlSelect = {
    kind: 'select',
    distinct: false,
    columns: [...columns(column(alias, value.alias))],
    from: { kind: 'derived', select: stripOrdering(inner), alias },
    joins: [],
    where: null,
    groupBy: [],
    having: null,
    setOperations: [],
    orderBy: [],
    limit: null,
    offset: null,
  };

  return tagged(aggregated, compiler.tags);
}

/** One aggregate over the projected value, named for the column it produces. */
const aggregate = (
  name: SqlAggregate['name'],
  value: SqlExpression,
  alias: string,
): SqlProjection => ({
  expression: { kind: 'aggregate', name, argument: value, distinct: false },
  alias,
});

/** `COUNT(*)`, carried by the terminals that must tell no rows from all null. */
const rowCount: SqlProjection = {
  expression: { kind: 'aggregate', name: 'count', argument: null, distinct: false },
  alias: 'count',
};

/**
 * Compiles a plan into `SELECT AVG(<value>), COUNT(*) FROM (<plan>)`.
 *
 * `COUNT(*)` rides along because `AVG` answers null for two different queries:
 * one with no rows, and one whose every value was null. `average` returns a
 * `number` and so cannot report the second as null, which makes the two
 * different errors rather than an error and an answer. The count separates
 * them, and it costs nothing to carry over a scan already being made.
 */
export function compileAverage(plan: QueryPlan, options: CompileOptions): SqlSelect {
  return aggregateOver(plan, options, (value) => [aggregate('avg', value, 'average'), rowCount]);
}

/**
 * Compiles a plan into `SELECT COALESCE(SUM(<value>), 0) FROM (<plan>)`.
 *
 * The `COALESCE` is where `sum` parts company with the other two. SQL answers
 * `SUM` over no rows with null and LINQ answers zero, so the gap is closed in
 * the SQL rather than left in the caller's head, which is what Entity Framework
 * Core does here too.
 *
 * It settles the other null case for free: a query whose every value was null
 * also sums to zero in LINQ, so unlike `average` and `min` there is nothing
 * here worth telling apart and no `COUNT(*)` riding along to do it.
 */
export function compileSum(plan: QueryPlan, options: CompileOptions): SqlSelect {
  return aggregateOver(plan, options, (value) => [
    {
      expression: sqlFunction('COALESCE', [
        { kind: 'aggregate', name: 'sum', argument: value, distinct: false },
        sqlLiteral('0'),
      ]),
      alias: 'sum',
    },
  ]);
}

/**
 * Compiles a plan into `SELECT COUNT(DISTINCT <value>) + <null> FROM (<plan>)`.
 *
 * `COUNT(DISTINCT ...)` skips nulls, where LINQ's `Distinct().Count()` treats
 * null as a value like any other and counts it once. This library has settled
 * that question the same way everywhere else — `distinctBy` keeps one row for
 * the null key, `exceptBy` matches a null key against a null key — so the gap
 * is closed here rather than left to surprise a caller who counted rows and
 * counted values and found them one apart.
 *
 * The adjustment is exact and costs nothing beyond the scan already being made:
 * `COUNT(<value>)` skips nulls and `COUNT(*)` does not, so they differ exactly
 * when at least one null is present, and that is the one the distinct count
 * left out. Every other case adds zero: no rows at all counts nothing, and rows
 * that are all null count one.
 */
export function compileCountDistinct(plan: QueryPlan, options: CompileOptions): SqlSelect {
  return aggregateOver(plan, options, (value) => [
    { expression: countDistinctExpression(value), alias: 'countDistinct' },
  ]);
}

/**
 * `COUNT(DISTINCT value)` plus the null adjustment `compileCountDistinct`
 * documents, factored out so `Group`'s own `countDistinct` can share it
 * rather than answer null differently depending on where it was called from.
 * A `value` translated once and read three times costs nothing beyond the
 * scan the aggregate already makes.
 */
function countDistinctExpression(value: SqlExpression): SqlExpression {
  return sqlBinary(
    '+',
    { kind: 'aggregate', name: 'count', argument: value, distinct: true },
    {
      kind: 'case',
      branches: [
        {
          condition: sqlBinary(
            '<',
            { kind: 'aggregate', name: 'count', argument: value, distinct: false },
            { kind: 'aggregate', name: 'count', argument: null, distinct: false },
          ),
          result: sqlLiteral('1'),
        },
      ],
      otherwise: sqlLiteral('0'),
    },
  );
}

/**
 * Compiles a plan into `SELECT MIN(<value>), COUNT(*) FROM (<plan>)`, or the
 * same with `MAX`.
 *
 * These two are the aggregates that do not change the type of what they read:
 * the value was already in the column, so a text column yields text and a
 * timestamp yields a timestamp. Nothing here casts or coalesces, and the
 * terminals hand back what the driver gave rather than normalising to a number
 * as `count`, `sum`, and `average` all do.
 *
 * The `COUNT(*)` is `average`'s, wanted for a different reason. Both answer
 * null for no rows and for every value being null, and here those deserve
 * different answers rather than two error messages: no rows is an error, and a
 * column of nulls has a smallest and a largest value of null, which is what
 * LINQ answers and what these operators' type can carry.
 *
 * One function serves both because measuring found nothing to separate them.
 * `MIN` and `MAX` agree on the type they return, on what the driver makes of
 * it, and on both null cases, so the complement is a parameter rather than a
 * second implementation to keep in step.
 */
function compileExtreme(plan: QueryPlan, options: CompileOptions, name: 'min' | 'max'): SqlSelect {
  return aggregateOver(plan, options, (value) => [aggregate(name, value, name), rowCount]);
}

/** The smallest projected value, with the row count that gives null its meaning. */
export function compileMin(plan: QueryPlan, options: CompileOptions): SqlSelect {
  return compileExtreme(plan, options, 'min');
}

/** The largest projected value. `compileMin` read the other way, and no more. */
export function compileMax(plan: QueryPlan, options: CompileOptions): SqlSelect {
  return compileExtreme(plan, options, 'max');
}

/**
 * `ORDER BY` inside a counted subquery is dead weight and several databases
 * reject it outright unless the subquery is also limited.
 */
function stripOrdering(select: SqlSelect): SqlSelect {
  if (select.limit || select.offset) return select;
  return { ...select, orderBy: [] };
}

class Compiler {
  private aliasCounter = 0;

  /**
   * Tags gathered from every branch of the plan, in the order they were
   * written, for whichever entry point is building the statement to attach.
   */
  readonly tags: string[] = [];

  /**
   * The nested embeds the query's own outermost projection produced, read by
   * `compileQuery` once compilation finishes so the materializer knows how
   * to fold `project`'s flat, prefixed columns back into objects.
   *
   * Overwritten rather than accumulated, unlike `tags`: only the outermost
   * projection decides the shape a caller sees, and compilation reaches it
   * last, after any sub-query's own `project` call already ran and set this
   * to something else. An operator applied after a projection that set no
   * embeds of its own, such as `where` or `orderBy`, never calls `project`
   * again and so leaves whatever the last one wrote untouched.
   */
  nested: readonly NestedEmbed[] = [];

  /**
   * Joins the navigations in the clause being translated have asked for.
   *
   * A navigation is discovered while an expression is being lowered, long after
   * the `FROM` it has to attach to was built, and `translate` returns only an
   * expression. Collecting them here lets the clause that started the
   * translation merge them into the select it is building. Null outside a
   * translation, which is what makes a navigation in the wrong place an error
   * rather than a join quietly attached to the wrong query.
   */
  private navigationJoins: SqlJoin[] | null = null;

  /** Joins already made in this clause, so one navigation is followed once. */
  private navigationScopes = new Map<string, RowScope>();

  constructor(private readonly options: CompileOptions) {}

  /**
   * Runs a translation, returning it with whatever joins its navigations needed.
   *
   * Deduplication is per clause: `where(o => o.user.name === 'a' && o.user.age > 3)`
   * joins once, while a navigation used in two clauses joins in each. Both are
   * correct, since a reference matches at most one row.
   */
  private translating<R>(run: () => R): { value: R; joins: readonly SqlJoin[] } {
    const outerJoins = this.navigationJoins;
    const outerScopes = this.navigationScopes;
    this.navigationJoins = [];
    this.navigationScopes = new Map();

    try {
      return { value: run(), joins: this.navigationJoins };
    } finally {
      this.navigationJoins = outerJoins;
      this.navigationScopes = outerScopes;
    }
  }

  /**
   * The scope of the row a reference points at, joining it in if need be.
   *
   * An optional reference is joined with a `LEFT JOIN`, so a row whose key is
   * null keeps its place and reads the target's columns as null. A required one
   * is an `INNER JOIN`, which is what the metadata promised.
   */
  private followReference(reference: ResolvedRelation): RowScope {
    if (reference.kind === 'collection') {
      throw new UnsupportedExpressionError(
        `"${reference.property}" is many rows, not one, so no column can be read off it. ` +
          `Flatten it with selectMany((row) => row.${reference.property}, ...) instead.`,
      );
    }

    const cacheKey = `${reference.from}.${reference.property}`;
    const cached = this.navigationScopes.get(cacheKey);
    if (cached) return cached;

    if (!this.navigationJoins) {
      throw new UnsupportedExpressionError(
        `The reference "${reference.property}" cannot be followed here. Navigations are read in ` +
          'the clauses that filter, project, order, or group a query.',
      );
    }

    const target = reference.relation.target();
    const to = reference.relation.to ?? onlyPrimaryKey(target, reference.property);
    const { scope, from, filter } = this.entityTable(target);

    const matched = scope.resolve(to);
    if (!matched) {
      throw new ModelError(
        `Relation "${reference.property}" points at "${to}" on entity "${target.name}", ` +
          `which has no such column. Available: ${Object.keys(target.columns).join(', ')}.`,
      );
    }

    this.navigationJoins.push({
      kind: reference.relation.optional ? 'left' : 'inner',
      source: from,
      on: conjoin(filter, sqlBinary('=', reference.key, matched)),
    });

    this.navigationScopes.set(cacheKey, scope);
    return scope;
  }

  /**
   * A freshly aliased table, with the scope that reads columns off it and the
   * entity's own query filter, translated against that scope if it declared
   * one.
   *
   * Every navigation join reads a target's rows through this one place, so
   * folding the filter in here is what makes it reach a reference, a
   * collection, and everything built from either of them, `some`, `every`,
   * `groupJoin`, and a collection's own aggregates included, rather than
   * only the entity set a query happened to start from.
   */
  private entityTable(entity: EntityDefinition): {
    from: SqlFrom;
    scope: EntityScope;
    filter: SqlExpression | null;
  } {
    const alias = this.nextAlias();
    const scope = new EntityScope(alias, entity);
    const filter = entity.filter
      ? this.translate(entity.filter.body, LambdaScope.bind(entity.filter, [asRow(scope)]))
      : null;

    return {
      from: entity.schema
        ? { kind: 'table', schema: entity.schema, name: entity.table, alias }
        : { kind: 'table', name: entity.table, alias },
      scope,
      filter,
    };
  }

  /**
   * The join that flattens a collection navigation.
   *
   * The mirror of following a reference: the key is compared the other way
   * round, and the result multiplies rows rather than matching at most one, so
   * this is only reachable through `selectMany`.
   */
  private resolveCollection(selector: LambdaExpression, source: RowScope): ResolvedRelation {
    const body = selector.body;
    if (body.kind !== 'member' || body.object.kind !== 'parameter') {
      throw new UnsupportedExpressionError(
        'The collection a "selectMany" flattens must be one of the row\'s own collections, ' +
          'as (u) => u.orders.',
      );
    }

    const navigated = source.navigate?.(body.property);
    if (!navigated) {
      throw new InvalidQueryError(
        `"${body.property}" is not a collection of ${source.describe()}. Available: ` +
          `${(source.references?.() ?? []).join(', ') || 'none'}.`,
      );
    }

    if (navigated.kind !== 'collection') {
      throw new UnsupportedExpressionError(
        `"${body.property}" refers to one row, not many, so there is nothing to flatten. ` +
          `Read a column off it directly, as ${body.object.name}.${body.property}.<column>.`,
      );
    }

    return navigated;
  }

  /**
   * The join that flattens a resolved collection.
   *
   * `keys` is where the key is read from, which is not always the scope the
   * relation was found on: a source that had to be materialized first exposes
   * the same column through the derived table instead.
   */
  private expandCollection(navigated: ResolvedRelation, keys: RowScope): ExpandedCollection {
    if (navigated.kind !== 'collection') {
      throw new UnsupportedExpressionError(`"${navigated.property}" is not a collection.`);
    }

    const key = keys.resolve(navigated.keyProperty) ?? navigated.key;
    const target = navigated.relation.target();
    const { scope, from, filter } = this.entityTable(target);

    const matched = scope.resolve(navigated.relation.from);
    if (!matched) {
      throw new ModelError(
        `Collection "${navigated.property}" is keyed by "${navigated.relation.from}" on entity ` +
          `"${target.name}", which has no such column. Available: ` +
          `${Object.keys(target.columns).join(', ')}.`,
      );
    }

    return {
      scope,
      join: { kind: 'inner', source: from, on: conjoin(filter, sqlBinary('=', matched, key)) },
    };
  }

  /**
   * The `LATERAL` join that flattens a collection read with its own
   * `where`/`orderBy`/`skip`/`take`, rather than read whole.
   *
   * The shape's plan is compiled the ordinary way, since it was built the
   * ordinary way, one `.where`/`.orderBy`/`.take` at a time; nothing here
   * translates any of that a second time. What is added is the correlation,
   * folded into that same statement's own `WHERE` rather than left to a join
   * condition around it, because an `ORDER BY`/`LIMIT` inside has to see only
   * this outer row's matches before either one runs. Reading that back
   * requires `LATERAL`: an ordinary derived table may not mention a `FROM`
   * item that precedes it, and this one's own `WHERE` now does.
   *
   * The scope this hands back knows columns rather than an entity, the same
   * as any other derived table's, so nothing here could resolve a further
   * navigation even if `selectMany` did not already reshape the row before a
   * caller could ask for one.
   */
  private expandLateralCollection(
    navigated: ResolvedRelation,
    keys: RowScope,
    shape: { readonly plan: QueryPlan },
  ): ExpandedCollection {
    if (navigated.kind !== 'collection') {
      throw new UnsupportedExpressionError(`"${navigated.property}" is not a collection.`);
    }

    const key = keys.resolve(navigated.keyProperty) ?? navigated.key;
    const compiled = this.compile(shape.plan);

    if (compiled.select.groupBy.length > 0 || compiled.select.setOperations.length > 0) {
      throw new UnsupportedExpressionError(
        `"${navigated.property}" cannot be shaped with "groupBy" or a set operation: the ` +
          "correlation to the outer row has nowhere to go once the shape's rows are no longer one per match.",
      );
    }

    const matched = compiled.scope.resolve(navigated.relation.from);
    if (!matched) {
      throw new ModelError(
        `Collection "${navigated.property}" is keyed by "${navigated.relation.from}", which has ` +
          'no such column on the shape it was read with.',
      );
    }

    const alias = this.nextAlias();
    const columns = compiled.select.columns;

    return {
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        'selectMany',
        inherited(compiled.scope),
      ),
      join: {
        kind: 'cross',
        source: {
          kind: 'derived',
          select: {
            ...compiled.select,
            where: conjoin(compiled.select.where, sqlBinary('=', matched, key)),
          },
          alias,
          lateral: true,
        },
        on: null,
      },
    };
  }

  nextAlias(): string {
    const alias = `t${this.aliasCounter}`;
    this.aliasCounter += 1;
    return alias;
  }

  compile(plan: QueryPlan): CompiledQuery {
    switch (plan.kind) {
      case 'source':
        return this.compileSource(plan.entity);
      case 'rawSource':
        return this.compileRawSource(plan);
      case 'where':
        return this.compileWhere(plan.source, plan.predicate);
      case 'tag':
        return this.compileTag(plan);
      case 'select':
        return this.compileSelect(plan.source, plan.projector);
      case 'orderBy':
        return this.compileOrderBy(plan.source, plan.keys);
      case 'skip':
        return this.compileSkip(plan.source, plan.count);
      case 'take':
        return this.compileTake(plan.source, plan.count);
      case 'last':
        return this.compileLast(plan);
      case 'distinct':
        return this.compileDistinct(plan.source);
      case 'while':
        return this.compileWhile(plan);
      case 'perKey':
        return this.compilePerKey(plan);
      case 'chunkBy':
        return this.compileChunkBy(plan);
      case 'setOperationBy':
        return this.compileSetOperationBy(plan);
      case 'pairwise':
        return this.compilePairwise(plan);
      case 'windowed':
        return this.compileWindowed(plan);
      case 'expanding':
        return this.compileExpanding(plan);
      case 'index':
        return this.compileIndex(plan);
      case 'rank':
        return this.compileRank(plan);
      case 'wherePosition':
        return this.compileWherePosition(plan);
      case 'defaultIfEmpty':
        return this.compileDefaultIfEmpty(plan);
      case 'sample':
        return this.compileSample(plan.source, plan.count);
      case 'setOperation':
        return this.compileSetOperation(plan);
      case 'join':
        return this.compileJoin(plan);
      case 'groupJoin':
        return this.compileGroupJoin(plan);
      case 'selectMany':
        return this.compileSelectMany(plan);
      case 'zip':
        return this.compileZip(plan);
      case 'sequenceEqual':
        return this.compileSequenceEqual(plan);
      case 'groupBy':
        return this.compileGroupBy(plan);
      case 'literalRow':
        return this.compileLiteralRow(plan);
    }
  }

  /**
   * Records a tag and compiles the query under it, unchanged.
   *
   * The one operator that adds nothing to the statement it compiles into. The
   * text is collected on the compiler rather than attached to the `SELECT`
   * being built, because that `SELECT` may yet be wrapped in a derived table by
   * a later clause or by a counting terminal, and a comment is worth reading at
   * the top of the statement rather than from the middle of a subquery.
   *
   * Collecting here rather than walking the plan is also what makes a tag on a
   * joined or combined side count. The compiler reaches every branch it folds
   * in, where a walk down the spine would have seen only the query the tag
   * happened to be written on.
   */
  private compileTag(plan: TagNode): CompiledQuery {
    // Prepended rather than appended, because compilation descends from the
    // last operator written to the first and would otherwise print a chain's
    // tags backwards. Two tags on separate sides of a join or a set operation
    // have no such order between them, and take whichever one the branches were
    // folded in.
    this.tags.unshift(plan.text);
    return this.compile(plan.source);
  }

  private compileSource(entity: EntityDefinition): CompiledQuery {
    const alias = this.nextAlias();
    const columns: SqlProjection[] = Object.keys(entity.columns).map((property) => ({
      expression: column(alias, physicalName(entity.columns, property)),
      alias: property,
    }));

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns,
        from: entity.schema
          ? { kind: 'table', schema: entity.schema, name: entity.table, alias }
          : { kind: 'table', name: entity.table, alias },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
      scope: new EntityScope(alias, entity),
    };
  }

  /**
   * A source read from a caller's own SQL fragment rather than a plain table.
   *
   * The columns projected are `compileSource`'s own, since the fragment has
   * to answer with the entity's physical columns for anything composed on
   * top to keep working, and the scope is the same `EntityScope` for the same
   * reason: a raw source reads exactly like an ordinary one from here on.
   *
   * Each value is translated once, under an empty scope, since `constant` is
   * all `RawSourceNode.values` is ever built from and none of it reads a row
   * or a parameter bag, the same reasoning `compileLiteralRow` makes for
   * `append`'s row. The printer interleaves the translated values with the
   * fragment's literal text, so a value prints as an ordinary bound parameter
   * in whatever position it was written, sharing the running placeholder
   * count the rest of the statement uses.
   */
  private compileRawSource(plan: RawSourceNode): CompiledQuery {
    const alias = this.nextAlias();
    const columns: SqlProjection[] = Object.keys(plan.entity.columns).map((property) => ({
      expression: column(alias, physicalName(plan.entity.columns, property)),
      alias: property,
    }));

    const empty = LambdaScope.bind({ kind: 'lambda', parameters: [], body: constant(null) }, []);
    const values = plan.values.map((value) => this.translate(value, empty));

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns,
        from: { kind: 'raw', parts: plan.sql, values, alias },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
      scope: new EntityScope(alias, plan.entity),
    };
  }

  private compileWhere(source: QueryPlan, predicate: LambdaExpression): CompiledQuery {
    // A filter applied after paging or DISTINCT must run over the already
    // limited rows, so the existing query becomes a derived table.
    const current = this.materializeIf(this.compile(source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const { value: condition, joins } = this.translating(() =>
      this.translate(predicate.body, LambdaScope.bind(predicate, [asRow(current.scope)])),
    );

    const select = withNavigations(current.select, joins);

    // Over a grouped query the filter is about groups, not rows, and the rows
    // it would have filtered no longer exist by the time it runs. Note that the
    // materialization above already ran, so a filter after paging lands on the
    // unfiltered `where` of the wrapping select instead, which is correct.
    if (select.groupBy.length > 0) {
      return {
        select: { ...select, having: conjoin(select.having, condition) },
        scope: current.scope,
      };
    }

    return {
      select: { ...select, where: conjoin(select.where, condition) },
      scope: current.scope,
    };
  }

  private compileSelect(source: QueryPlan, projector: LambdaExpression): CompiledQuery {
    const current = this.materializeIf(this.compile(source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const { value: projected, joins } = this.translating(() =>
      this.project(
        current.select,
        projector.body,
        LambdaScope.bind(projector, [asRow(current.scope)]),
      ),
    );

    return { ...projected, select: withNavigations(projected.select, joins) };
  }

  private compileOrderBy(
    source: QueryPlan,
    keys: readonly { key: LambdaExpression; descending: boolean }[],
  ): CompiledQuery {
    const current = this.materializeIf(this.compile(source), (select) =>
      Boolean(select.limit || select.offset || select.setOperations.length > 0),
    );

    const { value: orderBy, joins } = this.translating(() =>
      keys.map((entry) => ({
        expression: this.translate(
          entry.key.body,
          LambdaScope.bind(entry.key, [asRow(current.scope)]),
        ),
        descending: entry.descending,
      })),
    );

    return {
      select: { ...withNavigations(current.select, joins), orderBy },
      scope: current.scope,
    };
  }

  private compileSkip(source: QueryPlan, count: number): CompiledQuery {
    // Skipping over rows a `take` already limited has to happen after that
    // limit, not before it. SQL applies OFFSET first, so folding both into one
    // select would turn "the first ten, less the first two" into "ten, starting
    // from the third", which is a different count of different rows.
    const current = this.materializeIf(
      this.compile(source),
      (select) =>
        select.offset !== null || select.limit !== null || select.setOperations.length > 0,
    );
    return {
      select: { ...current.select, offset: sqlLiteral(String(integer(count, 'skip'))) },
      scope: current.scope,
    };
  }

  private compileTake(source: QueryPlan, count: number): CompiledQuery {
    const current = this.materializeIf(
      this.compile(source),
      (select) => select.limit !== null || select.setOperations.length > 0,
    );
    return {
      select: { ...current.select, limit: sqlLiteral(String(integer(count, 'take'))) },
      scope: current.scope,
    };
  }

  /**
   * The rows at the end of an ordered query, kept or dropped.
   *
   * SQL can only page from the front, so either side is reached by flipping
   * every sort key: the last rows are then the first, and one `LIMIT` or one
   * `OFFSET` separates `takeLast` from `skipLast`. That the complement is a
   * single word is why the two share this method, as `takeWhile` and
   * `skipWhile` share theirs. What flipping leaves is the rows backwards, so
   * the ordering is applied once more outside.
   *
   * The two do not cost the same, and the asymmetry is SQL's rather than this
   * compilation's. `takeLast`'s `LIMIT` lets the database stop at `count` rows
   * and lets an index on the sort key serve the flipped order, so the table is
   * never sorted; `skipLast`'s `OFFSET` has to reach every row past `count`
   * and so orders all of them. Nothing cheaper exists for it: which rows are
   * last is a question about the whole sequence.
   *
   * A window would answer either without the second sort, but `ROW_NUMBER` has
   * to number every row before it can say which are last, which is the whole
   * table where `takeLast`'s `LIMIT` is `count` rows. The extra sort is the
   * smaller cost there, and taking the same shape for both keeps the complement
   * one word away.
   */
  private compileLast(plan: LastNode): CompiledQuery {
    const operator = plan.take ? 'takeLast' : 'skipLast';

    // The rows at the end are the source's own, so paging, DISTINCT, and set
    // operations are settled before the order is flipped underneath them.
    // DISTINCT is in the list for a second reason: the sort keys are carried
    // out as extra columns below, and duplicate rows telling apart on a column
    // the caller never selected is not what `distinct` promised.
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers these on an
      // ordered query. Without an ordering there is no end of the sequence to
      // count back from.
      throw new InvalidQueryError(
        `"${operator}" needs an ordering to know which end of the sequence is the last. ` +
          'Order the query first.',
      );
    }

    const alias = this.nextAlias();
    const columns = current.select.columns;

    // Each sort key is carried out under a name of its own, because the outer
    // sort has to reapply it and a key is not always a selected column: it can
    // be an expression, or reach through a navigation whose join only exists
    // inside the derived table.
    const carried = ordering.map((entry, index) => ({
      expression: entry.expression,
      alias: `${SORT_PREFIX}${index}`,
    }));

    const paged = sqlLiteral(String(integer(plan.count, operator)));

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: {
          kind: 'derived',
          select: {
            ...current.select,
            columns: [...columns, ...carried],
            orderBy: ordering.map((entry) => ({ ...entry, descending: !entry.descending })),
            // The one word the two operators differ by: the rows counted back
            // from the end are what one keeps and the other drops.
            ...(plan.take ? { limit: paged } : { offset: paged }),
          },
          alias,
        },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: carried.map((projection, index) => ({
          expression: column(alias, projection.alias),
          descending: ordering[index]!.descending,
        })),
        limit: null,
        offset: null,
      },
      // The carried keys stay inside the derived table, so nothing downstream
      // can see or collide with them.
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        operator,
        // The rows are the entity's own, flipped and paged and flipped back, so a
        // navigation off one resolves as it would before the paging.
        current.scope,
      ),
    };
  }

  private compileDistinct(source: QueryPlan): CompiledQuery {
    const current = this.materializeIf(this.compile(source), (select) =>
      Boolean(select.limit || select.offset || select.setOperations.length > 0),
    );
    return { select: { ...current.select, distinct: true }, scope: current.scope };
  }

  private compileJoin(plan: JoinNode): CompiledQuery {
    // A join that keeps the rows of the joined side has to settle a filter on
    // this side first as well. A `WHERE` is read after the join, so a row the
    // join kept with this side's columns null fails any test of them, and a
    // `FULL JOIN` or a `RIGHT JOIN` written after a `where` would quietly
    // return what an `INNER JOIN` returns. The kinds that preserve this side,
    // `inner` and `left`, are unaffected: filtering their rows before or after
    // the join is the same set either way.
    const keepsInner = plan.joinKind === 'right' || plan.joinKind === 'full';

    // Paging, DISTINCT, or grouping on the outer side has to be settled before
    // the join: a join runs before grouping and would otherwise change which
    // rows were limited or which rows each group was built from.
    const outer = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(
        select.limit ||
        select.offset ||
        select.distinct ||
        select.groupBy.length > 0 ||
        select.setOperations.length > 0 ||
        (keepsInner && select.where !== null),
      ),
    );

    const inner = this.joinSource(this.compile(plan.inner));

    const on = sqlBinary(
      '=',
      this.translate(plan.outerKey.body, LambdaScope.bind(plan.outerKey, [asRow(outer.scope)])),
      this.translate(plan.innerKey.body, LambdaScope.bind(plan.innerKey, [asRow(inner.scope)])),
    );

    const joined: SqlSelect = {
      ...outer.select,
      joins: [...outer.select.joins, { kind: plan.joinKind, source: inner.from, on }],
    };

    return this.project(
      joined,
      plan.projector.body,
      LambdaScope.bind(plan.projector, [asRow(outer.scope), asRow(inner.scope)]),
    );
  }

  /**
   * A join whose result selector reads the matches rather than one of them.
   *
   * The outer query is left as it is and each aggregate the projector asks for
   * becomes a correlated subquery over the joined side. The alternative, a
   * `LEFT JOIN` with a `GROUP BY` around it, has to name every column of the
   * outer row in that `GROUP BY` to put the row back together, and then two
   * outer rows alike in every column collapse into one where `GroupJoin`
   * answers two. Correlating instead leaves the outer query's row count alone,
   * which is the operator's whole contract.
   *
   * The other side is prepared with `joinSource` even though nothing is joined,
   * because the question it answers is the same one: whether the query can
   * contribute its `FROM` directly or has to become a derived table first.
   */
  private compileGroupJoin(plan: GroupJoinNode): CompiledQuery {
    // Paging, DISTINCT, or grouping on the outer side is settled first, for the
    // reason `compileJoin` settles it: the subqueries below are evaluated per
    // row of whatever the outer query ends up being.
    const outer = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(
        select.limit ||
        select.offset ||
        select.distinct ||
        select.groupBy.length > 0 ||
        select.setOperations.length > 0,
      ),
    );

    const inner = this.joinSource(this.compile(plan.inner));

    const on = sqlBinary(
      '=',
      this.translate(plan.outerKey.body, LambdaScope.bind(plan.outerKey, [asRow(outer.scope)])),
      this.translate(plan.innerKey.body, LambdaScope.bind(plan.innerKey, [asRow(inner.scope)])),
    );

    return this.project(
      outer.select,
      plan.projector.body,
      LambdaScope.bind(plan.projector, [
        asRow(outer.scope),
        asMatches(inner.scope, inner.from, on),
      ]),
    );
  }

  /**
   * One aggregate over the rows matching an outer row, as a subquery.
   *
   * An aggregate with no `GROUP BY` returns exactly one row, which is what lets
   * this stand where a value would. `COUNT` over no rows is zero, which is what
   * `GroupJoin` promises for an outer row with no matches; `SUM` over no rows
   * is null in SQL and zero in LINQ, so it takes the same `COALESCE` the
   * terminal `sum` takes. `MIN`, `MAX`, and `AVG` are left null, since SQL has
   * no other answer and LINQ would have thrown rather than invent one.
   * `toArray` takes the same `COALESCE` as `SUM`, for the same reason: no
   * matches should read as no rows, an empty array, rather than null.
   */
  private correlatedAggregate(
    binding: { rows: RowScope; from: SqlFrom; on: SqlExpression | null },
    method: string,
    args: readonly ExpressionNode[],
  ): SqlExpression {
    // A navigation the selector followed belongs inside the subquery, which is
    // the only place its columns are in scope. Left to the clause around this
    // one, the join would be attached to a query whose `FROM` cannot see the
    // alias it reads.
    const { value: aggregate, joins } = this.translating(() =>
      // A correlated aggregate is over the rows the subquery selects and never
      // over a frame, so it takes no window: the `on` clause is what narrows it.
      this.translateAggregate(binding.rows, method, args, null),
    );

    const subquery: SqlExpression = {
      kind: 'subquery',
      select: {
        kind: 'select',
        distinct: false,
        columns: [{ expression: aggregate, alias: MATCHES_COLUMN }],
        from: binding.from,
        joins: [...joins],
        where: binding.on,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
    };

    if (method === 'sum') return sqlFunction('COALESCE', [subquery, sqlLiteral('0')]);
    if (method === 'toArray') {
      return sqlFunction('COALESCE', [
        subquery,
        sqlBinary('::', sqlLiteral("'[]'"), sqlLiteral('json')),
      ]);
    }
    return subquery;
  }

  private compileSetOperation(plan: SetOperationNode): CompiledQuery {
    // An ordering or a page belongs to the branch that asked for it, but SQL
    // reads both as belonging to the whole operation and will not take them on
    // a branch without parentheses. Either one makes a branch a derived table.
    const isBounded = (select: SqlSelect) =>
      Boolean(select.limit || select.offset || select.orderBy.length > 0);

    const binding = SET_PRECEDENCE[plan.operator];

    // A run of set operators reads left to right only while they all bind
    // equally tightly. `INTERSECT` binds tighter than `UNION` and `EXCEPT`, so
    // `(A UNION B) INTERSECT C` cannot be written flat: SQL would read the
    // result as `A UNION (B INTERSECT C)`, a different set. Where the operators
    // disagree, the left branch becomes a derived table and the grouping the
    // caller chained is preserved.
    const left = this.materializeIf(
      this.compile(plan.source),
      (select) =>
        isBounded(select) ||
        select.setOperations.some((operation) => SET_PRECEDENCE[operation.kind] !== binding),
    );

    // The right branch may carry no set operation at all, whatever it binds
    // like: flattening it would re-associate the whole run to the left.
    const right = this.materializeIf(
      this.compile(plan.other),
      (select) => isBounded(select) || select.setOperations.length > 0,
    );

    return {
      select: {
        ...left.select,
        setOperations: [
          ...left.select.setOperations,
          {
            kind: plan.operator,
            all: plan.all,
            select: alignColumns(right.select, left.select),
          },
        ],
      },
      scope: left.scope,
    };
  }

  private compileWhile(plan: WhileNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const operator = plan.take ? 'takeWhile' : 'skipWhile';

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers these on an
      // ordered query, but the plan can be built by hand and the answer would
      // otherwise be whichever rows the database happened to return first.
      throw new InvalidQueryError(
        `"${operator}" needs an ordering to know where the sequence starts. Order the query first.`,
      );
    }

    const { value: condition, joins } = this.translating(() =>
      this.translate(plan.predicate.body, LambdaScope.bind(plan.predicate, [asRow(current.scope)])),
    );

    // A running count of the rows that have failed the predicate at or before
    // each row. It is zero for exactly the rows ahead of the first failure and
    // non-zero from that failure onward, so the same window answers both
    // operators and only the comparison below differs. A predicate that is NULL
    // rather than true counts as a failure, since the ELSE branch takes it.
    const failures: SqlExpression = {
      kind: 'over',
      name: 'SUM',
      args: [
        {
          kind: 'case',
          branches: [{ condition, result: sqlLiteral('0') }],
          otherwise: sqlLiteral('1'),
        },
      ],
      partitionBy: [],
      orderBy: ordering,
      frame: 'ROWS UNBOUNDED PRECEDING',
    };

    // The ordering cannot be relied on to survive a derived table, so it is
    // carried out as a column and reapplied outside.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const alias = this.nextAlias();
    const columns = current.select.columns;

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: {
          kind: 'derived',
          select: {
            // A navigation the predicate followed is joined inside the derived
            // table, which is the only place its columns are in scope.
            ...withNavigations(current.select, joins),
            columns: [
              ...columns,
              { expression: failures, alias: FAILURES_COLUMN },
              { expression: position, alias: POSITION_COLUMN },
            ],
            // The window carries the ordering now, so the inner select repeating
            // it would only buy a second sort.
            orderBy: [],
          },
          alias,
        },
        joins: [],
        where: sqlBinary(plan.take ? '=' : '>', column(alias, FAILURES_COLUMN), sqlLiteral('0')),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
        limit: null,
        offset: null,
      },
      // The two bookkeeping columns stay inside the derived table, so nothing
      // downstream can see or collide with them.
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        operator,
        // The rows are the entity's own, cut at the first failure, so a navigation
        // off one resolves.
        current.scope,
      ),
    };
  }

  /**
   * Some rows of each key, resolved with a window rather than a dialect's own
   * shorthand.
   *
   * Rows are numbered within each key over the query's ordering and the window
   * the node asks for is kept: the first row of each for `distinctBy`, the first
   * `take` of each for a filtered `include`. PostgreSQL spells the first case
   * `DISTINCT ON`, which is shorter but is PostgreSQL's alone, drags its own rule
   * that the leading `ORDER BY` must match the key, and says nothing at all
   * about the second. `ROW_NUMBER` says both everywhere and leaves the ordering
   * the caller wrote intact.
   */
  private compilePerKey(plan: PerKeyNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which offers both operators that
      // build this node on an ordered query only. Without an ordering the
      // surviving rows of each key would be whichever ones the database happened
      // to reach first.
      throw new InvalidQueryError(
        `"${plan.operator}" needs an ordering to know which rows of each key to ` +
          'keep. Order the query first.',
      );
    }

    const { value: key, joins } = this.translating(() => this.groupKey(plan.key, current.scope));

    // Position within the key, which is what the window below is a test on.
    const rank: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: key.expressions,
      orderBy: ordering,
      frame: null,
    };

    // The ordering cannot be relied on to survive a derived table, so it is
    // carried out as a column and reapplied outside.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const alias = this.nextAlias();
    const columns = current.select.columns;

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: {
          kind: 'derived',
          select: {
            // A navigation the key followed is joined inside the derived table,
            // which is the only place its columns are in scope.
            ...withNavigations(current.select, joins),
            columns: [
              ...columns,
              { expression: rank, alias: RANK_COLUMN },
              { expression: position, alias: POSITION_COLUMN },
            ],
            // The windows carry the ordering now, so the inner select repeating
            // it would only buy a second sort.
            orderBy: [],
          },
          alias,
        },
        joins: [],
        where: keptPerKey(column(alias, RANK_COLUMN), plan.skip, plan.take),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
        limit: null,
        offset: null,
      },
      // The two bookkeeping columns stay inside the derived table, so nothing
      // downstream can see or collide with them.
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        // The scope goes through whole rather than its types alone, so a
        // navigation still resolves after the window: the rows are the same
        // entity's, and its foreign keys came out of the derived table under
        // their own names.
        plan.operator,
        current.scope,
      ),
    };
  }

  /**
   * One run of consecutive rows sharing a key, numbered so that a single
   * statement can ask for a single run.
   *
   * A row starts a new run when its key differs from the key of the row before
   * it in the query's own ordering, which `LAG` is what reaches back for. A
   * running sum of those breaks then numbers the runs 1, 2, 3 ... in that same
   * order, which is `takeWhile`'s window put to a second use: there it counts
   * failures to find where a sequence stops, here it counts boundaries to say
   * which side of each one a row falls on. Numbering them contiguously is what
   * lets the caller walk them by index and stop at the first empty answer,
   * without a count or a second statement to learn there is nothing left.
   *
   * That takes two derived tables rather than the one every other windowed
   * operator here needs, because the sum is over the result of the `LAG` and
   * SQL will not nest one window function inside another. The break is settled
   * a level down and summed a level up, where it is an ordinary column. The
   * outer window orders by the position carried out of the inner one rather
   * than by the query's ordering again, which says the same thing and is the
   * only spelling still in scope: an ordering that followed a navigation left
   * its columns behind with the join that produced them.
   */
  private compileChunkBy(plan: ChunkByNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers this on an ordered
      // query. Without an ordering no two rows are consecutive, so every run
      // would be whatever the database happened to return next to what.
      throw new InvalidQueryError(
        '"chunkBy" needs an ordering to know which rows are consecutive. Order the query first.',
      );
    }

    const { value: key, joins } = this.translating(() => this.groupKey(plan.key, current.scope));

    const columns = current.select.columns;

    // The ordering cannot be relied on to survive a derived table, so it is
    // carried out as a column and reapplied outside. Both levels above read it
    // rather than the ordering itself.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const broken: SqlSelect = {
      // A navigation the key or the ordering followed is joined here, which is
      // the only place its columns are in scope.
      ...withNavigations(current.select, joins),
      columns: [
        ...columns,
        {
          expression: {
            kind: 'case',
            branches: [
              {
                // A row with no row before it starts a run whatever its key,
                // and saying so takes asking. The rest of the condition reads
                // the absent previous row as a null key, so the first row of a
                // table whose key is null would otherwise match it and the
                // first run would be numbered zero. This is the same window
                // that becomes the position column, written twice because SQL
                // has no way to read an alias from its own select list.
                condition: sqlBinary(
                  'AND',
                  sqlBinary('>', position, sqlLiteral('1')),
                  this.sameAsPrevious(key.expressions, ordering),
                ),
                result: sqlLiteral('0'),
              },
            ],
            otherwise: sqlLiteral('1'),
          },
          alias: BREAK_COLUMN,
        },
        { expression: position, alias: POSITION_COLUMN },
      ],
      // The windows carry the ordering now, so the inner select repeating it
      // would only buy a second sort.
      orderBy: [],
    };

    const brokenAlias = this.nextAlias();
    const carried = [...columns.map((projection) => projection.alias), POSITION_COLUMN];

    const numbered: SqlSelect = {
      kind: 'select',
      distinct: false,
      columns: [
        ...carried.map((alias) => ({ expression: column(brokenAlias, alias), alias })),
        {
          expression: {
            kind: 'over',
            name: 'SUM',
            args: [column(brokenAlias, BREAK_COLUMN)],
            partitionBy: [],
            orderBy: [{ expression: column(brokenAlias, POSITION_COLUMN), descending: false }],
            frame: 'ROWS UNBOUNDED PRECEDING',
          },
          alias: CHUNK_COLUMN,
        },
      ],
      from: { kind: 'derived', select: broken, alias: brokenAlias },
      joins: [],
      where: null,
      groupBy: [],
      having: null,
      setOperations: [],
      orderBy: [],
      limit: null,
      offset: null,
    };

    const alias = this.nextAlias();

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: { kind: 'derived', select: numbered, alias },
        joins: [],
        // The runs are numbered from one and the index from zero, and the
        // difference is settled here rather than in the statement: an index is
        // a number the compiler holds, so the SQL reads `= 1` rather than
        // carrying arithmetic no database needs to redo per row.
        where: sqlBinary(
          '=',
          column(alias, CHUNK_COLUMN),
          sqlLiteral(String(integer(plan.index, 'chunkBy') + 1)),
        ),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
        limit: null,
        offset: null,
      },
      // The three bookkeeping columns stay inside the derived tables, so nothing
      // downstream can see or collide with them.
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        // The run is this entity's rows, so a navigation off one resolves.
        'chunkBy',
        current.scope,
      ),
    };
  }

  /**
   * Whether every part of the key matches the row before this one.
   *
   * `LAG` is what reaches back for the previous row, and the comparison is the
   * null-tolerant one for the reason `notDistinctFrom` gives.
   */
  private sameAsPrevious(
    key: readonly SqlExpression[],
    ordering: readonly SqlOrdering[],
  ): SqlExpression {
    const matches = key.map((expression) =>
      notDistinctFrom(expression, {
        kind: 'over',
        name: 'LAG',
        args: [expression],
        partitionBy: [],
        orderBy: ordering,
        frame: null,
      }),
    );

    // An object key is one key with several parts, so a run continues only
    // while all of them do, exactly as `groupBy` treats such a key as one.
    return matches.reduce((left, right) => sqlBinary('AND', left, right));
  }

  /**
   * The rows whose key does not appear in the other query.
   *
   * `NOT EXISTS` rather than `NOT IN`, which is the trap this operator would
   * otherwise walk into: a subquery that yields a single null makes `NOT IN`
   * answer unknown for every row and the whole query return nothing, silently
   * and only when the data happens to contain a null. `NOT EXISTS` asks about
   * rows rather than about values and has no such cliff.
   *
   * A left join against a marker column would say the same thing without a new
   * AST node, and is not worth the two extra moving parts: the marker has to be
   * a constant rather than the joined key, since a null-tolerant match makes a
   * matched row's key null too, and the column then has to be hidden from
   * everything downstream. The subquery says what is meant and is what every
   * database plans as an anti-join anyway.
   */
  private compileSetOperationBy(plan: SetOperationByNode): CompiledQuery {
    const operator = plan.operator === 'except' ? 'exceptBy' : 'intersectBy';

    // This is a filter, so it takes `where`'s rule: applied after paging or
    // DISTINCT it has to run over the rows those settled on. Grouping
    // materializes too rather than becoming a `HAVING`, because the rows being
    // subtracted here are the groups themselves.
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(
        select.limit ||
        select.offset ||
        select.distinct ||
        select.groupBy.length > 0 ||
        select.setOperations.length > 0,
      ),
    );

    const other = this.joinSource(this.compile(plan.other));

    const { value: key, joins } = this.translating(() => this.keyParts(plan.key, current.scope));
    const { value: otherKey, joins: otherJoins } = this.translating(() =>
      this.keyParts(plan.otherKey, other.scope),
    );

    // The one field the two operators differ by. `exceptBy` asks for the rows
    // the key was not found for, `intersectBy` for the rows it was.
    const found: SqlExpression = {
      kind: 'exists',
      negated: plan.operator === 'except',
      select: {
        kind: 'select',
        distinct: false,
        // `EXISTS` asks whether a row is there and never reads it, so the
        // column list is a constant rather than the other query's own.
        columns: [{ expression: sqlLiteral('1'), alias: EXISTS_COLUMN }],
        from: other.from,
        // A navigation the other key followed belongs inside the subquery,
        // which is the only place its columns are in scope.
        joins: otherJoins,
        where: matchKeys(key, otherKey, operator),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
    };

    // A navigation this side's key followed belongs to the query around it.
    const select = withNavigations(current.select, joins);

    return {
      select: { ...select, where: conjoin(select.where, found) },
      scope: current.scope,
    };
  }

  /**
   * The parts of a key, carrying the names the caller gave them.
   *
   * An object literal is one key with several parts, as `groupBy` reads such a
   * key. Keeping the names rather than only the expressions is what lets two
   * keys written on different entities be paired by what each part means
   * instead of by where it happens to sit, which is the lesson `alignColumns`
   * already learned for the branches of a set operation.
   */
  private keyParts(key: LambdaExpression, source: RowScope): CompiledKey {
    const scope = LambdaScope.bind(key, [asRow(source)]);

    if (key.body.kind === 'object') {
      const parts = new Map<string, SqlExpression>();
      for (const property of key.body.properties) {
        parts.set(property.name, this.translate(property.value, scope));
      }
      return { named: true, parts };
    }

    // One expression, with no name to pair on and none needed.
    return { named: false, parts: new Map([['', this.translate(key.body, scope)]]) };
  }

  /**
   * Each row beside the one before it, both in scope for one projector.
   *
   * `LAG` is what reaches back a row, and it is taken over every column rather
   * than over the ones the projector turns out to read, which cannot be known
   * before the projector is translated and the projector is translated against
   * the result. Doing it a level down is also what keeps the windows out of the
   * projector's way: one window cannot be nested inside another, and the pairs
   * have to stay filterable, which a window in a `WHERE` is not.
   *
   * The first row has nothing before it, which `LAG` answers as null for every
   * column. That is indistinguishable from a previous row whose columns were all
   * null, so the row is dropped by its position rather than by looking at the
   * values, and a query of `n` rows becomes `n - 1`.
   */
  private compilePairwise(plan: PairwiseNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers this on an ordered
      // query. Without an ordering no row is before any other, so there would be
      // nothing for the operator to pair.
      throw new InvalidQueryError(
        '"pairwise" needs an ordering to know which row comes before which. ' +
          'Order the query first.',
      );
    }

    const columns = current.select.columns;
    const alias = this.nextAlias();

    // The ordering cannot be relied on to survive a derived table, so it is
    // carried out as a column and reapplied outside. It doubles as the test that
    // drops the first row.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const lagged: SqlSelect = {
      ...current.select,
      columns: [
        ...columns,
        ...columns.map((projection) => ({
          expression: {
            kind: 'over' as const,
            name: 'LAG',
            args: [projection.expression],
            partitionBy: [],
            orderBy: ordering,
            frame: null,
          },
          alias: `${PREVIOUS_PREFIX}${projection.alias}`,
        })),
        { expression: position, alias: POSITION_COLUMN },
      ],
      // The windows carry the ordering now, so the inner select repeating it
      // would only buy a second sort.
      orderBy: [],
    };

    // Two views of the same derived table, which is what lets one projector hold
    // both rows. Each keeps the row's own property names, so the projector reads
    // `previous.name` and `row.name` and neither knows about the prefix.
    const scopeFor = (prefix: string) =>
      new MapScope(
        new Map(
          columns.map((projection) => [
            projection.alias,
            column(alias, `${prefix}${projection.alias}`),
          ]),
        ),
        'pairwise',
      );

    const { value: projected, joins } = this.translating(() =>
      this.project(
        {
          kind: 'select',
          distinct: false,
          columns: [],
          from: { kind: 'derived', select: lagged, alias },
          joins: [],
          // The first row is dropped here rather than by testing the lagged
          // columns for null, which could not tell it from a real row of nulls.
          where: sqlBinary('>', column(alias, POSITION_COLUMN), sqlLiteral('1')),
          groupBy: [],
          having: null,
          setOperations: [],
          orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
          limit: null,
          offset: null,
        },
        plan.projector.body,
        LambdaScope.bind(plan.projector, [asRow(scopeFor(PREVIOUS_PREFIX)), asRow(scopeFor(''))]),
      ),
    );

    return { ...projected, select: withNavigations(projected.select, joins) };
  }

  /**
   * Every run of `size` consecutive rows, each reduced beside the row it ends
   * at.
   *
   * `pairwise` reaches back one row with `LAG` because two rows is a shape a
   * projector can name. A run of `size` rows is not, so this reaches for the
   * other thing a window can do: a frame of `size - 1` preceding rows and the
   * current one, over which the ordinary aggregates answer for the run. That is
   * why nothing here is added to the SQL AST — `SqlOver` already carries a
   * frame, and `chunkBy` had already used one.
   *
   * The first `size - 1` rows have no full run behind them and are dropped by
   * position rather than by testing an aggregate for null, which could not tell
   * a short run from a full one over a column of nulls. So `n` rows become
   * `n - size + 1`, which is `pairwise`'s `n - 1` when `size` is two.
   * `expanding` has no such rows to drop, which is the one place the two
   * operators part company below the frame text.
   */
  private compileWindowed(plan: WindowedNode): CompiledQuery {
    // Which spelling was written is readable off the partition rather than
    // stored beside it, so the message cannot drift from the node. A hardcoded
    // name here would have become a lie the moment the node grew a second
    // caller, which is what `matchKeys` learned when `intersectBy` arrived.
    const operator = plan.partition ? 'windowedBy' : 'windowed';

    return this.compileFramed(plan, {
      // The size has already been checked to be an integer of at least one
      // where the caller wrote it, which is what makes interpolating it here
      // the same kind of text as every other frame in this file rather than
      // user input.
      frame: `ROWS BETWEEN ${plan.size - 1} PRECEDING AND CURRENT ROW`,
      minimum: plan.size,
      unordered:
        `"${operator}" needs an ordering to know which rows are consecutive. ` +
        'Order the query first.',
    });
  }

  /**
   * Every row beside the run of every row up to it, each reduced the way
   * `windowed` reduces a run of fixed size.
   *
   * The whole of the difference is the near end of the frame: `UNBOUNDED
   * PRECEDING` where `windowed` counts back `size - 1` rows, which is what
   * turns the same aggregates from moving ones into running ones. Everything
   * else — the derived table, the carried position, the group receiver the
   * projector reads the run through — is `windowed`'s, so the two share a
   * compilation rather than each spelling that shape once.
   *
   * Dropping no rows falls out of taking no size. `windowed` has to discard
   * the rows with fewer than `size` rows behind them, since a short run and a
   * full run of nulls reduce alike; a run reaching back to the start of the
   * ordering is never short, the first row's holding that row alone, so there
   * is no position to test and `n` rows come back as `n`. The position is
   * still carried out of the derived table all the same, because the ordering
   * would not otherwise survive it.
   */
  private compileExpanding(plan: ExpandingNode): CompiledQuery {
    const operator = plan.partition ? 'expandingBy' : 'expanding';

    return this.compileFramed(plan, {
      frame: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
      minimum: null,
      unordered:
        `"${operator}" needs an ordering to know which rows come before. ` +
        'Order the query first.',
    });
  }

  /**
   * The shape `windowed` and `expanding` share: one frame over the query's
   * own ordering, reduced beside the row it ends at.
   *
   * The frame is computed here rather than in the projection above it for
   * `pairwise`'s reason and one of its own. A window cannot appear in a
   * `WHERE`, so a run computed in place would leave the result unfilterable;
   * and the rows without a full run behind them have to be dropped *after*
   * the frames are evaluated, since a `WHERE` applied first would shorten the
   * very frames it is meant to select from and the first surviving row would
   * average over itself alone. One derived table settles both: the aggregates
   * and the position are computed inside it and the position is tested
   * outside it.
   */
  private compileFramed(plan: WindowedNode | ExpandingNode, framing: Framing): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers these on an
      // ordered query. Without an ordering no rows are consecutive and none
      // comes before another, so a run would be whatever the database
      // happened to return next to what.
      throw new InvalidQueryError(framing.unordered);
    }

    // The key and the projector are translated together so a navigation either
    // one followed is joined once, inside the derived table where its columns
    // are in scope. The key has to come first: the frame it partitions is what
    // the projector then reduces over.
    const { value, joins } = this.translating(() => {
      const key = plan.partition ? this.groupKey(plan.partition, current.scope) : null;
      const window: WindowFrame = {
        partitionBy: key?.expressions ?? [],
        orderBy: ordering,
        frame: framing.frame,
      };

      // The run and the row it ends at are two readings of the same rows: one
      // reduced over the frame, one taken as it stands. Both resolve against
      // the scope the source produced, which is what lets a navigation still
      // be followed here where `pairwise` cannot follow one.
      return {
        window,
        projected: this.project(
          // The windows carry the ordering now, so the inner select repeating
          // it would only buy a second sort.
          { ...current.select, columns: [], orderBy: [] },
          plan.projector.body,
          LambdaScope.bind(plan.projector, [asRun(current.scope, window), asRow(current.scope)]),
        ),
      };
    });

    const { window, projected } = value;

    // The ordering cannot be relied on to survive a derived table, so it is
    // carried out as a column and reapplied outside. It is deliberately not
    // partitioned even when the frames are: a partition restarts the runs, not
    // the order the rows come back in, so an unpartitioned number is what puts
    // the result back in the order the caller asked for rather than grouping it
    // by key.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    // Where the run has a minimum, something has to count the rows behind each
    // one, and a partition splits that from the ordering above. Unpartitioned,
    // one number does both jobs and only `POSITION_COLUMN` is carried, which is
    // what keeps the generated statement identical to what it was before this
    // operator could partition at all. Partitioned, the count has to restart per
    // key while the ordering must not, so a second number is carried beside it
    // exactly as `distinctBy` carries its rank beside its position.
    const partitioned = window.partitionBy.length > 0;
    const rank: SqlExpression | null =
      partitioned && framing.minimum !== null
        ? {
            kind: 'over',
            name: 'ROW_NUMBER',
            args: [],
            partitionBy: window.partitionBy,
            orderBy: ordering,
            frame: null,
          }
        : null;
    const counter = rank ? RANK_COLUMN : POSITION_COLUMN;

    const columns = projected.select.columns;
    const alias = this.nextAlias();

    const framed: SqlSelect = {
      ...withNavigations(projected.select, joins),
      columns: [
        ...columns,
        { expression: position, alias: POSITION_COLUMN },
        ...(rank ? [{ expression: rank, alias: RANK_COLUMN }] : []),
      ],
    };

    const entries = new Map<string, SqlExpression>(
      columns.map((projection) => [projection.alias, column(alias, projection.alias)]),
    );

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: { kind: 'derived', select: framed, alias },
        joins: [],
        // A minimum of one would hold of every row, so an unbounded frame says
        // so with no condition at all rather than with one that reads as
        // though it were selecting something.
        where:
          framing.minimum === null
            ? null
            : sqlBinary('>=', column(alias, counter), sqlLiteral(String(framing.minimum))),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
        limit: null,
        offset: null,
      },
      // The projection named these columns and settled their types; reading
      // them back out of the derived table changes neither.
      scope: new MapScope(entries, plan.kind, inherited(projected.scope)),
    };
  }

  /**
   * Each row beside its position in the query's ordering.
   *
   * `ROW_NUMBER` is what counts, and it is computed a level down for the reason
   * `pairwise` computes its windows there: one window cannot be nested inside
   * another, and the projected rows have to stay filterable, which a window in a
   * `WHERE` is not. The same column carries the ordering back out, which a
   * derived table would otherwise lose.
   *
   * The position handed to the projector is one less than the number, because
   * `ROW_NUMBER` counts from one and LINQ's `Index` from zero. The gap is
   * closed here rather than in the caller's head, as `getMonth` closes the one
   * between JavaScript's months and `EXTRACT`'s, and the column itself keeps
   * counting from one so it means the same thing here as everywhere else in
   * this compiler.
   */
  private compileIndex(plan: IndexNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers this on an ordered
      // query. Without an ordering a position would be whichever number the
      // database happened to reach the row in.
      throw new InvalidQueryError(
        '"index" needs an ordering to number the rows over. Order the query first.',
      );
    }

    const columns = current.select.columns;
    const alias = this.nextAlias();

    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const numbered: SqlSelect = {
      ...current.select,
      columns: [...columns, { expression: position, alias: POSITION_COLUMN }],
      // The window carries the ordering now, so the inner select repeating it
      // would only buy a second sort.
      orderBy: [],
    };

    const rows = new MapScope(
      new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
      // The row beside the position is the entity's own, carried out of the
      // derived table column by column, so a navigation off it resolves.
      'index',
      current.scope,
    );

    const { value: projected, joins } = this.translating(() =>
      this.project(
        {
          kind: 'select',
          distinct: false,
          columns: [],
          from: { kind: 'derived', select: numbered, alias },
          joins: [],
          where: null,
          groupBy: [],
          having: null,
          setOperations: [],
          orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
          limit: null,
          offset: null,
        },
        plan.projector.body,
        LambdaScope.bind(plan.projector, [
          asRow(rows),
          // Counted from zero for the caller, from one in the column, and cast
          // because `ROW_NUMBER` is an exact numeric wide enough that several
          // drivers hand it back as a string rather than lose precision. The
          // projector's own `number` is what the cast makes true, and nothing
          // can be lost: a position this side of two billion rows is an int.
          asValue(
            this.options.dialect.castToInt(
              sqlBinary('-', column(alias, POSITION_COLUMN), sqlLiteral('1')),
            ),
          ),
        ]),
      ),
    );

    return { ...projected, select: withNavigations(projected.select, joins) };
  }

  /**
   * Each row beside its standing in the query's ordering.
   *
   * `index` numbers rows and this ranks them, which is one function name
   * apart in the statement and a different question in the query. `ROW_NUMBER`
   * gives two rows tied on every sort key different numbers; `RANK` and
   * `DENSE_RANK` give them the same one and differ only in what follows,
   * `RANK` skipping the numbers the tie consumed. That is the whole of what
   * `dense` selects, which is why the two are one node with a flag rather than
   * a node each.
   *
   * The window is computed a level down for `index`'s reason: a window cannot
   * appear in a `WHERE`, so a rank computed in place would leave
   * `rank(...).where((r) => r.place <= 10)` unwritable, which is the first
   * thing anyone will want from a leaderboard.
   *
   * Two numbers are carried, and the second is not redundant. A rank is not a
   * total order once anything ties — several rows share it — so ordering the
   * result by the rank alone would leave tied rows wherever the database put
   * them. `ROW_NUMBER` beside it puts the result in one settled order, which is
   * the same rank-beside-position `distinctBy` and `windowedBy` carry and costs
   * no second sort, both windows being over the same ordering.
   *
   * Nothing is subtracted, where `index` subtracts one. `RANK` counts from one
   * and so does the operator, deliberately: a standing is read by a person and
   * the first place is first. The gap `index` closes is between SQL and LINQ,
   * and there is no LINQ operator here to close a gap against.
   */
  private compileRank(plan: RankNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers these on an
      // ordered query. Without an ordering there is nothing to be ranked by,
      // and every row would tie with every other.
      throw new InvalidQueryError(
        `"${plan.dense ? 'denseRank' : 'rank'}" needs an ordering to rank the rows by. ` +
          'Order the query first.',
      );
    }

    const columns = current.select.columns;
    const alias = this.nextAlias();

    const standing: SqlExpression = {
      kind: 'over',
      name: plan.dense ? 'DENSE_RANK' : 'RANK',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    // The ordering the result comes back in, which the rank cannot supply on
    // its own because ties share theirs.
    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const ranked: SqlSelect = {
      ...current.select,
      columns: [
        ...columns,
        { expression: standing, alias: RANK_COLUMN },
        { expression: position, alias: POSITION_COLUMN },
      ],
      // The windows carry the ordering now, so the inner select repeating it
      // would only buy a second sort.
      orderBy: [],
    };

    const rows = new MapScope(
      new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
      'rank',
      current.scope,
    );

    const { value: projected, joins } = this.translating(() =>
      this.project(
        {
          kind: 'select',
          distinct: false,
          columns: [],
          from: { kind: 'derived', select: ranked, alias },
          joins: [],
          where: null,
          groupBy: [],
          having: null,
          setOperations: [],
          orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
          limit: null,
          offset: null,
        },
        plan.projector.body,
        LambdaScope.bind(plan.projector, [
          asRow(rows),
          // Counted from one on both sides, so unlike `index` there is nothing
          // to subtract. The cast is `index`' own: `RANK` is an exact numeric
          // wide enough that several drivers hand it back as a string, and a
          // standing this side of two billion rows loses nothing as an int.
          asValue(this.options.dialect.castToInt(column(alias, RANK_COLUMN))),
        ]),
      ),
    );

    return { ...projected, select: withNavigations(projected.select, joins) };
  }

  /**
   * `where` with the row's position as a second parameter, filtered the way
   * `takeWhile`/`skipWhile` already filter by a window: the position has to
   * be computed in a derived table first, since a window function cannot
   * appear inside the `WHERE` that reads it, and the outer statement filters
   * against that column instead of the window itself.
   *
   * The row this reads back comes from the same derived table `index`'s own
   * does, so it is bound the same way, `index`'s own `MapScope` in place of
   * the source's, and cannot be navigated off for the reason `index` cannot.
   */
  private compileWherePosition(plan: WherePositionNode): CompiledQuery {
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    const ordering = current.select.orderBy;
    if (ordering.length === 0) {
      // Unreachable through the typed API, which only offers this on an
      // ordered query. Without an ordering a position would be whichever
      // number the database happened to reach the row in.
      throw new InvalidQueryError(
        '"where" needs an ordering to number the rows over when its lambda asks for a ' +
          'position. Order the query first.',
      );
    }

    const columns = current.select.columns;
    const alias = this.nextAlias();

    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: ordering,
      frame: null,
    };

    const numbered: SqlSelect = {
      ...current.select,
      columns: [...columns, { expression: position, alias: POSITION_COLUMN }],
      // The window carries the ordering now, so the inner select repeating it
      // would only buy a second sort.
      orderBy: [],
    };

    const rows = new MapScope(
      new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
      'where with a position',
      current.scope,
    );

    const { value: condition, joins } = this.translating(() =>
      this.translate(
        plan.predicate.body,
        LambdaScope.bind(plan.predicate, [
          asRow(rows),
          // `index`'s own zero-from-caller, one-from-column, cast-for-drivers
          // reasons, unchanged.
          asValue(
            this.options.dialect.castToInt(
              sqlBinary('-', column(alias, POSITION_COLUMN), sqlLiteral('1')),
            ),
          ),
        ]),
      ),
    );

    return {
      select: withNavigations(
        {
          kind: 'select',
          distinct: false,
          columns: columns.map((projection) => ({
            expression: column(alias, projection.alias),
            alias: projection.alias,
          })),
          from: { kind: 'derived', select: numbered, alias },
          joins: [],
          where: condition,
          groupBy: [],
          having: null,
          setOperations: [],
          orderBy: [{ expression: column(alias, POSITION_COLUMN), descending: false }],
          limit: null,
          offset: null,
        },
        joins,
      ),
      scope: rows,
    };
  }

  /**
   * Translates `update`'s lambda form into column assignments, one per
   * property of the object literal it returned, such as
   * `(u) => ({ score: u.score + 1 })`.
   *
   * `writableSource` has already refused anything past a bare table and a
   * filter, so `EntityScope` is everything a property such as `u.score`
   * needs to resolve, and this runs outside `translating` on purpose: a
   * navigation such as `u.city.name` reaches `followReference` with nowhere
   * to put a join, which is what turns it into a refusal instead of one
   * silently dropped from the statement.
   */
  updateAssignments(
    entity: EntityDefinition,
    alias: string,
    projector: LambdaExpression,
  ): readonly { readonly column: string; readonly value: SqlExpression }[] {
    if (projector.body.kind !== 'object') {
      throw new UnsupportedExpressionError(
        '"update" needs an object literal from its lambda, naming the columns to set, such as ' +
          '(u) => ({ score: u.score + 1 }).',
      );
    }

    if (projector.body.properties.length === 0) {
      throw new InvalidQueryError(
        `"update" was given no columns to set on entity "${entity.name}". ` +
          `Columns: ${Object.keys(entity.columns).join(', ')}.`,
      );
    }

    const scope = LambdaScope.bind(projector, [asRow(new EntityScope(alias, entity))]);

    return projector.body.properties.map((property) => {
      if (!(property.name in entity.columns)) {
        throw new InvalidQueryError(
          `"${property.name}" is not a column of entity "${entity.name}". ` +
            `Columns: ${Object.keys(entity.columns).join(', ')}.`,
        );
      }

      return {
        column: physicalName(entity.columns, property.name),
        value: this.translate(property.value, scope),
      };
    });
  }

  /**
   * A query that cannot come back empty, because one row is joined to it.
   *
   * SQL has no operator for "or else one row of nulls", but a left join says
   * it: a source of exactly one row on the left, the query on the right, and a
   * condition that is always true. Match nothing and the one row survives with
   * the query's columns null; match anything and that row is multiplied by the
   * matches, leaving the query as it was. The query is read once, which the
   * obvious `UNION ALL` against a `NOT EXISTS` guard would not manage.
   *
   * The join has to be this way round. A right join would put the query first
   * and read the same, but right joins are not compiled here, and the point of
   * the unit source is that it exists whether or not anything else does.
   */
  private compileDefaultIfEmpty(plan: DefaultIfEmptyNode): CompiledQuery {
    const current = this.compile(plan.source);
    const inner = current.select;
    const columns = inner.columns;

    const unit = this.nextAlias();
    const alias = this.nextAlias();

    // An ordering inside a derived table is not guaranteed to survive it, so
    // each sort key is carried out as a column and reapplied outside, the way
    // `takeLast` carries its own. The inner ordering is kept only where a limit
    // or an offset depends on it to say which rows it keeps; anywhere else it
    // would buy a second sort and decide nothing.
    const ordering = inner.orderBy;
    const carried = ordering.map((entry, index) => ({
      expression: entry.expression,
      alias: `${SORT_PREFIX}${index}`,
    }));
    const paged = inner.limit !== null || inner.offset !== null;

    // A caller's own default needs a way to tell a real row from a missing
    // one, which nulls alone no longer give: a real row can hold a null in
    // every column it has, the same ambiguity the plain form already leaves
    // standing. A literal `1`, read back as `PRESENT_COLUMN`, survives only
    // when the join actually matched, so `IS NULL` on it is a clean test the
    // caller's own columns cannot interfere with.
    const defaults = this.defaultRowColumns(plan.defaultRow, columns);
    const innerColumns = defaults
      ? [...columns, ...carried, { expression: sqlLiteral('1'), alias: PRESENT_COLUMN }]
      : [...columns, ...carried];

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: columns.map((projection) => {
          const real = column(alias, projection.alias);
          const fallback = defaults?.get(projection.alias);

          return {
            expression: fallback
              ? {
                  kind: 'case',
                  branches: [
                    {
                      condition: {
                        kind: 'nullTest',
                        operand: column(alias, PRESENT_COLUMN),
                        negated: false,
                      },
                      result: fallback,
                    },
                  ],
                  otherwise: real,
                }
              : real,
            alias: projection.alias,
          };
        }),
        from: { kind: 'unit', alias: unit },
        joins: [
          {
            kind: 'left',
            source: {
              kind: 'derived',
              select: {
                ...inner,
                columns: innerColumns,
                orderBy: paged ? ordering : [],
              },
              alias,
            },
            // Always true, spelled as a comparison rather than as `TRUE`, which
            // not every database accepts in a join condition.
            on: sqlBinary('=', sqlLiteral('1'), sqlLiteral('1')),
          },
        ],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: carried.map((projection, index) => ({
          expression: column(alias, projection.alias),
          descending: ordering[index]!.descending,
        })),
        limit: null,
        offset: null,
      },
      // The carried keys and the presence witness stay inside the derived
      // table, so nothing downstream can see or collide with them.
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        // Types only, and this is the one place that withholds navigations
        // rather than being unable to offer them. The row this operator adds
        // when nothing matched is all nulls, including any foreign key, so a
        // required reference would join it away with an INNER JOIN and undo
        // the guarantee the operator exists to make. Refusing the navigation
        // is a compile-time sentence; honouring it would be a missing row.
        'defaultIfEmpty',
        inherited(current.scope),
      ),
    };
  }

  /**
   * Translates a caller's own default row, if there is one, into one SQL
   * expression per projected column, keyed by the alias `columns` already
   * uses. Built the way `compileLiteralRow` builds `append`'s row: under an
   * empty scope, since a default is a value from the caller's own process
   * rather than anything read off a table.
   */
  private defaultRowColumns(
    defaultRow: ExpressionNode | null,
    columns: readonly { alias: string }[],
  ): Map<string, SqlExpression> | null {
    if (defaultRow === null) return null;

    const empty = LambdaScope.bind({ kind: 'lambda', parameters: [], body: defaultRow }, []);

    if (defaultRow.kind === 'object') {
      return new Map(
        defaultRow.properties.map((property) => [
          property.name,
          this.translate(property.value, empty),
        ]),
      );
    }

    // A scalar projection has exactly the one column every scalar projection
    // does, so the default is that column's value and nothing more to align.
    const [only] = columns;
    return only ? new Map([[only.alias, this.translate(defaultRow, empty)]]) : new Map();
  }

  private compileSample(source: QueryPlan, count: number): CompiledQuery {
    // The sample is drawn from the rows the source settled on, so paging is
    // resolved first. DISTINCT is resolved too, because PostgreSQL rejects an
    // `ORDER BY` over a `SELECT DISTINCT` unless the expression it sorts by is
    // one of the selected columns, and a random value never is.
    const current = this.materializeIf(this.compile(source), (select) =>
      Boolean(select.limit || select.offset || select.distinct || select.setOperations.length > 0),
    );

    return {
      select: {
        ...current.select,
        // Any ordering asked for before this one is replaced rather than nested
        // in a subquery that could not affect the outcome: a random sample has
        // no order to inherit. Ordering the sample itself works, because the
        // limit set here makes a following `orderBy` materialize.
        orderBy: [{ expression: this.randomValue(), descending: false }],
        limit: sqlLiteral(String(integer(count, 'sample'))),
      },
      scope: current.scope,
    };
  }

  /**
   * The dialect's per-row random value.
   *
   * This goes through the same hook that translates `Math.random()` in a lambda
   * rather than through a dedicated one, because the two want the same thing: a
   * value that changes from row to row. A dialect that overrides one is
   * therefore right about both.
   */
  private randomValue(): SqlExpression {
    const random = this.options.dialect.translateMethod({
      target: null,
      method: 'Math.random',
      args: [],
    });

    if (!random) {
      throw new UnsupportedExpressionError(
        `The "${this.options.dialect.name}" dialect cannot produce a random value, ` +
          'which "sample" needs to choose rows with.',
      );
    }

    return random;
  }

  private compileZip(plan: ZipNode): CompiledQuery {
    const left = this.numbered(this.compile(plan.source), 'zip');
    const right = this.numbered(this.compile(plan.other), 'zip');
    // Numbered and joined on that same position, the way `right` already is,
    // so a third sequence costs a second join rather than a different shape.
    const far = plan.third ? this.numbered(this.compile(plan.third), 'zip') : null;

    return this.project(
      {
        kind: 'select',
        distinct: false,
        columns: [],
        from: left.from,
        // An inner join is what stops the pairing at the shortest side: a
        // position a sequence never reaches matches nothing.
        joins: [
          { kind: 'inner', source: right.from, on: sqlBinary('=', left.position, right.position) },
          ...(far
            ? [
                {
                  kind: 'inner' as const,
                  source: far.from,
                  on: sqlBinary('=', left.position, far.position),
                },
              ]
            : []),
        ],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        // The pairing is by position, so that is the order the pairs come in.
        orderBy: [{ expression: left.position, descending: false }],
        limit: null,
        offset: null,
      },
      plan.projector.body,
      LambdaScope.bind(
        plan.projector,
        far
          ? [asRow(left.scope), asRow(right.scope), asRow(far.scope)]
          : [asRow(left.scope), asRow(right.scope)],
      ),
    );
  }

  /**
   * One side of a `zip`, as a derived table that knows each row's position.
   *
   * SQL has no notion of where a row sits, so the ordering the caller asked for
   * is turned into a number that can be matched against the other side's. The
   * ordering then moves into the window, unless a limit is relying on it, in
   * which case dropping it would change which rows are there at all.
   */
  private numbered(
    current: CompiledQuery,
    operator: string,
  ): JoinSource & { position: SqlExpression } {
    if (current.select.orderBy.length === 0) {
      // Unreachable through the typed API, which offers this only on an ordered
      // query and only accepts one, but a plan can be built by hand.
      throw new InvalidQueryError(
        `"${operator}" needs both sides ordered, since it pairs rows by position.`,
      );
    }

    const position: SqlExpression = {
      kind: 'over',
      name: 'ROW_NUMBER',
      args: [],
      partitionBy: [],
      orderBy: current.select.orderBy,
      frame: null,
    };

    const alias = this.nextAlias();
    const columns = current.select.columns;

    return {
      from: {
        kind: 'derived',
        select: {
          ...stripOrdering(current.select),
          columns: [...columns, { expression: position, alias: POSITION_COLUMN }],
        },
        alias,
      },
      scope: new MapScope(
        new Map(columns.map((projection) => [projection.alias, column(alias, projection.alias)])),
        operator,
        inherited(current.scope),
      ),
      position: column(alias, POSITION_COLUMN),
    };
  }

  /**
   * `sequenceEqual`, as one statement rather than two queries read back and
   * compared in memory.
   *
   * Both sides are numbered by position exactly as `zip` numbers them, and a
   * `FULL JOIN` on that number is what turns a length mismatch into a row: a
   * position only one side reaches joins against nothing and comes back null
   * on the other, which cannot be told from a position both reached with
   * different values and is treated the same way. `NOT EXISTS` then asks the
   * one question that matters — is there a position where the two disagree —
   * without counting how many there are or reading either side's rows back.
   *
   * Columns are paired by name rather than by position, the way a set
   * operation pairs them, since the two sides may have projected the same
   * shape in a different order. `notDistinctFrom` is reused for the
   * comparison itself for the reason `matchKeys` reuses it: a null belongs
   * with a null there, and a plain `=` would leave a row that differs only by
   * a null column neither true nor false, silently missing the mismatch.
   */
  private compileSequenceEqual(plan: SequenceEqualNode): CompiledQuery {
    const left = this.numbered(this.compile(plan.source), 'sequenceEqual');
    const right = this.numbered(this.compile(plan.other), 'sequenceEqual');

    const names = left.scope.names();
    const rightNames = new Set(right.scope.names());
    if (names.length !== rightNames.size || names.some((name) => !rightNames.has(name))) {
      throw new InvalidQueryError(
        '"sequenceEqual" compares rows column by column, and the two queries project different ' +
          'columns. Give both the same shape.',
      );
    }

    const bothPresent = sqlBinary(
      'AND',
      { kind: 'nullTest', operand: left.position, negated: true },
      { kind: 'nullTest', operand: right.position, negated: true },
    );

    const sameRow = names
      .map((name) => notDistinctFrom(left.scope.resolve(name)!, right.scope.resolve(name)!))
      .reduce((matched, next) => sqlBinary('AND', matched, next), bothPresent);

    const differing: SqlSelect = {
      kind: 'select',
      distinct: false,
      columns: [{ expression: sqlLiteral('1'), alias: 'x' }],
      from: left.from,
      joins: [
        { kind: 'full', source: right.from, on: sqlBinary('=', left.position, right.position) },
      ],
      where: { kind: 'unary', operator: 'NOT', operand: sameRow },
      groupBy: [],
      having: null,
      setOperations: [],
      orderBy: [],
      limit: null,
      offset: null,
    };

    const alias = this.nextAlias();

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: [
          { expression: { kind: 'exists', select: differing, negated: true }, alias: 'value' },
        ],
        from: { kind: 'unit', alias },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
      scope: new MapScope(new Map([['value', column(alias, 'value')]]), 'sequenceEqual'),
    };
  }

  /**
   * A single row with no table behind it, as `append` builds one.
   *
   * There is no row parameter to bind, since the value came from the caller's
   * own process rather than off anything the database holds, so the row's
   * expression is translated under a scope with nothing in it — safe because
   * `append` only ever builds one from `constant`, which never asks a scope
   * for anything.
   *
   * An object row becomes one column per property, named as `select` would
   * name them; a scalar row becomes the one `value` column every scalar
   * projection uses, so the two sides of the `UNION ALL` line up under the
   * same names regardless of which one `append` was building for.
   */
  private compileLiteralRow(plan: LiteralRowNode): CompiledQuery {
    const empty = LambdaScope.bind({ kind: 'lambda', parameters: [], body: plan.row }, []);
    const unit: SqlSelect = {
      kind: 'select',
      distinct: false,
      columns: [],
      from: { kind: 'unit', alias: this.nextAlias() },
      joins: [],
      where: null,
      groupBy: [],
      having: null,
      setOperations: [],
      orderBy: [],
      limit: null,
      offset: null,
    };

    if (plan.row.kind === 'object') {
      const columns = plan.row.properties.map((property) => ({
        expression: this.translate(property.value, empty),
        alias: property.name,
      }));
      return {
        select: { ...unit, columns },
        scope: new MapScope(new Map(columns.map((c) => [c.alias, c.expression])), 'literalRow'),
      };
    }

    return scalarProjection(unit, this.translate(plan.row, empty));
  }

  private compileSelectMany(plan: SelectManyNode): CompiledQuery {
    const compiled = this.compile(plan.source);

    // The collection is looked up before anything is materialized, because only
    // the row the source produced knows its navigations: a derived table's scope
    // knows columns and nothing else. Its key is read back afterwards, off
    // whichever scope survived.
    const navigated =
      plan.over.kind === 'collection'
        ? this.resolveCollection(plan.over.selector, compiled.scope)
        : null;

    // Flattening multiplies rows, so anything that already fixed which rows
    // there are has to be settled before the count changes underneath it.
    const outer = this.materializeIf(compiled, (select) =>
      Boolean(
        select.limit ||
        select.offset ||
        select.distinct ||
        select.groupBy.length > 0 ||
        select.setOperations.length > 0,
      ),
    );

    const flattened =
      plan.over.kind === 'query'
        ? this.crossJoin(plan.over.plan)
        : plan.over.shape
          ? this.expandLateralCollection(navigated!, outer.scope, plan.over.shape)
          : this.expandCollection(navigated!, outer.scope);

    return this.project(
      { ...outer.select, joins: [...outer.select.joins, flattened.join] },
      plan.projector.body,
      LambdaScope.bind(plan.projector, [asRow(outer.scope), asRow(flattened.scope)]),
    );
  }

  /** Every row of another query paired with every row of this one. */
  private crossJoin(plan: QueryPlan): ExpandedCollection {
    const inner = this.joinSource(this.compile(plan));
    return { scope: inner.scope, join: { kind: 'cross', source: inner.from, on: null } };
  }

  private compileGroupBy(plan: GroupByNode): CompiledQuery {
    // Grouping consumes the rows the source produced, so anything that already
    // fixed which rows those are, or already grouped them, is settled first.
    const current = this.materializeIf(this.compile(plan.source), (select) =>
      Boolean(
        select.limit ||
        select.offset ||
        select.distinct ||
        select.groupBy.length > 0 ||
        select.setOperations.length > 0,
      ),
    );

    const { value: grouped, joins } = this.translating(() => {
      const key = this.groupKey(plan.key, current.scope);
      return { key, projected: this.projectGroup(current, key, plan) };
    });

    return { ...grouped.projected, select: withNavigations(grouped.projected.select, joins) };
  }

  /** The projection over a grouped select, split out so both parts share one translation. */
  private projectGroup(
    current: CompiledQuery,
    key: { expressions: SqlExpression[]; binding: RowBinding },
    plan: GroupByNode,
  ): CompiledQuery {
    return this.project(
      { ...current.select, groupBy: key.expressions },
      plan.projector.body,
      LambdaScope.bind(plan.projector, [key.binding, asGroup(current.scope)]),
    );
  }

  /**
   * Lowers the key selector into the `GROUP BY` list and into whatever the
   * result selector's first parameter stands for.
   *
   * An object literal groups by each of its properties and makes the key a row,
   * so `key.city` resolves the way a projected row does. Anything else is a
   * single expression and the key is that value.
   */
  private groupKey(
    key: LambdaExpression,
    source: RowScope,
  ): { expressions: SqlExpression[]; binding: RowBinding } {
    const scope = LambdaScope.bind(key, [asRow(source)]);

    if (key.body.kind === 'object') {
      const entries = new Map<string, SqlExpression>();
      for (const property of key.body.properties) {
        entries.set(property.name, this.translate(property.value, scope));
      }
      return {
        expressions: [...entries.values()],
        binding: asRow(new MapScope(entries, 'group key')),
      };
    }

    const expression = this.translate(key.body, scope);
    return { expressions: [expression], binding: asValue(expression) };
  }

  /**
   * Lowers `group.count()`, `group.sum(row => ...)`, and friends.
   *
   * The selector is a lambda over the rows behind the group, so it is
   * translated against the scope the query had before it was grouped.
   *
   * `window` is set when the receiver is a `windowed` or `expanding` run
   * rather than a group, and it moves the same aggregate from the `GROUP BY`
   * onto a frame. Which rows it reduces is the only difference; the selector,
   * the arity checks, and the names are the group's own, which is the point of
   * reaching for this receiver rather than inventing a second one.
   */
  private translateAggregate(
    rows: RowScope,
    method: string,
    args: readonly ExpressionNode[],
    window: WindowFrame | null,
  ): SqlExpression {
    // Every column of every row, rather than one value reduced from them, so
    // it takes none of the arguments the others do.
    if (method === 'toArray') {
      if (args.length !== 0) {
        throw new UnsupportedExpressionError(
          '"toArray" takes no arguments: it reads back every column of every row in the group.',
        );
      }
      const rowsAsJson = this.jsonAggregate(rows);
      return window ? over('json_agg', rowsAsJson.args, window) : rowsAsJson;
    }

    // `COUNT(DISTINCT ...)` is the one aggregate a window frame cannot carry:
    // the standard leaves DISTINCT out of a window function and PostgreSQL
    // rejects it outright. The type already keeps it off a run, so this is
    // reached only by an IR built some other way, and it names the operator
    // rather than letting the database answer with a syntax error.
    if (window && method === 'countDistinct') {
      throw new UnsupportedExpressionError(
        '"countDistinct" is not defined over a window, so a run of rows cannot answer it. ' +
          'Count the distinct values of a group with "groupBy" instead.',
      );
    }

    const name = AGGREGATES[method];
    if (!name) {
      throw new UnsupportedExpressionError(
        `"${method}" is not an aggregate. A group supports toArray, ` +
          `${Object.keys(AGGREGATES).join(', ')}.`,
      );
    }

    if (method === 'count') {
      if (args.length !== 0) {
        throw new UnsupportedExpressionError(
          '"count" takes no arguments: it counts every row in the group.',
        );
      }
      // `COUNT(*)` over a frame, where the star is the argument rather than an
      // absent one: `SqlOver` prints its arguments as written and `COUNT()` is
      // not a call any database accepts.
      if (window) return over('COUNT', [sqlLiteral('*')], window);
      return { kind: 'aggregate', name, argument: null, distinct: false };
    }

    const selector = args[0];
    if (args.length !== 1 || selector?.kind !== 'lambda') {
      throw new UnsupportedExpressionError(
        `"${method}" expects one lambda choosing the value to aggregate, ` +
          `for example ${method}((row) => row.total).`,
      );
    }

    const argument = this.translate(selector.body, LambdaScope.bind(selector, [asRow(rows)]));

    if (window) return over(name.toUpperCase(), [argument], window);

    // `countDistinct` needs the null adjustment `countDistinctExpression`
    // makes, the same one the standalone terminal makes, rather than a bare
    // DISTINCT flag: a group with no rows carrying a null should not count one
    // fewer distinct value than a caller who counted the rows themselves.
    if (method === 'countDistinct') return countDistinctExpression(argument);

    return { kind: 'aggregate', name, argument, distinct: false };
  }

  /**
   * `json_agg(json_build_object(...))` over every column a group's rows
   * expose, the way an identity projection already reads them: `names()`
   * says which, `resolve` how, so this asks nothing a plain `db.orders`
   * would not already answer about its own columns.
   *
   * A `decimal` or `bigint` column is cast to text first. JSON has one
   * number type, and PostgreSQL would otherwise narrow a value this library
   * keeps as a string everywhere else back into one that silently loses
   * precision past 2^53, undoing the reason those two are strings at all.
   *
   * Each property name is cast as well, and for a different reason.
   * `json_build_object` declares its arguments as `"any"`, which is a type
   * PostgreSQL will not resolve an untyped placeholder against: a bare `$1`
   * there is rejected outright with "could not determine data type of
   * parameter". The name stays a bound value rather than becoming a literal,
   * since a literal would mean quoting text into the statement, and the cast
   * is what tells the database which type it was bound as.
   */
  private jsonAggregate(rows: RowScope): SqlFunctionCall {
    const properties = rows.names().flatMap((name) => {
      const value = rows.resolve(name)!;
      const type = rows.columnType?.(name);
      const jsonValue =
        type === 'decimal' || type === 'bigint'
          ? sqlBinary('::', value, sqlLiteral('text'))
          : value;
      return [sqlBinary('::', valueParameter(name), sqlLiteral('text')), jsonValue];
    });

    return sqlFunction('json_agg', [sqlFunction('json_build_object', properties)]);
  }

  /**
   * Turns a compiled query into something that can sit on the right of a join.
   *
   * A query that has only picked a table and shaped its columns contributes its
   * own `FROM` directly, which is what keeps the common
   * `db.users.join(db.orders, ...)` readable. Anything carrying a clause a join
   * cannot absorb, such as a filter, an ordering, paging, `DISTINCT`, or a join
   * of its own, becomes a derived table so its meaning survives.
   */
  private joinSource(current: CompiledQuery): JoinSource {
    // An ordering on the joined side cannot affect which rows a join produces
    // unless it is paired with paging, and an unlimited `ORDER BY` inside a
    // subquery is rejected outright by several databases.
    const select = stripOrdering(current.select);
    const foldable =
      select.where === null &&
      select.orderBy.length === 0 &&
      select.limit === null &&
      select.offset === null &&
      select.joins.length === 0 &&
      select.groupBy.length === 0 &&
      select.setOperations.length === 0 &&
      !select.distinct;

    if (foldable) return { from: select.from, scope: current.scope };

    const alias = this.nextAlias();
    const entries = new Map<string, SqlExpression>(
      select.columns.map((projection) => [projection.alias, column(alias, projection.alias)]),
    );

    return {
      from: { kind: 'derived', select, alias },
      scope: new MapScope(entries, 'joined subquery', inherited(current.scope)),
    };
  }

  /**
   * Applies a projection body to a select, producing both the column list and
   * the scope later operators resolve their properties against.
   *
   * `select` and a join's result selector share this; the only difference
   * between them is how many rows the lambda has in scope.
   */
  private project(select: SqlSelect, body: ExpressionNode, scope: LambdaScope): CompiledQuery {
    // Reset here rather than only inside the `object` branch below, so a
    // projection that sets none clears whatever an earlier, now-superseded
    // one left behind: this is the outermost projection until proven
    // otherwise by reaching that branch.
    this.nested = [];

    // Read before the body is translated, so a scalar projection can carry the
    // type of the one column it kept under the name the materializer unwraps.
    const scalarType = this.columnTypeOf(body, scope);

    if (body.kind === 'parameter') {
      const binding = scope.binding(body.name);

      // `u => u`, and a join's `(u, o) => u`, keep one input's shape untouched.
      if (binding.kind === 'row') {
        return { select: { ...select, columns: columnsOf(binding.scope) }, scope: binding.scope };
      }

      // `(key, group) => key` over a single-expression key is one value, and is
      // unwrapped downstream exactly like any other scalar projection.
      if (binding.kind === 'value') {
        return scalarProjection(select, binding.expression);
      }

      throw new UnsupportedExpressionError(
        `"${body.name}" is a group, not a row. Project an aggregate of it, such as ` +
          `${body.name}.count().`,
      );
    }

    if (body.kind === 'object') {
      const columns: SqlProjection[] = [];
      const entries = new Map<string, SqlExpression>();
      // A projection renames its columns, so the types cannot be inherited by
      // name the way a derived table inherits them. They are read off the
      // expressions instead, which is where the declared type still is: a
      // property that is a column keeps its type, and one that is an
      // expression over columns has none to keep.
      const types = new Map<string, ColumnType>();
      const nested: NestedEmbed[] = [];

      for (const property of body.properties) {
        const embedded = this.embeddedRow(property.value, scope);

        if (embedded) {
          const prefix = `${NESTED_MARKER}${property.name}__`;
          for (const name of embedded.names()) {
            const expression = embedded.resolve(name)!;
            const alias = `${prefix}${name}`;
            columns.push({ expression, alias });
            entries.set(alias, expression);
            const type = embedded.columnType?.(name);
            if (type) types.set(alias, type);
          }
          nested.push({ property: property.name, prefix });
          continue;
        }

        const expression = this.translate(property.value, scope);
        columns.push({ expression, alias: property.name });
        entries.set(property.name, expression);

        const type = this.columnTypeOf(property.value, scope);
        if (type) types.set(property.name, type);
      }

      this.nested = nested;
      const embeddedProperties = new Set(nested.map((embed) => embed.property));
      return {
        select: { ...select, columns },
        scope: new MapScope(
          entries,
          'projection',
          (name) => types.get(name) ?? null,
          embeddedProperties.size === 0
            ? undefined
            : (name) =>
                embeddedProperties.has(name)
                  ? `"${name}" was embedded as a nested object by this projection, so it has no ` +
                    'property a further operator can read; read it back after a terminal instead.'
                  : null,
        ),
      };
    }

    return scalarProjection(select, this.translate(body, scope), scalarType);
  }

  /**
   * The scope of a property value that names one of the lambda's own rows
   * whole, such as `u` in `(o, u) => ({ order: o, user: u })`, rather than
   * one of its columns. `null` for anything else, which is everything
   * `translate` already handles on its own.
   */
  private embeddedRow(value: ExpressionNode, scope: LambdaScope): RowScope | null {
    if (value.kind !== 'parameter') return null;
    const binding = scope.binding(value.name);
    return binding.kind === 'row' ? binding.scope : null;
  }

  /** Pushes the current query into a derived table when the guard demands it. */
  private materializeIf(
    current: CompiledQuery,
    needsSubquery: (select: SqlSelect) => boolean,
  ): CompiledQuery {
    if (!needsSubquery(current.select)) return current;

    const alias = this.nextAlias();
    const entries = new Map<string, SqlExpression>(
      current.select.columns.map((projection) => [
        projection.alias,
        column(alias, projection.alias),
      ]),
    );

    return {
      select: {
        kind: 'select',
        distinct: false,
        columns: current.select.columns.map((projection) => ({
          expression: column(alias, projection.alias),
          alias: projection.alias,
        })),
        from: { kind: 'derived', select: current.select, alias },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
      // Same columns under the same names, so the types come with them.
      // Same columns under the same names, so the types come with them and so
      // do the navigations: this is what `take`, `skip`, `distinct`, and
      // `sample` are pushed into, and a foreign key of theirs still points at
      // the row it always did.
      //
      // A set operation reaches here too, and its navigations are the left
      // branch's because its whole scope always was — `compileSetOperation`
      // returns `left.scope`, which has answered every column and type
      // question for both branches since it was written. Carrying the
      // navigations follows that decision rather than making a new one.
      scope: new MapScope(entries, 'subquery', current.scope),
    };
  }

  /** Lowers one expression IR node into SQL. */
  private translate(node: ExpressionNode, scope: LambdaScope): SqlExpression {
    switch (node.kind) {
      case 'constant':
        return translateConstant(node.value);

      case 'regex':
        throw new UnsupportedExpressionError(
          'A regular expression literal is only meaningful as the argument to "match".',
        );

      case 'external':
        return externalParameter(node.path);

      case 'parameter': {
        const binding = scope.binding(node.name);
        if (binding.kind === 'value') return binding.expression;
        if (binding.kind === 'group') {
          throw new UnsupportedExpressionError(
            `The group "${node.name}" cannot be used as a value. Aggregate it instead, ` +
              `for example ${node.name}.count().`,
          );
        }
        throw new UnsupportedExpressionError(
          `The row "${node.name}" cannot be used as a value here. Reference one of its properties instead.`,
        );
      }

      case 'member':
        return this.translateMember(node.object, node.property, scope);

      case 'binary':
        return this.translateBinary(node.operator, node.left, node.right, scope);

      case 'unary': {
        // A negated number is just a smaller number. Folding it here keeps the
        // minus off a placeholder, which a database has no type for: PostgreSQL
        // rejects `-$1` outright as an ambiguous operator.
        if (
          node.operator === '-' &&
          node.operand.kind === 'constant' &&
          typeof node.operand.value === 'number'
        ) {
          return translateConstant(-node.operand.value);
        }

        const operand = this.translate(node.operand, scope);
        if (node.operator === '!') return { kind: 'unary', operator: 'NOT', operand };
        if (node.operator === '+') return operand;
        return { kind: 'unary', operator: '-', operand };
      }

      case 'conditional':
        return {
          kind: 'case',
          branches: [
            {
              condition: this.translate(node.test, scope),
              result: this.translate(node.whenTrue, scope),
            },
          ],
          otherwise: this.translate(node.whenFalse, scope),
        };

      case 'call':
        return this.translateCall(node.target, node.method, node.args, scope);

      case 'object':
        throw new UnsupportedExpressionError(
          'An object literal is only meaningful as the body of a projection.',
        );

      case 'array':
        throw new UnsupportedExpressionError(
          'An array literal can only appear as the receiver of "includes".',
        );

      case 'lambda':
        throw new UnsupportedExpressionError('A nested lambda cannot be translated here.');
    }
  }

  /**
   * The row an expression refers to through a navigation, if it does.
   *
   * Only `row.reference` is recognised, one hop. A longer chain would need the
   * hop before it to have been joined already, and says so rather than falling
   * through to the dialect, which would only report that it cannot translate a
   * property it was never meant to see.
   */
  private referencedScope(
    node: ExpressionNode,
    scope: LambdaScope,
  ): { scope: RowScope; path: string } | null {
    if (node.kind !== 'member') return null;

    if (node.object.kind === 'member') {
      const inner = this.referencedScope(node.object, scope);
      if (inner?.scope.navigate?.(node.property)) {
        throw new UnsupportedExpressionError(
          `"${inner.path}.${node.property}" follows a reference through another one. ` +
            'Only a single hop is translated; join the far entity explicitly instead.',
        );
      }
      return null;
    }

    if (node.object.kind !== 'parameter') return null;

    const binding = scope.binding(node.object.name);
    if (binding.kind !== 'row') return null;

    const reference = binding.scope.navigate?.(node.property);
    if (!reference) return null;

    return {
      scope: this.followReference(reference),
      path: `${node.object.name}.${node.property}`,
    };
  }

  private translateMember(
    object: ExpressionNode,
    property: string,
    scope: LambdaScope,
  ): SqlExpression {
    // `o.user.name`: the inner access names a reference, so the row it points
    // at is joined in and the outer access resolves against that row.
    const referenced = this.referencedScope(object, scope);
    if (referenced) {
      const resolved = referenced.scope.resolve(property);
      if (!resolved) {
        const reason = referenced.scope.describeUnresolved?.(property);
        throw new InvalidQueryError(
          reason ??
            `"${property}" is not a property of ${referenced.scope.describe()}, which ` +
              `"${referenced.path}" refers to. Available: ${referenced.scope.names().join(', ')}.`,
        );
      }
      return resolved;
    }

    if (object.kind === 'parameter') {
      const binding = scope.binding(object.name);

      if (binding.kind === 'value') {
        throw new InvalidQueryError(
          `The group key is a single value, so it has no property "${property}". ` +
            'Return an object from the key selector to group by more than one expression.',
        );
      }

      if (binding.kind === 'group' || binding.kind === 'matches') {
        throw new UnsupportedExpressionError(
          `"${object.name}" is a group, so it has no property "${property}". Aggregate it ` +
            `instead, for example ${object.name}.sum((row) => row.${property}).`,
        );
      }

      const resolved = binding.scope.resolve(property);
      if (!resolved) {
        const reason = binding.scope.describeUnresolved?.(property);
        if (reason) throw new InvalidQueryError(reason);

        if (binding.scope.navigate?.(property)) {
          throw new UnsupportedExpressionError(
            `"${property}" refers to a related row, not a value. Read one of its columns, ` +
              `such as ${object.name}.${property}.<column>.`,
          );
        }
        const references = binding.scope.references?.() ?? [];
        throw new InvalidQueryError(
          `"${property}" is not a property of ${binding.scope.describe()}. ` +
            `Available: ${binding.scope.names().join(', ')}.` +
            (references.length > 0 ? ` References: ${references.join(', ')}.` : ''),
        );
      }
      return resolved;
    }

    const target = this.translate(object, scope);
    // Looked up before delegating, because the dialect sees an expression and
    // cannot tell a text column from an array of text.
    const translated = this.options.dialect.translateMember(
      target,
      property,
      this.columnTypeOf(object, scope),
    );
    if (!translated) {
      throw new UnsupportedExpressionError(
        `The "${this.options.dialect.name}" dialect cannot translate the property "${property}".`,
      );
    }
    return translated;
  }

  /**
   * The declared type of the column an expression reads, when it reads one
   * directly off a row.
   *
   * Only the one hop is answered, `u.tags`, because that is the case where a
   * scope still knows types at all. A column read back out of a projection or a
   * derived table has become a name and a value, so this answers null and the
   * dialect falls back to whatever it does without a type.
   */
  private columnTypeOf(node: ExpressionNode, scope: LambdaScope): ColumnType | null {
    if (node.kind !== 'member' || node.object.kind !== 'parameter') return null;

    const binding = scope.binding(node.object.name);
    if (binding.kind !== 'row') return null;

    return binding.scope.columnType?.(node.property) ?? null;
  }

  private translateBinary(
    operator: string,
    left: ExpressionNode,
    right: ExpressionNode,
    scope: LambdaScope,
  ): SqlExpression {
    if (operator === '==' || operator === '!=') {
      const negated = operator === '!=';
      if (isNullLiteral(right)) {
        return { kind: 'nullTest', operand: this.translate(left, scope), negated };
      }
      if (isNullLiteral(left)) {
        return { kind: 'nullTest', operand: this.translate(right, scope), negated };
      }
    }

    const leftSql = this.translate(left, scope);
    const rightSql = this.translate(right, scope);

    switch (operator) {
      case '&&':
        return sqlBinary('AND', leftSql, rightSql);
      case '||':
        return sqlBinary('OR', leftSql, rightSql);
      case '??':
        return sqlFunction('COALESCE', [leftSql, rightSql]);
      case '==':
        return sqlBinary('=', leftSql, rightSql);
      case '!=':
        return sqlBinary('<>', leftSql, rightSql);
      case '+':
        // JavaScript overloads `+`. When either side is a string literal the
        // intent is concatenation, which most databases spell differently.
        return isStringLiteral(left) || isStringLiteral(right)
          ? this.options.dialect.concat([leftSql, rightSql])
          : sqlBinary('+', leftSql, rightSql);
      default:
        return sqlBinary(operator, leftSql, rightSql);
    }
  }

  private translateCall(
    target: ExpressionNode | null,
    method: string,
    args: readonly ExpressionNode[],
    scope: LambdaScope,
  ): SqlExpression {
    // A call on a group is an aggregate, and its argument is a lambda over the
    // rows behind the group rather than an ordinary value, so it is handled
    // before anything tries to translate those arguments in this scope.
    if (target?.kind === 'parameter') {
      const binding = scope.binding(target.name);
      if (binding.kind === 'group') {
        return this.translateAggregate(binding.rows, method, args, binding.window);
      }
      if (binding.kind === 'matches') {
        return this.correlatedAggregate(binding, method, args);
      }
    }

    // `u.orders.some((o) => ...)` asks about rows that are not in this query at
    // all, so it becomes a correlated subquery rather than anything the target
    // could be translated into: a collection is many rows and has no column.
    const overCollection = this.collectionExists(target, method, args, scope);
    if (overCollection) return overCollection;

    // `u.orders.sum((o) => o.total)` is the same shape asked for a value rather
    // than for whether a row is there, and it answers with a scalar subquery
    // where `some` answers with an `EXISTS`.
    const aggregated = this.collectionAggregate(target, method, args, scope);
    if (aggregated) return aggregated;

    // `p.vipIds.includes(u.id)` becomes `u.id IN (subquery)` when the bag
    // holds a query rather than a plain array: the one way a lambda can name
    // a query of a shape the compiler did not anticipate, since it travels in
    // the bag like any other captured value rather than by closure.
    if (method === 'includes' && target && this.isBoundQueryTarget(target)) {
      return this.translateInSubquery(target, args, scope);
    }

    // `list.includes(u.id)` becomes `u.id IN (...)`, which needs the actual
    // values because the placeholder count depends on the list length.
    if (method === 'includes' && target && this.isValueList(target)) {
      return this.translateInList(target, args, scope);
    }

    // `match` and `search` only translate a regular expression literal
    // written directly in the query. Its flags choose the operator or
    // function a dialect prints, which is a compile-time decision a value
    // read out of a variable could not support, so that is refused here
    // rather than reaching a dialect with nothing useful to translate.
    if ((method === 'match' || method === 'search') && target) {
      if (args.length !== 1 || args[0]!.kind !== 'regex') {
        throw new UnsupportedExpressionError(
          `"${method}" only translates a regular expression literal written directly in the ` +
            `query, such as .${method}(/^A/); a pattern read from a variable has no flags to read ` +
            'while compiling.',
        );
      }
      return this.translateRegexMethod(target, method, args[0] as RegexExpression, scope);
    }

    // `flatMap` needs its callback bound to a row standing for one unnested
    // element, which is a lambda coming into scope and is why it is settled
    // here rather than left for the dialect, which is never handed one.
    if (method === 'flatMap' && target && this.columnTypeOf(target, scope) === 'array') {
      const callback = args[0];
      if (args.length !== 1 || callback?.kind !== 'lambda') {
        throw new UnsupportedExpressionError(
          `"flatMap" expects one callback mapping each element in a query but received ` +
            `${args.length} argument(s).`,
        );
      }
      return this.translateFlatMap(target, callback, scope);
    }

    const translatedTarget = target ? this.translate(target, scope) : null;
    const translatedArgs = args.map((argument) => this.translate(argument, scope));

    const translated = this.options.dialect.translateMethod({
      target: translatedTarget,
      method,
      args: translatedArgs,
      // Looked up for the reason `translateMember` looks one up: a method name
      // can mean different things over a string and over an array.
      targetType: target ? this.columnTypeOf(target, scope) : null,
    });

    if (!translated) {
      throw new UnsupportedExpressionError(
        `The "${this.options.dialect.name}" dialect cannot translate the call "${method}(...)".`,
      );
    }

    return translated;
  }

  /**
   * `u.name.match(/pattern/flags)` and `u.name.search(/pattern/flags)`
   * against a regular expression literal.
   *
   * The pattern is compiled the way any other literal argument is, a bound
   * value rather than text pasted into the statement. The flags are not: they
   * decide which operator or function a dialect prints, which has to be
   * settled while compiling, so they are handed over as a separate field a
   * dialect can read synchronously rather than as another bound value it
   * would have to wait on. Both methods share this rather than each
   * translating its own regex literal, since only the dialect case they reach
   * afterward differs.
   */
  private translateRegexMethod(
    target: ExpressionNode,
    method: 'match' | 'search',
    node: RegexExpression,
    scope: LambdaScope,
  ): SqlExpression {
    const translatedTarget = this.translate(target, scope);

    const translated = this.options.dialect.translateMethod({
      target: translatedTarget,
      method,
      args: [],
      targetType: this.columnTypeOf(target, scope),
      regex: { pattern: valueParameter(node.source), flags: node.flags },
    });

    if (!translated) {
      throw new UnsupportedExpressionError(
        `The "${this.options.dialect.name}" dialect cannot translate the call "${method}(...)".`,
      );
    }

    return translated;
  }

  /**
   * `u.tags.flatMap((tag) => tag.split('-'))`, mapping each element of an
   * array column through a callback and flattening its own arrays into one.
   *
   * The callback only ever runs as SQL, never in this process, so it is
   * translated rather than invoked: a fresh row source numbers every unnested
   * element under the name `element`, the callback's one parameter is bound
   * to that row exactly as a `where` predicate's is to the row it filters,
   * and the callback's body is translated in that scope like any other
   * expression. Building the row source is what a dialect cannot do itself,
   * since only the compiler binds a lambda's parameters to begin with; the
   * row source and the callback's translation both travel to the dialect
   * afterward; assembling them into `flatMap`'s own SQL is what varies by
   * database.
   */
  private translateFlatMap(
    target: ExpressionNode,
    callback: LambdaExpression,
    scope: LambdaScope,
  ): SqlExpression {
    const translatedTarget = this.translate(target, scope);

    const elementsAlias = this.nextAlias();
    const elements: SqlFrom = {
      kind: 'derived',
      select: {
        kind: 'select',
        distinct: false,
        columns: [{ expression: sqlFunction('unnest', [translatedTarget]), alias: 'element' }],
        from: { kind: 'unit', alias: this.nextAlias() },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
      alias: elementsAlias,
    };

    const elementScope = LambdaScope.bind(callback, [asValue(column(elementsAlias, 'element'))]);
    const mapped = this.translate(callback.body, elementScope);

    const translated = this.options.dialect.translateMethod({
      target: translatedTarget,
      method: 'flatMap',
      args: [],
      targetType: 'array',
      flatMap: { elements, mapped },
    });

    if (!translated) {
      throw new UnsupportedExpressionError(
        `The "${this.options.dialect.name}" dialect cannot translate the call "flatMap(...)".`,
      );
    }

    return translated;
  }

  /**
   * `row.collection.some(predicate)` and its complement, as a correlated
   * `EXISTS`.
   *
   * A collection navigation is many rows and has no column, so reading one off
   * it is refused everywhere else. Asking whether any of them matches is the
   * one question that needs no column, and `EXISTS` answers it without joining:
   * the row is not multiplied by its matches and a row with twenty of them
   * costs the same as a row with one, since the subquery stops at the first.
   *
   * This is the same join `selectMany` would have built, read as a condition
   * rather than as a source, which is why it reuses `expandCollection` for the
   * key that ties the two sides together.
   *
   * One compilation answers both operators, the way `takeWhile` and `skipWhile`
   * share theirs: `every` looks for a row that fails and negates the answer. A
   * failing row is `NOT p OR p IS NULL` and not `NOT p` alone, because a
   * predicate that is null rather than true is unknown in SQL and `NOT` of
   * unknown is unknown too, so such a row would answer neither and quietly pass.
   * That makes `every` exactly as strict as the `all` terminal, which is the
   * reading the rest of this library takes. A collection with no rows at all
   * satisfies `every` and fails `some`, as an empty array does in JavaScript.
   *
   * Returns null rather than throwing when the call is not this shape at all,
   * so an ordinary method on an ordinary value still reaches the dialect.
   */
  private collectionExists(
    target: ExpressionNode | null,
    method: string,
    args: readonly ExpressionNode[],
    scope: LambdaScope,
  ): SqlExpression | null {
    if (method !== 'some' && method !== 'every') return null;
    if (target?.kind !== 'member' || target.object.kind !== 'parameter') return null;

    const binding = scope.binding(target.object.name);
    if (binding.kind !== 'row') return null;

    const navigated = binding.scope.navigate?.(target.property);
    if (!navigated || navigated.kind !== 'collection') return null;

    const predicate = args[0];
    if (args.length !== 1 || predicate?.kind !== 'lambda') {
      throw new UnsupportedExpressionError(
        `"${method}" expects one predicate over the rows of "${target.property}", for example ` +
          `${target.object.name}.${target.property}.${method}((row) => row.id > 0).`,
      );
    }

    const expanded = this.expandCollection(navigated, binding.scope);

    // A navigation the predicate followed belongs inside the subquery, which is
    // the only place its columns are in scope, so the joins are captured here
    // rather than left to the clause around this one.
    const { value: condition, joins } = this.translating(() =>
      this.translate(predicate.body, LambdaScope.bind(predicate, [asRow(expanded.scope)])),
    );

    // `some` looks for a matching row and `every` for a failing one, which is
    // the whole of the difference between them.
    const wanted =
      method === 'some'
        ? condition
        : sqlBinary(
            'OR',
            { kind: 'unary', operator: 'NOT', operand: condition },
            { kind: 'nullTest', operand: condition, negated: false },
          );

    return {
      kind: 'exists',
      negated: method === 'every',
      select: {
        kind: 'select',
        distinct: false,
        // `EXISTS` asks whether a row is there and never reads it, so the
        // column list is a constant rather than the collection's own.
        columns: [{ expression: sqlLiteral('1'), alias: EXISTS_COLUMN }],
        from: expanded.join.source,
        joins: [...joins],
        where: conjoin(expanded.join.on, wanted),
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
    };
  }

  /**
   * `row.collection.sum((r) => r.value)` and the other aggregates, as a
   * correlated scalar subquery.
   *
   * This is `some`'s translation with the question changed. A collection is many
   * rows and has no column, so the aggregate cannot be handed to a dialect: what
   * it needs is a table, a key, and a join, which only the compiler holds. The
   * key comes from `expandCollection`, the same lookup `selectMany` and `some`
   * use, so none of the three can drift about which column a collection is
   * keyed by.
   *
   * A subquery per aggregate leaves the outer query's row count alone, which is
   * the property that matters and the one a join would have broken: joining the
   * collection and grouping would have to name every outer column in the
   * `GROUP BY` and would collapse two rows alike in all of them. That is
   * `groupJoin`'s reasoning, and this reuses `groupJoin`'s compilation of it.
   *
   * Empty is where the two languages part, and the answers are the ones this
   * library has already given: `count` is zero, `sum` is zero through the
   * `COALESCE` the `sum` terminal also carries, and `min`, `max`, and `average`
   * are null because SQL has nothing else to say and LINQ would have thrown.
   *
   * Returns null for anything that is not this shape, so an ordinary method on
   * an ordinary value still reaches the dialect, and so `u.name.min()` is the
   * dialect's error rather than this one's.
   */
  private collectionAggregate(
    target: ExpressionNode | null,
    method: string,
    args: readonly ExpressionNode[],
    scope: LambdaScope,
  ): SqlExpression | null {
    if (!AGGREGATES[method]) return null;
    if (target?.kind !== 'member' || target.object.kind !== 'parameter') return null;

    const binding = scope.binding(target.object.name);
    if (binding.kind !== 'row') return null;

    const navigated = binding.scope.navigate?.(target.property);
    if (!navigated || navigated.kind !== 'collection') return null;

    const expanded = this.expandCollection(navigated, binding.scope);

    return this.correlatedAggregate(
      { rows: expanded.scope, from: expanded.join.source, on: expanded.join.on },
      method,
      args,
    );
  }

  private isValueList(target: ExpressionNode): boolean {
    if (target.kind === 'array') return true;
    return target.kind === 'external' && Array.isArray(this.readBag(target.path));
  }

  private translateInList(
    target: ExpressionNode,
    args: readonly ExpressionNode[],
    scope: LambdaScope,
  ): SqlExpression {
    if (args.length !== 1) {
      throw new UnsupportedExpressionError('"includes" on a list expects exactly one argument.');
    }

    const operand = this.translate(args[0]!, scope);

    if (target.kind === 'array') {
      return {
        kind: 'in',
        operand,
        values: target.elements.map((element) => this.translate(element, scope)),
        negated: false,
      };
    }

    const path = (target as { path: readonly string[] }).path;
    const values = this.readBag(path) as unknown[];

    return {
      kind: 'in',
      operand,
      // Each element gets its own placeholder so the values are still bound
      // rather than inlined into the statement text.
      values: values.map((_, index) => externalParameter([...path, String(index)])),
      negated: false,
    };
  }

  /**
   * Whether `target` names a parameter bag entry holding a query rather than
   * a plain value, which is what `Queryable.asValues` marks one for.
   */
  private isBoundQueryTarget(target: ExpressionNode): target is ExternalExpression {
    return target.kind === 'external' && isBoundQuery(this.readBag(target.path));
  }

  /**
   * `p.vipIds.includes(u.id)` where `vipIds` is a query, compiled as
   * `u.id IN (subquery)` rather than a list of placeholders.
   *
   * The query is compiled independently, the ordinary way, since it was
   * already renumbered against this query's own bags when it was passed in;
   * nothing here reaches back into the scope `operand` came from, which is
   * what keeps this apart from `SqlExists`. `Queryable.asValues` already
   * refuses a query that still projects a row, so the column count checked
   * here is only for a caller who reached past that with a cast.
   */
  private translateInSubquery(
    target: ExternalExpression,
    args: readonly ExpressionNode[],
    scope: LambdaScope,
  ): SqlExpression {
    if (args.length !== 1) {
      throw new UnsupportedExpressionError('"includes" on a query expects exactly one argument.');
    }

    const operand = this.translate(args[0]!, scope);
    const embedded = this.readBag(target.path) as BoundQuery;
    const compiled = this.compile(embedded.plan);

    if (compiled.select.columns.length !== 1) {
      throw new UnsupportedExpressionError(
        '"includes" over a query needs it to project exactly one value, the way "contains" ' +
          'does: project one with "select" before calling "asValues".',
      );
    }

    return { kind: 'inSubquery', operand, select: compiled.select, negated: false };
  }

  private readBag(path: readonly string[]): unknown {
    return readPath(this.options.bags, path);
  }
}

/**
 * The aggregates a group exposes, keyed by the name written in the lambda.
 *
 * The names follow LINQ rather than SQL, except that `avg` keeps its SQL
 * spelling in the AST because that is what the printer emits.
 */
const AGGREGATES: Record<string, SqlAggregate['name']> = {
  count: 'count',
  // Present so the name is recognised and listed in the error below; the
  // expression it actually builds is `countDistinctExpression`, not a bare
  // aggregate carrying this name, since a group's count needs the same null
  // adjustment the standalone terminal makes.
  countDistinct: 'count',
  sum: 'sum',
  average: 'avg',
  min: 'min',
  max: 'max',
};

/**
 * How tightly each set operator binds, per the SQL standard.
 *
 * `INTERSECT` binds tighter than `UNION` and `EXCEPT`, which bind equally and
 * associate left to right. This decides when a chain can stay flat and when a
 * branch has to be parenthesised into a derived table to keep its grouping.
 */
/**
 * Aliases for the bookkeeping columns the windowed operators add inside their
 * derived tables. Every one of them is dropped by the select around it, so none
 * reaches a caller nor collides with a projected column of the same name.
 */
const FAILURES_COLUMN = '__sqlinqo_failed';
const RANK_COLUMN = '__sqlinqo_rank';
const POSITION_COLUMN = '__sqlinqo_position';
const CHUNK_COLUMN = '__sqlinqo_chunk';
const EXISTS_COLUMN = '__sqlinqo_exists';
/** Alias for the one column a `groupJoin` aggregate subquery returns. */
const MATCHES_COLUMN = '__sqlinqo_matches';
/** Prefix for the sort keys `takeLast` and `skipLast` carry out to reapply their ordering. */
const SORT_PREFIX = '__sqlinqo_sort_';
/** Prefix for `pairwise`'s copy of each column, taken from the row before. */
const PREVIOUS_PREFIX = '__sqlinqo_prev_';
const BREAK_COLUMN = '__sqlinqo_break';
/** Witness `defaultIfEmpty` adds inside its derived table to tell a real row from a missing one. */
const PRESENT_COLUMN = '__sqlinqo_present';

const SET_PRECEDENCE: Record<SqlSetOperation['kind'], number> = {
  intersect: 2,
  union: 1,
  except: 1,
};

/**
 * Reorders one branch's columns to line up with the branch it is united with.
 *
 * SQL pairs the columns of a set operation by position, but a row here is
 * identified by alias, and two queries of the same row type may well have
 * projected those aliases in a different order. Pairing by name instead keeps
 * each value in the property it was written to, rather than quietly landing it
 * in whichever property happened to sit at the same index.
 */
function alignColumns(branch: SqlSelect, template: SqlSelect): SqlSelect {
  const describe = (select: SqlSelect) =>
    select.columns.map((projection) => projection.alias).join(', ');

  if (branch.columns.length !== template.columns.length) {
    throw new InvalidQueryError(
      `Both sides of a set operation must project the same columns, but one projects ` +
        `${template.columns.length} (${describe(template)}) and the other ` +
        `${branch.columns.length} (${describe(branch)}).`,
    );
  }

  const byAlias = new Map(branch.columns.map((projection) => [projection.alias, projection]));

  return {
    ...branch,
    columns: template.columns.map((wanted) => {
      const match = byAlias.get(wanted.alias);
      if (!match) {
        throw new InvalidQueryError(
          `One side of a set operation has no column "${wanted.alias}". Both sides must ` +
            `project the same columns; this one has: ${describe(branch)}.`,
        );
      }
      return match;
    }),
  };
}

/** Attaches the joins a clause's navigations asked for to the select it lands on. */
function withNavigations(select: SqlSelect, joins: readonly SqlJoin[]): SqlSelect {
  return joins.length === 0 ? select : { ...select, joins: [...select.joins, ...joins] };
}

/**
 * The one column a reference matches when it does not name one itself.
 *
 * A composite or absent primary key leaves nothing to guess at, so the relation
 * has to say which column it points at.
 */
function onlyPrimaryKey(target: EntityDefinition, property: string): string {
  const [key, ...rest] = target.primaryKey;
  if (!key || rest.length > 0) {
    throw new ModelError(
      `Relation "${property}" points at entity "${target.name}", whose primary key is ` +
        `${key ? 'made of several columns' : 'not declared'}. Name the column to match with ` +
        'the "to" option.',
    );
  }
  return key;
}

/** Rebuilds the column list a scope exposes, which is what an identity projection selects. */
function columnsOf(scope: RowScope): SqlProjection[] {
  return scope.names().map((name) => ({ expression: scope.resolve(name)!, alias: name }));
}

/** Projects one unnamed value, which the materializer unwraps from its row. */
function scalarProjection(
  select: SqlSelect,
  expression: SqlExpression,
  type: ColumnType | null = null,
): CompiledQuery {
  return {
    select: { ...select, columns: [{ expression, alias: 'value' }] },
    scope: new MapScope(new Map([['value', expression]]), 'scalar projection', (name) =>
      name === 'value' ? type : null,
    ),
  };
}

function translateConstant(value: unknown): SqlExpression {
  if (value === null || value === undefined) return SQL_NULL;
  if (typeof value === 'boolean') return sqlLiteral(value ? 'TRUE' : 'FALSE');
  return valueParameter(value);
}

function isNullLiteral(node: ExpressionNode): boolean {
  return node.kind === 'constant' && (node.value === null || node.value === undefined);
}

function isStringLiteral(node: ExpressionNode): boolean {
  return node.kind === 'constant' && typeof node.value === 'string';
}

/** A key lowered into SQL, one part per property when the caller named them. */
interface CompiledKey {
  /** True when the key was an object literal, so its parts have names. */
  readonly named: boolean;
  readonly parts: ReadonlyMap<string, SqlExpression>;
}

/**
 * `left = right`, with two nulls counting as a match.
 *
 * SQL reads `NULL = NULL` as unknown rather than true, which is not what
 * comparing keys means anywhere else this library looks. LINQ's default
 * comparer holds two nulls equal, and so does SQL's own `EXCEPT`, whose set
 * semantics are "not distinct" rather than "equal". `IS NOT DISTINCT FROM` is
 * the operator that says this in one breath and is not something every database
 * has, so the reading is spelled out in `=`, `OR`, and `IS NULL`, which are
 * ANSI as `localeCompare`'s `CASE` is.
 *
 * Both sides are mentioned twice, which costs nothing where placeholders are
 * numbered: the printer binds one value and repeats its placeholder.
 */
function notDistinctFrom(left: SqlExpression, right: SqlExpression): SqlExpression {
  return sqlBinary(
    'OR',
    sqlBinary('=', left, right),
    sqlBinary(
      'AND',
      { kind: 'nullTest', operand: left, negated: false },
      { kind: 'nullTest', operand: right, negated: false },
    ),
  );
}

/**
 * The condition matching two keys, part by part.
 *
 * Object keys are paired by name rather than by position. The two selectors are
 * written on different entities and may well declare the same properties in a
 * different order, which the type system cannot see: both are a `TKey`. Pairing
 * positionally would compare each part against whichever one happened to sit at
 * the same index and answer a question nobody asked.
 */
function matchKeys(key: CompiledKey, otherKey: CompiledKey, operator: string): SqlExpression {
  const mismatch = () =>
    new InvalidQueryError(
      `"${operator}" compares the two keys part by part, and ${describeKey(key)} has no ` +
        `counterpart in ${describeKey(otherKey)}. Give both selectors the same shape.`,
    );

  if (key.named !== otherKey.named || key.parts.size !== otherKey.parts.size) throw mismatch();

  const matches: SqlExpression[] = [];
  for (const [name, expression] of key.parts) {
    const counterpart = otherKey.parts.get(name);
    if (!counterpart) throw mismatch();
    matches.push(notDistinctFrom(expression, counterpart));
  }

  // A row is dropped only when every part of its key is accounted for, which is
  // what makes an object key one key rather than several.
  return matches.reduce((left, right) => sqlBinary('AND', left, right));
}

/** Names a key's shape for an error message. */
function describeKey(key: CompiledKey): string {
  return key.named ? `{ ${[...key.parts.keys()].join(', ')} }` : 'a key of one value';
}

/**
 * The test on a row's position within its key that keeps the window asked for.
 *
 * One row of each key is written as `= 1` rather than as a range: the same rows,
 * and the text every reader and test of `distinctBy` already knows. Everything
 * else is a range, open at the top when nothing said how many rows to keep.
 */
function keptPerKey(rank: SqlExpression, skip: number, take: number | null): SqlExpression {
  if (skip === 0 && take === 1) return sqlBinary('=', rank, sqlLiteral('1'));

  const after = sqlBinary('>', rank, sqlLiteral(String(skip)));
  if (take === null) return after;

  const upTo = sqlBinary('<=', rank, sqlLiteral(String(skip + take)));
  return skip === 0 ? upTo : sqlBinary('AND', after, upTo);
}

function integer(value: number, operator: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidQueryError(
      `"${operator}" expects a non-negative integer but received ${value}.`,
    );
  }
  return value;
}
