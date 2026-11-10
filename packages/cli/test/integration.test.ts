import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildModel } from '../src/generate/model.js';
import { PostgresSchemaReader } from '../src/schema/postgres.js';
import type { ColumnInfo, DatabaseSchema, TableInfo } from '../src/schema/types.js';

/**
 * These tests need a real PostgreSQL instance. `pnpm test:db:up` starts the one
 * described in `docker-compose.yml`, and CI sets `DATABASE_URL` the same way.
 * Without it the suite is skipped rather than failed, so `pnpm test` stays
 * useful on a machine with no database.
 *
 * Every other test in this package feeds the generator a schema description
 * written by hand, which proves the generator and assumes the reader. This is
 * the one that asks the database, and it is the only place the catalogue
 * queries are ever exercised: a wrong join or a misread flag shows up here or
 * nowhere.
 */
const connectionString = process.env['DATABASE_URL'];
const describeIfDatabase = connectionString ? describe : describe.skip;

const SCHEMA = 'scaffold';

describeIfDatabase('PostgreSQL introspection', () => {
  const pool = new pg.Pool({ connectionString });
  let schema: DatabaseSchema;

  const table = (name: string): TableInfo => {
    const found = schema.tables.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No table ${name} in ${schema.tables.map((t) => t.name)}`);
    return found;
  };

  const column = (tableName: string, name: string): ColumnInfo => {
    const found = table(tableName).columns.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No column ${tableName}.${name}`);
    return found;
  };

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);

    await pool.query(`CREATE TYPE ${SCHEMA}.order_state AS ENUM ('open', 'paid', 'shipped')`);
    await pool.query(`CREATE DOMAIN ${SCHEMA}.email AS text CHECK (VALUE LIKE '%@%')`);

    await pool.query(`
      CREATE TABLE ${SCHEMA}.cities (
        id      integer PRIMARY KEY,
        name    text NOT NULL,
        country text NOT NULL
      )
    `);

    // One table carrying every mapping decision worth checking: an identity, a
    // serial default, a stored generated column, a nullable foreign key, an
    // array, an enum, a domain, and a type with no logical answer at all.
    await pool.query(`
      CREATE TABLE ${SCHEMA}.users (
        id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        legacy_id   serial  NOT NULL,
        name        text    NOT NULL,
        contact     ${SCHEMA}.email NOT NULL,
        age         smallint NOT NULL,
        balance     numeric(10, 2) NOT NULL,
        ratio       double precision NOT NULL,
        big         bigint  NOT NULL,
        token       uuid    NOT NULL,
        is_active   boolean NOT NULL DEFAULT true,
        born_on     date    NOT NULL,
        seen_at     timestamptz NOT NULL,
        settings    jsonb   NOT NULL,
        tags        text[]  NOT NULL,
        scores      integer[] NOT NULL,
        state       ${SCHEMA}.order_state NOT NULL,
        avatar      bytea,
        city_id     integer NULL REFERENCES ${SCHEMA}.cities (id),
        display     text GENERATED ALWAYS AS (name || ' <' || contact || '>') STORED
      )
    `);

    await pool.query(`
      CREATE TABLE ${SCHEMA}.employees (
        id         integer PRIMARY KEY,
        manager_id integer NULL REFERENCES ${SCHEMA}.employees (id)
      )
    `);

    // A composite primary key, and a composite foreign key pointing at it.
    await pool.query(`
      CREATE TABLE ${SCHEMA}.regions (
        country text NOT NULL,
        name    text NOT NULL,
        PRIMARY KEY (country, name)
      )
    `);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.offices (
        id             integer PRIMARY KEY,
        region_country text NOT NULL,
        region_name    text NOT NULL,
        FOREIGN KEY (region_country, region_name)
          REFERENCES ${SCHEMA}.regions (country, name)
      )
    `);

    await pool.query(`CREATE TABLE ${SCHEMA}.audit_log (message text NOT NULL)`);
    await pool.query(`CREATE VIEW ${SCHEMA}.active_users AS SELECT id FROM ${SCHEMA}.users`);

    await pool.query(`COMMENT ON TABLE ${SCHEMA}.users IS 'Customer accounts.'`);
    await pool.query(`COMMENT ON COLUMN ${SCHEMA}.users.name IS 'Display name.'`);

    schema = await new PostgresSchemaReader({ pool, schema: SCHEMA }).read();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('reads the base tables and leaves views out', () => {
    expect(schema.tables.map((t) => t.name).sort()).toEqual([
      'audit_log',
      'cities',
      'employees',
      'offices',
      'regions',
      'users',
    ]);
  });

  it('reads columns in table order', () => {
    expect(table('cities').columns.map((c) => c.name)).toEqual(['id', 'name', 'country']);
  });

  it('reads nullability as the database has it', () => {
    expect(column('users', 'name').nullable).toBe(false);
    expect(column('users', 'city_id').nullable).toBe(true);
  });

  it('reads the primary key, composite included', () => {
    expect(
      table('users')
        .columns.filter((c) => c.primaryKey)
        .map((c) => c.name),
    ).toEqual(['id']);
    expect(
      table('regions')
        .columns.filter((c) => c.primaryKey)
        .map((c) => c.name),
    ).toEqual(['country', 'name']);
    expect(table('audit_log').columns.some((c) => c.primaryKey)).toBe(false);
  });

  it('tells an identity, a serial and a stored generated column apart', () => {
    expect(column('users', 'id')).toMatchObject({ isIdentity: true, hasDefault: true });
    // A serial is a default rather than an identity, and both are values the
    // database produces, which is the only distinction `generated` needs.
    expect(column('users', 'legacy_id')).toMatchObject({ isIdentity: false, hasDefault: true });
    expect(column('users', 'display')).toMatchObject({ isStored: true });
    expect(column('users', 'name')).toMatchObject({
      isIdentity: false,
      hasDefault: false,
      isStored: false,
    });
  });

  it('unwraps an array to its element type', () => {
    expect(column('users', 'tags')).toMatchObject({ isArray: true, udtName: 'text' });
    expect(column('users', 'scores')).toMatchObject({ isArray: true, udtName: 'int4' });
    expect(column('users', 'name').isArray).toBe(false);
  });

  it('unwraps a domain to the type it was built over', () => {
    expect(column('users', 'contact')).toMatchObject({ udtName: 'text', typeCategory: 'b' });
  });

  it('reports an enum by its category, not by a name it could not know', () => {
    expect(column('users', 'state')).toMatchObject({ udtName: 'order_state', typeCategory: 'e' });
  });

  it('reads table and column comments', () => {
    expect(table('users').comment).toBe('Customer accounts.');
    expect(column('users', 'name').comment).toBe('Display name.');
    expect(column('users', 'age').comment).toBeNull();
  });

  it('reads a single-column foreign key', () => {
    expect(table('users').foreignKeys).toEqual([
      expect.objectContaining({
        table: 'users',
        columns: ['city_id'],
        targetTable: 'cities',
        targetColumns: ['id'],
      }),
    ]);
  });

  it('keeps a composite foreign key in the order its columns were declared', () => {
    expect(table('offices').foreignKeys).toEqual([
      expect.objectContaining({
        columns: ['region_country', 'region_name'],
        targetTable: 'regions',
        targetColumns: ['country', 'name'],
      }),
    ]);
  });

  it('reads a table that points at itself', () => {
    expect(table('employees').foreignKeys).toEqual([
      expect.objectContaining({ table: 'employees', targetTable: 'employees' }),
    ]);
  });

  it('honours the table filters', async () => {
    const only = await new PostgresSchemaReader({
      pool,
      schema: SCHEMA,
      include: ['users', 'cities'],
      exclude: ['cities'],
    }).read();

    expect(only.tables.map((t) => t.name)).toEqual(['users']);
    // The key now points outside the scaffolded set, so it is dropped rather
    // than left pointing at a file that will not be written.
    expect(only.tables[0]?.foreignKeys).toEqual([]);
  });

  it('maps the whole schema into a model with only the expected refusals', () => {
    const model = buildModel(schema);

    expect(model.entities.map((e) => e.name).sort()).toEqual([
      'AuditLog',
      'City',
      'Employee',
      'Office',
      'Region',
      'User',
    ]);

    const user = model.entities.find((e) => e.name === 'User');
    expect(user?.columns.find((c) => c.property === 'age')).toMatchObject({ type: 'int' });
    expect(user?.columns.find((c) => c.property === 'big')).toMatchObject({ type: 'bigint' });
    expect(user?.columns.find((c) => c.property === 'balance')).toMatchObject({ type: 'decimal' });
    expect(user?.columns.find((c) => c.property === 'ratio')).toMatchObject({ type: 'float' });
    expect(user?.columns.find((c) => c.property === 'settings')).toMatchObject({ type: 'json' });
    expect(user?.columns.find((c) => c.property === 'seenAt')).toMatchObject({ type: 'timestamp' });
    expect(user?.columns.find((c) => c.property === 'bornOn')).toMatchObject({ type: 'date' });
    expect(user?.columns.find((c) => c.property === 'token')).toMatchObject({ type: 'uuid' });
    expect(user?.columns.find((c) => c.property === 'contact')).toMatchObject({ type: 'text' });
    expect(user?.columns.find((c) => c.property === 'state')).toMatchObject({ type: 'text' });
    expect(user?.columns.find((c) => c.property === 'tags')).toMatchObject({
      type: 'array',
      of: 'text',
    });
    expect(user?.columns.find((c) => c.property === 'legacyId')).toMatchObject({ generated: true });
    expect(user?.columns.find((c) => c.property === 'display')).toMatchObject({ generated: true });

    // `bytea` has no logical type, so the column is left out and said so.
    expect(user?.columns.some((c) => c.property === 'avatar')).toBe(false);

    expect(user?.relations).toEqual([
      expect.objectContaining({ kind: 'reference', property: 'city', optional: true }),
    ]);
    expect(model.entities.find((e) => e.name === 'City')?.relations).toEqual([
      expect.objectContaining({ kind: 'collection', property: 'users', from: 'cityId' }),
    ]);

    expect([...model.warnings].sort()).toEqual([
      expect.stringContaining('audit_log: no primary key'),
      expect.stringContaining('offices: foreign key'),
      expect.stringContaining('users.avatar'),
    ]);
  });
});
