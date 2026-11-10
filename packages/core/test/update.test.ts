import { describe, expect, it } from 'vitest';
import { createDbContext } from '../src/index.js';
import { City, FakeDriver, Order, testDialect, User } from './support.js';

function context(rows: Record<string, unknown>[] = [{ id: 1 }]) {
  const driver = new FakeDriver(rows);
  const db = createDbContext({
    driver,
    dialect: testDialect,
    entities: { users: User, orders: Order, cities: City },
  });
  return { db, driver };
}

describe('update', () => {
  it('sets the columns it was given on the rows the filter selects', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.age > 18).update({ isActive: true, name: 'Ada' });

    expect(driver.lastStatement.text).toContain(
      'UPDATE "users" AS "t0" SET "is_active" = TRUE, "name" = $1 WHERE "t0"."age" > $2',
    );
    expect(driver.lastStatement.values).toEqual(['Ada', 18]);
  });

  it('names the assigned column bare and the filtered one through the alias', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.age > 18).update({ name: 'Ada' });

    // SQL names the column being assigned without the alias, since there is
    // only one table it could belong to, and PostgreSQL rejects the qualified
    // form. The predicate is qualified because a query's columns always are.
    expect(driver.lastStatement.text).toContain('SET "name" = $1');
    expect(driver.lastStatement.text).toContain('WHERE "t0"."age" > $2');
  });

  it('numbers the assignments before the predicate', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.age > 18).update({ name: 'Ada' });

    // They are printed in that order, so the values line up with them.
    expect(driver.lastStatement.values).toEqual(['Ada', 18]);
  });

  it('reads every column back', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.id === 1).update({ name: 'Ada' });

    // A trigger and a computed column are as invisible as the assignment is
    // visible, which is the reason an insert returns everything too.
    expect(driver.lastStatement.text).toContain(
      'RETURNING "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email"',
    );
  });

  it('hands back the rows the statement answered with', async () => {
    const { db } = context([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Ada' },
    ]);

    const rows = await db.users.where((u) => u.age > 18).update({ name: 'Ada' });

    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it('updates every row when the query has no filter', async () => {
    const { db, driver } = context();

    await db.users.update({ isActive: false });

    // A thing SQL can do and a thing this does. It is a sentence that means
    // what it says rather than a mistake the library catches.
    expect(driver.lastStatement.text).toContain('UPDATE "users" AS "t0" SET "is_active" = FALSE');
    expect(driver.lastStatement.text).not.toContain('WHERE');
  });

  it('qualifies a table with its schema', async () => {
    const { db, driver } = context();

    await db.orders.where((o) => o.id === 1).update({ total: '5' });

    expect(driver.lastStatement.text).toContain('UPDATE "sales"."orders" AS "t0"');
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

    await db.users.update({ name: 'Ada' });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('UPDATE "users"');
  });
});

describe('update with a relative lambda', () => {
  it('reads the row through its own alias, on the right of its own assignment', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.age > 18).update((u) => ({ age: u.age + 1 }));

    expect(driver.lastStatement.text).toBe(
      'UPDATE "users" AS "t0" SET "age" = "t0"."age" + $1 WHERE "t0"."age" > $2 ' +
        'RETURNING "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email", ' +
        '"t0"."age" AS "age", "t0"."city_id" AS "cityId", "t0"."is_active" AS "isActive", ' +
        '"t0"."created_at" AS "createdAt"',
    );
    expect(driver.lastStatement.values).toEqual([1, 18]);
  });

  it('binds a value from the params object the same way select does', async () => {
    const { db, driver } = context();

    await db.users
      .where((u) => u.age > 18)
      .update((u, p) => ({ age: u.age + p.amount }), { amount: 5 });

    expect(driver.lastStatement.text).toContain('SET "age" = "t0"."age" + $1');
    expect(driver.lastStatement.values).toEqual([5, 18]);
  });

  it('sets more than one column in the same statement', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.isActive).update((u) => ({ age: u.age + 1, name: u.name }));

    expect(driver.lastStatement.text).toContain(
      'SET "age" = "t0"."age" + $1, "name" = "t0"."name"',
    );
  });

  it('refuses a lambda that returns anything but an object literal', async () => {
    const { db } = context();

    await expect(db.users.where((u) => u.age > 18).update((u) => u.age as never)).rejects.toThrow(
      /"update" needs an object literal from its lambda/,
    );
  });

  it('refuses a property the entity does not declare', async () => {
    const { db } = context();

    await expect(
      db.users.where((u) => u.age > 18).update((u) => ({ nickname: u.age }) as never),
    ).rejects.toThrow(/"nickname" is not a column of entity "User"/);
  });

  it('refuses a lambda whose object literal sets nothing', async () => {
    const { db } = context();

    await expect(db.users.where((u) => u.age > 18).update((_u) => ({}))).rejects.toThrow(
      /"update" was given no columns to set/,
    );
  });

  it('refuses a navigation, since there is no join for a bare UPDATE to hold one against', async () => {
    const { db } = context();

    await expect(
      db.orders
        .where((o) => o.id === 1)
        .update(
          (o) => ({ total: (o as unknown as { user: { name: string } }).user.name }) as never,
        ),
    ).rejects.toThrow(/The reference "user" cannot be followed here/);
  });
});

describe('update refusals', () => {
  it('refuses a projection, which leaves no table to write to', async () => {
    const { db } = context();

    // A projection over a bare source changes only the column list, which an
    // UPDATE never had, so the compiled statement looks fine and the plan is
    // what gives it away.
    await expect(
      db.users.select((u) => ({ name: u.name })).update({ name: 'Ada' }),
    ).rejects.toThrow(/this query has a projection/);
  });

  it('refuses an ordering', async () => {
    const { db } = context();

    await expect(db.users.orderBy((u) => u.id).update({ name: 'Ada' })).rejects.toThrow(
      /this query has an ordering/,
    );
  });

  it('refuses a page', async () => {
    const { db } = context();

    await expect(db.users.take(1).update({ name: 'Ada' })).rejects.toThrow(/this query has a page/);
  });

  it('refuses a set operation', async () => {
    const { db } = context();

    await expect(db.users.union(db.users).update({ name: 'Ada' })).rejects.toThrow(
      /this query has a set operation/,
    );
  });

  it('refuses a where with a position, naming it rather than falling back to its plan kind', async () => {
    const { db } = context();

    await expect(
      db.users
        .orderBy((u) => u.id)
        .where((_u, i) => i < 10)
        .update({ name: 'Ada' }),
    ).rejects.toThrow(/this query has a where with a position/);
  });

  it('refuses a navigation in the filter, naming what it became', async () => {
    const { db } = context();

    // The plan cannot tell: a navigation reads as an ordinary `where` there and
    // only becomes a join once compiled.
    await expect(
      db.orders.where((o) => o.user.name === 'Ada').update({ total: '1' }),
    ).rejects.toThrow(/a navigation in its filter, which becomes a join/);
  });

  it('refuses an update that sets nothing', async () => {
    const { db } = context();

    await expect(db.users.update({})).rejects.toThrow(/was given no columns to set/);
  });

  it('refuses a property the entity does not declare', async () => {
    const { db } = context();

    await expect(db.users.update({ nickname: 'A' } as never)).rejects.toThrow(
      /"nickname" is not a column of entity "User"/,
    );
  });
});
