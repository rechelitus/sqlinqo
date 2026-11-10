import { describe, expect, it } from 'vitest';
import { createDbContext, defineEntity, InvalidQueryError } from '../src/index.js';
import { City, FakeDriver, Order, testDialect, User } from './support.js';

function context(rows: Record<string, unknown>[] = []) {
  const driver = new FakeDriver(rows);
  const db = createDbContext({
    driver,
    dialect: testDialect,
    entities: { users: User, orders: Order, cities: City },
  });
  return { db, driver };
}

const ada = {
  name: 'Ada',
  email: 'ada@example.com',
  age: 36,
  isActive: true,
  createdAt: new Date(0),
};

describe('insert', () => {
  it('writes the columns it was given, under their physical names', async () => {
    const { db, driver } = context([{ id: 9 }]);

    await db.users.insert(ada);

    expect(driver.lastStatement.text).toContain(
      'INSERT INTO "users" ("name", "email", "age", "is_active", "created_at")',
    );
  });

  it('leaves a generated column out of the statement', async () => {
    const { db, driver } = context([{ id: 9 }]);

    await db.users.insert(ada);

    // `id` is the database's to produce, so naming it would be writing over the
    // sequence rather than using it.
    expect(driver.lastStatement.text).not.toContain('("id"');
  });

  it('reads every column back, not only the generated ones', async () => {
    const { db, driver } = context([{ id: 9 }]);

    await db.users.insert(ada);

    // A column default and a trigger are as invisible to the caller as a
    // sequence is, and the statement is already reading something.
    expect(driver.lastStatement.text).toContain(
      'RETURNING "id" AS "id", "name" AS "name", "email" AS "email", "age" AS "age", ' +
        '"city_id" AS "cityId", "is_active" AS "isActive", "created_at" AS "createdAt"',
    );
  });

  it('hands back the row the database answered with', async () => {
    const { db } = context([{ id: 9, name: 'Ada', age: 36 }]);

    const row = await db.users.insert(ada);

    // Read from the statement rather than assembled from the argument, which is
    // what makes the generated key visible.
    expect(row.id).toBe(9);
  });

  it('binds the values rather than inlining them', async () => {
    const { db, driver } = context([{ id: 9 }]);

    await db.users.insert(ada);

    expect(driver.lastStatement.values).toEqual(['Ada', 'ada@example.com', 36, new Date(0)]);
  });

  it('qualifies a table with its schema', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.orders.insert({ id: 1, userId: 2, total: '5' });

    expect(driver.lastStatement.text).toContain('INSERT INTO "sales"."orders"');
  });

  it('faults when the statement read nothing back', async () => {
    const { db } = context([]);

    await expect(db.users.insert(ada)).rejects.toThrow(/read none back/);
  });
});

describe('insertMany', () => {
  it('writes several rows in one statement', async () => {
    const { db, driver } = context([{ id: 1 }, { id: 2 }]);

    await db.users.insertMany([
      ada,
      {
        name: 'Grace',
        email: 'grace@example.com',
        age: 45,
        isActive: true,
        createdAt: new Date(1),
      },
    ]);

    expect(driver.statements).toHaveLength(1);
    expect(driver.lastStatement.text).toContain(
      'VALUES ($1, $2, $3, TRUE, $4), ($5, $6, $7, TRUE, $8)',
    );
  });

  it('binds a value once however many rows carry it', async () => {
    const { db, driver } = context([{ id: 1 }, { id: 2 }]);

    await db.users.insertMany([ada, { ...ada, name: 'Grace' }]);

    // The printer shares a placeholder between equal values wherever the
    // dialect numbers them, so the email and age both rows agree on are bound
    // once. The two dates are equal and are still separate objects, so they are
    // not the same value and are bound twice, which is the sharing being about
    // identity rather than about equality.
    expect(driver.lastStatement.text).toContain(
      'VALUES ($1, $2, $3, TRUE, $4), ($5, $2, $3, TRUE, $6)',
    );
    expect(driver.lastStatement.values).toEqual([
      'Ada',
      'ada@example.com',
      36,
      new Date(0),
      'Grace',
      new Date(0),
    ]);
  });

  it('takes the union of the columns the rows named', async () => {
    const { db, driver } = context([{ id: 1 }, { id: 2 }]);

    await db.users.insertMany([ada, { ...ada, cityId: 3 }]);

    // One statement has one column list, so a column only the second row named
    // is written as null in the first.
    expect(driver.lastStatement.text).toContain('"city_id"');
    expect(driver.lastStatement.text).toContain('VALUES ($1, $2, $3, NULL,');
  });

  it('orders the columns as the entity declares them, not as a row lists them', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.users.insertMany([
      { createdAt: new Date(0), age: 36, isActive: true, email: 'a', name: 'Ada' },
    ]);

    expect(driver.lastStatement.text).toContain(
      '("name", "email", "age", "is_active", "created_at")',
    );
  });

  it('issues no statement for an empty list', async () => {
    const { db, driver } = context([]);

    const rows = await db.users.insertMany([]);

    // `VALUES` with no rows is not a statement any database accepts, and the
    // answer is already known.
    expect(rows).toEqual([]);
    expect(driver.statements).toHaveLength(0);
  });

  it('hands back every row the statement answered with', async () => {
    const { db } = context([{ id: 1 }, { id: 2 }]);

    const rows = await db.users.insertMany([ada, { ...ada, name: 'Grace' }]);

    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it('refuses a property the entity does not declare', async () => {
    const { db } = context([{ id: 1 }]);

    await expect(
      db.users.insertMany([{ ...ada, nickname: 'A' } as unknown as typeof ada]),
    ).rejects.toThrow(InvalidQueryError);
    await expect(
      db.users.insertMany([{ ...ada, nickname: 'A' } as unknown as typeof ada]),
    ).rejects.toThrow(/"nickname" is not a column of entity "User"/);
  });

  it('refuses rows that name no column at all', async () => {
    const { db } = context([{ id: 1 }]);

    await expect(db.users.insertMany([{} as unknown as typeof ada])).rejects.toThrow(
      /name no column of entity "User"/,
    );
  });

  it('logs the statement as a read would be logged', async () => {
    const driver = new FakeDriver([{ id: 1 }]);
    const logged: string[] = [];
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User },
      logger: (statement) => logged.push(statement.text),
    });

    await db.users.insert(ada);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('INSERT INTO "users"');
  });
});

describe('insertFrom', () => {
  it('writes an INSERT ... SELECT rather than a VALUES list', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.cities.insertFrom(
      db.users
        .where((u) => !u.isActive)
        .select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    expect(driver.lastStatement.text).toBe(
      'INSERT INTO "cities" ("id", "name", "country") ' +
        'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "country" ' +
        'FROM "users" AS "t0" WHERE NOT "t0"."is_active" ' +
        'RETURNING "id" AS "id", "name" AS "name", "country" AS "country"',
    );
  });

  it('puts the projection in the order the column list names, not the order it was written', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.cities.insertFrom(
      db.users.select((u) => ({ country: u.email, id: u.id, name: u.name })),
    );

    // `INSERT ... SELECT` lines the two up by position and ignores the aliases,
    // so a projection left in the order it was written would put every email in
    // the "id" column and no error would be raised.
    expect(driver.lastStatement.text).toContain('("id", "name", "country") SELECT "t0"."id"');
  });

  it('reorders every branch of a set operation, not only the outer projection', async () => {
    const { db, driver } = context([{ id: 1 }]);
    const branch = () => db.users.select((u) => ({ country: u.email, id: u.id, name: u.name }));

    await db.cities.insertFrom(branch().union(branch()));

    // A `UNION` pairs its branches by position for the same reason
    // `INSERT ... SELECT` pairs the column list with the projection. Each
    // branch was aligned against the projection in the order it was written, so
    // reordering the outer columns and stopping there would leave the second
    // branch a permutation behind — and where the swapped columns share a type
    // the database would accept it and write the rows crooked.
    expect(driver.lastStatement.text).toBe(
      'INSERT INTO "cities" ("id", "name", "country") ' +
        'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "country" ' +
        'FROM "users" AS "t0" UNION ' +
        'SELECT "t1"."id" AS "id", "t1"."name" AS "name", "t1"."email" AS "country" ' +
        'FROM "users" AS "t1" ' +
        'RETURNING "id" AS "id", "name" AS "name", "country" AS "country"',
    );
  });

  it('reorders the branches of a mixed set operation, across the derived table one becomes', async () => {
    const { db, driver } = context([{ id: 1 }]);
    const branch = () => db.users.select((u) => ({ country: u.email, id: u.id, name: u.name }));

    await db.cities.insertFrom(branch().concat(branch()).intersect(branch()));

    // `INTERSECT` binds tighter than `UNION ALL`, so the first pair becomes a
    // derived table and only what reads out of it is a branch here. Both of the
    // branches that remain project the column list's order.
    expect(driver.lastStatement.text).toContain(
      'SELECT "t2"."id" AS "id", "t2"."name" AS "name", "t2"."country" AS "country"',
    );
    expect(driver.lastStatement.text).toContain(
      'INTERSECT SELECT "t3"."id" AS "id", "t3"."name" AS "name", "t3"."email" AS "country"',
    );
  });

  it("carries the query's own bound values through", async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.cities.insertFrom(
      db.users
        .where((u, p) => u.age >= p.min, { min: 18 })
        .select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    expect(driver.lastStatement.text).toContain('WHERE "t0"."age" >= $1');
    expect(driver.lastStatement.values).toEqual([18]);
  });

  it('reads the rows back the way a VALUES insert does', async () => {
    const { db } = context([
      { id: 1, name: 'Ada', country: 'GB' },
      { id: 2, name: 'Grace', country: 'US' },
    ]);

    const rows = await db.cities.insertFrom(
      db.users.select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('issues its statement even when the query may match nothing', async () => {
    const { db, driver } = context([]);

    const rows = await db.cities.insertFrom(
      db.users
        .where((u) => u.age > 200)
        .select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    // Unlike `insertMany([])`, whether there is anything to write is the
    // database's to answer rather than something known before asking.
    expect(rows).toEqual([]);
    expect(driver.statements).toHaveLength(1);
  });

  it('takes a query that is more than a filter, unlike update and delete', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.cities.insertFrom(
      db.users
        .orderBy((u) => u.name)
        .take(5)
        .select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    // Nothing here has to work out which rows in one table a statement is
    // about, which is the whole of what an update and a delete refuse a
    // projection, an ordering, and a page for.
    expect(driver.lastStatement.text).toContain('ORDER BY "t0"."name" ASC LIMIT 5');
  });

  it('reads a tag at the top of the statement rather than from inside the query', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.cities.insertFrom(
      db.users.tag('archive').select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    // The tag was written on the query and the statement the caller sees is
    // this one, so it is lifted out of the SELECT it would otherwise sit in the
    // middle of, exactly as an UPDATE's is.
    expect(driver.lastStatement.text).toMatch(/^\/\* archive \*\/ INSERT INTO "cities"/);
  });

  it('qualifies a table with its schema', async () => {
    const { db, driver } = context([{ id: 1 }]);

    await db.orders.insertFrom(
      db.users.select((u) => ({ id: u.id, userId: u.id, total: u.email })),
    );

    expect(driver.lastStatement.text).toContain('INSERT INTO "sales"."orders"');
  });

  it('refuses a projection naming something the entity does not declare', async () => {
    const { db } = context([{ id: 1 }]);

    await expect(
      db.cities.insertFrom(
        db.users.select((u) => ({ id: u.id, name: u.name, country: u.email, nickname: u.name })),
      ),
    ).rejects.toThrow(/"nickname" is not a column of entity "City"/);
  });

  it('refuses a query projecting one unnamed value', async () => {
    const { db } = context([{ id: 1 }]);

    // A value with no name cannot say which column it fills. TypeScript refuses
    // this too; the cast is what lets the runtime message be pinned.
    await expect(db.cities.insertFrom(db.users.select((u) => u.name) as never)).rejects.toThrow(
      /one unnamed value/,
    );
  });

  it('refuses a query projecting a nested row', async () => {
    const { db } = context([{ id: 1 }]);

    await expect(
      db.cities.insertFrom(
        db.users.select((u) => ({ id: u.id, name: u.name, country: u })) as never,
      ),
    ).rejects.toThrow(/a column holds one value rather than a row/);
  });

  it('refuses a query from another context', async () => {
    const { db } = context([{ id: 1 }]);
    const other = context([{ id: 1 }]);

    await expect(
      db.cities.insertFrom(
        other.db.users.select((u) => ({ id: u.id, name: u.name, country: u.email })),
      ),
    ).rejects.toThrow(/must come from the same context/);
  });

  it('logs the statement as a read would be logged', async () => {
    const driver = new FakeDriver([{ id: 1 }]);
    const logged: string[] = [];
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, cities: City },
      logger: (statement) => logged.push(statement.text),
    });

    await db.cities.insertFrom(
      db.users.select((u) => ({ id: u.id, name: u.name, country: u.email })),
    );

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('INSERT INTO "cities"');
  });
});

describe('upsert', () => {
  it('writes an ON CONFLICT clause on the primary key, updating every other column', async () => {
    const { db, driver } = context([{ id: 1, userId: 2, total: '5' }]);

    await db.orders.upsert({ id: 1, userId: 2, total: '5' });

    expect(driver.lastStatement.text).toBe(
      'INSERT INTO "sales"."orders" ("id", "user_id", "total") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("id") DO UPDATE SET "user_id" = EXCLUDED."user_id", "total" = EXCLUDED."total" ' +
        'RETURNING "id" AS "id", "user_id" AS "userId", "total" AS "total"',
    );
  });

  it('hands back the row the database ended up with', async () => {
    const { db } = context([{ id: 1, userId: 2, total: '5' }]);

    const row = await db.orders.upsert({ id: 1, userId: 2, total: '5' });

    expect(row).toEqual({ id: 1, userId: 2, total: '5' });
  });

  it('binds the values rather than inlining them', async () => {
    const { db, driver } = context([{ id: 1, userId: 2, total: '5' }]);

    await db.orders.upsert({ id: 1, userId: 2, total: '5' });

    expect(driver.lastStatement.values).toEqual([1, 2, '5']);
  });

  it('rejects an entity with no declared primary key', async () => {
    const NoKey = defineEntity({
      name: 'NoKey',
      columns: { id: { type: 'int' }, name: { type: 'text' } },
    });
    const db = createDbContext({
      driver: new FakeDriver([{ id: 1 }]),
      dialect: testDialect,
      entities: { noKeys: NoKey },
    });

    await expect(db.noKeys.upsert({ id: 1, name: 'x' })).rejects.toThrow(
      /"upsert" needs entity "NoKey" to declare a primary key/,
    );
  });

  it('rejects a row that names only the primary key, with nothing left to update', async () => {
    const { db } = context([{ id: 1 }]);

    await expect(db.orders.upsert({ id: 1 } as never)).rejects.toThrow(
      /nothing left to update on a conflict/,
    );
  });

  it('faults when the statement read nothing back', async () => {
    const { db } = context([]);

    await expect(db.orders.upsert({ id: 1, userId: 2, total: '5' })).rejects.toThrow(
      /read none back/,
    );
  });
});

describe('upsertMany', () => {
  it('writes several rows in one statement', async () => {
    const { db, driver } = context([
      { id: 1, userId: 2, total: '5' },
      { id: 2, userId: 3, total: '9' },
    ]);

    await db.orders.upsertMany([
      { id: 1, userId: 2, total: '5' },
      { id: 2, userId: 3, total: '9' },
    ]);

    expect(driver.statements).toHaveLength(1);
    expect(driver.lastStatement.text).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "user_id" = EXCLUDED."user_id", "total" = EXCLUDED."total"',
    );
  });

  it('issues no statement for an empty list', async () => {
    const { db, driver } = context([]);

    const rows = await db.orders.upsertMany([]);

    expect(rows).toEqual([]);
    expect(driver.statements).toHaveLength(0);
  });

  it('hands back every row the statement answered with', async () => {
    const { db } = context([
      { id: 1, userId: 2, total: '5' },
      { id: 2, userId: 3, total: '9' },
    ]);

    const rows = await db.orders.upsertMany([
      { id: 1, userId: 2, total: '5' },
      { id: 2, userId: 3, total: '9' },
    ]);

    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });
});
