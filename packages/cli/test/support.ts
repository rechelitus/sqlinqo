import type {
  ColumnInfo,
  DatabaseSchema,
  ForeignKeyInfo,
  SchemaReader,
  TableInfo,
} from '../src/schema/types.js';

/**
 * Builds a column the way the PostgreSQL reader would report it.
 *
 * Only what a test cares about is named at the call site; everything else takes
 * the shape of an ordinary `NOT NULL` column with no default, which is the case
 * that needs no flags in the generated output either.
 */
export function column(
  name: string,
  udtName: string,
  overrides: Partial<ColumnInfo> = {},
): ColumnInfo {
  return {
    name,
    position: 1,
    nullable: false,
    dataType: udtName,
    udtName,
    isArray: false,
    typeCategory: 'b',
    hasDefault: false,
    isIdentity: false,
    isStored: false,
    primaryKey: false,
    comment: null,
    ...overrides,
  };
}

export function table(
  name: string,
  columns: readonly ColumnInfo[],
  foreignKeys: readonly ForeignKeyInfo[] = [],
  overrides: Partial<TableInfo> = {},
): TableInfo {
  return { schema: 'public', name, comment: null, columns, foreignKeys, ...overrides };
}

/** A single-column foreign key, the shape that becomes a navigation. */
export function foreignKey(
  name: string,
  from: [table: string, column: string],
  to: [table: string, column: string],
): ForeignKeyInfo {
  return { name, table: from[0], columns: [from[1]], targetTable: to[0], targetColumns: [to[1]] };
}

export function schema(tables: readonly TableInfo[], name = 'public'): DatabaseSchema {
  return { schema: name, tables };
}

/** Replays a schema without touching a database. */
export class FakeReader implements SchemaReader {
  constructor(private readonly database: DatabaseSchema) {}

  async read(): Promise<DatabaseSchema> {
    return this.database;
  }
}

/**
 * The schema behind `examples/basic-pg`, which the tests use as their worked case.
 *
 * `users.city_id` is nullable, so it exercises an optional reference and the
 * left join behind it, and `cities` gains the collection on the other side.
 */
export function exampleSchema(): DatabaseSchema {
  return schema([
    table('cities', [
      column('id', 'int4', { primaryKey: true, position: 1 }),
      column('name', 'text', { position: 2 }),
      column('country', 'text', { position: 3 }),
    ]),
    table(
      'users',
      [
        column('id', 'int4', { primaryKey: true, isIdentity: true, hasDefault: true, position: 1 }),
        column('name', 'text', { position: 2 }),
        column('email', 'text', { position: 3 }),
        column('age', 'int4', { position: 4 }),
        column('city_id', 'int4', { nullable: true, position: 5 }),
        column('is_active', 'bool', { hasDefault: true, position: 6 }),
        column('created_at', 'timestamptz', { hasDefault: true, position: 7 }),
      ],
      [foreignKey('users_city_id_fkey', ['users', 'city_id'], ['cities', 'id'])],
    ),
  ]);
}
