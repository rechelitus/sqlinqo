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

describe('delete', () => {
  it('removes the rows the filter selects', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.age > 18).delete();

    expect(driver.lastStatement.text).toContain(
      'DELETE FROM "users" AS "t0" WHERE "t0"."age" > $1',
    );
    expect(driver.lastStatement.values).toEqual([18]);
  });

  it('names the table through the alias the predicate already uses', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.name === 'Ada').delete();

    // The predicate is compiled by the query compiler, which qualifies every
    // column it resolves, so the table has to be introduced under that alias.
    expect(driver.lastStatement.text).toContain('DELETE FROM "users" AS "t0" WHERE "t0"."name"');
  });

  it('reads every column back', async () => {
    const { db, driver } = context();

    await db.users.where((u) => u.id === 1).delete();

    // Worth more here than for the other writes: once the statement has run,
    // what it removed can be named from nothing but what it returned.
    expect(driver.lastStatement.text).toContain(
      'RETURNING "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email"',
    );
  });

  it('hands back the rows the statement answered with', async () => {
    const { db } = context([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);

    const removed = await db.users.where((u) => u.age > 18).delete();

    expect(removed.map((row) => row.id)).toEqual([1, 2]);
  });

  it('answers an empty array when the filter selected nothing', async () => {
    const { db } = context([]);

    await expect(db.users.where((u) => u.id === 404).delete()).resolves.toEqual([]);
  });

  it('empties the table when the query has no filter', async () => {
    const { db, driver } = context();

    await db.users.delete();

    // A thing SQL can do and a thing this does. It is a sentence that means
    // what it says rather than a mistake the library catches, and a missing
    // `where` is the only thing between the two readings.
    expect(driver.lastStatement.text).toContain('DELETE FROM "users" AS "t0"');
    expect(driver.lastStatement.text).not.toContain('WHERE');
  });

  it('takes its values from the parameter bag', async () => {
    const { db, driver } = context();

    await db.users.where((u, p) => u.age < p.limit, { limit: 13 }).delete();

    expect(driver.lastStatement.values).toEqual([13]);
  });

  it('qualifies a table with its schema', async () => {
    const { db, driver } = context();

    await db.orders.where((o) => o.id === 1).delete();

    expect(driver.lastStatement.text).toContain('DELETE FROM "sales"."orders" AS "t0"');
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

    await db.users.delete();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('DELETE FROM "users"');
  });
});

describe('delete refusals', () => {
  it('refuses a projection, which leaves no table to write to', async () => {
    const { db } = context();

    // A projection over a bare source changes only the column list, which a
    // DELETE never had, so the compiled statement looks fine and the plan is
    // what gives it away.
    await expect(db.users.select((u) => ({ name: u.name })).delete()).rejects.toThrow(
      /"delete" removes rows of one table, and this query has a projection/,
    );
  });

  it('refuses an ordering', async () => {
    const { db } = context();

    await expect(db.users.orderBy((u) => u.id).delete()).rejects.toThrow(
      /this query has an ordering/,
    );
  });

  it('refuses a page, so a delete cannot be talked into removing the first n rows', async () => {
    const { db } = context();

    await expect(db.users.take(1).delete()).rejects.toThrow(/this query has a page/);
  });

  it('refuses a set operation', async () => {
    const { db } = context();

    await expect(db.users.union(db.users).delete()).rejects.toThrow(
      /this query has a set operation/,
    );
  });

  it('refuses a grouping', async () => {
    const { db } = context();

    await expect(
      db.users
        .groupBy(
          (u) => u.cityId,
          (city, users) => ({ city, n: users.count() }),
        )
        .delete(),
    ).rejects.toThrow(/this query has a grouping/);
  });

  it('refuses a navigation in the filter, naming what it became', async () => {
    const { db } = context();

    // The plan cannot tell: a navigation reads as an ordinary `where` there and
    // only becomes a join once compiled.
    await expect(db.orders.where((o) => o.user.name === 'Ada').delete()).rejects.toThrow(
      /a navigation in its filter, which becomes a join/,
    );
  });

  it("says which rows to filter in its own words, not an update's", async () => {
    const { db } = context();

    await expect(db.users.take(1).delete()).rejects.toThrow(
      /Filter the rows to delete and nothing else\./,
    );
  });
});
