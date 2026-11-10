import { ModelError } from '../errors.js';
import type { LambdaExpression } from '../expression/nodes.js';
import { toExpression } from '../parser/lambda.js';

/**
 * Logical column types understood by the engine.
 *
 * These are deliberately abstract: each provider maps them onto its own
 * physical types, so a model written once can target more than one database.
 */
export type ScalarColumnType =
  | 'int'
  | 'bigint'
  | 'float'
  | 'decimal'
  | 'text'
  | 'uuid'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'json';

/**
 * A column's logical type. `array` is the one that carries another with it, in
 * `of`, and holds many values of that type rather than one.
 */
export type ColumnType = ScalarColumnType | 'array';

/**
 * What an array column holds one of: an ordinary scalar, or one more array
 * nested inside it.
 *
 * Nesting stops at one level on purpose. `flat()` is the only operator that
 * reads a second level at all, and PostgreSQL's own arrays are rectangular
 * rather than jagged, so a column declared this way is closer to a Postgres
 * two-dimensional array than to an arbitrarily deep JavaScript one; going
 * deeper would claim a shape neither side actually has.
 */
export type ArrayElementType =
  ScalarColumnType | { readonly type: 'array'; readonly of: ScalarColumnType };

/**
 * Maps a logical column type onto the TypeScript value the driver returns.
 *
 * `decimal` maps to `string` on purpose: most drivers refuse to narrow an
 * arbitrary-precision numeric into a float, and silently losing precision in a
 * financial column is worse than making the caller convert explicitly.
 */
export interface ColumnTypeMap {
  int: number;
  bigint: bigint;
  float: number;
  decimal: string;
  text: string;
  uuid: string;
  boolean: boolean;
  date: Date;
  timestamp: Date;
  json: unknown;
}

export interface ColumnDefinition<TType extends ColumnType = ColumnType> {
  /** Logical type used for translation and for typing the entity shape. */
  readonly type: TType;
  /** Element type. Required when `type` is `array`, and meaningless otherwise. */
  readonly of?: ArrayElementType;
  /** Physical column name. Defaults to the property name in the model. */
  readonly column?: string;
  readonly primaryKey?: boolean;
  readonly nullable?: boolean;
  /** Value produced by the database (identity, sequence, default). */
  readonly generated?: boolean;
}

export type ColumnMap = Record<string, ColumnDefinition>;

/**
 * A property that stands for one related row rather than for a column.
 *
 * The target is named through a thunk so that two entities can refer to each
 * other without either having to be declared first.
 */
export interface ReferenceDefinition<TTarget extends AnyEntity = AnyEntity> {
  readonly kind: 'reference';
  readonly target: () => TTarget;
  /** Property on this entity holding the key that points at the target. */
  readonly from: string;
  /** Property on the target it matches. Defaults to the target's primary key. */
  readonly to?: string;
  /**
   * True when the key may be null, so the related row need not exist. An
   * optional reference is joined with a `LEFT JOIN` and reads as null columns;
   * a required one is joined with an `INNER JOIN`.
   */
  readonly optional?: boolean;
}

/**
 * A property that stands for the many rows pointing back at this one.
 *
 * The mirror of a reference, with the key on the other side: `from` names the
 * column on the target that holds it, and `to` the column here that it matches,
 * which is this entity's primary key unless said otherwise.
 */
export interface CollectionDefinition<TTarget extends AnyEntity = AnyEntity> {
  readonly kind: 'collection';
  readonly target: () => TTarget;
  /** Property on the target holding the key that points back here. */
  readonly from: string;
  /** Property here that it matches. Defaults to this entity's primary key. */
  readonly to?: string;
}

export type RelationDefinition = ReferenceDefinition | CollectionDefinition;

export type RelationMap = Readonly<Record<string, RelationDefinition>>;

/**
 * Declares a many-to-one reference from one entity to another.
 *
 * ```ts
 * const Order = defineEntity({
 *   name: 'Order',
 *   columns: { id: { type: 'int', primaryKey: true }, userId: { type: 'int' } },
 *   relations: { user: reference(() => User, 'userId') },
 * });
 * ```
 */
export function reference<TTarget extends AnyEntity>(
  target: () => TTarget,
  from: string,
  options: { readonly to?: string; readonly optional?: boolean } = {},
): ReferenceDefinition<TTarget> {
  return { kind: 'reference', target, from, ...options };
}

/**
 * Declares a one-to-many collection, the other end of a reference.
 *
 * ```ts
 * const User = defineEntity({
 *   name: 'User',
 *   columns: { id: { type: 'int', primaryKey: true } },
 *   relations: { orders: collection(() => Order, 'userId') },
 * });
 * ```
 *
 * A collection is read through `selectMany`, which flattens it. Reading a
 * column off one directly has no meaning, since there may be any number of
 * rows behind it.
 */
export function collection<TTarget extends AnyEntity>(
  target: () => TTarget,
  from: string,
  options: { readonly to?: string } = {},
): CollectionDefinition<TTarget> {
  return { kind: 'collection', target, from, ...options };
}

export interface EntityDefinition<
  TColumns extends ColumnMap = ColumnMap,
  TRelations extends RelationMap = RelationMap,
> {
  /** Name used in diagnostics and error messages. */
  readonly name: string;
  readonly table: string;
  readonly schema?: string;
  readonly columns: TColumns;
  /** Navigations to other entities, empty when none were declared. */
  readonly relations: TRelations;
  /** Property names that make up the primary key, in declaration order. */
  readonly primaryKey: readonly (keyof TColumns & string)[];
  /**
   * A predicate applied to every ordinary query over this entity, as a soft
   * delete needs. Parsed once here rather than on every query it reaches,
   * since the source behind it never changes once the entity is defined.
   */
  readonly filter?: LambdaExpression;
}

/**
 * An entity definition with its column map erased.
 *
 * `EntityDefinition<T>` mentions `keyof T`, which makes it invariant in `T`, so
 * a concrete definition is not assignable to `EntityDefinition<ColumnMap>`.
 * This alias is the constraint to use wherever a collection of unrelated
 * entities is accepted; the precise shape is still recovered through `EntityOf`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntity = EntityDefinition<any, any>;

/** The value one element of an array column holds, honouring one level of nesting. */
type ElementValue<TOf extends ArrayElementType> = TOf extends ScalarColumnType
  ? ColumnTypeMap[TOf]
  : TOf extends { type: 'array'; of: infer TInner extends ScalarColumnType }
    ? ColumnTypeMap[TInner][]
    : never;

/**
 * The value a column holds, before nullability is considered.
 *
 * An `array` column is read through its `of`, which is why it is matched first:
 * `array` has no entry in the type map of its own, so a declaration missing
 * `of` resolves to `never` rather than to something plausible and wrong.
 */
type ColumnContents<TColumn extends ColumnDefinition> = TColumn extends {
  type: 'array';
  of: infer TOf extends ArrayElementType;
}
  ? ElementValue<TOf>[]
  : TColumn extends { type: infer TType extends ScalarColumnType }
    ? ColumnTypeMap[TType]
    : never;

/** Resolves the TypeScript value type of a single column, honouring nullability. */
export type ColumnValue<TColumn extends ColumnDefinition> = TColumn extends { nullable: true }
  ? ColumnContents<TColumn> | null
  : ColumnContents<TColumn>;

/** The columns of an entity, without its navigations. */
export type ColumnShape<TColumns extends ColumnMap> = {
  [K in keyof TColumns]: ColumnValue<TColumns[K]>;
};

/**
 * Tag naming the entity a navigation's rows came from.
 *
 * A related row types as columns and nothing else, which is what keeps a chain
 * of navigations from expanding forever and what makes a second hop in a lambda
 * a compile error rather than a runtime one. The cost is that the entity behind
 * a navigation cannot be recovered from the shape, and `thenInclude` needs
 * exactly that: the rows an `include` brought back have navigations of their
 * own, and only the entity definition knows what they are.
 *
 * So the shape carries an optional property under a symbol no caller can name.
 * It is invisible to property access and to anything reading columns, and it is
 * inferable in a signature, which is the whole of what it exists for. The
 * property is never present at runtime: it is a type, not a value.
 */
declare const RELATED_ENTITY: unique symbol;

/**
 * The rows of a navigation, tagged with the entity they came from.
 *
 * `TShape` defaults to `unknown` so a signature can ask for "a related row of
 * some entity" without saying anything about its columns, which is how
 * `include` and `thenInclude` infer what a selector named.
 */
export type Related<TTarget extends AnyEntity, TShape = unknown> = TShape & {
  readonly [RELATED_ENTITY]?: TTarget;
};

/**
 * The rows on the far side of a collection navigation.
 *
 * An array, because that is what they are and what `selectMany` flattens, plus
 * the questions a database can answer about them without reading any: how many
 * there are, and what one of their columns comes to. Each of those compiles to a
 * correlated subquery, so `u.orders.sum((o) => o.total)` can be projected,
 * filtered on, or ordered by while the query still reads one row per user.
 *
 * These aggregate methods exist for lambdas to be translated from and nowhere
 * else. A JavaScript array has no `sum`, so the rows an `include` hands back
 * type as a plain array and calling one on them would throw: they are a
 * description of what SQL can compute, in the same way `Group`'s are.
 *
 * `min`, `max`, and `average` may answer null where the terminals of the same
 * name cannot, because a collection with no rows at all is the ordinary case
 * here — a user need not have ordered anything — and SQL has no other answer for
 * it. `sum` answers zero for that row, as the `sum` terminal does.
 */
export interface Collection<TRow> extends Array<TRow> {
  /** `COUNT(*)` over the rows pointing back at this one. */
  count(): number;
  sum<TValue extends number | string>(value: (row: TRow) => TValue): TValue;
  average<TValue extends number | string>(value: (row: TRow) => TValue): TValue | null;
  min<TValue>(value: (row: TRow) => TValue): TValue | null;
  max<TValue>(value: (row: TRow) => TValue): TValue | null;
}

/** The columns of an entity definition, with its relations erased. */
type ColumnsOf<TEntity> =
  TEntity extends EntityDefinition<infer TColumns, RelationMap> ? TColumns : never;

/**
 * What one navigation reads as: the target's columns, and only those.
 *
 * Stopping at the target's own columns is what keeps a chain of navigations
 * from expanding forever in the type system, and it matches what the compiler
 * translates, which is a single hop. An optional reference widens every column
 * rather than the row itself, so `o.city.name` stays writable while typing as
 * `string | null`, the same trade `leftJoin` makes. A collection is an array of
 * those rows, which is what lets `selectMany` infer what it flattens to.
 *
 * Each of those rows is tagged with the entity it came from, which costs
 * nothing to read and is what lets an include chain follow a second hop. A
 * collection is a `Collection`, which is an array of them and the aggregates a
 * correlated subquery can answer.
 */
export type RelatedShape<TRelation> =
  TRelation extends CollectionDefinition<infer TTarget>
    ? Collection<Related<TTarget, ColumnShape<ColumnsOf<TTarget>>>>
    : TRelation extends ReferenceDefinition<infer TTarget>
      ? TRelation extends { readonly optional: true }
        ? Related<
            TTarget,
            { [K in keyof ColumnsOf<TTarget>]: ColumnValue<ColumnsOf<TTarget>[K]> | null }
          >
        : Related<TTarget, ColumnShape<ColumnsOf<TTarget>>>
      : never;

/** The row shape produced by an entity definition, navigations included. */
export type EntityShape<
  TColumns extends ColumnMap,
  TRelations extends RelationMap = RelationMap,
> = ColumnShape<TColumns> & {
  readonly [K in keyof TRelations]: RelatedShape<TRelations[K]>;
};

/**
 * How many hops of navigation an included row's type expands.
 *
 * A limit is needed because a model may well be cyclic — a user has orders and
 * an order has a user — and a type that followed those forever would not
 * compile. Three is chosen to be past what any `include` chain written here has
 * needed, and it is a claim about the type only: what a row actually carries is
 * whatever was included.
 */
type IncludeDepth = 0 | 1 | 2 | 3;

/** One hop less, as a lookup because a type cannot do arithmetic. */
type Shallower = { 0: 0; 1: 0; 2: 1; 3: 2 };

/**
 * A row read back from an include chain: every navigation expanded so the rows
 * behind it carry their own navigations.
 *
 * This is the include chain's own reading of a row and not the row type the
 * lambdas use, which is the point. `Queryable<T>` keeps stopping at one hop, so
 * `o.user.city.name` in a `where` stays the compile error it has always been;
 * an `IncludedQueryable` takes no lambdas over rows and can afford to describe
 * a graph.
 *
 * It describes what `include` and `thenInclude` *can* bring back rather than
 * what a particular chain did, which is the trade `include` already made at one
 * hop: the row type claims the navigation and a query without the operator hands
 * back rows where the property is simply absent.
 */
export type IncludedRow<TRow, TDepth extends IncludeDepth = 3> = {
  [K in keyof TRow]: IncludedValue<TRow[K], TDepth>;
};

/**
 * One property of such a row: a tagged navigation expanded, anything else left
 * exactly as it was.
 *
 * The tag is what tells the two apart. A column holding an array of text is an
 * array whose element carries no tag, and a `json` column is `unknown`, so
 * neither is mistaken for a navigation.
 */
type IncludedValue<TValue, TDepth extends IncludeDepth> = TDepth extends 0
  ? TValue
  : TValue extends readonly (infer TElement)[]
    ? TElement extends { readonly [RELATED_ENTITY]?: infer TTarget }
      ? TTarget extends AnyEntity
        ? (TElement & IncludedNavigations<TTarget, TDepth>)[]
        : TValue
      : TValue
    : TValue extends { readonly [RELATED_ENTITY]?: infer TTarget }
      ? TTarget extends AnyEntity
        ? TValue & IncludedNavigations<TTarget, TDepth>
        : TValue
      : TValue;

/**
 * The navigations of an entity, one hop shallower.
 *
 * Only the navigations: intersecting the target's columns back in would narrow
 * an optional reference's `string | null` to `string`, which is the opposite of
 * what that widening is for.
 */
type IncludedNavigations<TTarget, TDepth extends IncludeDepth> =
  TTarget extends EntityDefinition<infer TColumns, infer TRelations>
    ? TColumns extends ColumnMap
      ? {
          readonly [K in keyof TRelations]: IncludedValue<
            RelatedShape<TRelations[K]>,
            Shallower[TDepth]
          >;
        }
      : never
    : never;

/**
 * A column the caller has to supply when inserting a row.
 *
 * Anything the database produces is not one, and neither is anything that may
 * be null, since leaving it out and writing null are the same row. Everything
 * else has no other source and is required.
 */
type Supplied<TColumn extends ColumnDefinition> = TColumn extends { generated: true }
  ? false
  : TColumn extends { nullable: true }
    ? false
    : true;

/**
 * The shape of a row being inserted: the columns without a source of their own
 * required, the rest optional, and no navigations at all.
 *
 * A navigation is left out because inserting through one would mean writing to
 * a second table, which is a different statement and a decision this operator
 * does not make for the caller.
 */
export type InsertShape<TColumns extends ColumnMap> = {
  [K in keyof TColumns as Supplied<TColumns[K]> extends true ? K : never]: ColumnValue<TColumns[K]>;
} & {
  [K in keyof TColumns as Supplied<TColumns[K]> extends true ? never : K]?: ColumnValue<
    TColumns[K]
  >;
};

/** Convenience alias: `InsertOf<typeof User>` gives the shape an insert takes. */
export type InsertOf<TEntity> =
  TEntity extends EntityDefinition<infer TColumns, RelationMap> ? InsertShape<TColumns> : never;

/** Convenience alias: `EntityOf<typeof User>` gives the row type. */
export type EntityOf<TEntity> =
  TEntity extends EntityDefinition<infer TColumns, infer TRelations>
    ? EntityShape<TColumns, TRelations>
    : never;

export interface EntityOptions<TColumns extends ColumnMap, TRelations extends RelationMap> {
  readonly name: string;
  /** Physical table name. Defaults to `name`. */
  readonly table?: string;
  readonly schema?: string;
  readonly columns: TColumns;
  /** Navigations to other entities, declared with `reference`. */
  readonly relations?: TRelations;
  /**
   * A predicate applied to every ordinary query over this entity, as a soft
   * delete needs: `(row) => !row.deletedAt`, say. It reaches `db.users`
   * itself, a reference or collection navigated to this entity, and rows
   * `include` reads through it; bypass it for one query with
   * `ignoreQueryFilters()`.
   */
  readonly filter?: (row: EntityShape<TColumns, TRelations>) => boolean;
}

/**
 * Declares an entity and its column mapping.
 *
 * The `const` type parameter keeps the literal types of `type: 'int'` and
 * `nullable: true`, which is what lets `EntityOf` produce a precise row type
 * without the caller writing an interface by hand.
 */
export function defineEntity<
  const TColumns extends ColumnMap,
  const TRelations extends RelationMap = Record<never, never>,
>(options: EntityOptions<TColumns, TRelations>): EntityDefinition<TColumns, TRelations> {
  const propertyNames = Object.keys(options.columns) as (keyof TColumns & string)[];
  if (propertyNames.length === 0) {
    throw new ModelError(`Entity "${options.name}" declares no columns.`);
  }

  const seen = new Map<string, string>();
  for (const property of propertyNames) {
    const definition = options.columns[property]!;
    if (definition.type === 'array' && !definition.of) {
      throw new ModelError(
        `Column "${property}" on entity "${options.name}" is an array but does not say ` +
          'what of. Give it an element type, as { type: "array", of: "text" }.',
      );
    }
    if (definition.type !== 'array' && definition.of) {
      throw new ModelError(
        `Column "${property}" on entity "${options.name}" names an element type but is a ` +
          `"${definition.type}", not an array.`,
      );
    }

    const physical = physicalName(options.columns, property);
    const previous = seen.get(physical);
    if (previous) {
      throw new ModelError(
        `Entity "${options.name}" maps both "${previous}" and "${property}" to column "${physical}".`,
      );
    }
    seen.set(physical, property);
  }

  const relations = options.relations ?? ({} as TRelations);
  for (const [name, relation] of Object.entries(relations)) {
    // The target is a thunk and may not be constructed yet, so only this side
    // can be checked here. The other side is checked when the query compiles.
    if (name in options.columns) {
      throw new ModelError(
        `Entity "${options.name}" declares both a column and a relation named "${name}".`,
      );
    }
    // Which side holds the key depends on the direction. A reference keeps it
    // here, so `from` must be a column of this entity; a collection is pointed
    // at, so `from` belongs to the target and only `to` can be checked now.
    const here = relation.kind === 'collection' ? relation.to : relation.from;
    if (here !== undefined && !(here in options.columns)) {
      throw new ModelError(
        `Relation "${name}" on entity "${options.name}" reads from "${here}", ` +
          `which is not one of its columns: ${propertyNames.join(', ')}.`,
      );
    }
  }

  return {
    name: options.name,
    table: options.table ?? options.name,
    schema: options.schema,
    columns: options.columns,
    relations,
    primaryKey: propertyNames.filter((property) => options.columns[property]?.primaryKey === true),
    filter: options.filter && toExpression(options.filter, { rowParameterCount: 1 }),
  };
}

/** Resolves the physical column name for a model property. */
export function physicalName(columns: ColumnMap, property: string): string {
  return columns[property]?.column ?? property;
}

/** Fully qualified table reference, honouring an optional schema. */
export function qualifiedTable(entity: EntityDefinition): { schema?: string; table: string } {
  return entity.schema ? { schema: entity.schema, table: entity.table } : { table: entity.table };
}
