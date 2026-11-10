import { defineEntity, UnsupportedExpressionError } from '@sqlinqo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MssqlDriver } from '../src/index.js';
import { createMssqlContext } from '../src/index.js';

/**
 * These tests need a real SQL Server instance. `pnpm test:db:up` starts the
 * one described in `docker-compose.yml`. CI does not yet run this suite (see
 * the package README). Without `MSSQL_DATABASE_URL` the suite is skipped
 * rather than failed, so `pnpm test` stays useful on a machine with no
 * database, exactly as the PostgreSQL suite does with `DATABASE_URL`.
 *
 * The scope here is deliberately narrower than the PostgreSQL integration
 * suite. The query plan, the compiler, and the operators above the dialect
 * are shared code already proven there; what is specific to this provider is
 * the dialect's T-SQL translations and the driver's own execution against a
 * real server, which is what this file exercises.
 */
const connectionString =
  'Server=localhost;Database=sqlinqo;Integrated Security=False;User Id=sa;Password=prac!4;TrustServerCertificate=True;'; //process.env['MSSQL_DATABASE_URL'];
const describeIfDatabase = connectionString ? describe : describe.skip;

const Person = defineEntity({
  name: 'Person',
  table: 'people',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    age: { type: 'int' },
    city: { type: 'text', nullable: true },
    joinedAt: { type: 'timestamp', column: 'joined_at' },
  },
});

const Writable = defineEntity({
  name: 'Writable',
  table: 'writable',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    label: { type: 'text' },
  },
});

describeIfDatabase('SQL Server integration', () => {
  const db = createMssqlContext({
    connectionString,
    options: { trustServerCertificate: true },
    entities: { people: Person, writable: Writable },
  });

  beforeAll(async () => {
    const pool = (db.$driver as MssqlDriver).connectionPool;
    await pool.connect();
    await pool.request().query(`
      IF OBJECT_ID('writable', 'U') IS NOT NULL DROP TABLE writable;
      IF OBJECT_ID('people', 'U') IS NOT NULL DROP TABLE people;

      CREATE TABLE people (
        id int PRIMARY KEY,
        name nvarchar(200) NOT NULL,
        age int NOT NULL,
        city nvarchar(200) NULL,
        joined_at datetime2 NOT NULL
      );

      CREATE TABLE writable (
        id int IDENTITY PRIMARY KEY,
        label nvarchar(200) NOT NULL
      );

      -- The fractional seconds are what getSeconds and getMilliseconds are
      -- tested against: a whole second and one with milliseconds, since
      -- DATEPART(millisecond, x) carries the fraction and DATEPART(second, x)
      -- does not.
      INSERT INTO people (id, name, age, city, joined_at) VALUES
        (1, 'Ada',   36, 'London',    '2024-01-15T09:00:00.000'),
        (2, 'Grace', 45, 'Arlington', '2024-03-02T23:45:59.750'),
        (3, 'Alan',  41, NULL,        '2024-06-20T00:00:00.000');
    `);
  });

  afterAll(async () => {
    await db.$close();
  });

  it('filters and orders through a real connection', async () => {
    const rows = await db.people
      .where((p, args) => p.age > args.min, { min: 40 })
      .orderBy((p) => p.name)
      .toArray();

    expect(rows.map((p) => p.name)).toEqual(['Alan', 'Grace']);
  });

  it('pages with OFFSET and FETCH NEXT, which needs the ORDER BY this query supplies', async () => {
    const page = await db.people
      .orderBy((p) => p.id)
      .skip(1)
      .take(1)
      .toArray();

    expect(page.map((p) => p.id)).toEqual([2]);
  });

  it('refuses to page without an ordering, at the database rather than in this library', async () => {
    // formatPaging emits OFFSET with no ORDER BY ahead of it when the query
    // supplies none, and SQL Server refuses that statement outright rather
    // than running it unordered.
    await expect(db.people.skip(1).take(1).toArray()).rejects.toThrow();
  });

  it('reads date parts through DATEPART', async () => {
    const [ada] = await db.people
      .where((p) => p.id === 1)
      .select((p) => ({
        year: p.joinedAt.getFullYear(),
        month: p.joinedAt.getMonth(),
        day: p.joinedAt.getDay(),
        hours: p.joinedAt.getHours(),
      }))
      .toArray();

    // 15 January 2024 was a Monday, so getDay() reads 1 exactly as JavaScript
    // numbers it, independently of the server's @@DATEFIRST setting.
    expect(ada).toEqual({ year: 2024, month: 0, day: 1, hours: 9 });
  });

  it('floors nothing off getSeconds and reads the fraction through getMilliseconds', async () => {
    const [grace] = await db.people
      .where((p) => p.id === 2)
      .select((p) => ({ s: p.joinedAt.getSeconds(), ms: p.joinedAt.getMilliseconds() }))
      .toArray();

    expect(grace).toEqual({ s: 59, ms: 750 });
  });

  it('renders toISOString in JavaScript-shaped ISO 8601 text', async () => {
    const [ada] = await db.people
      .where((p) => p.id === 1)
      .select((p) => ({ iso: p.joinedAt.toISOString() }))
      .toArray();

    expect(ada!.iso).toBe('2024-01-15T09:00:00.000Z');
  });

  it('searches case-insensitively, under the database collation rather than JavaScript equality', async () => {
    // "Alan" holds one lowercase 'a' (index 2) and one uppercase 'A' (index 0).
    // JavaScript's own case-sensitive indexOf and lastIndexOf both land on 2,
    // the only lowercase 'a'; CHARINDEX runs under the column's collation,
    // which is case-insensitive by default, so it matches the capital letter
    // too and indexOf lands on 0 instead. This is the same divergence
    // `localeCompare` already documents for ordering, arriving here for search.
    const [alan] = await db.people
      .where((p) => p.id === 3)
      .select((p) => ({ first: p.name.indexOf('a'), last: p.name.lastIndexOf('a') }))
      .toArray();

    expect(alan).toEqual({ first: 0, last: 2 });
  });

  it('pads through REPLICATE without truncating a string already at width', async () => {
    const [ada] = await db.people
      .where((p) => p.id === 1)
      .select((p) => ({ padded: p.name.padStart(10, '*') }))
      .toArray();

    expect(ada!.padded).toBe('*******Ada');
  });

  it('rounds a number to a fixed number of digits through FORMAT', async () => {
    const [ada] = await db.people
      .where((p) => p.id === 1)
      .select((p) => ({ fixed: p.age.toFixed(2) }))
      .toArray();

    expect(ada!.fixed).toBe('36.00');
  });

  it('rolls back a transaction that throws, seeding through the raw driver since writes are refused', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.$driver.execute({
          text: 'INSERT INTO writable (label) VALUES (@p0)',
          values: ['should not survive'],
        });
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    expect(await db.writable.toArray()).toEqual([]);
  });

  it('commits a transaction that returns normally', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({
        text: 'INSERT INTO writable (label) VALUES (@p0)',
        values: ['kept'],
      });
    });

    const rows = await db.writable.toArray();
    expect(rows.map((r) => r.label)).toEqual(['kept']);
  });

  it('refuses insert at print time, since OUTPUT has no RETURNING-shaped position here', async () => {
    await expect(db.writable.insert({ label: 'x' })).rejects.toThrow(UnsupportedExpressionError);
    expect(await db.writable.where((w) => w.label === 'x').toArray()).toEqual([]);
  });
});
