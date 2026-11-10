/**
 * The shape a schema reader produces, and the only thing the generator sees.
 *
 * It is deliberately a plain description of what is in the database rather than
 * anything resembling an entity: every decision about naming, logical types and
 * navigations happens in the generator, so a second reader for another database
 * has one small contract to satisfy and no code generation to reimplement.
 */

/** One column of one table, as the database describes it. */
export interface ColumnInfo {
  /** Physical column name, exactly as stored. */
  readonly name: string;
  /** Position in the table, used to keep generated output in table order. */
  readonly position: number;
  readonly nullable: boolean;
  /** `information_schema.columns.data_type`, such as `integer` or `ARRAY`. */
  readonly dataType: string;
  /**
   * The type's own name, with any array wrapper already unwrapped: a `text[]`
   * column reports `text` here and sets `isArray`. Resolving it in the reader
   * keeps the knowledge that PostgreSQL spells that type `_text` out of the
   * generator, where it would not hold for another database.
   */
  readonly udtName: string;
  /** True when the column holds many values of `udtName` rather than one. */
  readonly isArray: boolean;
  /**
   * `pg_type.typtype` for the column's type: `b` base, `e` enum, `d` domain,
   * `c` composite. Enums are the reason this is carried: they arrive as
   * arbitrary type names and are still read back as strings.
   */
  readonly typeCategory: string | null;
  /** True for an identity column, a serial, or any column with a default. */
  readonly hasDefault: boolean;
  readonly isIdentity: boolean;
  /** True for `GENERATED ALWAYS AS (...) STORED`, which is never writable. */
  readonly isStored: boolean;
  readonly primaryKey: boolean;
  /** `COMMENT ON COLUMN`, carried into the generated code as a doc comment. */
  readonly comment: string | null;
}

/**
 * One foreign key constraint.
 *
 * The columns are arrays because PostgreSQL allows composite keys. The
 * generator refuses those rather than guessing, since `reference` names a
 * single property, but the reader reports them faithfully so the refusal can
 * say which constraint it declined and why.
 */
export interface ForeignKeyInfo {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  /** `COMMENT ON TABLE`, carried into the generated code as a doc comment. */
  readonly comment: string | null;
  readonly columns: readonly ColumnInfo[];
  /** Constraints where this table holds the key, so it is the child side. */
  readonly foreignKeys: readonly ForeignKeyInfo[];
}

export interface DatabaseSchema {
  readonly schema: string;
  readonly tables: readonly TableInfo[];
}

/**
 * Reads a database's tables, columns and foreign keys.
 *
 * Only the PostgreSQL reader exists today. The interface is what a reader for
 * another database, or one that parses a DDL file offline, would implement.
 */
export interface SchemaReader {
  read(): Promise<DatabaseSchema>;
}
