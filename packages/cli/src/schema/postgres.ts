import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';
import type {
  ColumnInfo,
  DatabaseSchema,
  ForeignKeyInfo,
  SchemaReader,
  TableInfo,
} from './types.js';

// `pg` is CommonJS, so the named exports are read off the default import, the
// same form the postgres provider uses.
const { Pool: PgPool } = pg;

/**
 * Tables in the schema, ordered by name.
 *
 * A partitioned table is mapped and its partitions are not: the partitions are
 * ordinary tables as far as the catalogue is concerned, so scaffolding them
 * would produce one entity per partition for a table that reads as one. Temp
 * tables are excluded by persistence; unlogged ones are real tables and stay.
 */
const TABLES_SQL = `
  SELECT
    c.relname                            AS table_name,
    obj_description(c.oid, 'pg_class')   AS comment
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relpersistence IN ('p', 'u')
  ORDER BY c.relname
`;

/**
 * Columns of every table in the schema.
 *
 * This reads `pg_catalog` rather than `information_schema` because three of the
 * facts the generator needs are not in the standard views: `typtype`, which is
 * what tells an enum apart from any other user-defined type; `attidentity` and
 * `attgenerated`, which separate an identity column from a stored generated
 * one; and `typelem`, which names what an array column holds.
 */
const COLUMNS_SQL = `
  SELECT
    c.relname                             AS table_name,
    a.attname                             AS name,
    a.attnum                              AS position,
    NOT a.attnotnull                      AS nullable,
    format_type(a.atttypid, a.atttypmod)  AS data_type,
    t.typname                             AS udt_name,
    t.typtype::text                       AS type_category,
    (a.atthasdef OR a.attidentity <> '')  AS has_default,
    (a.attidentity <> '')                 AS is_identity,
    (a.attgenerated <> '')                AS is_stored,
    (pk.attnum IS NOT NULL)               AS primary_key,
    col_description(c.oid, a.attnum)      AS comment,
    (t.typcategory = 'A')                 AS is_array,
    elem.typname                          AS element_udt_name,
    elem.typtype::text                    AS element_type_category,
    base.typname                          AS base_udt_name,
    base.typtype::text                    AS base_type_category
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_catalog.pg_type elem ON elem.oid = t.typelem AND t.typcategory = 'A'
  LEFT JOIN pg_catalog.pg_type base ON base.oid = t.typbasetype AND t.typtype = 'd'
  LEFT JOIN LATERAL (
    SELECT k.attnum
    FROM pg_catalog.pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
    WHERE con.conrelid = c.oid AND con.contype = 'p' AND k.attnum = a.attnum
    LIMIT 1
  ) pk ON true
  WHERE n.nspname = $1
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND c.relpersistence IN ('p', 'u')
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum
`;

/**
 * Foreign keys whose child side lives in the schema.
 *
 * `conkey` and `confkey` are parallel arrays, so the constraint is expanded one
 * subscript at a time and reassembled in order. `generate_subscripts` is used
 * rather than a two-argument `unnest` because it makes the pairing of the two
 * arrays at the same subscript explicit, which is the property the reassembly
 * depends on.
 *
 * The target may sit in another schema, which the generator has not read and
 * therefore cannot point at. Such a key is reported here and declined below.
 */
const FOREIGN_KEYS_SQL = `
  SELECT
    con.conname          AS name,
    child.relname        AS table_name,
    parent_ns.nspname    AS target_schema,
    parent.relname       AS target_table,
    child_att.attname    AS column_name,
    parent_att.attname   AS target_column
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
  JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
  JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  JOIN LATERAL generate_subscripts(con.conkey, 1) AS ord ON true
  JOIN pg_catalog.pg_attribute child_att
    ON child_att.attrelid = child.oid AND child_att.attnum = con.conkey[ord]
  JOIN pg_catalog.pg_attribute parent_att
    ON parent_att.attrelid = parent.oid AND parent_att.attnum = con.confkey[ord]
  WHERE con.contype = 'f'
    AND child_ns.nspname = $1
  ORDER BY child.relname, con.conname, ord
`;

interface TableRow {
  table_name: string;
  comment: string | null;
}

interface ColumnRow {
  table_name: string;
  name: string;
  position: number;
  nullable: boolean;
  data_type: string;
  udt_name: string;
  type_category: string | null;
  has_default: boolean;
  is_identity: boolean;
  is_stored: boolean;
  primary_key: boolean;
  comment: string | null;
  is_array: boolean;
  element_udt_name: string | null;
  element_type_category: string | null;
  base_udt_name: string | null;
  base_type_category: string | null;
}

interface ForeignKeyRow {
  name: string;
  table_name: string;
  target_schema: string;
  target_table: string;
  column_name: string;
  target_column: string;
}

export interface PostgresSchemaReaderOptions extends PoolConfig {
  /** An existing pool to read through. When given, `read` leaves it open. */
  readonly pool?: Pool;
  /** Schema to scaffold. Defaults to `public`. */
  readonly schema?: string;
  /** When given, only these tables are read. Physical names, not entity names. */
  readonly include?: readonly string[];
  /** Tables to leave out, applied after `include`. */
  readonly exclude?: readonly string[];
}

/**
 * Reads a live PostgreSQL schema through its catalogue.
 *
 * An array column is reported with its element type already resolved, so the
 * generator never has to know that PostgreSQL spells an array of `int4` as a
 * type named `_int4`.
 */
export class PostgresSchemaReader implements SchemaReader {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly include: ReadonlySet<string> | null;
  private readonly exclude: ReadonlySet<string>;

  constructor(options: PostgresSchemaReaderOptions = {}) {
    const { pool, schema, include, exclude, ...config } = options;
    this.pool = pool ?? new PgPool(config);
    this.ownsPool = pool === undefined;
    this.schema = schema ?? 'public';
    this.include = include && include.length > 0 ? new Set(include) : null;
    this.exclude = new Set(exclude ?? []);
  }

  async read(): Promise<DatabaseSchema> {
    try {
      const [tables, columns, foreignKeys] = await Promise.all([
        this.query<TableRow>(TABLES_SQL),
        this.query<ColumnRow>(COLUMNS_SQL),
        this.query<ForeignKeyRow>(FOREIGN_KEYS_SQL),
      ]);

      const wanted = tables.filter((table) => this.wanted(table.table_name));
      const names = new Set(wanted.map((table) => table.table_name));

      const columnsByTable = groupBy(
        columns.filter((column) => names.has(column.table_name)),
        (column) => column.table_name,
      );
      // A key pointing out of the scaffolded set has nothing to point at, so it
      // is dropped here rather than surfacing later as an import of a file that
      // was never written. Filtering by table rather than by schema is what
      // makes `--tables` and `--exclude` safe to use on a schema with keys.
      const keysByTable = groupBy(
        collapseForeignKeys(foreignKeys, this.schema).filter(
          (key) => names.has(key.table) && names.has(key.targetTable),
        ),
        (key) => key.table,
      );

      return {
        schema: this.schema,
        tables: wanted.map((table): TableInfo => ({
          schema: this.schema,
          name: table.table_name,
          comment: table.comment,
          columns: (columnsByTable.get(table.table_name) ?? []).map(toColumnInfo),
          foreignKeys: keysByTable.get(table.table_name) ?? [],
        })),
      };
    } finally {
      if (this.ownsPool) await this.pool.end();
    }
  }

  private wanted(table: string): boolean {
    if (this.exclude.has(table)) return false;
    return this.include === null || this.include.has(table);
  }

  private async query<TRow>(text: string): Promise<TRow[]> {
    const result = await this.pool.query({ text, values: [this.schema] });
    return result.rows as TRow[];
  }
}

/**
 * Reassembles the one-row-per-key-column result into one entry per constraint.
 *
 * Rows arrive ordered by constraint and then by subscript, so appending in
 * order is what keeps a composite key's columns paired with the right target
 * columns.
 */
function collapseForeignKeys(rows: readonly ForeignKeyRow[], schema: string): ForeignKeyInfo[] {
  const keys = new Map<string, { info: ForeignKeyInfo; columns: string[]; targets: string[] }>();

  for (const row of rows) {
    if (row.target_schema !== schema) continue;
    const id = `${row.table_name}.${row.name}`;
    let entry = keys.get(id);
    if (!entry) {
      const columns: string[] = [];
      const targets: string[] = [];
      entry = {
        info: {
          name: row.name,
          table: row.table_name,
          columns,
          targetTable: row.target_table,
          targetColumns: targets,
        },
        columns,
        targets,
      };
      keys.set(id, entry);
    }
    entry.columns.push(row.column_name);
    entry.targets.push(row.target_column);
  }

  return [...keys.values()].map((entry) => entry.info);
}

function toColumnInfo(row: ColumnRow): ColumnInfo {
  // Two wrappers are unwrapped here so the generator sees a plain type name.
  //
  // An array reports its element type, so nothing downstream has to know that
  // PostgreSQL names an array of `int4` as `_int4`. A domain reports the type
  // it was built over, since a domain is a constraint on an existing type and
  // reads back as that type's value. The two are not combined: an array of
  // domains keeps the domain name and falls through as unmapped, which says
  // so rather than guessing.
  //
  // `dataType` keeps the printed form, brackets included, which is what a
  // diagnostic about an unmapped column should quote.
  const wrapped = row.is_array
    ? { name: row.element_udt_name, category: row.element_type_category }
    : { name: row.base_udt_name, category: row.base_type_category };

  return {
    name: row.name,
    position: row.position,
    nullable: row.nullable,
    dataType: row.data_type,
    udtName: wrapped.name ?? row.udt_name,
    isArray: row.is_array,
    typeCategory: wrapped.name ? wrapped.category : row.type_category,
    hasDefault: row.has_default,
    isIdentity: row.is_identity,
    isStored: row.is_stored,
    primaryKey: row.primary_key,
    comment: row.comment,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}
