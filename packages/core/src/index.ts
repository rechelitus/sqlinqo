/**
 * @sqlinqo/core
 *
 * The provider-agnostic half of the library: entity metadata, the lambda
 * parser, the expression IR, and the SQL compiler. Pair it with a provider
 * package such as `@sqlinqo/postgres` to actually reach a database.
 */

export { createDbContext } from './context.js';
export type {
  DbContext,
  DbContextInternals,
  DbContextOptions,
  DbContextTransaction,
} from './context.js';

export type { Driver, ExecutedStatement, PreparedStatement, ResultRow } from './driver.js';

export {
  InvalidQueryError,
  LinqError,
  ModelError,
  ParseError,
  SequenceError,
  UnsupportedExpressionError,
} from './errors.js';

export {
  collection,
  defineEntity,
  physicalName,
  qualifiedTable,
  reference,
} from './metadata/entity.js';
export type {
  AnyEntity,
  ColumnDefinition,
  ColumnMap,
  ColumnShape,
  ColumnType,
  ScalarColumnType,
  ColumnTypeMap,
  Collection,
  ColumnValue,
  EntityDefinition,
  EntityOf,
  EntityOptions,
  EntityShape,
  IncludedRow,
  InsertOf,
  InsertShape,
  CollectionDefinition,
  ReferenceDefinition,
  Related,
  RelatedShape,
  RelationDefinition,
  RelationMap,
} from './metadata/entity.js';

export {
  EntitySet,
  IncludedCollection,
  IncludedQueryable,
  OrderedIncludedCollection,
  OrderedQueryable,
  Queryable,
  queryableFor,
} from './query/queryable.js';
export type { Group, NullableRow, QueryRuntime, Run } from './query/queryable.js';
export { rootEntity } from './query/plan.js';
export type { OrderKey, QueryPlan } from './query/plan.js';

export { BaseDialect } from './sql/dialect.js';
export type { MethodTranslation, SqlDialect } from './sql/dialect.js';

export {
  compileAverage,
  compileCount,
  compileMax,
  compileMin,
  compileQuery,
  compileSum,
} from './sql/compiler.js';
export type { CompileOptions } from './sql/compiler.js';

export { bindParameters, printSelect, readPath } from './sql/printer.js';
export type { CompiledStatement } from './sql/printer.js';

export * as sql from './sql/nodes.js';
export type {
  ParameterSource,
  SqlExists,
  SqlExpression,
  SqlFrom,
  SqlJoin,
  SqlOrdering,
  SqlOver,
  SqlSubscript,
  SqlSetOperation,
  SqlProjection,
  SqlSelect,
} from './sql/nodes.js';

export * as expression from './expression/nodes.js';
export type { ExpressionNode, LambdaExpression } from './expression/nodes.js';

export { parseLambda, toExpression } from './parser/lambda.js';
export type { BindOptions } from './parser/bind.js';
