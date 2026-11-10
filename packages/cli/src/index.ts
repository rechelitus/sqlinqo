/**
 * @sqlinqo/cli
 *
 * Scaffolds `@sqlinqo/core` entity definitions from an existing PostgreSQL
 * schema. The executable is `sqlinqo scaffold`; everything it does is also
 * exported here, one step at a time, so a project with its own conventions can
 * read the schema, reshape the model, and render it however it likes.
 */

export { run } from './cli.js';
export { scaffold } from './scaffold.js';
export type { FileOutcome, ScaffoldOptions, ScaffoldResult, ScaffoldedFile } from './scaffold.js';

export { PostgresSchemaReader } from './schema/postgres.js';
export type { PostgresSchemaReaderOptions } from './schema/postgres.js';
export type {
  ColumnInfo,
  DatabaseSchema,
  ForeignKeyInfo,
  SchemaReader,
  TableInfo,
} from './schema/types.js';

export { buildModel } from './generate/model.js';
export type {
  BuildModelOptions,
  EntityModel,
  GeneratedCollection,
  GeneratedColumn,
  GeneratedEntity,
  GeneratedReference,
  GeneratedRelation,
} from './generate/model.js';

export { emitBarrel, emitEntity, emitFiles } from './generate/emit.js';
export type { EmitOptions, GeneratedFile } from './generate/emit.js';

export { mapColumnType, mapScalarType } from './generate/column-type.js';
export type { MappedColumnType } from './generate/column-type.js';
