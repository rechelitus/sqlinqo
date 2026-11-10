import { describe, expect, it } from 'vitest';
import { collection, createDbContext, defineEntity, ModelError, reference } from '../src/index.js';
import type { EntityOf, IncludedCollection, Related } from '../src/index.js';
import { toExpression } from '../src/parser/lambda.js';
import type { QueryPlan } from '../src/query/plan.js';
import { compileQuery } from '../src/sql/compiler.js';
import type { SqlExpression } from '../src/sql/nodes.js';
import { sqlBinary } from '../src/sql/nodes.js';
import {
  City,
  Comment,
  FakeDriver,
  Line,
  Order,
  PagingDriver,
  Post,
  TestDialect,
  testDialect,
  User,
} from './support.js';

type UserRow = EntityOf<typeof User>;

function context() {
  const driver = new FakeDriver();
  const db = createDbContext({
    driver,
    dialect: testDialect,
    entities: { users: User, orders: Order, cities: City, posts: Post, comments: Comment },
  });
  return { db, driver };
}

/** A dialect whose database insists on a table to select from, as Oracle does. */
class DualDialect extends TestDialect {
  override formatUnitTable(alias: string): string {
    return `"dual" AS ${this.quoteIdentifier(alias)}`;
  }
}

describe('SELECT generation', () => {
  it('projects every mapped column, aliased to its property name', () => {
    const { db } = context();
    const { text, values } = db.users.toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email", ' +
        '"t0"."age" AS "age", "t0"."city_id" AS "cityId", "t0"."is_active" AS "isActive", ' +
        '"t0"."created_at" AS "createdAt" FROM "users" AS "t0"',
    );
    expect(values).toEqual([]);
  });

  it('qualifies a table with its schema', () => {
    const { db } = context();
    expect(db.orders.toSQL().text).toContain('FROM "sales"."orders" AS "t0"');
  });

  it('parameterises literals instead of inlining them', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.name === 'ada').toSQL();

    expect(text).toContain('WHERE "t0"."name" = $1');
    expect(values).toEqual(['ada']);
  });

  it('binds values from the parameter bag', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age >= p.min && u.isActive, { min: 18 })
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" >= $1 AND "t0"."is_active"');
    expect(values).toEqual([18]);
  });

  it('reuses one compiled statement across different argument values', () => {
    const { db } = context();
    const build = (min: number) => db.users.where((u, p) => u.age >= p.min, { min }).toSQL();

    expect(build(18).text).toBe(build(65).text);
    expect(build(65).values).toEqual([65]);
  });

  it('translates null comparison to IS NULL', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.cityId === null).toSQL();

    expect(text).toContain('WHERE "t0"."city_id" IS NULL');
    expect(values).toEqual([]);
  });

  it('translates inequality against null to IS NOT NULL', () => {
    const { db } = context();
    expect(db.users.where((u) => u.cityId !== null).toSQL().text).toContain('IS NOT NULL');
  });

  it('parenthesises OR inside AND', () => {
    const { db } = context();
    const { text } = db.users.where((u) => (u.age > 18 || u.isActive) && u.name === 'ada').toSQL();

    expect(text).toContain('WHERE ("t0"."age" > $1 OR "t0"."is_active") AND "t0"."name" = $2');
  });

  it('combines successive filters with AND', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u) => u.age > 18)
      .where((u) => u.name === 'ada')
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1 AND "t0"."name" = $2');
    expect(values).toEqual([18, 'ada']);
  });

  it('translates string methods through the dialect', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.name.toLowerCase().startsWith(p.prefix), { prefix: 'a' })
      .toSQL();

    expect(text).toContain(`WHERE LOWER("t0"."name") LIKE $1 || '%'`);
    expect(values).toEqual(['a']);
  });

  it('expands a list into an IN clause with one placeholder per value', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => p.ids.includes(u.id), { ids: [1, 2, 3] })
      .toSQL();

    expect(text).toContain('WHERE "t0"."id" IN ($1, $2, $3)');
    expect(values).toEqual([1, 2, 3]);
  });

  it('renders an empty IN list as a constant false', () => {
    const { db } = context();
    expect(
      db.users.where((u, p) => p.ids.includes(u.id), { ids: [] as number[] }).toSQL().text,
    ).toContain('WHERE 1 = 0');
  });

  it('projects an object literal into a column list', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ id: u.id, label: u.name })).toSQL();

    expect(text).toBe('SELECT "t0"."id" AS "id", "t0"."name" AS "label" FROM "users" AS "t0"');
  });

  it('inlines a projected expression when a later filter references it', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, nameLength: u.name.length }))
      .where((row) => row.nameLength > 3)
      .toSQL();

    expect(text).toContain('WHERE CHAR_LENGTH("t0"."name") > $1');
  });

  it('orders by several keys in declaration order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.name)
      .thenByDescending((u) => u.age)
      .toSQL();

    expect(text).toContain('ORDER BY "t0"."name" ASC, "t0"."age" DESC');
  });

  it('emits LIMIT and OFFSET for paging', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .skip(20)
      .take(10)
      .toSQL();

    expect(text).toContain('ORDER BY "t0"."id" ASC LIMIT 10 OFFSET 20');
  });

  it('pushes the query into a subquery when a filter follows paging', () => {
    const { db } = context();
    const { text } = db.users
      .take(10)
      .where((u) => u.isActive)
      .toSQL();

    expect(text).toMatch(/FROM \(SELECT .* LIMIT 10\) AS "t1" WHERE "t1"\."isActive"/);
  });

  it('counts through a wrapping subquery so paging is respected', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '7' }]);

    return db.users
      .take(10)
      .count()
      .then((total) => {
        expect(total).toBe(7);
        expect(driver.lastStatement.text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
      });
  });

  it('translates a ternary into a CASE expression', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ tier: u.age > 65 ? 'senior' : 'standard' })).toSQL();

    expect(text).toContain('CASE WHEN "t0"."age" > $1 THEN $2 ELSE $3 END AS "tier"');
  });

  it('rejects a property that is not mapped', () => {
    const { db } = context();
    const query = db.users as unknown as {
      where(fn: (u: UserRow & { nope: number }) => boolean): { toSQL(): unknown };
    };
    expect(() => query.where((u) => u.nope > 1).toSQL()).toThrow(/is not a property of/);
  });
});

describe('fromSql', () => {
  it('wraps the fragment as a derived table and binds an interpolated value', () => {
    const { db } = context();
    const { text, values } = db.users.fromSql`SELECT * FROM users WHERE age >= ${18}`.toSQL();

    // The aliases are the entity's property names, exactly as a plain
    // `db.users` projects them, over the physical column the fragment must
    // answer with under each one.
    expect(text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email", ' +
        '"t0"."age" AS "age", "t0"."city_id" AS "cityId", "t0"."is_active" AS "isActive", ' +
        '"t0"."created_at" AS "createdAt" FROM (SELECT * FROM users WHERE age >= $1) AS "t0"',
    );
    expect(values).toEqual([18]);
  });

  it('projects the same physical columns db.users itself would read', () => {
    const { db } = context();
    const { text } = db.users.fromSql`SELECT * FROM users`.select((u) => u.name).toSQL();

    expect(text).toBe('SELECT "t0"."name" AS "value" FROM (SELECT * FROM users) AS "t0"');
  });

  it('needs no interpolated value at all', () => {
    const { db } = context();
    const { text, values } = db.users.fromSql`SELECT * FROM users WHERE is_active`.toSQL();

    expect(text).toContain('FROM (SELECT * FROM users WHERE is_active) AS "t0"');
    expect(values).toEqual([]);
  });

  it('numbers its own values alongside whatever composes on top', () => {
    const { db } = context();
    const { text, values } = db.users.fromSql`SELECT * FROM users WHERE age >= ${18}`
      .where((u) => u.name === 'Ada')
      .toSQL();

    expect(text).toContain('WHERE age >= $1');
    expect(text).toContain('WHERE "t0"."name" = $2');
    expect(values).toEqual([18, 'Ada']);
  });

  it('composes with select, where, and order the same as an ordinary source', () => {
    const { db } = context();
    const { text } = db.users.fromSql`SELECT * FROM users`
      .where((u) => u.isActive)
      .orderBy((u) => u.name)
      .select((u) => ({ name: u.name }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "name" FROM (SELECT * FROM users) AS "t0" ' +
        'WHERE "t0"."is_active" ORDER BY "t0"."name" ASC',
    );
  });

  it('resolves a navigation the same as an ordinary source', () => {
    const { db } = context();
    const { text } = db.orders.fromSql`SELECT * FROM sales.orders`
      .select((o) => o.user.name)
      .toSQL();

    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
    expect(text).toContain('SELECT "t1"."name" AS "value"');
  });
});

describe('query filters', () => {
  it("applies the entity's own filter to a plain query", () => {
    const { db } = context();
    const { text } = db.posts.toSQL();

    expect(text).toContain('WHERE NOT "t0"."is_deleted"');
  });

  it("composes with a caller's own where rather than replacing it", () => {
    const { db } = context();
    const { text } = db.posts.where((p) => p.title === 'Hello').toSQL();

    expect(text).toContain('NOT "t0"."is_deleted"');
    expect(text).toContain('"t0"."title" = $1');
  });

  it('is bypassed by ignoreQueryFilters', () => {
    const { db } = context();
    const { text } = db.posts.ignoreQueryFilters().toSQL();

    // The column is still projected; only the automatic WHERE is gone.
    expect(text).not.toContain('WHERE');
  });

  it('reaches a reference navigated to a filtered entity', () => {
    const { db } = context();
    const { text } = db.comments.select((c) => c.post.title).toSQL();

    expect(text).toContain('INNER JOIN "posts" AS "t1"');
    expect(text).toContain('NOT "t1"."is_deleted"');
    expect(text).toContain('"t0"."post_id" = "t1"."id"');
  });

  it('reaches a collection navigated to a filtered entity', () => {
    const { db } = context();
    const { text } = db.users.select((u) => u.posts.count()).toSQL();

    expect(text).toContain('NOT "t1"."is_deleted"');
  });

  it("reaches include's own second statement", async () => {
    const driver = new PagingDriver([
      [{ id: 1, name: 'Ada' }],
      [{ id: 10, userId: 1, title: 'Hello', isDeleted: false }],
    ]);
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, posts: Post },
    });

    await db.users.include((u) => u.posts).toArray();

    expect(driver.statements[1]!.text).toContain('NOT "t0"."is_deleted"');
  });
});

describe('JOIN generation', () => {
  it('joins two tables on a key from each side', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "name", "t1"."total" AS "total" FROM "users" AS "t0" ' +
        'INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"',
    );
  });

  it('keeps a filter on the outer side in WHERE rather than in ON', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u) => u.isActive)
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toContain('INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"');
    expect(text).toContain('WHERE "t0"."is_active"');
    expect(values).toEqual([]);
  });

  it('pushes a filtered inner side into a derived table', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders.where((o) => o.userId > 100),
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toMatch(
      /INNER JOIN \(SELECT .* FROM "sales"\."orders" AS "t1" WHERE "t1"\."user_id" > \$1\) AS "t2" ON "t0"\."id" = "t2"\."userId"/,
    );
  });

  it('renumbers the parameter bag of the joined query so the two cannot collide', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age >= p.min, { min: 18 })
      .join(
        db.orders.where((o, p) => o.userId > p.min, { min: 100 }),
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    // The inner subquery is printed before the outer WHERE, so its placeholder
    // comes first. Both values survive, which is the point of the renumbering.
    expect(text).toContain('WHERE "t1"."user_id" > $1');
    expect(text).toContain('WHERE "t0"."age" >= $2');
    expect(values).toEqual([100, 18]);
  });

  it('settles paging on the outer side before joining', () => {
    const { db } = context();
    const { text } = db.users
      .take(10)
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* FROM "users" AS "t0" LIMIT 10\) AS "t1" INNER JOIN "sales"\."orders" AS "t2" ON "t1"\."id" = "t2"\."user_id"/,
    );
  });

  it('returns the joined row untouched when the selector is the identity', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (_u, o) => o,
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "id", "t1"."user_id" AS "userId", "t1"."total" AS "total" ' +
        'FROM "users" AS "t0" INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"',
    );
  });

  it('projects a scalar out of a join', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, _o) => u.name,
      )
      .toSQL();

    expect(text).toContain('SELECT "t0"."name" AS "value" FROM "users" AS "t0" INNER JOIN');
  });

  it('inlines an expression the inner side projected', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders.select((o) => ({ owner: o.userId, size: o.total })),
        (u) => u.id,
        (o) => o.owner,
        (u, o) => ({ name: u.name, size: o.size }),
      )
      .toSQL();

    // No derived table is needed: the projection only renamed columns of a
    // table that is still joined directly.
    expect(text).toBe(
      'SELECT "t0"."name" AS "name", "t1"."total" AS "size" FROM "users" AS "t0" ' +
        'INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"',
    );
  });

  it('chains a second join and keeps filtering, ordering, and paging afterwards', () => {
    const { db } = context();
    const { text, values } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ cityId: u.cityId, orderId: o.id }),
      )
      .join(
        db.cities,
        (row) => row.cityId,
        (c) => c.id,
        (row, c) => ({ city: c.name, orderId: row.orderId }),
      )
      .where((row) => row.orderId > 10)
      .orderBy((row) => row.city)
      .skip(5)
      .take(5)
      .toSQL();

    expect(text).toBe(
      'SELECT "t2"."name" AS "city", "t1"."id" AS "orderId" FROM "users" AS "t0" ' +
        'INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id" ' +
        'INNER JOIN "cities" AS "t2" ON "t0"."city_id" = "t2"."id" ' +
        'WHERE "t1"."id" > $1 ORDER BY "t2"."name" ASC LIMIT 5 OFFSET 5',
    );
    expect(values).toEqual([10]);
  });

  it('counts a join through the usual wrapping subquery', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    return db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .count()
      .then((total) => {
        expect(total).toBe(3);
        expect(driver.lastStatement.text).toMatch(
          /^SELECT COUNT\(\*\) AS "count" FROM \(SELECT .* INNER JOIN .*\) AS "t2"$/,
        );
      });
  });

  it('reports a property that belongs to the other side of the join', () => {
    const { db } = context();
    const query = () =>
      db.users
        .join(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (_u, o) => ({ oops: (o as unknown as { age: number }).age }),
        )
        .toSQL();

    expect(query).toThrow(/is not a property of entity "Order"/);
  });
});

describe('JOIN of an ordered query', () => {
  it('drops an ordering the joined side cannot act on', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders.orderBy((o) => o.id),
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toContain('INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"');
    expect(text).not.toContain('ORDER BY');
  });

  it('keeps the ordering when the joined side is also paged', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders.orderBy((o) => o.id).take(5),
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toMatch(
      /INNER JOIN \(SELECT .* ORDER BY "t1"\."id" ASC LIMIT 5\) AS "t2" ON "t0"\."id" = "t2"\."userId"/,
    );
  });
});

describe('GROUP BY generation', () => {
  it('groups by one key and counts each group', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "city", COUNT(*) AS "headcount" FROM "users" AS "t0" ' +
        'GROUP BY "t0"."city_id"',
    );
  });

  it('groups by every property of an object key', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => ({ city: u.cityId, active: u.isActive }),
        (key, users) => ({ city: key.city, active: key.active, headcount: users.count() }),
      )
      .toSQL();

    expect(text).toContain('SELECT "t0"."city_id" AS "city", "t0"."is_active" AS "active"');
    expect(text).toContain('GROUP BY "t0"."city_id", "t0"."is_active"');
  });

  it('translates each aggregate the group exposes', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (_city, users) => ({
          n: users.count(),
          total: users.sum((u) => u.age),
          mean: users.average((u) => u.age),
          youngest: users.min((u) => u.age),
          oldest: users.max((u) => u.age),
        }),
      )
      .toSQL();

    expect(text).toContain(
      'SELECT COUNT(*) AS "n", SUM("t0"."age") AS "total", AVG("t0"."age") AS "mean", ' +
        'MIN("t0"."age") AS "youngest", MAX("t0"."age") AS "oldest"',
    );
  });

  it('counts the different values a selector takes within each group', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, distinctAges: users.countDistinct((u) => u.age) }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "city", COUNT(DISTINCT "t0"."age") + ' +
        'CASE WHEN COUNT("t0"."age") < COUNT(*) THEN 1 ELSE 0 END AS "distinctAges" ' +
        'FROM "users" AS "t0" GROUP BY "t0"."city_id"',
    );
  });

  it('counts null as a value within a group, the same reading the standalone terminal takes', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, distinctAges: users.countDistinct((u) => u.age) }),
      )
      .toSQL();

    // COUNT(DISTINCT ...) skips nulls where LINQ counts one, closed the same
    // way the standalone countDistinct terminal closes it.
    expect(text).toContain('CASE WHEN COUNT("t0"."age") < COUNT(*) THEN 1 ELSE 0 END');
  });

  it('groups by an expression rather than a bare column', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.createdAt.getFullYear(),
        (year, users) => ({ year, joined: users.count() }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT EXTRACT(YEAR FROM "t0"."created_at") AS "year", COUNT(*) AS "joined" ' +
        'FROM "users" AS "t0" GROUP BY EXTRACT(YEAR FROM "t0"."created_at")',
    );
  });

  it('projects a lone scalar key as an unnamed value', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city) => city,
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "value" FROM "users" AS "t0" GROUP BY "t0"."city_id"',
    );
  });

  it('filters rows in WHERE and groups in HAVING', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age >= p.min, { min: 18 })
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .where((row) => row.headcount > 5)
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "city", COUNT(*) AS "headcount" FROM "users" AS "t0" ' +
        'WHERE "t0"."age" >= $1 GROUP BY "t0"."city_id" HAVING COUNT(*) > $2',
    );
    expect(values).toEqual([18, 5]);
  });

  it('combines successive group filters with AND in HAVING', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count(), oldest: users.max((u) => u.age) }),
      )
      .where((row) => row.headcount > 5)
      .where((row) => row.oldest < 90)
      .toSQL();

    expect(text).toContain('HAVING COUNT(*) > $1 AND MAX("t0"."age") < $2');
  });

  it('orders and pages a grouped query', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .orderByDescending((row) => row.headcount)
      .take(10)
      .toSQL();

    expect(text).toContain('GROUP BY "t0"."city_id" ORDER BY COUNT(*) DESC LIMIT 10');
  });

  it('groups the rows a join produced', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ cityId: u.cityId, total: o.total }),
      )
      .groupBy(
        (row) => row.cityId,
        (city, rows) => ({ city, revenue: rows.sum((row) => row.total) }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "city", SUM("t1"."total") AS "revenue" FROM "users" AS "t0" ' +
        'INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id" ' +
        'GROUP BY "t0"."city_id"',
    );
  });

  it('pushes a grouped query into a derived table before joining it', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .join(
        db.cities,
        (row) => row.city,
        (c) => c.id,
        (row, c) => ({ city: c.name, headcount: row.headcount }),
      )
      .toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* GROUP BY "t0"\."city_id"\) AS "t1" INNER JOIN "cities" AS "t2" ON "t1"\."city" = "t2"\."id"/,
    );
  });

  it('pushes a grouped query into a derived table before grouping it again', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => ({ city: u.cityId, active: u.isActive }),
        (key, users) => ({ city: key.city, active: key.active, headcount: users.count() }),
      )
      .groupBy(
        (row) => row.city,
        (city, rows) => ({ city, buckets: rows.count() }),
      )
      .toSQL();

    expect(text).toMatch(
      /^SELECT "t1"\."city" AS "city", COUNT\(\*\) AS "buckets" FROM \(SELECT .* GROUP BY "t0"\."city_id", "t0"\."is_active"\) AS "t1" GROUP BY "t1"\."city"$/,
    );
  });

  it('counts the groups rather than the rows behind them', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '4' }]);

    return db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .count()
      .then((total) => {
        expect(total).toBe(4);
        expect(driver.lastStatement.text).toMatch(
          /^SELECT COUNT\(\*\) AS "count" FROM \(SELECT .* GROUP BY "t0"\."city_id"\) AS "t1"$/,
        );
      });
  });

  it('rejects a method that is not an aggregate', () => {
    const { db } = context();
    const query = () =>
      db.users
        .groupBy(
          (u) => u.cityId,
          (city, users) => ({
            city,
            oops: (users as unknown as { median(): number }).median(),
          }),
        )
        .toSQL();

    expect(query).toThrow(/"median" is not an aggregate/);
  });

  it('rejects a property read on a scalar key', () => {
    const { db } = context();
    const query = () =>
      db.users
        .groupBy(
          (u) => u.cityId,
          (key: unknown, users) => ({
            city: (key as { city: number }).city,
            headcount: users.count(),
          }),
        )
        .toSQL();

    expect(query).toThrow(/group key is a single value/);
  });

  it('rejects using the group itself as a value', () => {
    const { db } = context();
    const query = () =>
      db.users
        .groupBy(
          (u) => u.cityId,
          (city, users) => ({ city, oops: users as unknown as number }),
        )
        .toSQL();

    expect(query).toThrow(/cannot be used as a value/);
  });

  it('rejects an aggregate given no value to aggregate', () => {
    const { db } = context();
    const query = () =>
      db.users
        .groupBy(
          (u) => u.cityId,
          (city, users) => ({
            city,
            oops: (users as unknown as { sum(): number }).sum(),
          }),
        )
        .toSQL();

    expect(query).toThrow(/expects one lambda/);
  });
});

describe('padStart and padEnd', () => {
  it('translates padStart to LPAD', () => {
    const { db } = context();
    const { text, values } = db.users.select((u) => ({ padded: u.name.padStart(10, '.') })).toSQL();

    expect(text).toBe(
      'SELECT LPAD("t0"."name", GREATEST($1, CHAR_LENGTH("t0"."name")), $2) AS "padded" ' +
        'FROM "users" AS "t0"',
    );
    expect(values).toEqual([10, '.']);
  });

  it('translates padEnd to RPAD', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ padded: u.name.padEnd(10, '.') })).toSQL();

    expect(text).toContain('RPAD("t0"."name", GREATEST($1, CHAR_LENGTH("t0"."name")), $2)');
  });

  it('defaults the pad string to a space', () => {
    const { db } = context();
    const { text, values } = db.users.select((u) => ({ padded: u.name.padStart(10) })).toSQL();

    expect(text).toContain(`GREATEST($1, CHAR_LENGTH("t0"."name")), ' ')`);
    expect(values).toEqual([10]);
  });

  it('pads to a width from the parameter bag', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u, p) => ({ padded: u.email.padStart(p.width, p.fill) }), { width: 8, fill: '0' })
      .toSQL();

    expect(text).toContain('LPAD("t0"."email", GREATEST($1, CHAR_LENGTH("t0"."email")), $2)');
    expect(values).toEqual([8, '0']);
  });

  it('never truncates, unlike a bare LPAD', () => {
    // `'hello'.padStart(3)` is `'hello'` in JavaScript but `'hel'` from a plain
    // LPAD, so the width is raised to the string's own length first.
    const { db } = context();
    const { text } = db.users.select((u) => ({ padded: u.name.padStart(3) })).toSQL();

    expect(text).toContain('GREATEST($1, CHAR_LENGTH("t0"."name"))');
  });

  it('rejects a call with no target length', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          padded: (u.name as unknown as { padStart(): string }).padStart(),
        }))
        .toSQL();

    expect(query).toThrow(/expects a target length/);
  });
});

describe('concat', () => {
  it('joins the receiver and its argument', () => {
    const { db } = context();
    const { text, values } = db.users.select((u) => ({ label: u.name.concat('!') })).toSQL();

    expect(text).toBe('SELECT "t0"."name" || $1 AS "label" FROM "users" AS "t0"');
    expect(values).toEqual(['!']);
  });

  it('joins two columns, which the + operator would not have', () => {
    // `+` is concatenation only when a string literal is on one side of it, so
    // two text columns added together compile to arithmetic. This is the whole
    // reason the method is worth translating.
    const { db } = context();
    const { text } = db.users.select((u) => ({ label: u.name.concat(u.email) })).toSQL();

    expect(text).toBe('SELECT "t0"."name" || "t0"."email" AS "label" FROM "users" AS "t0"');
  });

  it('joins any number of arguments, left to right', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u) => ({ label: u.name.concat(' <', u.email, '>') }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" || $1 || "t0"."email" || $2 AS "label" FROM "users" AS "t0"',
    );
    expect(values).toEqual([' <', '>']);
  });

  it('answers the receiver alone when given nothing to join', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ label: (u.name as unknown as { concat(): string }).concat() }))
      .toSQL();

    // `'a'.concat()` is `'a'`, and the dialect's join of one part is that part,
    // so the arity needs no case of its own.
    expect(text).toBe('SELECT "t0"."name" AS "label" FROM "users" AS "t0"');
  });

  it('takes its parts from the parameter bag', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.name.concat(p.suffix) === p.wanted, { suffix: '!', wanted: 'Ada!' })
      .toSQL();

    expect(text).toContain('WHERE "t0"."name" || $1 = $2');
    expect(values).toEqual(['!', 'Ada!']);
  });

  it('goes through the dialect, so a database spelling the join + keeps doing so', () => {
    class PlusDialect extends TestDialect {
      override concat(parts: readonly SqlExpression[]): SqlExpression {
        return parts.reduce((left, right) => sqlBinary('+', left, right));
      }
    }

    const driver = new FakeDriver();
    const db = createDbContext({
      driver,
      dialect: new PlusDialect(),
      entities: { users: User },
    });

    const { text } = db.users.select((u) => ({ label: u.name.concat(u.email) })).toSQL();

    expect(text).toContain('"t0"."name" + "t0"."email"');
  });

  it('refuses an array receiver rather than guessing what was meant', () => {
    const driver = new FakeDriver();
    const Post = defineEntity({
      name: 'Post',
      table: 'posts',
      columns: {
        id: { type: 'int', primaryKey: true },
        tags: { type: 'array', of: 'text' },
      },
    });
    const db = createDbContext({ driver, dialect: testDialect, entities: { posts: Post } });

    // `Array.prototype.concat` splices an array argument in and appends
    // anything else whole, and nothing here can tell those apart, so the string
    // reading is not quietly emitted over an array column.
    const query = () =>
      db.posts.select((p, q) => ({ all: p.tags.concat(q.more) }), { more: ['x'] }).toSQL();

    expect(query).toThrow(/"concat" over an array column is not translated/);
  });
});

describe('parameter sharing', () => {
  it('gives a grouped expression the same placeholder in SELECT and GROUP BY', () => {
    // PostgreSQL matches a GROUP BY item against the projection by expression,
    // so a second placeholder for the same value makes the two look unrelated
    // and the column appears to be neither grouped nor aggregated.
    const { db } = context();
    const { text, values } = db.users
      .groupBy(
        (u) => u.age >= 41,
        (senior, users) => ({ senior, n: users.count() }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."age" >= $1 AS "senior", COUNT(*) AS "n" FROM "users" AS "t0" ' +
        'GROUP BY "t0"."age" >= $1',
    );
    expect(values).toEqual([41]);
  });

  it('shares a bag reference across the clauses it was compiled into', () => {
    const { db } = context();
    const { text, values } = db.users
      .groupBy(
        (u) => u.name.padStart(4, '0'),
        (code, users) => ({ code, n: users.count() }),
      )
      .toSQL();

    expect(text).toContain(
      'SELECT LPAD("t0"."name", GREATEST($1, CHAR_LENGTH("t0"."name")), $2) AS "code"',
    );
    expect(text).toContain(
      'GROUP BY LPAD("t0"."name", GREATEST($1, CHAR_LENGTH("t0"."name")), $2)',
    );
    expect(values).toEqual([4, '0']);
  });

  it('binds a repeated literal once', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u) => u.age > 18)
      .where((u) => u.id > 18)
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1 AND "t0"."id" > $1');
    expect(values).toEqual([18]);
  });

  it('keeps values of different types apart', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age > p.n && u.name === p.s, { n: 1, s: '1' })
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1 AND "t0"."name" = $2');
    expect(values).toEqual([1, '1']);
  });

  it('still gives each element of an IN list its own placeholder', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => p.ids.includes(u.id), { ids: [7, 7, 8] })
      .toSQL();

    // Each element is a distinct bag path, so repeated values stay separate.
    expect(text).toContain('WHERE "t0"."id" IN ($1, $2, $3)');
    expect(values).toEqual([7, 7, 8]);
  });

  it('leaves a value it cannot compare cheaply unshared', () => {
    const { db } = context();
    const when = new Date(0);
    const { values } = db.users
      .where((u, p) => u.createdAt > p.a && u.createdAt < p.b, { a: when, b: when })
      .toSQL();

    // Two Dates are not compared by identity, so each keeps its own placeholder
    // rather than risk sharing on a stringification that could collide.
    expect(values).toEqual([when, when]);
  });
});

describe('sample generation', () => {
  it('orders by a random value and limits', () => {
    const { db } = context();
    const { text } = db.users.sample(5).toSQL();

    expect(text).toContain('FROM "users" AS "t0" ORDER BY RANDOM() ASC LIMIT 5');
  });

  it('samples only the rows a filter left, without a subquery', () => {
    const { db } = context();
    const { text } = db.users
      .where((u) => u.isActive)
      .sample(5)
      .toSQL();

    expect(text).toContain('WHERE "t0"."is_active" ORDER BY RANDOM() ASC LIMIT 5');
  });

  it('replaces an ordering applied before it', () => {
    // A random sample has no order to inherit, so nesting the earlier ordering
    // in a subquery would cost a sort that cannot change the outcome.
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.name)
      .sample(5)
      .toSQL();

    expect(text).toContain('ORDER BY RANDOM() ASC LIMIT 5');
    expect(text).not.toContain('"t0"."name" ASC');
  });

  it('orders the sample when the ordering is chained after it', () => {
    const { db } = context();
    const { text } = db.users
      .sample(5)
      .orderBy((u) => u.name)
      .toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* ORDER BY RANDOM\(\) ASC LIMIT 5\) AS "t1" ORDER BY "t1"\."name" ASC/,
    );
  });

  it('draws from the paged rows rather than the whole table', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.name)
      .take(100)
      .sample(5)
      .toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* ORDER BY "t0"\."name" ASC LIMIT 100\) AS "t1" ORDER BY RANDOM\(\) ASC LIMIT 5/,
    );
  });

  it('pushes DISTINCT into a subquery first', () => {
    // PostgreSQL rejects an ORDER BY over SELECT DISTINCT unless it sorts by a
    // selected column, and a random value never is one.
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ city: u.cityId }))
      .distinct()
      .sample(5)
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."city" AS "city" FROM (SELECT DISTINCT "t0"."city_id" AS "city" ' +
        'FROM "users" AS "t0") AS "t1" ORDER BY RANDOM() ASC LIMIT 5',
    );
  });

  it('samples groups without wrapping the grouped query', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, n: users.count() }),
      )
      .sample(3)
      .toSQL();

    expect(text).toContain('GROUP BY "t0"."city_id" ORDER BY RANDOM() ASC LIMIT 3');
  });

  it('samples a sample through a subquery', () => {
    const { db } = context();
    const { text } = db.users.sample(10).sample(3).toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* ORDER BY RANDOM\(\) ASC LIMIT 10\) AS "t1" ORDER BY RANDOM\(\) ASC LIMIT 3/,
    );
  });

  it('filters the sample rather than the rows it came from', () => {
    const { db } = context();
    const { text } = db.users
      .sample(5)
      .where((u) => u.isActive)
      .toSQL();

    expect(text).toMatch(/ORDER BY RANDOM\(\) ASC LIMIT 5\) AS "t1" WHERE "t1"\."isActive"/);
  });

  it('counts a sample through the wrapping subquery', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '5' }]);

    return db.users
      .sample(5)
      .count()
      .then((total) => {
        expect(total).toBe(5);
        expect(driver.lastStatement.text).toMatch(
          /^SELECT COUNT\(\*\) AS "count" FROM \(SELECT .* ORDER BY RANDOM\(\) ASC LIMIT 5\) AS "t1"$/,
        );
      });
  });

  it('translates Math.random in a projection with the same function', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ id: u.id, r: Math.random() })).toSQL();

    expect(text).toContain('RANDOM() AS "r"');
  });

  it('rejects a count that is not a non-negative integer', () => {
    const { db } = context();
    expect(() => db.users.sample(-1).toSQL()).toThrow(/"sample" expects a non-negative integer/);
    expect(() => db.users.sample(2.5).toSQL()).toThrow(/"sample" expects a non-negative integer/);
  });
});

describe('trimStart and trimEnd', () => {
  it('translates trimStart to LTRIM', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ name: u.name.trimStart() })).toSQL();

    expect(text).toBe('SELECT LTRIM("t0"."name") AS "name" FROM "users" AS "t0"');
  });

  it('translates trimEnd to RTRIM', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ name: u.name.trimEnd() })).toSQL();

    expect(text).toBe('SELECT RTRIM("t0"."name") AS "name" FROM "users" AS "t0"');
  });

  it('accepts the pre-ES2019 aliases', () => {
    const { db } = context();
    const rows = db.users as unknown as {
      select(fn: (u: { name: { trimLeft(): string; trimRight(): string } }) => unknown): {
        toSQL(): { text: string };
      };
    };

    expect(rows.select((u) => ({ a: u.name.trimLeft() })).toSQL().text).toContain(
      'LTRIM("t0"."name")',
    );
    expect(rows.select((u) => ({ a: u.name.trimRight() })).toSQL().text).toContain(
      'RTRIM("t0"."name")',
    );
  });

  it('composes with the other string translations', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.name.trimStart().toLowerCase().startsWith(p.prefix), { prefix: 'a' })
      .toSQL();

    expect(text).toContain(`WHERE LOWER(LTRIM("t0"."name")) LIKE $1 || '%'`);
    expect(values).toEqual(['a']);
  });

  it('filters and groups on a trimmed column', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => u.name.trimStart(),
        (name, users) => ({ name, n: users.count() }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT LTRIM("t0"."name") AS "name", COUNT(*) AS "n" FROM "users" AS "t0" ' +
        'GROUP BY LTRIM("t0"."name")',
    );
  });

  it('rejects a trim given arguments', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          name: (u.name as unknown as { trimStart(c: string): string }).trimStart('.'),
        }))
        .toSQL();

    expect(query).toThrow(/"trimStart" expects 0 argument\(s\)/);
  });
});

describe('UNION generation', () => {
  it('unions two queries into one statement', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60))
      .toSQL();

    expect(text).toMatch(
      /^SELECT .* FROM "users" AS "t0" WHERE "t0"\."age" < \$1 UNION SELECT .* FROM "users" AS "t1" WHERE "t1"\."age" > \$2$/,
    );
    expect(values).toEqual([30, 60]);
  });

  it('keeps duplicates for concat', () => {
    const { db } = context();
    const { text } = db.users
      .where((u) => u.age < 30)
      .concat(db.users)
      .toSQL();

    expect(text).toContain('UNION ALL SELECT');
    expect(text).not.toContain('UNION SELECT');
  });

  it('renumbers the parameter bag of the united query', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age < p.n, { n: 30 })
      .union(db.users.where((u, p) => u.age > p.n, { n: 60 }))
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" < $1');
    expect(text).toContain('WHERE "t1"."age" > $2');
    expect(values).toEqual([30, 60]);
  });

  it('keeps a chain flat rather than nesting each link', () => {
    const { db } = context();
    const { text } = db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60))
      .union(db.users.where((u) => u.isActive))
      .toSQL();

    // Three branches, one statement, no derived table.
    expect(text.match(/UNION SELECT/g)).toHaveLength(2);
    expect(text).not.toContain('FROM (SELECT');
  });

  it('parenthesises a united query that is itself a union', () => {
    // `A UNION (B UNION ALL C)` must not flatten, or SQL regroups it as
    // `(A UNION B) UNION ALL C`, which is a different set.
    const { db } = context();
    const { text } = db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60).concat(db.users.where((u) => u.isActive)))
      .toSQL();

    expect(text).toMatch(/UNION SELECT .* FROM \(SELECT .* UNION ALL SELECT .*\) AS "t\d+"$/);
  });

  it('pairs columns by name rather than by position', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ a: u.id, b: u.name }))
      .union(db.users.select((u) => ({ b: u.name, a: u.id })))
      .toSQL();

    // The second branch was written b-then-a and is emitted a-then-b, so each
    // value still lands in the property it was named for.
    expect(text).toBe(
      'SELECT "t0"."id" AS "a", "t0"."name" AS "b" FROM "users" AS "t0" ' +
        'UNION SELECT "t1"."id" AS "a", "t1"."name" AS "b" FROM "users" AS "t1"',
    );
  });

  it('rejects branches that project different columns', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({ a: u.id, b: u.name }))
        .union(db.users.select((u) => ({ a: u.id })) as never)
        .toSQL();

    expect(query).toThrow(/Both sides of a set operation must project the same columns/);
  });

  it('rejects branches whose column names disagree', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({ a: u.id, b: u.name }))
        .union(db.users.select((u) => ({ a: u.id, c: u.name })) as never)
        .toSQL();

    expect(query).toThrow(/has no column "b"/);
  });

  it('pushes a paged branch into a derived table', () => {
    const { db } = context();
    const { text } = db.users
      .take(5)
      .union(db.users.where((u) => u.isActive))
      .toSQL();

    expect(text).toMatch(/^SELECT .* FROM \(SELECT .* LIMIT 5\) AS "t1" UNION SELECT /);
  });

  it('filters the union rather than its last branch', () => {
    // A trailing WHERE would bind to the branch it follows, so the union is
    // pushed into a derived table first.
    const { db } = context();
    const { text } = db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60))
      .where((u) => u.isActive)
      .toSQL();

    expect(text).toMatch(/FROM \(SELECT .* UNION SELECT .*\) AS "t2" WHERE "t2"\."isActive"$/);
  });

  it('orders the union rather than its last branch', () => {
    const { db } = context();
    const { text } = db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60))
      .orderBy((u) => u.name)
      .toSQL();

    expect(text).toMatch(/FROM \(SELECT .* UNION SELECT .*\) AS "t2" ORDER BY "t2"\."name" ASC$/);
  });

  it('unions two grouped queries without wrapping either', () => {
    const { db } = context();
    const grouped = () =>
      db.users.groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, n: users.count() }),
      );
    const { text } = grouped().union(grouped()).toSQL();

    expect(text).toBe(
      'SELECT "t0"."city_id" AS "city", COUNT(*) AS "n" FROM "users" AS "t0" ' +
        'GROUP BY "t0"."city_id" UNION SELECT "t1"."city_id" AS "city", COUNT(*) AS "n" ' +
        'FROM "users" AS "t1" GROUP BY "t1"."city_id"',
    );
  });

  it('counts a union through the wrapping subquery', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '9' }]);

    return db.users
      .where((u) => u.age < 30)
      .union(db.users.where((u) => u.age > 60))
      .count()
      .then((total) => {
        expect(total).toBe(9);
        expect(driver.lastStatement.text).toMatch(
          /^SELECT COUNT\(\*\) AS "count" FROM \(SELECT .* UNION SELECT .*\) AS "t2"$/,
        );
      });
  });
});

describe('append', () => {
  // `City` carries no relations, so its row type is the plain column shape:
  // an entity with a `reference` would also need a value for that navigation,
  // which is `append`'s own limit and is why the README points at projecting
  // the columns wanted first for one of those.
  it('adds a literal row with UNION ALL, one column per property', () => {
    const { db } = context();
    const { text, values } = db.cities
      .where((c) => c.id < 30)
      .append({ id: 1, name: 'Newtown', country: 'Oz' })
      .toSQL();

    expect(text).toContain('UNION ALL SELECT');
    expect(text).toMatch(/\$2 AS "id", \$3 AS "name", \$4 AS "country" FROM \(SELECT 1\) AS "t1"$/);
    expect(values.slice(1)).toEqual([1, 'Newtown', 'Oz']);
  });

  it('keeps duplicates, as concat does', () => {
    const { db } = context();
    const { text } = db.cities.append({ id: 1, name: 'Newtown', country: 'Oz' }).toSQL();

    expect(text).toContain('UNION ALL SELECT');
    expect(text).not.toContain('UNION SELECT');
  });

  it('appends to a scalar projection as a bare column named "value"', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u) => u.name)
      .append('Guest')
      .toSQL();

    expect(text).toMatch(
      /^SELECT .* AS "value" FROM "users" AS "t0" UNION ALL SELECT \$1 AS "value" FROM \(SELECT 1\) AS "t1"$/,
    );
    expect(values).toEqual(['Guest']);
  });

  it('leaves the source query untouched', () => {
    const { db } = context();
    const active = db.cities.where((c) => c.id > 0);

    active.append({ id: 1, name: 'Newtown', country: 'Oz' });

    expect(active.toSQL().text).not.toContain('UNION');
  });
});

describe('prepend', () => {
  it('adds a literal row ahead of the query, the same UNION ALL the other way round', () => {
    const { db } = context();
    const { text, values } = db.cities
      .where((c) => c.id < 30)
      .prepend({ id: 1, name: 'Newtown', country: 'Oz' })
      .toSQL();

    expect(text).toContain('UNION ALL SELECT');
    // The literal comes first here, where it comes last for `append`.
    expect(text).toMatch(
      /^SELECT \$1 AS "id", \$2 AS "name", \$3 AS "country" FROM \(SELECT 1\) AS "t0" UNION ALL SELECT/,
    );
    expect(values.slice(0, 3)).toEqual([1, 'Newtown', 'Oz']);
  });

  it('keeps duplicates, as concat does', () => {
    const { db } = context();
    const { text } = db.cities.prepend({ id: 1, name: 'Newtown', country: 'Oz' }).toSQL();

    expect(text).toContain('UNION ALL SELECT');
    expect(text).not.toContain('UNION SELECT');
  });

  it('prepends to a scalar projection as a bare column named "value"', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u) => u.name)
      .prepend('Guest')
      .toSQL();

    expect(text).toMatch(
      /^SELECT \$1 AS "value" FROM \(SELECT 1\) AS "t0" UNION ALL SELECT .* AS "value" FROM "users" AS "t1"$/,
    );
    expect(values).toEqual(['Guest']);
  });

  it('leaves the source query untouched', () => {
    const { db } = context();
    const active = db.cities.where((c) => c.id > 0);

    active.prepend({ id: 1, name: 'Newtown', country: 'Oz' });

    expect(active.toSQL().text).not.toContain('UNION');
  });
});

describe('INTERSECT and EXCEPT generation', () => {
  const branches = (db: ReturnType<typeof context>['db']) => ({
    a: db.users.where((u) => u.age < 30),
    b: db.users.where((u) => u.age > 60),
    c: db.users.where((u) => u.isActive),
  });

  it('intersects two queries into one statement', () => {
    const { db } = context();
    const { a, b } = branches(db);
    const { text, values } = a.intersect(b).toSQL();

    expect(text).toMatch(
      /^SELECT .* WHERE "t0"\."age" < \$1 INTERSECT SELECT .* WHERE "t1"\."age" > \$2$/,
    );
    expect(values).toEqual([30, 60]);
  });

  it('subtracts one query from another', () => {
    const { db } = context();
    const { a, b } = branches(db);

    expect(a.except(b).toSQL().text).toContain('EXCEPT SELECT');
  });

  it('keeps a run of one operator flat', () => {
    const { db } = context();
    const { a, b, c } = branches(db);
    const { text } = a.intersect(b).intersect(c).toSQL();

    expect(text.match(/INTERSECT SELECT/g)).toHaveLength(2);
    expect(text).not.toContain('FROM (SELECT');
  });

  it('keeps UNION and EXCEPT flat, since they bind equally', () => {
    const { db } = context();
    const { a, b, c } = branches(db);

    // `(A UNION B) EXCEPT C` is what SQL reads from the flat form, which is
    // the grouping the chain asked for.
    expect(a.union(b).except(c).toSQL().text).not.toContain('FROM (SELECT');
    expect(a.except(b).union(c).toSQL().text).not.toContain('FROM (SELECT');
  });

  it('parenthesises a union before intersecting it', () => {
    // The reason this operator needed more than a keyword: INTERSECT binds
    // tighter, so flat `A UNION B INTERSECT C` means `A UNION (B INTERSECT C)`,
    // and the chain asked for `(A UNION B) INTERSECT C`.
    const { db } = context();
    const { a, b, c } = branches(db);
    const { text } = a.union(b).intersect(c).toSQL();

    expect(text).toMatch(
      /^SELECT .* FROM \(SELECT .* UNION SELECT .*\) AS "t2" INTERSECT SELECT .* "t3"\."is_active"$/,
    );
  });

  it('parenthesises an intersect on the right of a union', () => {
    const { db } = context();
    const { a, b, c } = branches(db);
    const { text } = a.union(b.intersect(c)).toSQL();

    expect(text).toMatch(/UNION SELECT .* FROM \(SELECT .* INTERSECT SELECT .*\) AS "t3"$/);
  });

  it('parenthesises an intersect before uniting it, though SQL would not need it', () => {
    // Conservative on purpose: the rule is that a chain stays flat only while
    // every operator binds equally, which is cheap to be sure of.
    const { db } = context();
    const { a, b, c } = branches(db);
    const { text } = a.intersect(b).union(c).toSQL();

    expect(text).toMatch(/FROM \(SELECT .* INTERSECT SELECT .*\) AS "t2" UNION SELECT /);
  });

  it('orders an intersect rather than its last branch', () => {
    const { db } = context();
    const { a, b } = branches(db);
    const { text } = a
      .intersect(b)
      .orderBy((u) => u.name)
      .toSQL();

    expect(text).toMatch(
      /FROM \(SELECT .* INTERSECT SELECT .*\) AS "t2" ORDER BY "t2"\."name" ASC$/,
    );
  });

  it('pairs columns by name across an intersect too', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ a: u.id, b: u.name }))
      .intersect(db.users.select((u) => ({ b: u.name, a: u.id })))
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "a", "t0"."name" AS "b" FROM "users" AS "t0" ' +
        'INTERSECT SELECT "t1"."id" AS "a", "t1"."name" AS "b" FROM "users" AS "t1"',
    );
  });

  it('rejects branches that project different columns', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({ a: u.id, b: u.name }))
        .except(db.users.select((u) => ({ a: u.id })) as never)
        .toSQL();

    expect(query).toThrow(/Both sides of a set operation must project the same columns/);
  });
});

describe('getDate', () => {
  it('extracts the day of the month without adjusting it', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ day: u.createdAt.getDate() })).toSQL();

    // Both sides number the month from one, so unlike `getMonth` there is no
    // gap to close and the extraction stands alone.
    expect(text).toBe('SELECT EXTRACT(DAY FROM "t0"."created_at") AS "day" FROM "users" AS "t0"');
  });

  it('is the day of the month, not the day of the week', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ day: u.createdAt.getDate() })).toSQL();

    // `getDay` is the weekday and is a different field, spelled differently and
    // answered only by a provider. Nothing here should reach for it.
    expect(text).toContain('EXTRACT(DAY FROM');
    expect(text).not.toContain('DOW');
  });

  it('filters on a day of the month', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.createdAt.getDate() === 1).toSQL();

    expect(text).toContain('WHERE EXTRACT(DAY FROM "t0"."created_at") = $1');
    expect(values).toEqual([1]);
  });

  it('groups by month and day together', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => ({ month: u.createdAt.getMonth(), day: u.createdAt.getDate() }),
        (key, users) => ({ month: key.month, day: key.day, joined: users.count() }),
      )
      .toSQL();

    expect(text).toContain(
      'GROUP BY EXTRACT(MONTH FROM "t0"."created_at") - 1, EXTRACT(DAY FROM "t0"."created_at")',
    );
  });

  it('rejects a call given arguments', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          day: (u.createdAt as unknown as { getDate(n: number): number }).getDate(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getDate" expects 0 argument\(s\)/);
  });
});

describe('getMonth', () => {
  it('subtracts one, since JavaScript numbers months from zero', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ month: u.createdAt.getMonth() })).toSQL();

    expect(text).toBe(
      'SELECT EXTRACT(MONTH FROM "t0"."created_at") - 1 AS "month" FROM "users" AS "t0"',
    );
  });

  it('compares without needing parentheses of its own', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.createdAt.getMonth() === 0).toSQL();

    // `-` binds tighter than `=`, so the subtraction stands as written.
    expect(text).toContain('WHERE EXTRACT(MONTH FROM "t0"."created_at") - 1 = $1');
    expect(values).toEqual([0]);
  });

  it('parenthesises itself inside a tighter operator', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ quarter: u.createdAt.getMonth() * 3 })).toSQL();

    expect(text).toContain('(EXTRACT(MONTH FROM "t0"."created_at") - 1) * $1');
  });

  it('groups by year and month together', () => {
    const { db } = context();
    const { text } = db.users
      .groupBy(
        (u) => ({ year: u.createdAt.getFullYear(), month: u.createdAt.getMonth() }),
        (key, users) => ({ year: key.year, month: key.month, joined: users.count() }),
      )
      .toSQL();

    expect(text).toContain(
      'GROUP BY EXTRACT(YEAR FROM "t0"."created_at"), EXTRACT(MONTH FROM "t0"."created_at") - 1',
    );
  });

  it('rejects a call given arguments', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          month: (u.createdAt as unknown as { getMonth(n: number): number }).getMonth(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getMonth" expects 0 argument\(s\)/);
  });
});

describe('after generation', () => {
  const cursor = {
    id: 5,
    name: 'Ada',
    email: 'ada@example.com',
    age: 36,
    cityId: 1,
    isActive: true,
    createdAt: new Date(0),
  };

  it('seeks past the cursor rather than counting rows to skip', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.id)
      .after(cursor)
      .take(20)
      .toSQL();

    // The whole point in one statement: a WHERE an index can seek on, where
    // `skip(n)` would have read and discarded every row before this page.
    expect(text).toContain('WHERE "t0"."id" > $1 ORDER BY "t0"."id" ASC LIMIT 20');
    expect(values).toEqual([5]);
  });

  it('compares several keys the way a dictionary does', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.name)
      .thenBy((u) => u.id)
      .after(cursor)
      .toSQL();

    // Each key only settles the rows its predecessors tied on. A conjunction
    // of independent comparisons would drop every row that comes after on the
    // name while sitting below the cursor on the id, which is most of them.
    expect(text).toContain('WHERE "t0"."name" > $1 OR "t0"."name" = $1 AND "t0"."id" > $2');
    expect(values).toEqual(['Ada', 5]);
  });

  it('flips only the descending key, keeping the tie test alone', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .thenBy((u) => u.id)
      .after(cursor)
      .toSQL();

    // "After" in a descending ordering means a smaller value, and a tie is a
    // tie in either direction.
    expect(text).toContain('WHERE "t0"."age" < $1 OR "t0"."age" = $1 AND "t0"."id" > $2');
    expect(text).toContain('ORDER BY "t0"."age" DESC, "t0"."id" ASC');
  });

  it('numbers its own value past a query that already bound some', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age > p.min, { min: 18 })
      .orderBy((u) => u.id)
      .after(cursor)
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1 AND "t0"."id" > $2');
    expect(values).toEqual([18, 5]);
  });

  it('seeks past a scalar the query already unwrapped', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u) => u.age)
      .order()
      .after(36)
      .toSQL();

    // A scalar query's row is the value itself, since `materialize` unwraps it
    // out of the `value` column, so there is no property to read it off.
    expect(text).toContain('> $1');
    expect(values).toEqual([36]);
  });

  it('takes a cursor carrying only the sort keys', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.id)
      .after({ id: 5 })
      .toSQL();

    // Only the sort keys are read off the cursor, so the whole row is not
    // required. This is the shape a cursor round-tripped through a URL comes
    // back as, which is most of what keyset paging is used for.
    expect(text).toContain('WHERE "t0"."id" > $1');
    expect(values).toEqual([5]);
  });

  it('refuses a cursor with no value for a key the ordering names', () => {
    const { db } = context();

    expect(() =>
      db.users
        .orderBy((u) => u.name)
        .thenBy((u) => u.id)
        .after({ name: 'Ada' }),
    ).toThrow(/carrying no "id"/);
  });

  it('refuses a computed sort key, which the cursor never carried', () => {
    const { db } = context();

    expect(() => db.users.orderBy((u) => u.name.length).after(cursor)).toThrow(
      /"after" needs every sort key to be a plain property of the row/,
    );
  });

  it('refuses a null in the cursor, which SQL orders but cannot compare', () => {
    const { db } = context();

    // `cityId` is nullable. `city_id > NULL` is unknown rather than true, so
    // every remaining row would fail and the walk would stop a page early.
    expect(() => db.users.orderBy((u) => u.cityId).after({ ...cursor, cityId: null })).toThrow(
      /SQL orders nulls without being able to compare them/,
    );
  });

  it('faults the operator that was written, not the where it becomes', () => {
    const { db } = context();

    // Thrown when `after` is called rather than when the query is compiled, so
    // the stack points at the call site.
    expect(() => db.users.orderBy((u) => u.age * 2).after(cursor)).toThrow(/"after"/);
  });

  it('hands back an ordinary query, so no key can be added behind the cursor', () => {
    const { db } = context();
    const seeked = db.users.orderBy((u) => u.id).after(cursor);

    // The predicate was built against the keys the query had, so a `thenBy`
    // afterwards would order by something the cursor never accounted for.
    expect('thenBy' in seeked).toBe(false);
  });
});

describe('before generation', () => {
  const cursor = {
    id: 5,
    name: 'Ada',
    email: 'ada@example.com',
    age: 36,
    cityId: 1,
    isActive: true,
    createdAt: new Date(0),
  };

  it('seeks the other side of the cursor and reads outward from it', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.id)
      .before(cursor)
      .take(20)
      .toSQL();

    // Both halves matter, and the second is the one worth guarding. With the
    // ordering left as written this LIMIT would have taken the first twenty
    // rows of the table rather than the twenty sitting behind the cursor.
    expect(text).toContain('WHERE "t0"."id" < $1 ORDER BY "t0"."id" DESC LIMIT 20');
    expect(values).toEqual([5]);
  });

  it('is the strict mirror of after, so the pair partitions the sequence', () => {
    const { db } = context();
    const ordered = () => db.users.orderBy((u) => u.id);

    const forwards = ordered().after(cursor).toSQL().text;
    const backwards = ordered().before(cursor).toSQL().text;

    // Strict on both sides, so the cursor row belongs to neither page and a
    // caller stepping back and forth is never handed it twice.
    expect(forwards).toContain('WHERE "t0"."id" > $1');
    expect(backwards).toContain('WHERE "t0"."id" < $1');
  });

  it('flips every key without disturbing the dictionary comparison', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.name)
      .thenBy((u) => u.id)
      .before(cursor)
      .toSQL();

    // Each comparison turns and the guard structure does not: the tie test is
    // still an equality, since a tie is a tie in either direction.
    expect(text).toContain('WHERE "t0"."name" < $1 OR "t0"."name" = $1 AND "t0"."id" < $2');
    expect(text).toContain('ORDER BY "t0"."name" DESC, "t0"."id" DESC');
    expect(values).toEqual(['Ada', 5]);
  });

  it('reads a descending ordering back the ascending way', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .before(cursor)
      .toSQL();

    // "Before" in a descending ordering means a larger value, and the rows come
    // back ascending, that ordering being read from the cursor outward.
    expect(text).toContain('WHERE "t0"."age" > $1');
    expect(text).toContain('ORDER BY "t0"."age" ASC');
  });

  it('numbers its own value past a query that already bound some', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age > p.min, { min: 18 })
      .orderBy((u) => u.id)
      .before(cursor)
      .toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1 AND "t0"."id" < $2');
    expect(values).toEqual([18, 5]);
  });

  it('takes a cursor carrying only the sort keys', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.id)
      .before({ id: 5 })
      .toSQL();

    expect(text).toContain('WHERE "t0"."id" < $1');
    expect(values).toEqual([5]);
  });

  it('faults itself rather than after, whose machinery it borrows', () => {
    const { db } = context();

    // The three refusals are shared with `after`, so what is worth asserting is
    // that each names the operator the caller wrote and not the one underneath.
    expect(() => db.users.orderBy((u) => u.name.length).before(cursor)).toThrow(
      /"before" needs every sort key to be a plain property of the row/,
    );
    expect(() =>
      db.users
        .orderBy((u) => u.name)
        .thenBy((u) => u.id)
        .before({ name: 'Ada' }),
    ).toThrow(/"before" was given a cursor carrying no "id"/);
    expect(() => db.users.orderBy((u) => u.cityId).before({ ...cursor, cityId: null })).toThrow(
      /"before" was given a cursor whose "cityId" is null/,
    );
  });

  it('hands back an ordinary query, so no key can be added behind the cursor', () => {
    const { db } = context();
    const seeked = db.users.orderBy((u) => u.id).before(cursor);

    expect('thenBy' in seeked).toBe(false);
  });
});

describe('takeWhile generation', () => {
  const ordered = (db: ReturnType<typeof context>['db']) =>
    db.users.select((u) => ({ id: u.id, age: u.age })).orderBy((u) => u.id);

  it('counts failures in a window and keeps the rows before the first', () => {
    const { db } = context();
    const { text, values } = ordered(db)
      .takeWhile((u) => u.age < 30)
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "id", "t1"."age" AS "age" FROM (' +
        'SELECT "t0"."id" AS "id", "t0"."age" AS "age", ' +
        'SUM(CASE WHEN "t0"."age" < $1 THEN 0 ELSE 1 END) ' +
        'OVER (ORDER BY "t0"."id" ASC ROWS UNBOUNDED PRECEDING) AS "__sqlinqo_failed", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_failed" = 0 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
    expect(values).toEqual([30]);
  });

  it('windows over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .takeWhile((u) => u.isActive)
      .toSQL();

    expect(text).toContain(
      'OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC ROWS UNBOUNDED PRECEDING)',
    );
    expect(text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC)');
  });

  it('binds a value from the parameter bag', () => {
    const { db } = context();
    const { text, values } = ordered(db)
      .takeWhile((u, p) => u.age < p.max, { max: 30 })
      .toSQL();

    expect(text).toContain('CASE WHEN "t0"."age" < $1 THEN 0 ELSE 1 END');
    expect(values).toEqual([30]);
  });

  it('keeps the bookkeeping columns out of the result', () => {
    const { db } = context();
    const { text } = ordered(db)
      .takeWhile((u) => u.age < 30)
      .toSQL();

    // They appear only inside the derived table and in the clauses that read
    // them, never in the outer projection.
    expect(text).toMatch(/^SELECT "t1"\."id" AS "id", "t1"\."age" AS "age" FROM \(/);
  });

  it('filters the kept rows rather than the ones behind them', () => {
    const { db } = context();
    const { text } = ordered(db)
      .takeWhile((u) => u.age < 30)
      .where((u) => u.id > 2)
      .toSQL();

    expect(text).toContain('WHERE "t1"."__sqlinqo_failed" = 0 AND "t1"."id" > $2');
  });

  it('pages what it kept', () => {
    const { db } = context();
    const { text } = ordered(db)
      .takeWhile((u) => u.age < 30)
      .take(2)
      .toSQL();

    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC LIMIT 2');
  });

  it('counts what it kept, through the wrapping subquery', () => {
    const { db, driver } = context();
    driver.setRows([{ count: '2' }]);

    return ordered(db)
      .takeWhile((u) => u.age < 30)
      .count()
      .then((total) => {
        expect(total).toBe(2);

        const { text } = driver.lastStatement;
        expect(text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
        expect(text).toContain('WHERE "t1"."__sqlinqo_failed" = 0) AS "t2"');
        // Counting does not care what order the kept rows came in, so the
        // position ordering is stripped. The windows keep theirs, which is what
        // decides which rows are kept in the first place.
        expect(text).not.toContain('ORDER BY "t1"."__sqlinqo_position"');
        expect(text).toContain('OVER (ORDER BY "t0"."id" ASC ROWS UNBOUNDED PRECEDING)');
      });
  });
});

describe('skipWhile generation', () => {
  const ordered = (db: ReturnType<typeof context>['db']) =>
    db.users.select((u) => ({ id: u.id, age: u.age })).orderBy((u) => u.id);

  it('keeps the rows from the first failure onward', () => {
    const { db } = context();
    const { text, values } = ordered(db)
      .skipWhile((u) => u.age < 30)
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "id", "t1"."age" AS "age" FROM (' +
        'SELECT "t0"."id" AS "id", "t0"."age" AS "age", ' +
        'SUM(CASE WHEN "t0"."age" < $1 THEN 0 ELSE 1 END) ' +
        'OVER (ORDER BY "t0"."id" ASC ROWS UNBOUNDED PRECEDING) AS "__sqlinqo_failed", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_failed" > 0 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
    expect(values).toEqual([30]);
  });

  it('differs from takeWhile only in the comparison', () => {
    // One window answers both: the running count is zero before the first
    // failure and non-zero from it onward, so the two partition the sequence.
    const { db } = context();
    const taken = ordered(db)
      .takeWhile((u) => u.age < 30)
      .toSQL().text;
    const skipped = ordered(db)
      .skipWhile((u) => u.age < 30)
      .toSQL().text;

    expect(skipped).toBe(taken.replace('"__sqlinqo_failed" = 0', '"__sqlinqo_failed" > 0'));
  });

  it('binds a value from the parameter bag', () => {
    const { db } = context();
    const { text, values } = ordered(db)
      .skipWhile((u, p) => u.age < p.min, { min: 30 })
      .toSQL();

    expect(text).toContain('CASE WHEN "t0"."age" < $1 THEN 0 ELSE 1 END');
    expect(values).toEqual([30]);
  });

  it('windows over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .thenBy((u) => u.name)
      .skipWhile((u) => u.isActive)
      .toSQL();

    expect(text).toContain(
      'OVER (ORDER BY "t0"."age" DESC, "t0"."name" ASC ROWS UNBOUNDED PRECEDING)',
    );
  });

  it('pages what it kept', () => {
    const { db } = context();
    const { text } = ordered(db)
      .skipWhile((u) => u.age < 30)
      .skip(1)
      .take(2)
      .toSQL();

    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC LIMIT 2 OFFSET 1');
  });
});

describe('distinctBy generation', () => {
  it('numbers rows within each key and keeps the first', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, cityId: u.cityId }))
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "id", "t1"."cityId" AS "cityId" FROM (' +
        'SELECT "t0"."id" AS "id", "t0"."city_id" AS "cityId", ' +
        'ROW_NUMBER() OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."id" ASC) AS "__sqlinqo_rank", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_rank" = 1 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('reverses which row survives when the ordering is reversed', () => {
    const { db } = context();
    const first = db.users
      .orderBy((u) => u.createdAt)
      .distinctBy((u) => u.cityId)
      .toSQL().text;
    const last = db.users
      .orderByDescending((u) => u.createdAt)
      .distinctBy((u) => u.cityId)
      .toSQL().text;

    // Only the sort direction differs: the same window answers "earliest of
    // each city" and "latest of each city".
    expect(last).toBe(first.replaceAll('"t0"."created_at" ASC', '"t0"."created_at" DESC'));
  });

  it('partitions by every property of an object key', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => ({ city: u.cityId, active: u.isActive }))
      .toSQL();

    expect(text).toContain('PARTITION BY "t0"."city_id", "t0"."is_active" ORDER BY "t0"."id" ASC');
  });

  it('partitions over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .distinctBy((u) => u.cityId)
      .toSQL();

    expect(text).toContain('PARTITION BY "t0"."city_id" ORDER BY "t0"."age" ASC, "t0"."id" DESC');
  });

  it('joins a navigation the key follows', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .distinctBy((o) => o.user.name)
      .toSQL();

    // The join lives inside the derived table, which is the only place the
    // window can see it.
    expect(text).toContain(
      'FROM "sales"."orders" AS "t0" INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id") AS "t2"',
    );
    expect(text).toContain('PARTITION BY "t1"."name"');
  });

  it('keeps the bookkeeping columns out of the result', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, cityId: u.cityId }))
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."id" AS "id", "t1"\."cityId" AS "cityId" FROM \(/);
  });

  it('binds a value the key was built from', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => u.age > 30)
      .toSQL();

    // The key is projected into the window and compared there once, so the one
    // value it needs is bound once.
    expect(text).toContain('PARTITION BY "t0"."age" > $1');
    expect(values).toEqual([30]);
  });

  it('filters the surviving rows rather than the ones they stood for', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .where((u) => u.age > 21)
      .toSQL();

    // A row dropped for sharing a key is gone before this runs, so the filter
    // cannot promote the next row of that key into its place.
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" = 1 AND "t1"."age" > $1');
  });

  it('pages what survived', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .take(2)
      .toSQL();

    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC LIMIT 2');
  });

  it('counts what survived, through the wrapping subquery', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    const total = await db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .count();

    expect(total).toBe(3);
    expect(driver.lastStatement.text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
    expect(driver.lastStatement.text).toContain('WHERE "t1"."__sqlinqo_rank" = 1) AS "t2"');
  });

  it('is not distinct, which compares whole rows', () => {
    const { db } = context();
    const byKey = db.users
      .orderBy((u) => u.id)
      .distinctBy((u) => u.cityId)
      .toSQL().text;
    const whole = db.users.distinct().toSQL().text;

    expect(whole).toContain('SELECT DISTINCT');
    expect(byKey).not.toContain('SELECT DISTINCT');
  });

  it('refuses a plan built without an ordering', () => {
    // The typed API only offers the operator on an ordered query, so the guard
    // is reachable only by handing the compiler a plan built by hand. Without
    // an ordering the surviving row of each key would be whichever one the
    // database happened to reach first.
    const compile = () =>
      compileQuery(
        {
          kind: 'perKey',
          source: { kind: 'source', entity: User },
          key: toExpression((u: UserRow) => u.cityId, { rowParameterCount: 1 }),
          skip: 0,
          take: 1,
          operator: 'distinctBy',
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    // The node carries the operator's name, so the refusal is about the one the
    // caller wrote rather than about the window two operators share.
    expect(compile).toThrow(/"distinctBy" needs an ordering/);
  });
});

describe('reverse', () => {
  it('flips every sort key rather than wrapping the query', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .reverse()
      .toSQL();

    expect(text).toContain('ORDER BY "t0"."age" DESC, "t0"."id" ASC');
    // No window and no derived table: reversing an order costs nothing.
    expect(text).not.toContain('SELECT "t1"');
  });

  it('is the query it started as when applied twice', () => {
    const { db } = context();
    const ordered = db.users.orderBy((u) => u.age);

    expect(ordered.reverse().reverse().toSQL().text).toBe(ordered.toSQL().text);
  });

  it('pages from the other end', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.createdAt)
      .reverse()
      .take(3)
      .toSQL();

    // The three newest, which is the only way to reach the end of a sequence
    // that SQL can only page from the front of.
    expect(text).toContain('ORDER BY "t0"."created_at" DESC LIMIT 3');
  });

  it('appends a later key as a tiebreaker on the reversed order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .reverse()
      .thenBy((u) => u.id)
      .toSQL();

    // The new key breaks ties in the order as it now stands rather than being
    // reversed along with the ones that came before it.
    expect(text).toContain('ORDER BY "t0"."age" DESC, "t0"."id" ASC');
  });

  it('is the order a positional operator after it works in', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .reverse()
      .distinctBy((u) => u.cityId)
      .toSQL();

    // Reversing before `distinctBy` swaps which row of each key survives, which
    // only works because the window reads the ordering the query carries.
    expect(text).toContain('PARTITION BY "t0"."city_id" ORDER BY "t0"."age" DESC');
  });
});

describe('takeLast generation', () => {
  it('reads the rows backwards and hands them back forwards', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.createdAt)
      .takeLast(3)
      .toSQL();

    // Backwards inside, so the database stops at three rows rather than sorting
    // the table; forwards outside, over the three that survived.
    expect(text).toContain('ORDER BY "t0"."created_at" DESC LIMIT 3');
    expect(text).toContain('AS "t1" ORDER BY "t1"."__sqlinqo_sort_0" ASC');
  });

  it('is the rows reverse and take select, in the opposite order', () => {
    const { db } = context();
    const ordered = db.users.orderBy((u) => u.createdAt);

    const backwards = ordered.reverse().take(3).toSQL().text;
    const forwards = ordered.takeLast(3).toSQL().text;

    // The cheap query is what reads the rows here too: everything from the table
    // onward is the same clause, and the outer sort is what is added to it.
    const reached = backwards.slice(backwards.indexOf(' FROM '));
    expect(reached).toBe(' FROM "users" AS "t0" ORDER BY "t0"."created_at" DESC LIMIT 3');
    expect(forwards).toContain(reached + ') AS "t1"');
  });

  it('flips every sort key and restores every one', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .takeLast(2)
      .toSQL();

    expect(text).toContain('ORDER BY "t0"."age" DESC, "t0"."id" ASC LIMIT 2');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_sort_0" ASC, "t1"."__sqlinqo_sort_1" DESC');
  });

  it('carries a sort key that is an expression rather than a column', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.age * 2)
      .takeLast(2)
      .toSQL();

    // The outer sort cannot recompute the key, because the columns it was built
    // from are the derived table's rather than the entity's.
    expect(text).toContain('"t0"."age" * $1 AS "__sqlinqo_sort_0"');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_sort_0" ASC');
    expect(values).toEqual([2]);
  });

  it('carries a sort key reached through a navigation', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.user.name)
      .takeLast(2)
      .toSQL();

    // The join lives inside the derived table, which is the only place its
    // columns are in scope, so the key has to come out as a column of its own.
    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
    expect(text).toContain('"t1"."name" AS "__sqlinqo_sort_0"');
    expect(text).toContain('AS "t2" ORDER BY "t2"."__sqlinqo_sort_0" ASC');
  });

  it('keeps the carried keys out of the answer', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ who: u.name }))
      .orderBy((r) => r.who)
      .takeLast(2)
      .toSQL();

    // The outer select projects the caller's columns and nothing else, so the
    // bookkeeping never reaches a row or collides with a projected name.
    expect(text.slice(0, text.indexOf(' FROM '))).toBe('SELECT "t1"."who" AS "who"');
  });

  it('stops at the limit rather than numbering every row', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .takeLast(3)
      .toSQL();

    // A window could answer without the second sort, but only after numbering
    // the whole table, which is the cost the limit exists to avoid.
    expect(text).not.toContain('ROW_NUMBER');
    expect(text).not.toContain('OVER');
  });

  it('takes from the end of the rows paging already settled', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .take(10)
      .orderBy((u) => u.age)
      .takeLast(3)
      .toSQL();

    // The first ten by age, then the last three of those, rather than a limit
    // of three folded onto a limit of ten.
    expect(text).toContain('LIMIT 10');
    expect(text).toContain('LIMIT 3');
  });

  it('filters the rows it kept rather than the rows behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .takeLast(3)
      .where((u) => u.isActive)
      .toSQL();

    // The filter lands outside the limit, so it narrows the last three rather
    // than choosing which three the limit reaches.
    expect(text).toContain('LIMIT 3) AS "t1" WHERE "t1"."isActive"');
  });

  it('pages the rows it kept', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .takeLast(3)
      .take(2)
      .toSQL();

    // The page is taken from the last three, which is why the outer limit sits
    // outside the derived table rather than replacing the one inside it.
    expect(text).toContain('LIMIT 3) AS "t1"');
    expect(text.endsWith('ORDER BY "t1"."__sqlinqo_sort_0" ASC LIMIT 2')).toBe(true);
  });

  it('rejects a count that is not a whole number of rows', () => {
    const { db } = context();
    const ordered = db.users.orderBy((u) => u.age);

    expect(() => ordered.takeLast(-1).toSQL()).toThrow(/"takeLast" expects a non-negative integer/);
    expect(() => ordered.takeLast(2.5).toSQL()).toThrow(
      /"takeLast" expects a non-negative integer/,
    );
  });

  it('refuses a plan with no ordering to take the end of', () => {
    const compile = () =>
      compileQuery(
        {
          kind: 'last',
          source: { kind: 'source', entity: User },
          count: 3,
          take: true,
          // Unreachable through the typed API, which only offers this on an
          // ordered query.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"takeLast" needs an ordering/);
  });
});

describe('skipLast generation', () => {
  it('reads past the end of the flipped order and hands the rest back forwards', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.createdAt)
      .skipLast(3)
      .toSQL();

    // The same flip `takeLast` makes, cut with an OFFSET instead of a LIMIT.
    expect(text).toContain('ORDER BY "t0"."created_at" DESC OFFSET 3');
    expect(text).toContain('AS "t1" ORDER BY "t1"."__sqlinqo_sort_0" ASC');
  });

  it('is takeLast with one word changed', () => {
    const { db } = context();
    const ordered = db.users.orderBy((u) => u.createdAt);

    const kept = ordered.takeLast(3).toSQL().text;
    const dropped = ordered.skipLast(3).toSQL().text;

    // One compilation answers both, which is what makes them a partition of the
    // sequence rather than two operators that happen to be near each other.
    expect(dropped).toBe(kept.replace('DESC LIMIT 3', 'DESC OFFSET 3'));
  });

  it('flips every sort key and restores every one', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .skipLast(2)
      .toSQL();

    expect(text).toContain('ORDER BY "t0"."age" DESC, "t0"."id" ASC OFFSET 2');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_sort_0" ASC, "t1"."__sqlinqo_sort_1" DESC');
  });

  it('carries a sort key reached through a navigation', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.user.name)
      .skipLast(2)
      .toSQL();

    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
    expect(text).toContain('"t1"."name" AS "__sqlinqo_sort_0"');
    expect(text).toContain('AS "t2" ORDER BY "t2"."__sqlinqo_sort_0" ASC');
  });

  it('keeps the carried keys out of the answer', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ who: u.name }))
      .orderBy((r) => r.who)
      .skipLast(2)
      .toSQL();

    expect(text.slice(0, text.indexOf(' FROM '))).toBe('SELECT "t1"."who" AS "who"');
  });

  it('keeps everything for a count of none', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .skipLast(0)
      .toSQL();

    // An offset of zero drops nothing, which is the answer LINQ gives too.
    expect(text).toContain('OFFSET 0');
  });

  it('drops from the end of the rows paging already settled', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .take(10)
      .orderBy((u) => u.age)
      .skipLast(3)
      .toSQL();

    // The first ten by age, less the last three of those, rather than one
    // paging clause folded onto another.
    expect(text).toContain('LIMIT 10');
    expect(text).toContain('OFFSET 3');
  });

  it('filters the rows it kept rather than the rows behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .skipLast(3)
      .where((u) => u.isActive)
      .toSQL();

    expect(text).toContain('OFFSET 3) AS "t1" WHERE "t1"."isActive"');
  });

  it('rejects a count that is not a whole number of rows', () => {
    const { db } = context();
    const ordered = db.users.orderBy((u) => u.age);

    expect(() => ordered.skipLast(-1).toSQL()).toThrow(/"skipLast" expects a non-negative integer/);
    expect(() => ordered.skipLast(2.5).toSQL()).toThrow(
      /"skipLast" expects a non-negative integer/,
    );
  });

  it('refuses a plan with no ordering to count back from', () => {
    const compile = () =>
      compileQuery(
        {
          kind: 'last',
          source: { kind: 'source', entity: User },
          count: 3,
          take: false,
          // Unreachable through the typed API, which only offers this on an
          // ordered query.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"skipLast" needs an ordering/);
  });
});

describe('index generation', () => {
  it('numbers the rows from zero, where ROW_NUMBER counts from one', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ name: u.name }))
      .orderBy((r) => r.name)
      .index((r, position) => ({ name: r.name, position }))
      .toSQL();

    // LINQ's `Index` and JavaScript both count from zero, so the gap is closed
    // in the translation rather than left for the caller, as `getMonth` does.
    expect(text).toBe(
      'SELECT "t1"."name" AS "name", CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) AS "position" FROM ' +
        '(SELECT "t0"."name" AS "name", ROW_NUMBER() OVER (ORDER BY "t0"."name" ASC) ' +
        'AS "__sqlinqo_position" FROM "users" AS "t0") AS "t1" ' +
        'ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('numbers over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .index((u, position) => ({ who: u.name, position }))
      .toSQL();

    expect(text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC)');
  });

  it('numbers from the other end when the ordering is reversed', () => {
    const { db } = context();
    const forwards = db.users
      .orderBy((u) => u.age)
      .index((u, position) => ({ who: u.name, position }))
      .toSQL().text;
    const backwards = db.users
      .orderBy((u) => u.age)
      .reverse()
      .index((u, position) => ({ who: u.name, position }))
      .toSQL().text;

    // Only the sort direction differs, and it is what decides which row is
    // numbered zero.
    expect(backwards).toBe(forwards.replaceAll('"t0"."age" ASC', '"t0"."age" DESC'));
  });

  it('numbers a level down so the projection stays filterable', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.age)
      .index((u, position) => ({ name: u.name, position }))
      .where((r) => r.position > 5)
      .toSQL();

    // A window cannot appear in a WHERE, so the filter lands outside the derived
    // table the number was computed in, reading it as an ordinary column.
    expect(text).toContain('WHERE CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) > $1');
    expect(text).not.toContain('WHERE ROW_NUMBER');
    expect(values).toEqual([5]);
  });

  it('projects the position alone as a scalar', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .index((_u, position) => position)
      .toSQL();

    expect(text).toContain('SELECT CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) AS "value"');
  });

  it('hands the row back whole, without the number beside it', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, name: u.name }))
      .orderBy((r) => r.id)
      .index((r) => r)
      .toSQL();

    // The bookkeeping column stays inside the derived table, so a projection of
    // the row reads as the row it stands for.
    expect(text.slice(0, text.indexOf(' FROM '))).toBe(
      'SELECT "t1"."id" AS "id", "t1"."name" AS "name"',
    );
  });

  it('uses the position more than once without recomputing the window', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .index((_u, position) => ({ zero: position, one: position + 1 }))
      .toSQL();

    // The column is read twice and the window is computed once, which is what
    // the derived table buys.
    expect(text.match(/ROW_NUMBER/g)).toHaveLength(1);
    expect(text).toContain('CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) AS "zero"');
    expect(text).toContain('CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) + $1 AS "one"');
  });

  it('follows a navigation off the numbered row', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .index((o, position) => ({ who: o.user.name, position }))
      .toSQL();

    // The row is read back out of a derived table, and the scope over it now
    // stands for the entity rather than for a bag of column names: the foreign
    // key came out under its own name, so the join is emitted against the
    // derived table instead of the table underneath it.
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
  });

  it('joins off the derived table, not the table inside it', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .index((o, position) => ({ who: o.user.name, position }))
      .toSQL();

    // The distinction the translation turns on. `t0` is inside the derived
    // table and out of scope outside it, so a join naming it would not compile
    // at all; the key has to be re-resolved against the scope that is actually
    // in scope.
    expect(text).not.toContain('ON "t0"."user_id"');
  });

  it('refuses a plan with no ordering to number over', () => {
    const compile = () =>
      compileQuery(
        {
          kind: 'index',
          source: { kind: 'source', entity: User },
          projector: toExpression((u: UserRow, i: number) => ({ id: u.id, i }), {
            rowParameterCount: 2,
          }),
          // Unreachable through the typed API, which only offers this on an
          // ordered query.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"index" needs an ordering/);
  });
});

describe('select with a position', () => {
  it('compiles to the exact statement index does', () => {
    const { db } = context();
    const withSelect = db.users
      .orderBy((u) => u.age)
      .select((u, position) => ({ who: u.name, position }))
      .toSQL().text;
    const withIndex = db.users
      .orderBy((u) => u.age)
      .index((u, position) => ({ who: u.name, position }))
      .toSQL().text;

    expect(withSelect).toBe(withIndex);
  });

  it('still means the ordinary projection when the lambda takes one parameter', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .select((u) => ({ who: u.name }))
      .toSQL();

    expect(text).not.toContain('ROW_NUMBER');
    expect(text).toBe('SELECT "t0"."name" AS "who" FROM "users" AS "t0" ORDER BY "t0"."age" ASC');
  });

  it('keeps the params-object overload distinct, since that reads as a second argument', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.age)
      .select((u, p) => ({ who: u.name, bonus: u.age + p.extra }), { extra: 5 })
      .toSQL();

    expect(text).not.toContain('ROW_NUMBER');
    expect(text).toContain('"t0"."age" + $1 AS "bonus"');
    expect(values).toEqual([5]);
  });

  it('follows a navigation the same way index does', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .select((o, position) => ({ who: o.user.name, position }))
      .toSQL();

    // The indexed `select` is the same statement `index` builds, so whatever
    // the one can reach the other can.
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
  });
});

describe('where with a position', () => {
  it('compiles to a windowed statement, filtered on the outer select', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.age)
      .where((_u, position) => position < 3)
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "id", "t1"."name" AS "name", "t1"."email" AS "email", ' +
        '"t1"."age" AS "age", "t1"."cityId" AS "cityId", "t1"."isActive" AS "isActive", ' +
        '"t1"."createdAt" AS "createdAt" FROM (SELECT "t0"."id" AS "id", "t0"."name" AS "name", ' +
        '"t0"."email" AS "email", "t0"."age" AS "age", "t0"."city_id" AS "cityId", ' +
        '"t0"."is_active" AS "isActive", "t0"."created_at" AS "createdAt", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."age" ASC) AS "__sqlinqo_position" FROM "users" AS "t0") ' +
        'AS "t1" WHERE CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) < $1 ' +
        'ORDER BY "t1"."__sqlinqo_position" ASC',
    );
    expect(values).toEqual([3]);
  });

  it('still means the ordinary predicate when the lambda takes one parameter', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .where((u) => u.age > 18)
      .toSQL();

    expect(text).not.toContain('ROW_NUMBER');
    expect(text).toContain('WHERE "t0"."age" > $1');
  });

  it('keeps the params-object overload distinct, since that reads as a second argument', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderBy((u) => u.age)
      .where((u, p) => u.age > p.min, { min: 18 })
      .toSQL();

    expect(text).not.toContain('ROW_NUMBER');
    expect(text).toContain('WHERE "t0"."age" > $1');
    expect(values).toEqual([18]);
  });

  it('combines the row and its position in the same predicate', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .where((u, i) => u.isActive && i < 5)
      .toSQL();

    expect(text).toContain(
      'WHERE "t1"."isActive" AND CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) < $1',
    );
  });

  it('follows a navigation the same way index does', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .where(
        (o, position) =>
          (o as unknown as { user: { name: string } }).user.name === 'x' || position > 0,
      )
      .toSQL();

    // A navigation in a filter over a position joins off the derived table the
    // position was computed in, which is what makes this the same capability
    // `index` has rather than a second one.
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
  });

  it('still filters normally with an ordinary where chained after it', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .where((_u, i) => i < 10)
      .where((u) => u.isActive)
      .toSQL();

    expect(text).toContain(
      'WHERE CAST("t1"."__sqlinqo_position" - 1 AS INTEGER) < $1 AND "t1"."isActive"',
    );
  });
});

describe('count with a predicate', () => {
  it('counts only the matching rows, filtered inside the wrapping count', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    const active = await db.users.count((u) => u.isActive);

    expect(active).toBe(3);
    expect(driver.lastStatement.text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
    expect(driver.lastStatement.text).toContain('FROM "users" AS "t0" WHERE "t0"."is_active"');
  });

  it('binds a params object the way where does', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    await db.users.count((u, p) => u.age > p.min, { min: 18 });

    expect(driver.lastStatement.text).toContain('WHERE "t0"."age" > $1');
    expect(driver.lastStatement.values).toEqual([18]);
  });

  it('counts within a page rather than around it', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    await db.users.take(10).count((u) => u.isActive);

    // The page is taken first and the predicate reads the rows it left, which
    // is what `take(10).where(...).count()` already meant.
    expect(driver.lastStatement.text).toContain('LIMIT 10) AS "t1" WHERE "t1"."isActive"');
  });

  it('means an ordinary filter on an ordered query, not a position', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    await db.users.orderBy((u) => u.age).count((u) => u.isActive);

    // The filter is built without going through `where`, whose second
    // parameter on an ordered query is the row's position.
    expect(driver.lastStatement.text).not.toContain('ROW_NUMBER');
    expect(driver.lastStatement.text).toContain('WHERE "t0"."is_active"');
  });

  it('follows a navigation in the predicate, as the same filter would', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '3' }]);

    await db.orders.count((o) => o.user.name === 'Ada');

    expect(driver.lastStatement.text).toContain(
      'INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id" WHERE "t1"."name" = $1',
    );
  });

  it('still counts every row when no predicate is given', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '7' }]);

    const total = await db.users.count();

    expect(total).toBe(7);
    expect(driver.lastStatement.text).not.toContain('WHERE');
  });
});

describe('LEFT JOIN generation', () => {
  describe('include', () => {
    const withPages = (pages: Record<string, unknown>[][]) => {
      const driver = new PagingDriver(pages);
      const db = createDbContext({
        driver,
        dialect: testDialect,
        entities: { users: User, orders: Order, cities: City, lines: Line },
      });
      return { db, driver };
    };

    const twoOrders = [
      { id: 1, userId: 7, total: '10' },
      { id: 2, userId: 8, total: '20' },
    ];

    it('reads the rows and their collection in two statements', async () => {
      const { db, driver } = withPages([
        twoOrders,
        [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 1, sku: 'B' },
        ],
      ]);

      await db.orders.include((o) => o.lines).toArray();

      expect(driver.statements).toHaveLength(2);
      expect(driver.statements[0]!.text).toContain('FROM "sales"."orders"');
      expect(driver.statements[1]!.text).toContain(
        'FROM "order_lines" AS "t0" WHERE "t0"."order_id" IN ($1, $2)',
      );
    });

    it('matches the second statement against the keys the first returned', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders.include((o) => o.lines).toArray();

      expect(driver.statements[1]!.values).toEqual([1, 2]);
    });

    it('hands each row the children that point at it', async () => {
      const { db } = withPages([
        twoOrders,
        [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 1, sku: 'B' },
          { id: 102, orderId: 2, sku: 'C' },
        ],
      ]);

      const rows = await db.orders.include((o) => o.lines).toArray();

      expect(rows[0]!.lines.map((line) => line.sku)).toEqual(['A', 'B']);
      expect(rows[1]!.lines.map((line) => line.sku)).toEqual(['C']);
    });

    it('gives a row with no children an empty array rather than nothing', async () => {
      const { db } = withPages([twoOrders, [{ id: 100, orderId: 1, sku: 'A' }]]);

      const rows = await db.orders.include((o) => o.lines).toArray();

      // Always safe to iterate, which is what the row type has been claiming all
      // along and what a missing property would not have been.
      expect(rows[1]!.lines).toEqual([]);
    });

    it('never multiplies the rows it reads', async () => {
      const { db } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 1, sku: 'B' },
          { id: 102, orderId: 1, sku: 'C' },
        ],
      ]);

      const rows = await db.orders.include((o) => o.lines).toArray();

      // A LEFT JOIN would have answered three rows with the order repeated across
      // them, which is the cost two statements buy their way out of.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.lines).toHaveLength(3);
    });

    it('issues no second statement when the first found nothing', async () => {
      const { db, driver } = withPages([[]]);

      const rows = await db.orders.include((o) => o.lines).toArray();

      // An `IN` over no keys would have to be written as a constant false, and
      // the answer is already known.
      expect(rows).toEqual([]);
      expect(driver.statements).toHaveLength(1);
    });

    it('carries the inclusions through first', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 100, orderId: 1, sku: 'A' }],
      ]);

      const row = await db.orders.include((o) => o.lines).first();

      expect(row.lines.map((line) => line.sku)).toEqual(['A']);
      expect(driver.statements[0]!.text).toContain('LIMIT 1');
    });

    it('answers null from firstOrDefault when the rows ran out', async () => {
      const { db } = withPages([[]]);

      await expect(db.orders.include((o) => o.lines).firstOrDefault()).resolves.toBeNull();
    });

    it('shows the statement that reads the rows', () => {
      const { db } = withPages([[]]);

      const { text } = db.orders
        .where((o) => o.id > 0)
        .include((o) => o.lines)
        .toSQL();

      expect(text).toContain('FROM "sales"."orders" AS "t0" WHERE "t0"."id" > $1');
    });

    it('reads a reference in a second statement over the key it carries', async () => {
      const { db, driver } = withPages([twoOrders, [{ id: 7, name: 'Ada' }]]);

      await db.orders.include((o) => o.user).toArray();

      expect(driver.statements).toHaveLength(2);
      expect(driver.statements[1]!.text).toContain(
        'FROM "users" AS "t0" WHERE "t0"."id" IN ($1, $2)',
      );
      // The key is read off the row for a reference and off the related rows for
      // a collection, which is the only thing that differs between the two.
      expect(driver.statements[1]!.values).toEqual([7, 8]);
    });

    it('hands each row the one row its key points at', async () => {
      const { db } = withPages([
        twoOrders,
        [
          { id: 7, name: 'Ada' },
          { id: 8, name: 'Grace' },
        ],
      ]);

      const rows = await db.orders.include((o) => o.user).toArray();

      expect(rows[0]!.user.name).toBe('Ada');
      expect(rows[1]!.user.name).toBe('Grace');
    });

    it('gives a row whose reference is missing null rather than nothing', async () => {
      const { db } = withPages([twoOrders, [{ id: 7, name: 'Ada' }]]);

      const rows = await db.orders.include((o) => o.user).toArray();

      // Set before the second statement runs, so the property is there to read
      // whether or not the row on the other end is.
      expect(rows[1]!.user).toBeNull();
    });

    it('reads one key once however many rows carry it', async () => {
      const { db, driver } = withPages([
        [
          { id: 1, userId: 7, total: '10' },
          { id: 2, userId: 7, total: '20' },
        ],
        [{ id: 7, name: 'Ada' }],
      ]);

      const rows = await db.orders.include((o) => o.user).toArray();

      expect(driver.statements[1]!.values).toEqual([7]);
      // Both rows are handed the same row, which is what a join would have
      // returned twice.
      expect(rows[0]!.user.name).toBe('Ada');
      expect(rows[1]!.user.name).toBe('Ada');
    });

    it('leaves a null key out of the second statement', async () => {
      const { db, driver } = withPages([
        [
          { id: 1, name: 'Ada', cityId: null },
          { id: 2, name: 'Grace', cityId: 4 },
        ],
        [{ id: 4, name: 'Paris' }],
      ]);

      const rows = await db.users.include((u) => u.city).toArray();

      expect(driver.statements[1]!.values).toEqual([4]);
      expect(rows[0]!.city).toBeNull();
      expect(rows[1]!.city.name).toBe('Paris');
    });

    it('issues no second statement when every key is null', async () => {
      const { db, driver } = withPages([[{ id: 1, name: 'Ada', cityId: null }]]);

      const rows = await db.users.include((u) => u.city).toArray();

      expect(driver.statements).toHaveLength(1);
      expect(rows[0]!.city).toBeNull();
    });

    it('reads a reference and a collection in one statement each', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 7, name: 'Ada' }],
        [{ id: 100, orderId: 1, sku: 'A' }],
      ]);

      const rows = await db.orders
        .include((o) => o.user)
        .include((o) => o.lines)
        .toArray();

      expect(driver.statements).toHaveLength(3);
      expect(rows[0]!.user.name).toBe('Ada');
      expect(rows[0]!.lines.map((line) => line.sku)).toEqual(['A']);
    });

    it('filters the collection inside the statement that reads it', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.where((line) => line.sku === 'A'),
        )
        .toArray();

      // One statement still, with the caller's filter and the keys of the rows
      // that were read alongside each other.
      expect(driver.statements).toHaveLength(2);
      expect(driver.statements[1]!.text).toContain(
        'WHERE "t0"."sku" = $1 AND "t0"."order_id" IN ($2, $3)',
      );
      expect(driver.statements[1]!.values).toEqual(['A', 1, 2]);
    });

    it('takes the first rows of each parent rather than of the statement', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.orderByDescending((line) => line.id).take(2),
        )
        .toArray();

      const { text } = driver.statements[1]!;
      // A LIMIT would have handed the first two rows to whichever order they
      // belonged to. The window numbers each order's lines separately.
      expect(text).toContain(
        'ROW_NUMBER() OVER (PARTITION BY "t0"."order_id" ORDER BY "t0"."id" DESC)',
      );
      expect(text).toContain('WHERE "t1"."__sqlinqo_rank" <= 2');
      expect(text).not.toContain('LIMIT');
    });

    it('reads the keys before the window, so only the rows it asked for are numbered', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.orderBy((line) => line.id).take(1),
        )
        .toArray();

      // The IN is inside the derived table: numbering rows belonging to parents
      // this query never read would give away part of every parent's window.
      expect(driver.statements[1]!.text).toMatch(
        /FROM "order_lines" AS "t0" WHERE "t0"\."order_id" IN \(\$1, \$2\)\) AS "t1"/,
      );
    });

    it('pages within each parent when a skip is written too', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) =>
            lines
              .orderBy((line) => line.sku)
              .skip(1)
              .take(2),
        )
        .toArray();

      // Rows two and three of each parent, which is a range on the position
      // rather than the OFFSET a statement would have paged with.
      expect(driver.statements[1]!.text).toContain(
        'WHERE "t1"."__sqlinqo_rank" > 1 AND "t1"."__sqlinqo_rank" <= 3',
      );
    });

    it('keeps the rest of each parent when only a skip is written', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.orderBy((line) => line.sku).skip(1),
        )
        .toArray();

      expect(driver.statements[1]!.text).toContain('WHERE "t1"."__sqlinqo_rank" > 1');
      expect(driver.statements[1]!.text).not.toContain('<=');
    });

    it('numbers the key list past whatever the filter bound', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.where((line, p) => line.sku !== p.excluded, { excluded: 'Z' }),
        )
        .toArray();

      // The collection's own bag is p0, so the keys are p1. Two bags called p0
      // would have collided the moment they were merged.
      expect(driver.statements[1]!.values).toEqual(['Z', 1, 2]);
    });

    it('leaves an unfiltered include as the one statement it always was', async () => {
      const { db, driver } = withPages([twoOrders, []]);

      await db.orders.include((o) => o.lines).toArray();

      expect(driver.statements[1]!.text).toBe(
        'SELECT "t0"."id" AS "id", "t0"."order_id" AS "orderId", "t0"."sku" AS "sku" ' +
          'FROM "order_lines" AS "t0" WHERE "t0"."order_id" IN ($1, $2)',
      );
    });

    it('filters a reference too, which then reads as null', async () => {
      const { db, driver } = withPages([twoOrders, [{ id: 7, name: 'Ada' }]]);

      const rows = await db.orders
        .include(
          (o) => o.user,
          (users) => users.where((u) => u.isActive),
        )
        .toArray();

      expect(driver.statements[1]!.text).toContain('WHERE "t0"."is_active"');
      // Order 2's user was filtered out, which is the same answer as a key that
      // points at nothing.
      expect(rows[1]!.user).toBeNull();
    });

    it('shapes a second hop as readily as the first', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 100, orderId: 1, sku: 'A' }],
        [],
      ]);

      await db.orders
        .include((o) => o.lines)
        .thenInclude(
          (line) => line.catalogue,
          (catalogue) => catalogue.where((entry) => entry.title !== ''),
        )
        .toArray();

      expect(driver.statements[2]!.text).toContain('WHERE "t0"."title" <> $1');
    });

    it('offers no take until the collection is ordered, and no projection ever', () => {
      // Pinned as compile errors rather than as thrown ones, which is where they
      // belong: neither shape has a plan-node or a message behind it, because
      // neither can be written. The lambdas are never called.
      const early = (lines: IncludedCollection<EntityOf<typeof Line>>) =>
        // @ts-expect-error which rows are the first two is a question only an ordering answers.
        lines.take(2);

      const projected = (lines: IncludedCollection<EntityOf<typeof Line>>) =>
        // @ts-expect-error the related rows have to stay the entity the navigation claims.
        lines.select((line) => line.sku);

      expect(early).toBeTypeOf('function');
      expect(projected).toBeTypeOf('function');
    });

    it('refuses a count that is not a whole number of rows', () => {
      const { db } = withPages([[]]);

      expect(() =>
        db.orders.include(
          (o) => o.lines,
          (lines) => lines.orderBy((line) => line.id).take(-1),
        ),
      ).toThrow(/"take" on an included collection expects a non-negative integer but received -1/);

      expect(() =>
        db.orders.include(
          (o) => o.lines,
          (lines) => lines.orderBy((line) => line.id).skip(1.5),
        ),
      ).toThrow(/"skip" on an included collection expects a non-negative integer/);
    });

    it('reads a second hop from the rows the first one brought back', async () => {
      const { db } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 1, sku: 'B' },
        ],
        [
          { sku: 'A', title: 'Widget' },
          { sku: 'B', title: 'Gasket' },
        ],
      ]);

      const rows = await db.orders
        .include((o) => o.lines)
        .thenInclude((line) => line.catalogue)
        .toArray();

      expect(rows[0]!.lines.map((line) => line.catalogue.title)).toEqual(['Widget', 'Gasket']);
    });

    it('reads one statement per hop rather than one per row', async () => {
      const { db, driver } = withPages([
        [
          { id: 1, userId: 7, total: '10' },
          { id: 2, userId: 7, total: '20' },
        ],
        [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 2, sku: 'B' },
        ],
        [{ sku: 'A', title: 'Widget' }],
      ]);

      await db.orders
        .include((o) => o.lines)
        .thenInclude((line) => line.catalogue)
        .toArray();

      // Three statements for two hops, and the last asks after both lines at
      // once: the keys of a hop are collected before the next one runs, which is
      // the query per row this is meant to avoid.
      expect(driver.statements).toHaveLength(3);
      expect(driver.statements[2]!.text).toContain(
        'FROM "catalogue" AS "t0" WHERE "t0"."sku" IN ($1, $2)',
      );
      expect(driver.statements[2]!.values).toEqual(['A', 'B']);
    });

    it('follows a reference on the far side of a reference', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 7, name: 'Ada', cityId: 4 }],
        [{ id: 4, name: 'Paris' }],
      ]);

      const rows = await db.orders
        .include((o) => o.user)
        .thenInclude((u) => u.city)
        .toArray();

      expect(rows[0]!.user.city.name).toBe('Paris');
      expect(driver.statements).toHaveLength(3);
    });

    it('stops a chain whose hop found nothing', async () => {
      const { db, driver } = withPages([[{ id: 1, userId: 7, total: '10' }], []]);

      const rows = await db.orders
        .include((o) => o.lines)
        .thenInclude((line) => line.catalogue)
        .toArray();

      // No lines is no keys for the second hop, so the third statement is not
      // issued at all.
      expect(driver.statements).toHaveLength(2);
      expect(rows[0]!.lines).toEqual([]);
    });

    it('follows the hop last written, not the chain before it', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 100, orderId: 1, sku: 'A' }],
        [{ id: 7, name: 'Ada', cityId: 4 }],
        [{ id: 4, name: 'Paris' }],
      ]);

      const rows = await db.orders
        .include((o) => o.lines)
        .include((o) => o.user)
        .thenInclude((u) => u.city)
        .toArray();

      // The second chain is the one extended, the way thenBy extends the last
      // sort key rather than the first.
      expect(rows[0]!.lines.map((line) => line.sku)).toEqual(['A']);
      expect(rows[0]!.user.city.name).toBe('Paris');
      expect(driver.statements).toHaveLength(4);
    });

    it('carries a chain through a terminal that limits the rows', async () => {
      const { db, driver } = withPages([
        [{ id: 1, userId: 7, total: '10' }],
        [{ id: 100, orderId: 1, sku: 'A' }],
        [{ sku: 'A', title: 'Widget' }],
      ]);

      const row = await db.orders
        .include((o) => o.lines)
        .thenInclude((line) => line.catalogue)
        .first();

      expect(row.lines[0]!.catalogue.title).toBe('Widget');
      expect(driver.statements[0]!.text).toContain('LIMIT 1');
    });

    it('refuses a second hop that is not a navigation, naming thenInclude', () => {
      const { db } = withPages([[]]);

      expect(() =>
        db.orders.include((o) => o.lines).thenInclude((line) => line.sku as never),
      ).toThrow(
        /"sku" is not a collection or a reference on entity "Line"\. Navigations: catalogue\./,
      );
    });

    it('refuses a second hop that is not one of the row properties', () => {
      const { db } = withPages([[]]);

      expect(() => db.orders.include((o) => o.lines).thenInclude(() => [] as never)).toThrow(
        /"thenInclude" expects one of the row navigations/,
      );
    });

    it('refuses a selector that is neither a collection nor a reference', () => {
      const { db } = withPages([[]]);

      expect(() =>
        // @ts-expect-error a column is not a navigation, and the signature says so first.
        db.orders.include((o) => o.total),
      ).toThrow(
        /"total" is not a collection or a reference on entity "Order"\. Navigations: user, lines\./,
      );

      expect(() => db.orders.include((o) => o.total as never)).toThrow(
        /"total" is not a collection or a reference on entity "Order"\. Navigations: user, lines\./,
      );
    });

    it('refuses a query whose rows have been reshaped', () => {
      const { db } = withPages([[]]);

      expect(() => db.orders.select((o) => ({ id: o.id })).include((r) => r as never)).toThrow(
        /"include" needs rows that are still an entity/,
      );
    });
  });

  describe('asSingleStatement', () => {
    const withLines = () => {
      const driver = new FakeDriver();
      const db = createDbContext({
        driver,
        dialect: testDialect,
        entities: { users: User, orders: Order, cities: City, lines: Line },
      });
      return { db, driver };
    };

    const flatLines = [
      {
        id: 1,
        userId: 7,
        total: '10',
        __sqlinqo_include_id: 100,
        __sqlinqo_include_orderId: 1,
        __sqlinqo_include_sku: 'A',
      },
      {
        id: 1,
        userId: 7,
        total: '10',
        __sqlinqo_include_id: 101,
        __sqlinqo_include_orderId: 1,
        __sqlinqo_include_sku: 'B',
      },
      {
        id: 2,
        userId: 8,
        total: '20',
        __sqlinqo_include_id: null,
        __sqlinqo_include_orderId: null,
        __sqlinqo_include_sku: null,
      },
    ];

    it('compiles a collection to a LEFT JOIN with the matches under a prefix', () => {
      const { db } = withLines();
      const { text } = db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .toSQL();

      expect(text).toBe(
        'SELECT "t0"."id" AS "id", "t0"."user_id" AS "userId", "t0"."total" AS "total", ' +
          '"t1"."id" AS "__sqlinqo_include_id", "t1"."order_id" AS "__sqlinqo_include_orderId", ' +
          '"t1"."sku" AS "__sqlinqo_include_sku" FROM "sales"."orders" AS "t0" LEFT JOIN ' +
          '"order_lines" AS "t1" ON "t0"."id" = "t1"."order_id"',
      );
    });

    it('compiles a reference the same way', () => {
      const { db } = withLines();
      const { text } = db.orders
        .include((o) => o.user)
        .asSingleStatement()
        .toSQL();

      expect(text).toContain('LEFT JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
      expect(text).toContain('"t1"."name" AS "__sqlinqo_include_name"');
    });

    it('issues one statement rather than a second', async () => {
      const { db, driver } = withLines();
      driver.setRows(flatLines);

      await db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .toArray();

      expect(driver.statements).toHaveLength(1);
    });

    it('nests the matches under the property, recognising the same parent by primary key', async () => {
      const { db, driver } = withLines();
      driver.setRows(flatLines);

      const rows = await db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: 1,
        lines: [
          { id: 100, orderId: 1, sku: 'A' },
          { id: 101, orderId: 1, sku: 'B' },
        ],
      });
    });

    it('gives a row with no matches an empty array', async () => {
      const { db, driver } = withLines();
      driver.setRows(flatLines);

      const rows = await db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .toArray();

      expect(rows[1]).toMatchObject({ id: 2, lines: [] });
    });

    it('gives a row with no matched reference null', async () => {
      const { db, driver } = withLines();
      driver.setRows([
        { id: 2, userId: 8, total: '20', __sqlinqo_include_id: null, __sqlinqo_include_name: null },
      ]);

      const rows = await db.orders
        .include((o) => o.user)
        .asSingleStatement()
        .toArray();

      expect(rows[0]!.user).toBeNull();
    });

    it('reads a where-only shape inside the joined side', () => {
      const { db } = withLines();
      const { text, values } = db.orders
        .include(
          (o) => o.lines,
          (lines) => lines.where((l) => l.sku === 'A'),
        )
        .asSingleStatement()
        .toSQL();

      expect(text).toContain(
        'LEFT JOIN (SELECT "t1"."id" AS "id", "t1"."order_id" AS "orderId", ' +
          '"t1"."sku" AS "sku" FROM "order_lines" AS "t1" WHERE "t1"."sku" = $1) AS "t2" ' +
          'ON "t0"."id" = "t2"."orderId"',
      );
      expect(values).toEqual(['A']);
    });

    it('collapses several matches into one row before first and single count them', async () => {
      const { db, driver } = withLines();
      driver.setRows(flatLines.slice(0, 2)); // two flat rows, one parent

      const row = await db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .single();

      expect(row.lines).toHaveLength(2);
    });

    it('limits the outer side, not the flat rows, for first', async () => {
      const { db, driver } = withLines();
      driver.setRows(flatLines.slice(0, 1));

      await db.orders
        .include((o) => o.lines)
        .asSingleStatement()
        .first();

      expect(driver.lastStatement.text).toContain('LIMIT 1');
    });

    it('rejects a chained thenInclude', () => {
      const { db } = withLines();

      expect(() =>
        db.orders
          .include((o) => o.lines)
          .thenInclude((l) => l.catalogue)
          .asSingleStatement(),
      ).toThrow(/no "thenInclude" written after it/);
    });

    it('rejects a second, independent chain', () => {
      const { db } = withLines();

      expect(() =>
        db.orders
          .include((o) => o.lines)
          .include((o) => o.user)
          .asSingleStatement(),
      ).toThrow(/exactly one "include", and this query has 2/);
    });

    it('rejects a shape ordered or limited per parent', () => {
      const { db } = withLines();

      expect(() =>
        db.orders
          .include(
            (o) => o.lines,
            (lines) => lines.orderBy((l) => l.id).take(2),
          )
          .asSingleStatement(),
      ).toThrow(/needs a LATERAL join this does not build yet/);
    });

    it('rejects an entity with no declared primary key', () => {
      const NoKey = defineEntity({
        name: 'NoKey',
        columns: { id: { type: 'int' } },
        relations: { lines: collection(() => Line, 'orderId', { to: 'id' }) },
      });
      const db = createDbContext({
        driver: new FakeDriver(),
        dialect: testDialect,
        entities: { noKeys: NoKey },
      });

      expect(() => db.noKeys.include((n) => n.lines).asSingleStatement()).toThrow(
        /"asSingleStatement" needs entity "NoKey" to declare a primary key/,
      );
    });
  });

  describe('nested join projection', () => {
    const withLines = () => {
      const driver = new FakeDriver();
      const db = createDbContext({
        driver,
        dialect: testDialect,
        entities: { users: User, orders: Order, cities: City, lines: Line },
      });
      return { db, driver };
    };

    it('compiles a whole row embedded as a property into prefixed columns', () => {
      const { db } = withLines();
      const { text } = db.orders
        .join(
          db.users,
          (o) => o.userId,
          (u) => u.id,
          (o, u) => ({ order: o, user: u }),
        )
        .toSQL();

      expect(text).toBe(
        'SELECT "t0"."id" AS "__sqlinqo_nested_order__id", ' +
          '"t0"."user_id" AS "__sqlinqo_nested_order__userId", ' +
          '"t0"."total" AS "__sqlinqo_nested_order__total", ' +
          '"t1"."id" AS "__sqlinqo_nested_user__id", "t1"."name" AS "__sqlinqo_nested_user__name", ' +
          '"t1"."email" AS "__sqlinqo_nested_user__email", "t1"."age" AS "__sqlinqo_nested_user__age", ' +
          '"t1"."city_id" AS "__sqlinqo_nested_user__cityId", ' +
          '"t1"."is_active" AS "__sqlinqo_nested_user__isActive", ' +
          '"t1"."created_at" AS "__sqlinqo_nested_user__createdAt" ' +
          'FROM "sales"."orders" AS "t0" INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"',
      );
    });

    it('folds the flat, prefixed columns back into the object a caller named', async () => {
      const { db, driver } = withLines();
      driver.setRows([
        {
          __sqlinqo_nested_order__id: 1,
          __sqlinqo_nested_order__userId: 7,
          __sqlinqo_nested_order__total: '10',
          __sqlinqo_nested_user__id: 7,
          __sqlinqo_nested_user__name: 'Ada',
        },
      ]);

      const rows = await db.orders
        .join(
          db.users,
          (o) => o.userId,
          (u) => u.id,
          (o, u) => ({ order: o, user: u }),
        )
        .toArray();

      expect(rows).toEqual([
        { order: { id: 1, userId: 7, total: '10' }, user: { id: 7, name: 'Ada' } },
      ]);
    });

    it('mixes a nested embed with an ordinary column in the same projection', () => {
      const { db } = withLines();
      const { text } = db.orders
        .join(
          db.users,
          (o) => o.userId,
          (u) => u.id,
          (o, u) => ({ order: o, name: u.name }),
        )
        .toSQL();

      expect(text).toContain('"t0"."total" AS "__sqlinqo_nested_order__total"');
      expect(text).toContain('"t1"."name" AS "name"');
    });

    it('works from select as well as a join result selector', async () => {
      const { db, driver } = withLines();
      driver.setRows([
        {
          __sqlinqo_nested_order__id: 1,
          __sqlinqo_nested_order__userId: 7,
          __sqlinqo_nested_order__total: '10',
        },
      ]);

      const rows = await db.orders.select((o) => ({ order: o })).toArray();

      expect(rows).toEqual([{ order: { id: 1, userId: 7, total: '10' } }]);
    });

    it('rejects a further operator reading a property of the embed', () => {
      const { db } = withLines();

      const query = () =>
        db.orders
          .join(
            db.users,
            (o) => o.userId,
            (u) => u.id,
            (o, u) => ({ order: o, user: u }),
          )
          .where((row) => (row as unknown as { order: { id: number } }).order.id > 0)
          .toSQL();

      expect(query).toThrow(
        /"order" was embedded as a nested object by this projection, so it has no property/,
      );
    });
  });

  describe('intersectBy generation', () => {
    it('keeps the rows whose key is found', () => {
      const { db } = context();
      const { text } = db.users
        .intersectBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL();

      expect(text).toContain(
        'WHERE EXISTS (SELECT 1 AS "__sqlinqo_exists" FROM "cities" AS "t1" ' +
          'WHERE "t0"."city_id" = "t1"."id"',
      );
    });

    it('is exceptBy with the negation removed', () => {
      const { db } = context();
      const kept = db.users
        .intersectBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL().text;
      const dropped = db.users
        .exceptBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL().text;

      // One compilation answers both, which is what makes them a partition of the
      // query rather than two operators that happen to look alike.
      expect(dropped).toBe(kept.replace('WHERE EXISTS', 'WHERE NOT EXISTS'));
    });

    it('never multiplies a row, however many times the key is found', () => {
      const { db } = context();
      const { text } = db.users
        .intersectBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL();

      // The reason to reach for this over a join that projects the outer row
      // back: EXISTS asks whether a row is there and never reads it.
      expect(text).not.toContain('JOIN');
      expect(text).toContain('SELECT 1 AS "__sqlinqo_exists"');
    });

    it('matches a null key against a null key', () => {
      const { db } = context();
      const { text } = db.users
        .intersectBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL();

      // As LINQ does and as SQL's own INTERSECT does, unlike a bare comparison.
      expect(text).toContain('"t0"."city_id" IS NULL AND "t1"."id" IS NULL');
    });

    it('pairs the parts of a composite key by name', () => {
      const { db } = context();
      const { text } = db.users
        .intersectBy(
          db.cities,
          (u) => ({ a: u.cityId, b: u.name }),
          (c) => ({ b: c.name, a: c.id }),
        )
        .toSQL();

      // Written in a different order on each side and still paired by what each
      // part means, which is `alignColumns`' lesson.
      expect(text).toContain('"t0"."city_id" = "t1"."id"');
      expect(text).toContain('"t0"."name" = "t1"."name"');
    });

    it('names the operator that was written when the keys disagree', () => {
      const { db } = context();
      const query = () =>
        db.users
          .intersectBy(
            db.cities,
            (u) => u.cityId,
            (c) => ({ a: c.id }) as never,
          )
          .toSQL();

      expect(query).toThrow(/"intersectBy" compares the two keys part by part/);
    });

    it('filters the rows paging already settled', () => {
      const { db } = context();
      const { text } = db.users
        .orderBy((u) => u.id)
        .take(10)
        .intersectBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toSQL();

      // A filter after paging runs over the rows the limit settled on.
      expect(text).toContain('LIMIT 10) AS "t1" WHERE EXISTS');
    });
  });

  describe('countBy generation', () => {
    it('groups by the key and counts each group', () => {
      const { db } = context();
      const { text } = db.users.countBy((u) => u.cityId).toSQL();

      // The same GROUP BY `groupBy` would compile, with the one result selector
      // it is most often given, so there is no plan node behind this.
      expect(text).toBe(
        'SELECT "t0"."city_id" AS "key", COUNT(*) AS "count" FROM "users" AS "t0" ' +
          'GROUP BY "t0"."city_id"',
      );
    });

    it('counts by an expression, not only a column', () => {
      const { db } = context();
      const { text, values } = db.users.countBy((u) => u.age > 30).toSQL();

      expect(text).toContain('SELECT "t0"."age" > $1 AS "key"');
      expect(text).toContain('GROUP BY "t0"."age" > $1');
      expect(values).toEqual([30]);
    });

    it('counts by a key reached through a navigation', () => {
      const { db } = context();
      const { text } = db.orders.countBy((o) => o.user.name).toSQL();

      expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
      expect(text).toContain('GROUP BY "t1"."name"');
    });

    it('counts only the rows a filter left', () => {
      const { db } = context();
      const { text } = db.users
        .where((u) => u.isActive)
        .countBy((u) => u.cityId)
        .toSQL();

      expect(text).toContain('WHERE "t0"."is_active" GROUP BY "t0"."city_id"');
    });

    it('is ordered and paged like any other query', () => {
      const { db } = context();
      const { text } = db.users
        .countBy((u) => u.cityId)
        .orderByDescending((row) => row.count)
        .take(3)
        .toSQL();

      // The commonest thing to do with a count, and it needs nothing of its own:
      // what comes back is a `Queryable` like any other.
      expect(text).toContain('GROUP BY "t0"."city_id" ORDER BY COUNT(*) DESC LIMIT 3');
    });

    it('refuses a composite key, which has no column to sit in', () => {
      const { db } = context();

      expect(() => db.users.countBy((u) => ({ city: u.cityId, active: u.isActive }))).toThrow(
        /"countBy" puts the key in a single column/,
      );
    });

    it('faults the operator that was written, not the groupBy behind it', () => {
      const { db } = context();

      // Thrown when the operator is called rather than when the query is
      // compiled, so the stack points at the call site.
      expect(() => db.users.countBy((u) => ({ a: u.id }))).toThrow(/"countBy"/);
    });
  });

  describe('sumBy generation', () => {
    it('groups by the key and totals the value beside it', () => {
      const { db } = context();
      const { text } = db.orders
        .sumBy(
          (o) => o.userId,
          (o) => o.total,
        )
        .toSQL();

      // `countBy`'s statement with a SUM where the COUNT(*) was, which is the
      // whole of the difference: the same GROUP BY, and no plan node behind it.
      expect(text).toBe(
        'SELECT "t0"."user_id" AS "key", SUM("t0"."total") AS "sum" ' +
          'FROM "sales"."orders" AS "t0" GROUP BY "t0"."user_id"',
      );
    });

    it('totals an expression, not only a column', () => {
      const { db } = context();
      const { text, values } = db.users
        .sumBy(
          (u) => u.cityId,
          (u) => u.age * 2,
        )
        .toSQL();

      expect(text).toContain('SUM("t0"."age" * $1) AS "sum"');
      expect(values).toEqual([2]);
    });

    it('keys by an expression, as countBy does', () => {
      const { db } = context();
      const { text, values } = db.users
        .sumBy(
          (u) => u.age > 30,
          (u) => u.age,
        )
        .toSQL();

      expect(text).toContain('SELECT "t0"."age" > $1 AS "key"');
      expect(text).toContain('GROUP BY "t0"."age" > $1');
      expect(values).toEqual([30]);
    });

    it('keys by a value reached through a navigation', () => {
      const { db } = context();
      const { text } = db.orders
        .sumBy(
          (o) => o.user.name,
          (o) => o.total,
        )
        .toSQL();

      expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
      expect(text).toContain('GROUP BY "t1"."name"');
    });

    it('totals a value reached through a navigation', () => {
      const { db } = context();
      const { text } = db.orders
        .sumBy(
          (o) => o.userId,
          (o) => o.user.age,
        )
        .toSQL();

      // The value selector reaches the same joins the key selector would, since
      // both are translated against the rows behind the group.
      expect(text).toContain('INNER JOIN "users" AS "t1"');
      expect(text).toContain('SUM("t1"."age") AS "sum"');
    });

    it('totals only the rows a filter left', () => {
      const { db } = context();
      const { text } = db.users
        .where((u) => u.isActive)
        .sumBy(
          (u) => u.cityId,
          (u) => u.age,
        )
        .toSQL();

      expect(text).toContain('WHERE "t0"."is_active" GROUP BY "t0"."city_id"');
    });

    it('is ordered and paged like any other query', () => {
      const { db } = context();
      const { text } = db.users
        .sumBy(
          (u) => u.cityId,
          (u) => u.age,
        )
        .orderByDescending((row) => row.sum)
        .take(3)
        .toSQL();

      // What comes back is an ordinary Queryable, so the commonest thing to do
      // with a total needs nothing of its own.
      expect(text).toContain('GROUP BY "t0"."city_id" ORDER BY SUM("t0"."age") DESC LIMIT 3');
    });

    it('lets a value selector shadow the names the built selector uses', () => {
      const { db } = context();
      const { text } = db.users
        .sumBy(
          (u) => u.cityId,
          (key) => key.age,
        )
        .toSQL();

      // The projector this builds names its own parameters `key` and `group`. A
      // caller's lambda naming its row `key` shadows the first, which is what
      // the same lambda written by hand inside a `groupBy` would do and what
      // JavaScript's own scoping would do: `key.age` is the row's age.
      expect(text).toContain('SUM("t0"."age") AS "sum"');
      expect(text).not.toContain('SUM("t0"."city_id")');
    });

    it("emits a bare SUM rather than the sum terminal's COALESCE", () => {
      const { db } = context();
      const { text } = db.users
        .sumBy(
          (u) => u.cityId,
          (u) => u.age,
        )
        .toSQL();

      // The standalone `sum` terminal wraps its aggregate to answer zero for an
      // empty sequence. A group is never empty, and widening the sugar past the
      // `g.sum(...)` it stands for would make the two spellings differ.
      expect(text).not.toContain('COALESCE');
    });

    it('totals a nullable column, which SQL adds up by skipping the nulls', () => {
      const { db } = context();
      const { text } = db.users
        .sumBy(
          (u) => u.isActive,
          (u) => u.cityId,
        )
        .toSQL();

      // `cityId` is nullable, so the value selector returns `number | null`.
      // Refusing that in the type would make an ordinary statement unwritable
      // while the `sum` terminal accepted the very same selector, and it is the
      // only way the all-null group this operator documents can be written at
      // all. It compiles here rather than needing a cast.
      expect(text).toContain('SUM("t0"."city_id") AS "sum"');
    });

    it('refuses a composite key, which has no column to sit in', () => {
      const { db } = context();

      expect(() =>
        db.users.sumBy(
          (u) => ({ city: u.cityId, active: u.isActive }),
          (u) => u.age,
        ),
      ).toThrow(/"sumBy" puts the key in a single column/);
    });

    it('faults the operator that was written, not the groupBy behind it', () => {
      const { db } = context();

      // Thrown when the operator is called rather than when the query is
      // compiled, so the stack points at the call site.
      expect(() =>
        db.users.sumBy(
          (u) => ({ a: u.id }),
          (u) => u.age,
        ),
      ).toThrow(/"sumBy"/);
    });
  });

  describe('defaultIfEmpty generation', () => {
    it('left-joins the query onto a source of one row', () => {
      const { db } = context();
      const { text } = db.users
        .select((u) => ({ name: u.name }))
        .defaultIfEmpty()
        .toSQL();

      // Match nothing and the one row survives with the query's columns null;
      // match anything and it is multiplied away by the rows that matched.
      expect(text).toBe(
        'SELECT "t2"."name" AS "name" FROM (SELECT 1) AS "t1" LEFT JOIN ' +
          '(SELECT "t0"."name" AS "name" FROM "users" AS "t0") AS "t2" ON 1 = 1',
      );
    });

    it('reads the query once', () => {
      const { db } = context();
      const { text } = db.users
        .where((u) => u.isActive)
        .defaultIfEmpty()
        .toSQL();

      // The obvious spelling, a UNION ALL against a NOT EXISTS guard, would name
      // the table twice and run the filter twice with it.
      expect(text.match(/"users"/g)).toHaveLength(1);
      expect(text).not.toContain('UNION');
      expect(text).not.toContain('EXISTS');
    });

    it('carries the ordering out of the derived table', () => {
      const { db } = context();
      const { text } = db.users
        .orderBy((u) => u.age)
        .defaultIfEmpty()
        .toSQL();

      // An ordering inside a derived table is not guaranteed to survive it.
      expect(text).toContain('"t0"."age" AS "__sqlinqo_sort_0"');
      expect(text).toContain('ON 1 = 1 ORDER BY "t2"."__sqlinqo_sort_0" ASC');
    });

    it('drops an inner ordering that decides nothing', () => {
      const { db } = context();
      const { text } = db.users
        .orderBy((u) => u.age)
        .defaultIfEmpty()
        .toSQL();

      // Reapplied outside, so repeating it inside would only buy a second sort.
      expect(text).not.toContain('FROM "users" AS "t0" ORDER BY');
    });

    it('keeps an inner ordering a limit depends on', () => {
      const { db } = context();
      const { text } = db.users
        .orderBy((u) => u.age)
        .take(5)
        .defaultIfEmpty()
        .toSQL();

      // Here the ordering says which five rows the limit keeps, so it cannot be
      // moved outside the derived table the limit lives in.
      expect(text).toContain('FROM "users" AS "t0" ORDER BY "t0"."age" ASC LIMIT 5');
      expect(text).toContain('ORDER BY "t2"."__sqlinqo_sort_0" ASC');
    });

    it('defaults a scalar projection to one null value', () => {
      const { db } = context();
      const { text } = db.users
        .select((u) => u.name)
        .defaultIfEmpty()
        .toSQL();

      // The scalar stays wrapped in its `value` column, which the materializer
      // unwraps, so an empty query reads back as a single null.
      expect(text).toContain('SELECT "t2"."value" AS "value"');
    });

    it('defaults a grouped query, which can legitimately return no groups', () => {
      const { db } = context();
      const { text } = db.orders
        .groupBy(
          (o) => o.userId,
          (who, orders) => ({ who, n: orders.count() }),
        )
        .defaultIfEmpty()
        .toSQL();

      expect(text).toContain('GROUP BY "t0"."user_id") AS "t2" ON 1 = 1');
    });

    it('filters the defaulted sequence rather than the rows behind it', () => {
      const { db } = context();
      const { text } = db.users
        .defaultIfEmpty()
        .where((u) => u.age !== null)
        .toSQL();

      // The filter lands outside the join, which is what lets it inspect the
      // default row, and equally what lets it drop that row.
      expect(text).toContain('ON 1 = 1 WHERE "t2"."age" IS NOT NULL');
    });

    it('spells the one-row source through the dialect', () => {
      const driver = new FakeDriver();
      const db = createDbContext({
        driver,
        dialect: new DualDialect(),
        entities: { users: User },
      });

      const { text } = db.users.defaultIfEmpty().toSQL();

      // A `SELECT` with no `FROM` is a common extension rather than standard SQL,
      // so a database that insists on a table to select from names its own.
      expect(text).toContain('FROM "dual" AS "t1" LEFT JOIN');
      expect(text).not.toContain('(SELECT 1)');
    });

    it('answers a caller-chosen default rather than nulls', () => {
      const { db } = context();
      const { text, values } = db.users
        .select((u) => ({ name: u.name }))
        .defaultIfEmpty({ name: 'Guest' })
        .toSQL();

      // A literal witness inside the derived table is what tells a real row
      // from a missing one, since a real row's own columns can be null too.
      expect(text).toContain('1 AS "__sqlinqo_present"');
      expect(text).toContain(
        'CASE WHEN "t2"."__sqlinqo_present" IS NULL THEN $1 ELSE "t2"."name" END AS "name"',
      );
      expect(values).toEqual(['Guest']);
    });

    it('leaves a real row untouched even where one of its own columns is null', async () => {
      const { db, driver } = context();
      driver.setRows([{ name: null }]);

      const rows = await db.users
        .select((u) => ({ name: u.name }))
        .defaultIfEmpty({ name: 'Guest' })
        .toArray();

      // The witness says the row is real, so its own null survives rather than
      // being replaced by the default meant for a row that never matched.
      expect(rows).toEqual([{ name: null }]);
    });

    it('defaults a scalar projection to a caller-chosen value', () => {
      const { db } = context();
      const { text, values } = db.users
        .select((u) => u.name)
        .defaultIfEmpty('Guest')
        .toSQL();

      expect(text).toContain(
        'CASE WHEN "t2"."__sqlinqo_present" IS NULL THEN $1 ELSE "t2"."value" END AS "value"',
      );
      expect(values).toEqual(['Guest']);
    });
  });

  it('emits a LEFT JOIN', () => {
    const { db } = context();
    const { text } = db.users
      .leftJoin(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "name", "t1"."total" AS "total" FROM "users" AS "t0" ' +
        'LEFT JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"',
    );
  });

  it('differs from an inner join only in the keyword', () => {
    const { db } = context();

    const inner = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL().text;

    const outer = db.users
      .leftJoin(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL().text;

    expect(outer).toBe(inner.replace('INNER JOIN', 'LEFT JOIN'));
  });

  it('pushes a filtered joined side into a derived table', () => {
    // The filter has to run before the match, or it would drop the very rows a
    // left join exists to keep.
    const { db } = context();
    const { text } = db.users
      .leftJoin(
        db.orders.where((o) => o.userId > 100),
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toMatch(
      /LEFT JOIN \(SELECT .* WHERE "t1"\."user_id" > \$1\) AS "t2" ON "t0"\."id" = "t2"\."userId"/,
    );
  });

  it('settles paging on the outer side before joining', () => {
    const { db } = context();
    const { text } = db.users
      .take(10)
      .leftJoin(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toSQL();

    expect(text).toMatch(/FROM \(SELECT .* LIMIT 10\) AS "t1" LEFT JOIN /);
  });

  it('chains with an inner join, each keeping its own kind', () => {
    const { db } = context();
    const { text } = db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ cityId: u.cityId, total: o.total }),
      )
      .leftJoin(
        db.cities,
        (r) => r.cityId,
        (c) => c.id,
        (r, c) => ({ city: c.name, total: r.total }),
      )
      .toSQL();

    expect(text).toContain('INNER JOIN "sales"."orders" AS "t1"');
    expect(text).toContain('LEFT JOIN "cities" AS "t2"');
  });

  it('refuses to join across two contexts, naming the operator', () => {
    const { db } = context();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { orders: Order },
    });

    expect(() =>
      db.users.leftJoin(
        other.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      ),
    ).toThrow(/"leftJoin"/);
  });
});

describe('RIGHT JOIN generation', () => {
  describe('index materialization', () => {
    it('hands back the positions themselves when the projector is the position', async () => {
      const { db, driver } = context();
      driver.setRows([{ value: 0 }, { value: 1 }]);

      const rows = await db.users
        .orderBy((u) => u.age)
        .index((_u, position) => position)
        .toArray();

      // The compiler aliases this projection `value`, so the rows have to be
      // unwrapped on the way out or the caller reads { value: 0 } instead of 0.
      expect(rows).toEqual([0, 1]);
    });

    it('keeps a projected object as an object', async () => {
      const { db, driver } = context();
      driver.setRows([{ who: 'Ada', position: 0 }]);

      const rows = await db.users
        .orderBy((u) => u.age)
        .index((u, position) => ({ who: u.name, position }))
        .toArray();

      expect(rows).toEqual([{ who: 'Ada', position: 0 }]);
    });

    it('keeps the row as a row', async () => {
      const { db, driver } = context();
      driver.setRows([{ id: 1, name: 'Ada' }]);

      const rows = await db.users
        .orderBy((u) => u.age)
        .index((u) => u)
        .toArray();

      expect(rows).toEqual([{ id: 1, name: 'Ada' }]);
    });
  });

  describe('a filter before a join that keeps the joined side', () => {
    it('settles the filter in a derived table for a fullJoin', () => {
      const { db } = context();
      const { text } = db.users
        .where((u) => u.isActive)
        .fullJoin(
          db.cities,
          (u) => u.cityId,
          (city) => city.id,
          (u, city) => ({ who: u.name, city: city.name }),
        )
        .toSQL();

      // A WHERE is read after the join, so leaving the filter outside would drop
      // every city the join kept with no user beside it, and the FULL JOIN would
      // quietly answer what an INNER JOIN answers.
      expect(text).toMatch(/FROM \(SELECT .* WHERE "t0"\."is_active"\) AS "t\d+" FULL JOIN/);
    });

    it('does the same for a rightJoin', () => {
      const { db } = context();
      const { text } = db.users
        .where((u) => u.isActive)
        .rightJoin(
          db.cities,
          (u) => u.cityId,
          (city) => city.id,
          (u, city) => ({ who: u.name, city: city.name }),
        )
        .toSQL();

      expect(text).toMatch(/FROM \(SELECT .* WHERE "t0"\."is_active"\) AS "t\d+" RIGHT JOIN/);
    });

    it('leaves an inner or left join filtering in place', () => {
      const { db } = context();
      const inner = db.users
        .where((u) => u.isActive)
        .join(
          db.cities,
          (u) => u.cityId,
          (city) => city.id,
          (u, city) => ({ who: u.name, city: city.name }),
        )
        .toSQL().text;
      const left = db.users
        .where((u) => u.isActive)
        .leftJoin(
          db.cities,
          (u) => u.cityId,
          (city) => city.id,
          (u, city) => ({ who: u.name, city: city.name }),
        )
        .toSQL().text;

      // These two keep this side's rows, so filtering before or after the join is
      // the same set and the derived table would only cost a subquery.
      expect(inner).toContain('FROM "users" AS "t0" INNER JOIN');
      expect(inner).toContain('WHERE "t0"."is_active"');
      expect(left).toContain('FROM "users" AS "t0" LEFT JOIN');
    });
  });

  describe('groupJoin generation', () => {
    it('counts the matches with a correlated subquery', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (u, orders) => ({ who: u.name, placed: orders.count() }),
        )
        .toSQL();

      expect(text).toBe(
        'SELECT "t0"."name" AS "who", (SELECT COUNT(*) AS "__sqlinqo_matches" ' +
          'FROM "sales"."orders" AS "t1" WHERE "t0"."id" = "t1"."user_id") AS "placed" ' +
          'FROM "users" AS "t0"',
      );
    });

    it('leaves the outer query one row per row', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (u, orders) => ({ who: u.name, placed: orders.count() }),
        )
        .toSQL();

      // A LEFT JOIN with a GROUP BY around it would have had to name every column
      // of the outer row, and would then merge two outer rows alike in all of
      // them. Nothing is joined and nothing is grouped here.
      expect(text).not.toContain('JOIN');
      expect(text).not.toContain('GROUP BY');
    });

    it('sums to zero for a row with no matches', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ spent: orders.sum((o) => o.total) }),
        )
        .toSQL();

      // SUM over no rows is null in SQL and zero in LINQ, so it takes the same
      // COALESCE the terminal `sum` takes.
      expect(text).toContain('COALESCE((SELECT SUM("t1"."total")');
      expect(text).toContain('), 0) AS "spent"');
    });

    it('leaves min and max null, which SQL has no other answer for', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ biggest: orders.max((o) => o.total) }),
        )
        .toSQL();

      expect(text).toContain('(SELECT MAX("t1"."total")');
      expect(text).not.toContain('COALESCE');
    });

    it('emits one subquery per aggregate asked for', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ n: orders.count(), biggest: orders.max((o) => o.total) }),
        )
        .toSQL();

      expect(text.match(/SELECT COUNT\(\*\)/g)).toHaveLength(1);
      expect(text.match(/SELECT MAX/g)).toHaveLength(1);
    });

    it('pushes a filtered joined side into a derived table and still correlates', () => {
      const { db } = context();
      const { text, values } = db.users
        .groupJoin(
          db.orders.where((o) => o.id > 10),
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ n: orders.count() }),
        )
        .toSQL();

      expect(text).toContain('FROM (SELECT "t1"."id" AS "id"');
      expect(text).toContain('AS "t2" WHERE "t0"."id" = "t2"."userId"');
      expect(values).toEqual([10]);
    });

    it('settles paging on the outer side before correlating', () => {
      const { db } = context();
      const { text } = db.users
        .orderBy((u) => u.id)
        .take(5)
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (u, orders) => ({ who: u.name, n: orders.count() }),
        )
        .toSQL();

      // The subqueries run per row of whatever the outer query settled on.
      expect(text).toContain('LIMIT 5) AS "t1"');
    });

    it('refuses the matches as a row of their own', () => {
      const { db } = context();
      const query = () =>
        db.users
          .groupJoin(
            db.orders,
            (u) => u.id,
            (o) => o.userId,
            (_u, orders) => orders as never,
          )
          .toSQL();

      // A row has columns and not a nested sequence, which is the whole reason
      // the second parameter is a group.
      expect(query).toThrow(/is a group, not a row/);
    });

    it('refuses a property read off the matches', () => {
      const { db } = context();
      const query = () =>
        db.users
          .groupJoin(
            db.orders,
            (u) => u.id,
            (o) => o.userId,
            (_u, orders) => ({ t: (orders as unknown as { total: number }).total }),
          )
          .toSQL();

      expect(query).toThrow(/is a group, so it has no property "total"/);
    });

    it('folds the matches into one JSON value per outer row', () => {
      const { db } = context();
      const { text, values } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (u, orders) => ({ who: u.name, orders: orders.toArray() }),
        )
        .toSQL();

      // `total` is a decimal, cast to text before it enters the JSON so it
      // keeps the precision this library reads it as a string for everywhere
      // else; `id` and `userId` are plain ints and need no such rescue. Every
      // property name is cast too, for a different reason:
      // `json_build_object` takes `"any"`, against which PostgreSQL will not
      // resolve an untyped placeholder at all.
      expect(text).toBe(
        'SELECT "t0"."name" AS "who", COALESCE((SELECT json_agg(json_build_object($1 :: text, ' +
          '"t1"."id", $2 :: text, "t1"."user_id", $3 :: text, "t1"."total" :: text)) ' +
          'AS "__sqlinqo_matches" FROM "sales"."orders" AS "t1" ' +
          'WHERE "t0"."id" = "t1"."user_id"), \'[]\' :: json) AS "orders" FROM "users" AS "t0"',
      );
      expect(values).toEqual(['id', 'userId', 'total']);
    });

    it('reads back as an empty array rather than null for a row with no matches', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders,
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ orders: orders.toArray() }),
        )
        .toSQL();

      expect(text).toContain('), \'[]\' :: json) AS "orders"');
    });

    it('pushes a filtered joined side into a derived table and still correlates', () => {
      const { db } = context();
      const { text } = db.users
        .groupJoin(
          db.orders.where((o) => o.id > 10),
          (u) => u.id,
          (o) => o.userId,
          (_u, orders) => ({ orders: orders.toArray() }),
        )
        .toSQL();

      expect(text).toContain('FROM (SELECT "t1"."id" AS "id"');
      expect(text).toContain('WHERE "t0"."id" = "t2"."userId"');
    });

    it('rejects an argument, since it reads back every column rather than one a selector chose', () => {
      const { db } = context();
      const query = () =>
        db.users
          .groupJoin(
            db.orders,
            (u) => u.id,
            (o) => o.userId,
            (_u, orders) => ({
              orders: (orders as unknown as { toArray(x: number): unknown }).toArray(1),
            }),
          )
          .toSQL();

      expect(query).toThrow(/"toArray" takes no arguments/);
    });
  });

  describe('groupBy with toArray', () => {
    it('folds a group into one JSON value as an ordinary aggregate, not a correlated subquery', () => {
      const { db } = context();
      const { text } = db.users
        .groupBy(
          (u) => u.cityId,
          (cityId, users) => ({ cityId, members: users.toArray() }),
        )
        .toSQL();

      expect(text).toContain('GROUP BY "t0"."city_id"');
      expect(text).not.toContain('SELECT json_agg');
      expect(text).toContain(
        'json_agg(json_build_object($1 :: text, "t0"."id", $2 :: text, "t0"."name", ' +
          '$3 :: text, "t0"."email", $4 :: text, "t0"."age", $5 :: text, "t0"."city_id", ' +
          '$6 :: text, "t0"."is_active", $7 :: text, "t0"."created_at")) AS "members"',
      );
    });

    it('casts each property name, which json_build_object cannot type on its own', () => {
      const { db } = context();
      const { text, values } = db.users
        .groupBy(
          (u) => u.cityId,
          (cityId, users) => ({ cityId, members: users.toArray() }),
        )
        .toSQL();

      // `json_build_object` declares its arguments as `"any"`, and PostgreSQL
      // will not resolve an untyped placeholder against that: a bare `$1` there
      // is rejected with "could not determine data type of parameter". The name
      // stays bound rather than becoming a literal, so nothing is quoted into
      // the statement, and the cast is what says what it was bound as.
      expect(text).not.toMatch(/json_build_object\(\$1,/);
      expect(values.slice(0, 2)).toEqual(['id', 'name']);
    });
  });

  it('emits a RIGHT JOIN', () => {
    const { db } = context();
    const { text } = db.users
      .rightJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (u, c) => ({ city: c.name, who: u.name }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."name" AS "city", "t0"."name" AS "who" FROM "users" AS "t0" ' +
        'RIGHT JOIN "cities" AS "t1" ON "t0"."city_id" = "t1"."id"',
    );
  });

  it('asks what a leftJoin with the sides swapped asks', () => {
    const { db } = context();
    const right = db.users
      .rightJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (u, c) => ({ city: c.name, who: u.name }),
      )
      .toSQL().text;
    const left = db.cities
      .leftJoin(
        db.users,
        (c) => c.id,
        (u) => u.cityId,
        (c, u) => ({ city: c.name, who: u.name }),
      )
      .toSQL().text;

    // Both keep every city. The left-joined spelling reads in the order the
    // rows come out, and is the one to prefer when the query is new.
    expect(right).toContain('RIGHT JOIN "cities"');
    expect(left).toContain('LEFT JOIN "users"');
    expect(right).not.toBe(left);
  });

  it('settles paging on the outer side before joining', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(5)
      .rightJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (_u, c) => ({ city: c.name }),
      )
      .toSQL();

    // A limit on the outer side has to be settled before the join whichever
    // side the join preserves, or it would limit the joined result instead.
    expect(text).toContain('LIMIT 5) AS "t1" RIGHT JOIN "cities" AS "t2"');
  });
});

describe('FULL JOIN generation', () => {
  it('emits a FULL JOIN', () => {
    const { db } = context();
    const { text } = db.users
      .fullJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (u, c) => ({ who: u.name, city: c.name }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "who", "t1"."name" AS "city" FROM "users" AS "t0" ' +
        'FULL JOIN "cities" AS "t1" ON "t0"."city_id" = "t1"."id"',
    );
  });

  it('is the one join that swapping the sides cannot write', () => {
    const { db } = context();
    const one = db.users
      .fullJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (u, c) => ({ who: u.name, city: c.name }),
      )
      .toSQL().text;
    const other = db.cities
      .fullJoin(
        db.users,
        (c) => c.id,
        (u) => u.cityId,
        (c, u) => ({ who: u.name, city: c.name }),
      )
      .toSQL().text;

    // Neither side is preserved at the other's expense, so the two spellings
    // ask the same question rather than one being the fix for the other.
    expect(one).toContain('FULL JOIN "cities"');
    expect(other).toContain('FULL JOIN "users"');
  });

  it('settles paging on the outer side before joining', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(5)
      .fullJoin(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
        (_u, c) => ({ city: c.name }),
      )
      .toSQL();

    expect(text).toContain('LIMIT 5) AS "t1" FULL JOIN "cities" AS "t2"');
  });
});

describe('navigation properties', () => {
  it('joins the referenced table to read a column off it', () => {
    const { db } = context();
    const { text, values } = db.orders.where((o) => o.user.name === 'Ada').toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."user_id" AS "userId", "t0"."total" AS "total" ' +
        'FROM "sales"."orders" AS "t0" INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id" ' +
        'WHERE "t1"."name" = $1',
    );
    expect(values).toEqual(['Ada']);
  });

  it('follows one reference once, however often a clause reads it', () => {
    const { db } = context();
    const { text } = db.orders.where((o) => o.user.name === 'Ada' && o.user.age > 30).toSQL();

    expect(text.match(/INNER JOIN/g)).toHaveLength(1);
    expect(text).toContain('WHERE "t1"."name" = $1 AND "t1"."age" > $2');
  });

  it('reads a referenced column in a projection', () => {
    const { db } = context();
    const { text } = db.orders.select((o) => ({ total: o.total, who: o.user.name })).toSQL();

    expect(text).toBe(
      'SELECT "t0"."total" AS "total", "t1"."name" AS "who" FROM "sales"."orders" AS "t0" ' +
        'INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"',
    );
  });

  it('joins an optional reference with a LEFT JOIN', () => {
    // The key may be null, so an inner join would drop rows the model says are
    // allowed to have no related row at all.
    const { db } = context();
    const { text } = db.users.select((u) => ({ name: u.name, city: u.city.name })).toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "name", "t1"."name" AS "city" FROM "users" AS "t0" ' +
        'LEFT JOIN "cities" AS "t1" ON "t0"."city_id" = "t1"."id"',
    );
  });

  it('orders by a referenced column', () => {
    const { db } = context();
    const { text } = db.orders.orderBy((o) => o.user.name).toSQL();

    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
    expect(text).toContain('ORDER BY "t1"."name" ASC');
  });

  it('groups by a referenced column', () => {
    const { db } = context();
    const { text } = db.orders
      .groupBy(
        (o) => o.user.name,
        (who, orders) => ({ who, n: orders.count() }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."name" AS "who", COUNT(*) AS "n" FROM "sales"."orders" AS "t0" ' +
        'INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id" GROUP BY "t1"."name"',
    );
  });

  it('rejects a chain through two references', () => {
    const { db } = context();

    // The row type stops at one hop, so a second one cannot be written without
    // a cast. This reaches the runtime guard behind that.
    const query = db.orders as unknown as {
      where(fn: (o: { user: { city: { name: string } } }) => boolean): { toSQL(): unknown };
    };

    expect(() => query.where((o) => o.user.city.name === 'London').toSQL()).toThrow(
      /follows a reference through another one/,
    );
  });

  it('rejects a reference read as a value', () => {
    const { db } = context();

    expect(() => db.orders.select((o) => ({ u: o.user as unknown as number })).toSQL()).toThrow(
      /refers to a related row, not a value/,
    );
  });

  it('rejects a navigation in a join key, where it has no select to attach to', () => {
    const { db } = context();

    expect(() =>
      db.orders
        .join(
          db.cities,
          (o) => o.user.cityId,
          (c) => c.id,
          (o, c) => ({ total: o.total, city: c.name }),
        )
        .toSQL(),
    ).toThrow(/cannot be followed here/);
  });

  it('lists relations alongside columns when a property is not found', () => {
    const { db } = context();
    const query = db.orders as unknown as {
      where(fn: (o: { nope: number }) => boolean): { toSQL(): unknown };
    };

    expect(() => query.where((o) => o.nope > 1).toSQL()).toThrow(
      /Available: id, userId, total\. References: user, lines\./,
    );
  });
});

describe('relation metadata', () => {
  const Target = defineEntity({
    name: 'Target',
    columns: { id: { type: 'int', primaryKey: true }, label: { type: 'text' } },
  });

  it('rejects a relation reading from a column that does not exist', () => {
    expect(() =>
      defineEntity({
        name: 'Broken',
        columns: { id: { type: 'int', primaryKey: true } },
        relations: { target: reference(() => Target, 'targetId') },
      }),
    ).toThrow(ModelError);
  });

  it('rejects a relation that shadows a column', () => {
    expect(() =>
      defineEntity({
        name: 'Broken',
        columns: { id: { type: 'int', primaryKey: true }, target: { type: 'int' } },
        relations: { target: reference(() => Target, 'target') },
      }),
    ).toThrow(/both a column and a relation named "target"/);
  });

  it('reports a target column that does not exist, when the query compiles', () => {
    const Source = defineEntity({
      name: 'Source',
      columns: { id: { type: 'int', primaryKey: true }, targetId: { type: 'int' } },
      relations: { target: reference(() => Target, 'targetId', { to: 'nope' }) },
    });

    const db = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { sources: Source },
    });

    expect(() => db.sources.where((s) => s.target.label === 'x').toSQL()).toThrow(
      /points at "nope" on entity "Target", which has no such column/,
    );
  });

  it('needs a target column named when the primary key is composite', () => {
    const Composite = defineEntity({
      name: 'Composite',
      columns: {
        left: { type: 'int', primaryKey: true },
        right: { type: 'int', primaryKey: true },
        label: { type: 'text' },
      },
    });

    const Source = defineEntity({
      name: 'Source',
      columns: { id: { type: 'int', primaryKey: true }, key: { type: 'int' } },
      relations: { target: reference(() => Composite, 'key') },
    });

    const db = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { sources: Source },
    });

    expect(() => db.sources.where((s) => s.target.label === 'x').toSQL()).toThrow(
      /made of several columns/,
    );
  });

  it('matches a column other than the primary key when told to', () => {
    const Source = defineEntity({
      name: 'Source',
      columns: { id: { type: 'int', primaryKey: true }, tag: { type: 'text' } },
      relations: { target: reference(() => Target, 'tag', { to: 'label' }) },
    });

    const db = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { sources: Source },
    });

    expect(db.sources.where((s) => s.target.id > 1).toSQL().text).toContain(
      'INNER JOIN "Target" AS "t1" ON "t0"."tag" = "t1"."label"',
    );
  });
});

describe('toISOString', () => {
  it('is refused by a dialect with no format model of its own', () => {
    const { db } = context();

    // `to_char` and its format model are PostgreSQL's; no two databases spell a
    // format the same way, so the base dialect declines rather than pick one.
    expect(() => db.users.select((u) => ({ s: u.createdAt.toISOString() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "toISOString\(\.\.\.\)"/,
    );
  });
});

describe('split', () => {
  it('is refused by a dialect with no array to split into', () => {
    const { db } = context();

    // `string_to_array` is PostgreSQL's, and a database without arrays has no
    // answer at all rather than a differently spelled one.
    expect(() => db.users.select((u) => ({ p: u.name.split(',') })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "split\(\.\.\.\)"/,
    );
  });

  it('is refused by a dialect with no array to fold into a string', () => {
    const { db } = context();

    // `array_to_string` is PostgreSQL's, as `string_to_array` is, and the base
    // dialect answers null rather than emitting a name the database would not
    // know.
    const query = () =>
      db.users
        .select((u) => ({ all: (u.name as unknown as { join(s: string): string }).join(',') }))
        .toSQL();

    expect(query).toThrow(/cannot translate the call "join\(\.\.\.\)"/);
  });
});

describe('slice', () => {
  it('is refused by a dialect with no cast to type its bounds', () => {
    const { db } = context();

    // The arithmetic is ANSI but the casts that make it typeable are not, so
    // this sits beside `substring` and `at` in the provider rather than here.
    expect(() => db.users.select((u) => ({ s: u.name.slice(-3) })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "slice\(\.\.\.\)"/,
    );
  });
});

describe('repeat', () => {
  it('is refused by a dialect with no repeat function', () => {
    const { db } = context();

    // `REPEAT` is PostgreSQL's and MySQL's; SQL Server calls it `REPLICATE` and
    // Oracle has none, so the base dialect declines rather than pick a spelling.
    expect(() => db.users.select((u) => ({ r: u.name.repeat(3) })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "repeat\(\.\.\.\)"/,
    );
  });
});

describe('lastIndexOf', () => {
  it('turns the search around and converts the position back', () => {
    const { db } = context();
    const { text, values } = db.users.select((u) => ({ i: u.name.lastIndexOf('a') })).toSQL();

    // SQL has no backwards POSITION, so both strings are reversed and the last
    // occurrence becomes the first. `n - m + 1 - p` reads it back, where the
    // one is the same zero-based adjustment `indexOf` makes.
    expect(text).toContain(
      'CHAR_LENGTH("t0"."name") - CHAR_LENGTH($1) + 1 - ' +
        'POSITION(REVERSE($1) IN REVERSE("t0"."name"))',
    );
    expect(values).toEqual(['a']);
  });

  it('answers -1 for a substring it did not find', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ i: u.name.lastIndexOf('a') })).toSQL();

    // Unlike `indexOf`, the not-found answer does not fall out of the
    // arithmetic: a position of zero would read as a real index.
    expect(text).toContain('CASE WHEN POSITION(REVERSE($1) IN REVERSE("t0"."name")) = 0 THEN -1');
  });

  it('leaves a null string null rather than calling the substring absent', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ i: u.name.lastIndexOf('a') })).toSQL();

    // `p = 0` is unknown for a null and takes the else branch, which is null all
    // the way down. A COALESCE over a NULLIF would have answered -1 instead and
    // claimed the substring was merely missing.
    expect(text).not.toContain('COALESCE');
    expect(text).not.toContain('NULLIF');
  });

  it('parenthesises itself inside a comparison', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.name.lastIndexOf('a') === 2).toSQL();

    expect(text).toContain('END = $2');
    expect(values).toEqual(['a', 2]);
  });

  it('rejects an index to stop searching at, which POSITION has no room for', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          i: (u.name as unknown as { lastIndexOf(s: string, n: number): number }).lastIndexOf(
            'a',
            3,
          ),
        }))
        .toSQL();

    expect(query).toThrow(/"lastIndexOf" expects one value to search for/);
  });
});

describe('getTime', () => {
  it('is refused by a dialect that has no epoch field', () => {
    const { db } = context();

    // `EPOCH` is PostgreSQL's own `EXTRACT` field rather than a standard one,
    // so the base dialect declines it by name rather than guessing a spelling.
    expect(() => db.users.select((u) => ({ t: u.createdAt.getTime() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getTime\(\.\.\.\)"/,
    );
  });
});

describe('getDay', () => {
  it('is left to the provider, since no two databases number the week alike', () => {
    // The standard `EXTRACT` knows nothing of a day of the week, so the base
    // dialect declines it and says which dialect could not translate it rather
    // than guessing a spelling.
    const { db } = context();

    expect(() => db.users.select((u) => ({ day: u.createdAt.getDay() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getDay\(\.\.\.\)"/,
    );
  });
});

describe('getUTCFullYear', () => {
  it('is left to the provider, since AT TIME ZONE means opposite things per database', () => {
    // YEAR is as standard as a field gets and the base dialect already extracts
    // it for `getFullYear`. What is not standard is pinning the zone it is read
    // in: `AT TIME ZONE` is portable text that converts a zoned value to a
    // naive one in PostgreSQL and a naive value to a zoned one in SQL Server,
    // so a base-dialect spelling would compile everywhere and answer a
    // different question in each place.
    const { db } = context();

    expect(() => db.users.select((u) => ({ year: u.createdAt.getUTCFullYear() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCFullYear\(\.\.\.\)"/,
    );
  });
});

describe('getUTCMonth', () => {
  it('is left to the provider, as getUTCFullYear is', () => {
    // MONTH is a standard field and the base dialect already extracts it for
    // `getMonth`. What it cannot spell is the zone the extraction is read in,
    // which is the half `getUTCFullYear` is declined for too.
    const { db } = context();

    expect(() => db.users.select((u) => ({ month: u.createdAt.getUTCMonth() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCMonth\(\.\.\.\)"/,
    );
  });
});

describe('getUTCDate', () => {
  it('is left to the provider, as the rest of the getUTC family is', () => {
    // DAY is a standard field and the base dialect already extracts it for
    // `getDate`. What it cannot spell is the zone the extraction is read in,
    // which is the half every `getUTC*` method is declined here for.
    const { db } = context();

    expect(() => db.users.select((u) => ({ day: u.createdAt.getUTCDate() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCDate\(\.\.\.\)"/,
    );
  });
});

describe('getUTCHours', () => {
  it('is left to the provider, as the calendar fields of the family are', () => {
    // HOUR is a standard field and the base dialect already extracts it for
    // `getHours`. The half it cannot spell is the same one every `getUTC*`
    // method is declined here for: `AT TIME ZONE` compiles everywhere and
    // converts in opposite directions depending on the database.
    const { db } = context();

    expect(() => db.users.select((u) => ({ hour: u.createdAt.getUTCHours() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCHours\(\.\.\.\)"/,
    );
  });
});

describe('getUTCMinutes', () => {
  it('is left to the provider, as the rest of the getUTC family is', () => {
    // MINUTE is a standard field and the base dialect already extracts it for
    // `getMinutes`. The half it cannot spell is the one every `getUTC*` method
    // is declined here for, and the field being an ordinary one is the point:
    // what is unportable is pinning the zone, not reaching the minute.
    const { db } = context();

    expect(() => db.users.select((u) => ({ minute: u.createdAt.getUTCMinutes() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCMinutes\(\.\.\.\)"/,
    );
  });
});

describe('getUTCSeconds', () => {
  it('is left to the provider, as the rest of the getUTC family is', () => {
    // SECOND is a standard field and the base dialect already extracts it for
    // `getSeconds`, FLOOR included. The half it cannot spell is the zone the
    // extraction is read in, which is what every `getUTC*` method is declined
    // here for.
    const { db } = context();

    expect(() => db.users.select((u) => ({ second: u.createdAt.getUTCSeconds() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCSeconds\(\.\.\.\)"/,
    );
  });
});

describe('getUTCDay', () => {
  it('is declined for both of the reasons the base dialect declines things', () => {
    // The only member of the family that would live in a provider even without
    // a zone to pin: DOW is not an `EXTRACT` field the standard defines, so the
    // base dialect has no spelling for the day of the week at all, and pinning
    // the zone is unportable on its own account. Either reason alone is enough.
    const { db } = context();

    expect(() => db.users.select((u) => ({ day: u.createdAt.getUTCDay() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getUTCDay\(\.\.\.\)"/,
    );
  });
});

describe('getHours', () => {
  it('becomes an EXTRACT with no adjustment', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ hour: u.createdAt.getHours() })).toSQL();

    // Both count 0 through 23, so unlike `getMonth` there is nothing to
    // reconcile and no arithmetic around the extraction.
    expect(text).toBe('SELECT EXTRACT(HOUR FROM "t0"."created_at") AS "hour" FROM "users" AS "t0"');
  });

  it('filters on an hour of the day', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.createdAt.getHours() >= 9).toSQL();

    expect(text).toContain('WHERE EXTRACT(HOUR FROM "t0"."created_at") >= $1');
    expect(values).toEqual([9]);
  });

  it('rejects an argument', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          hour: (u.createdAt as unknown as { getHours(n: number): number }).getHours(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getHours" expects 0 argument\(s\)/);
  });
});

describe('getMinutes', () => {
  it('becomes an EXTRACT with no adjustment', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ minute: u.createdAt.getMinutes() })).toSQL();

    // Both count 0 through 59, so as with `getHours` the translation is the
    // extraction and nothing else.
    expect(text).toBe(
      'SELECT EXTRACT(MINUTE FROM "t0"."created_at") AS "minute" FROM "users" AS "t0"',
    );
  });

  it('filters on a minute of the hour', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.createdAt.getMinutes() === 0).toSQL();

    expect(text).toContain('WHERE EXTRACT(MINUTE FROM "t0"."created_at") = $1');
    expect(values).toEqual([0]);
  });

  it('rejects an argument', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          minute: (u.createdAt as unknown as { getMinutes(n: number): number }).getMinutes(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getMinutes" expects 0 argument\(s\)/);
  });
});

describe('getSeconds', () => {
  it('floors the extraction, unlike the hour and the minute', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ second: u.createdAt.getSeconds() })).toSQL();

    // SECOND is the one EXTRACT field allowed a fraction, and PostgreSQL takes
    // it, so the whole second JavaScript reports needs the FLOOR that `getHours`
    // and `getMinutes` do not.
    expect(text).toBe(
      'SELECT FLOOR(EXTRACT(SECOND FROM "t0"."created_at")) AS "second" FROM "users" AS "t0"',
    );
  });

  it('filters on a second of the minute', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.createdAt.getSeconds() === 0).toSQL();

    expect(text).toContain('WHERE FLOOR(EXTRACT(SECOND FROM "t0"."created_at")) = $1');
    expect(values).toEqual([0]);
  });

  it('rejects an argument', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          second: (u.createdAt as unknown as { getSeconds(n: number): number }).getSeconds(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getSeconds" expects 0 argument\(s\)/);
  });
});

describe('localeCompare', () => {
  it('becomes a three-way comparison', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ order: u.name.localeCompare(u.email) })).toSQL();

    expect(text).toBe(
      'SELECT CASE WHEN "t0"."name" < "t0"."email" THEN -1 ' +
        'WHEN "t0"."name" > "t0"."email" THEN 1 ELSE 0 END AS "order" FROM "users" AS "t0"',
    );
  });

  it('binds the value it compares against once, though it reads it twice', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.name.localeCompare(p.other) > 0, { other: 'm' })
      .toSQL();

    expect(text).toContain(
      'WHERE CASE WHEN "t0"."name" < $1 THEN -1 WHEN "t0"."name" > $1 THEN 1 ELSE 0 END > $2',
    );
    expect(values).toEqual(['m', 0]);
  });

  it('orders by the comparison', () => {
    const { db } = context();
    const { text } = db.users.orderBy((u) => u.name.localeCompare(u.email)).toSQL();

    expect(text).toContain('ORDER BY CASE WHEN "t0"."name" < "t0"."email" THEN -1');
  });

  it('refuses a locale or options rather than dropping them', () => {
    // A database compares under the collation the column has; it cannot be
    // handed an ICU locale, and answering a different question quietly would be
    // worse than not answering.
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          order: (
            u.name as unknown as { localeCompare(a: string, b: string): number }
          ).localeCompare('x', 'de'),
        }))
        .toSQL();

    expect(query).toThrow(/A locale or options cannot be honoured/);
  });

  it('refuses a call with nothing to compare against', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          order: (u.name as unknown as { localeCompare(): number }).localeCompare(),
        }))
        .toSQL();

    expect(query).toThrow(/expects one value to compare against/);
  });
});

describe('match', () => {
  it('falls through to an error when the dialect has no translation for it', () => {
    // Regular expressions have no ANSI spelling, so the base dialect declines
    // it and only a provider that adds one, such as PostgreSQL, answers.
    const { db } = context();
    const query = () => db.users.where((u) => !!u.name.match(/^A/)).toSQL();

    expect(query).toThrow(/The "test" dialect cannot translate the call "match\(\.\.\.\)"/);
  });

  it('rejects a pattern that is not a literal written in the query', () => {
    // The flags choose the operator a dialect prints, which has to be known
    // while compiling, so a pattern read out of a variable has nothing a
    // dialect could use.
    const { db } = context();
    const query = () =>
      db.users.where((u, p) => !!u.name.match(p.pattern), { pattern: /^A/ }).toSQL();

    expect(query).toThrow(/only translates a regular expression literal written directly/);
  });
});

describe('search', () => {
  it('falls through to an error when the dialect has no translation for it', () => {
    const { db } = context();
    const query = () => db.users.select((u) => ({ at: u.name.search(/^A/) })).toSQL();

    expect(query).toThrow(/The "test" dialect cannot translate the call "search\(\.\.\.\)"/);
  });

  it('rejects a pattern that is not a literal written in the query', () => {
    const { db } = context();
    const query = () =>
      db.users.select((u, p) => ({ at: u.name.search(p.pattern) }), { pattern: /^A/ }).toSQL();

    expect(query).toThrow(/only translates a regular expression literal written directly/);
  });
});

describe('array length', () => {
  const arrayContext = () => {
    const driver = new FakeDriver();
    const Post = defineEntity({
      name: 'Post',
      table: 'posts',
      columns: {
        id: { type: 'int', primaryKey: true },
        title: { type: 'text' },
        tags: { type: 'array', of: 'text' },
      },
    });
    return { db: createDbContext({ driver, dialect: testDialect, entities: { posts: Post } }) };
  };

  it('counts the elements of an array column', () => {
    const { db } = arrayContext();
    const { text } = db.posts.select((p) => ({ n: p.tags.length })).toSQL();

    // `CARDINALITY` rather than `CHAR_LENGTH`, which the database would have
    // rejected over an array. Which one is meant is the column's type to say.
    expect(text).toBe('SELECT CARDINALITY("t0"."tags") AS "n" FROM "posts" AS "t0"');
  });

  it('still counts the characters of a text column', () => {
    const { db } = arrayContext();
    const { text } = db.posts.select((p) => ({ n: p.title.length })).toSQL();

    expect(text).toContain('CHAR_LENGTH("t0"."title")');
  });

  it('filters on the number of elements', () => {
    const { db } = arrayContext();
    const { text, values } = db.posts.where((p) => p.tags.length > 2).toSQL();

    expect(text).toContain('WHERE CARDINALITY("t0"."tags") > $1');
    expect(values).toEqual([2]);
  });

  it('keeps the array reading through a projection', () => {
    const { db } = arrayContext();
    const { text } = db.posts
      .select((p) => ({ tags: p.tags }))
      .select((r) => ({ n: r.tags.length }))
      .toSQL();

    // A projection renames its columns, so the type is read off the expression
    // each one came from rather than inherited by name.
    expect(text).toContain('CARDINALITY("t0"."tags")');
    expect(text).not.toContain('CHAR_LENGTH');
  });

  it('keeps the array reading through a derived table', () => {
    const { db } = arrayContext();
    const { text } = db.posts
      .orderBy((p) => p.id)
      .take(2)
      .select((r) => ({ n: r.tags.length }))
      .toSQL();

    // Here the names are unchanged, so the derived table hands the question
    // back to the scope it wrapped.
    expect(text).toContain('CARDINALITY("t1"."tags")');
  });

  it('does not claim a type the column no longer has', () => {
    const { db } = arrayContext();
    const { text } = db.posts
      .select((p) => ({ n: p.tags.length }))
      .select((r) => ({ n: r.n }))
      .toSQL();

    // `n` is a count and not an array, so the second projection has no type to
    // carry and nothing counts it twice.
    expect(text).toContain('CARDINALITY("t0"."tags")');
    expect(text).not.toContain('CARDINALITY(CARDINALITY');
  });
});

describe('some over a collection', () => {
  it('filters on whether any row of a collection matches', () => {
    const { db } = context();
    const { text, values } = db.orders.where((o) => o.lines.some((l) => l.sku === 'X')).toSQL();

    expect(text).toContain(
      'WHERE EXISTS (SELECT 1 AS "__sqlinqo_exists" FROM "order_lines" AS "t1" ' +
        'WHERE "t1"."order_id" = "t0"."id" AND "t1"."sku" = $1)',
    );
    expect(values).toEqual(['X']);
  });

  it('never multiplies the row it asks about', () => {
    const { db } = context();
    const { text } = db.orders.where((o) => o.lines.some((l) => l.sku === 'X')).toSQL();

    // `selectMany` would have joined the same key and returned one row per
    // line. This asks whether a row is there and never reads it.
    expect(text).not.toContain('JOIN');
    expect(text).toContain('SELECT 1 AS "__sqlinqo_exists"');
  });

  it('projects as a boolean column', () => {
    const { db } = context();
    const { text } = db.orders
      .select((o) => ({ id: o.id, any: o.lines.some((l) => l.sku === 'X') }))
      .toSQL();

    // Nothing about `EXISTS` restricts it to a filter, so it reads as a value.
    expect(text).toContain('EXISTS (SELECT 1 AS "__sqlinqo_exists"');
    expect(text).toContain(') AS "any"');
  });

  it('negates to NOT EXISTS', () => {
    const { db } = context();
    const { text } = db.orders.where((o) => !o.lines.some((l) => l.sku === 'X')).toSQL();

    expect(text).toContain('WHERE NOT EXISTS (SELECT 1');
  });

  it('carries the correlation key from the collection metadata', () => {
    const { db } = context();
    const { text } = db.orders.where((o) => o.lines.some((l) => l.sku === 'X')).toSQL();

    // The same key `selectMany` would have joined on, read as a condition
    // rather than as a source.
    expect(text).toContain('"t1"."order_id" = "t0"."id"');
  });

  it('rejects a call with no predicate', () => {
    const { db } = context();
    const query = () =>
      db.orders.where((o) => (o.lines as unknown as { some(): boolean }).some()).toSQL();

    expect(query).toThrow(/"some" expects one predicate over the rows of "lines"/);
  });

  it('leaves some on a reference to the error a reference already gives', () => {
    const { db } = context();
    const query = () =>
      db.orders
        .where((o) => (o.user as unknown as { some(f: unknown): boolean }).some(() => true))
        .toSQL();

    // Only a collection is many rows, so this is not the shape at all and falls
    // through rather than being claimed by the `some` handling.
    expect(query).toThrow(/refers to a related row, not a value/);
  });
});

describe('aggregates over a collection', () => {
  const counted = (db: ReturnType<typeof context>['db']) =>
    db.orders.select((o) => ({ id: o.id, lines: o.lines.count() }));

  it('counts the rows on the other end with a correlated subquery', () => {
    const { db } = context();
    const { text } = counted(db).toSQL();

    expect(text).toContain(
      '(SELECT COUNT(*) AS "__sqlinqo_matches" FROM "order_lines" AS "t1" ' +
        'WHERE "t1"."order_id" = "t0"."id") AS "lines"',
    );
  });

  it('leaves the outer query one row per row', () => {
    const { db } = context();
    const { text } = counted(db).toSQL();

    // A join and a grouping would have answered the same numbers and a
    // different number of rows, which is the property a subquery protects.
    expect(text).not.toContain('JOIN');
    expect(text).not.toContain('GROUP BY');
  });

  it('sums a selected column, and reads no rows as zero', () => {
    const { db } = context();
    const { text } = db.orders.select((o) => ({ n: o.lines.sum((line) => line.id) })).toSQL();

    // SQL sums no rows to null and LINQ to zero, which is the COALESCE the sum
    // terminal already carried.
    expect(text).toContain(
      'COALESCE((SELECT SUM("t1"."id") AS "__sqlinqo_matches" FROM "order_lines" AS "t1" ' +
        'WHERE "t1"."order_id" = "t0"."id"), 0) AS "n"',
    );
  });

  it('leaves min, max, and average null over no rows', () => {
    const { db } = context();
    const smallest = db.orders.select((o) => ({ m: o.lines.min((line) => line.sku) })).toSQL().text;
    const mean = db.orders.select((o) => ({ a: o.lines.average((line) => line.id) })).toSQL().text;

    // SQL has no other answer and LINQ would have thrown, so null it is, which
    // is the reading groupJoin's aggregates already took.
    expect(smallest).toContain('SELECT MIN("t1"."sku")');
    expect(smallest).not.toContain('COALESCE');
    expect(mean).toContain('SELECT AVG("t1"."id")');
    expect(mean).not.toContain('COALESCE');
  });

  it('is a value like any other, so it filters and orders', () => {
    const { db } = context();
    const filtered = db.orders.where((o) => o.lines.count() > 2).toSQL();
    const ordered = db.orders.orderByDescending((o) => o.lines.count()).toSQL();

    expect(filtered.text).toContain('WHERE (SELECT COUNT(*)');
    expect(filtered.values).toEqual([2]);
    expect(ordered.text).toContain('ORDER BY (SELECT COUNT(*)');
    expect(ordered.text).toContain('DESC');
  });

  it('refuses a count with an argument and a sum without one', () => {
    const { db } = context();

    expect(() =>
      db.orders
        .select((o) => ({
          n: (o.lines as unknown as { count(x: number): number }).count(1),
        }))
        .toSQL(),
    ).toThrow(/"count" takes no arguments/);

    expect(() =>
      db.orders.select((o) => ({ n: (o.lines as unknown as { sum(): number }).sum() })).toSQL(),
    ).toThrow(/"sum" expects one lambda choosing the value to aggregate/);
  });

  it('leaves an aggregate on anything else to the code that has a better error', () => {
    const { db } = context();

    // A reference is one row and cannot be aggregated, and the message about
    // reading a column off a related row was already the right one to give.
    // Returning null for a shape this does not claim is what leaves it standing.
    expect(() =>
      db.orders.select((o) => ({ n: (o.user as unknown as { count(): number }).count() })).toSQL(),
    ).toThrow(/"user" refers to a related row, not a value/);

    // A column reaches the dialect, which refuses the method by name.
    expect(() =>
      db.orders.select((o) => ({ n: (o.total as unknown as { min(): string }).min() })).toSQL(),
    ).toThrow(/The "test" dialect cannot translate the call "min\(\.\.\.\)"/);
  });
});

describe('every over a collection', () => {
  it('looks for a failing row and negates the answer', () => {
    const { db } = context();
    const { text, values } = db.orders.where((o) => o.lines.every((l) => l.sku === 'X')).toSQL();

    expect(text).toContain(
      'WHERE NOT EXISTS (SELECT 1 AS "__sqlinqo_exists" FROM "order_lines" AS "t1" ' +
        'WHERE "t1"."order_id" = "t0"."id" AND (NOT "t1"."sku" = $1 OR ("t1"."sku" = $1) IS NULL))',
    );
    expect(values).toEqual(['X']);
  });

  it('counts an unknown predicate as a failure, as the all terminal does', () => {
    const { db } = context();
    const { text } = db.orders.where((o) => o.lines.every((l) => l.sku === 'X')).toSQL();

    // `NOT p` alone is not the complement of `p` in SQL: a predicate that is
    // null is unknown, and `NOT` of unknown is unknown too, so such a row would
    // answer neither and quietly pass.
    expect(text).toContain('IS NULL))');
  });

  it('is some with the search and the answer both turned round', () => {
    const { db } = context();
    const some = db.orders.where((o) => o.lines.some((l) => l.sku === 'X')).toSQL().text;
    const every = db.orders.where((o) => o.lines.every((l) => l.sku === 'X')).toSQL().text;

    // One compilation answers both: the same correlated subquery over the same
    // key, differing in what it looks for and whether the answer is negated.
    expect(some).toContain('WHERE EXISTS (SELECT 1');
    expect(every).toContain('WHERE NOT EXISTS (SELECT 1');
    expect(every).toContain('"t1"."order_id" = "t0"."id"');
  });

  it('projects as a boolean column', () => {
    const { db } = context();
    const { text } = db.orders
      .select((o) => ({ id: o.id, all: o.lines.every((l) => l.sku === 'X') }))
      .toSQL();

    expect(text).toContain('NOT EXISTS (SELECT 1');
    expect(text).toContain(') AS "all"');
  });

  it('names the operator that was written when the predicate is missing', () => {
    const { db } = context();
    const query = () =>
      db.orders.where((o) => (o.lines as unknown as { every(): boolean }).every()).toSQL();

    expect(query).toThrow(/"every" expects one predicate over the rows of "lines"/);
  });
});

describe('array columns', () => {
  it('types an array column by its element type', () => {
    const Post = defineEntity({
      name: 'Post',
      columns: {
        id: { type: 'int', primaryKey: true },
        tags: { type: 'array', of: 'text' },
        scores: { type: 'array', of: 'int', nullable: true },
      },
    });

    // The annotation is the assertion: `tags` is a string[], `scores` may be null.
    const row: EntityOf<typeof Post> = { id: 1, tags: ['a'], scores: null };

    expect(row.tags).toEqual(['a']);
    expect(Post.columns.tags.of).toBe('text');
  });

  it('rejects an array that does not say what of', () => {
    expect(() =>
      defineEntity({
        name: 'Post',
        columns: { id: { type: 'int', primaryKey: true }, tags: { type: 'array' } },
      }),
    ).toThrow(/is an array but does not say what of/);
  });

  it('rejects an element type on something that is not an array', () => {
    expect(() =>
      defineEntity({
        name: 'Post',
        columns: { id: { type: 'int', primaryKey: true }, title: { type: 'text', of: 'text' } },
      }),
    ).toThrow(/names an element type but is a "text", not an array/);
  });

  it('leaves subscripting to the provider, since not every database has arrays', () => {
    const Post = defineEntity({
      name: 'Post',
      columns: { id: { type: 'int', primaryKey: true }, tags: { type: 'array', of: 'text' } },
    });

    const db = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { posts: Post },
    });

    expect(() => db.posts.select((p) => ({ first: p.tags.at(0) })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "at\(\.\.\.\)"/,
    );
  });
});

describe('negative numeric literals', () => {
  it('folds a negated literal rather than negating a placeholder', () => {
    // `-$1` has no type a database can resolve, so the minus is folded into the
    // value before it is ever bound.
    const { db } = context();
    const { text, values } = db.users.where((u) => u.age > -5).toSQL();

    expect(text).toContain('WHERE "t0"."age" > $1');
    expect(values).toEqual([-5]);
  });

  it('still negates an expression it cannot fold', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ negated: -u.age })).toSQL();

    expect(text).toContain('-"t0"."age"');
  });
});

describe('selectMany', () => {
  function withLines() {
    const driver = new FakeDriver();
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, orders: Order, cities: City, lines: Line, posts: Post },
    });
    return { db, driver };
  }

  it('pairs every row with every row of another query', () => {
    const { db } = withLines();
    const { text } = db.users
      .selectMany(db.cities, (u, c) => ({ who: u.name, city: c.name }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "who", "t1"."name" AS "city" FROM "users" AS "t0" ' +
        'CROSS JOIN "cities" AS "t1"',
    );
  });

  it('flattens a collection onto the key that points back', () => {
    const { db } = withLines();
    const { text } = db.orders
      .selectMany(
        (o) => o.lines,
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "order", "t1"."sku" AS "sku" FROM "sales"."orders" AS "t0" ' +
        'INNER JOIN "order_lines" AS "t1" ON "t1"."order_id" = "t0"."id"',
    );
  });

  it('filters the flattened rows', () => {
    const { db } = withLines();
    const { text, values } = db.orders
      .selectMany(
        (o) => o.lines,
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .where((row) => row.sku === 'x')
      .toSQL();

    expect(text).toContain('ON "t1"."order_id" = "t0"."id" WHERE "t1"."sku" = $1');
    expect(values).toEqual(['x']);
  });

  it('settles paging on the source before multiplying its rows', () => {
    const { db } = withLines();
    const { text } = db.orders
      .take(10)
      .selectMany(
        (o) => o.lines,
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .toSQL();

    expect(text).toMatch(/FROM \(SELECT .* LIMIT 10\) AS "t1" INNER JOIN "order_lines"/);
  });

  it('rejects reading a column off a collection', () => {
    const { db } = withLines();
    const query = () =>
      db.orders.select((o) => ({ oops: (o.lines as unknown as { sku: string }).sku })).toSQL();

    expect(query).toThrow(/is many rows, not one/);
  });

  it('rejects flattening a reference, which is only ever one row', () => {
    const { db } = withLines();
    const query = () =>
      db.orders
        .selectMany(
          (o) => o.user as unknown as readonly { id: number }[],
          (o, u) => ({ order: o.id, who: u.id }),
        )
        .toSQL();

    expect(query).toThrow(/refers to one row, not many/);
  });

  it('rejects a collection selector that is not a navigation', () => {
    const { db } = withLines();
    const query = () =>
      db.orders
        .selectMany(
          (o) => [o.id] as unknown as readonly { id: number }[],
          (o, x) => ({ order: o.id, other: x.id }),
        )
        .toSQL();

    expect(query).toThrow(/must be one of the row's own collections/);
  });

  it('refuses to flatten a query from another context', () => {
    const { db } = withLines();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { cities: City },
    });

    expect(() =>
      db.users.selectMany(other.cities, (u, c) => ({ who: u.name, city: c.name })),
    ).toThrow(/"selectMany"/);
  });

  it('checks a collection key against the target when the query compiles', () => {
    const Broken = defineEntity({
      name: 'Broken',
      columns: { id: { type: 'int', primaryKey: true } },
      relations: { lines: collection(() => Line, 'nope') },
    });

    const db = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { broken: Broken },
    });

    expect(() =>
      db.broken
        .selectMany(
          (b) => b.lines,
          (b, l) => ({ id: b.id, sku: l.sku }),
        )
        .toSQL(),
    ).toThrow(/keyed by "nope" on entity "Line", which has no such column/);
  });

  it('reads a shaped collection as a correlated LATERAL join', () => {
    const { db } = withLines();
    const { text, values } = db.orders
      .selectMany(
        (o) => o.lines,
        (lines) =>
          lines
            .where((l) => l.sku !== 'x')
            .orderByDescending((l) => l.id)
            .take(2),
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "order", "t2"."sku" AS "sku" FROM "sales"."orders" AS "t0" ' +
        'CROSS JOIN LATERAL (SELECT "t1"."id" AS "id", "t1"."order_id" AS "orderId", ' +
        '"t1"."sku" AS "sku" FROM "order_lines" AS "t1" WHERE "t1"."sku" <> $1 AND ' +
        '"t1"."order_id" = "t0"."id" ORDER BY "t1"."id" DESC LIMIT 2) AS "t2"',
    );
    expect(values).toEqual(['x']);
  });

  it("applies the target entity's own query filter inside the lateral shape", () => {
    const { db } = withLines();
    const { text } = db.users
      .selectMany(
        (u) => u.posts,
        (posts) => posts.orderBy((p) => p.id).take(1),
        (u, p) => ({ who: u.name, title: p.title }),
      )
      .toSQL();

    expect(text).toContain(
      'CROSS JOIN LATERAL (SELECT "t1"."id" AS "id", "t1"."user_id" AS "userId", ' +
        '"t1"."title" AS "title", "t1"."is_deleted" AS "isDeleted" FROM "posts" AS "t1" ' +
        'WHERE NOT "t1"."is_deleted" AND "t1"."user_id" = "t0"."id" ORDER BY "t1"."id" ASC LIMIT 1)',
    );
  });

  it('renumbers parameter bags for a filter captured both outside and inside the shape', () => {
    const { db } = withLines();
    const { text, values } = db.orders
      .where((o, p) => o.id > p.min, { min: 5 })
      .selectMany(
        (o) => o.lines,
        (lines) => lines.where((l, p2) => l.sku !== p2.skip, { skip: 'x' }).take(1),
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "order", "t2"."sku" AS "sku" FROM "sales"."orders" AS "t0" ' +
        'CROSS JOIN LATERAL (SELECT "t1"."id" AS "id", "t1"."order_id" AS "orderId", ' +
        '"t1"."sku" AS "sku" FROM "order_lines" AS "t1" WHERE "t1"."sku" <> $1 AND ' +
        '"t1"."order_id" = "t0"."id" LIMIT 1) AS "t2" WHERE "t0"."id" > $2',
    );
    expect(values).toEqual(['x', 5]);
  });

  it('keeps a plain DISTINCT inside the shape, since WHERE still runs before it', () => {
    const { db } = withLines();
    const { text } = db.orders
      .selectMany(
        (o) => o.lines,
        (lines) => lines.distinct().take(2),
        (o, l) => ({ order: o.id, sku: l.sku }),
      )
      .toSQL();

    expect(text).toContain('SELECT DISTINCT');
    expect(text).toContain('WHERE "t1"."order_id" = "t0"."id" LIMIT 2');
  });

  it('rejects a shape that groups or combines with a set operation', () => {
    const { db } = withLines();
    const query = () =>
      db.orders
        .selectMany(
          (o) => o.lines,
          (lines) =>
            lines.groupBy(
              (l) => l.sku,
              (sku, g) => ({ sku, n: g.count() }),
            ) as never,
          (o, l) => ({ order: o.id, sku: l.sku }),
        )
        .toSQL();

    expect(query).toThrow(/cannot be shaped with "groupBy" or a set operation/);
  });

  it('rejects shaping a query that has already been reshaped', () => {
    const { db } = withLines();
    const query = () =>
      db.orders
        .select((o) => ({ id: o.id }))
        .selectMany(
          (o) => (o as unknown as { lines: readonly Related<typeof Line>[] }).lines,
          (lines) => lines.take(1),
          (o, l) => ({ id: o.id, sku: l.sku }),
        );

    expect(query).toThrow(/needs rows that are still an entity/);
  });

  it("rejects shaping a selector that is not one of the row's own collections", () => {
    const { db } = withLines();
    const query = () =>
      db.orders.selectMany(
        (o) => [o.id] as unknown as readonly Related<typeof Line>[],
        (rows) => rows.take(1),
        (o, x) => ({ order: o.id, other: x.id }),
      );

    expect(query).toThrow(/expects one of the row's own collections/);
  });

  it('rejects shaping a reference, which is only ever one row', () => {
    const { db } = withLines();
    const query = () =>
      db.orders.selectMany(
        (o) => o.user as unknown as readonly Related<typeof Line>[],
        (rows) => rows.take(1),
        (o, u) => ({ order: o.id, who: u.id }),
      );

    expect(query).toThrow(/"user" is not a collection on entity "Order"/);
  });
});

describe('asValues', () => {
  it('compiles "includes" over a query to IN (subquery)', () => {
    const { db } = context();
    const vip = db.orders
      .where((o) => o.userId > 0)
      .select((o) => o.userId)
      .asValues();

    const { text, values } = db.users.where((u, p) => p.vip.includes(u.id), { vip }).toSQL();

    expect(text).toContain(
      'WHERE "t0"."id" IN (SELECT "t1"."user_id" AS "value" FROM "sales"."orders" AS "t1" ' +
        'WHERE "t1"."user_id" > $1)',
    );
    expect(values).toEqual([0]);
  });

  it('negates through the ordinary NOT wrapping, since nothing here builds NOT IN directly', () => {
    const { db } = context();
    const vip = db.orders.select((o) => o.userId).asValues();

    const { text } = db.users.where((u, p) => !p.vip.includes(u.id), { vip }).toSQL();

    expect(text).toContain('WHERE NOT "t0"."id" IN (SELECT');
  });

  it('combines with other conditions in the same predicate', () => {
    const { db } = context();
    const vip = db.orders.select((o) => o.userId).asValues();

    const { text, values } = db.users
      .where((u, p) => u.age > 18 && p.vip.includes(u.id), { vip })
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email", ' +
        '"t0"."age" AS "age", "t0"."city_id" AS "cityId", "t0"."is_active" AS "isActive", ' +
        '"t0"."created_at" AS "createdAt" FROM "users" AS "t0" WHERE "t0"."age" > $1 AND ' +
        '"t0"."id" IN (SELECT "t1"."user_id" AS "value" FROM "sales"."orders" AS "t1")',
    );
    expect(values).toEqual([18]);
  });

  it('renumbers parameter bags for values captured both outside and inside the embedded query', () => {
    const { db } = context();
    const vip = db.orders
      .where((o, p) => o.userId > p.min, { min: 5 })
      .select((o) => o.userId)
      .asValues();

    const { text, values } = db.users
      .where((u, p) => u.age > p.minAge && p.vip.includes(u.id), { minAge: 21, vip })
      .toSQL();

    expect(text).toContain(
      'WHERE "t0"."age" > $1 AND "t0"."id" IN (SELECT "t1"."user_id" AS "value" ' +
        'FROM "sales"."orders" AS "t1" WHERE "t1"."user_id" > $2)',
    );
    expect(values).toEqual([21, 5]);
  });

  it('supports more than one embedded query in the same parameter bag', () => {
    const { db } = context();
    const highIds = db.orders
      .where((o) => o.userId > 100)
      .select((o) => o.userId)
      .asValues();
    const lowIds = db.orders
      .where((o) => o.userId < 10)
      .select((o) => o.userId)
      .asValues();

    const { text } = db.users
      .where((u, p) => p.a.includes(u.id) || p.b.includes(u.id), { a: highIds, b: lowIds })
      .toSQL();

    expect(text).toContain(
      '"t0"."id" IN (SELECT "t1"."user_id" AS "value" FROM "sales"."orders" AS "t1" ' +
        'WHERE "t1"."user_id" > $1) OR "t0"."id" IN (SELECT "t2"."user_id" AS "value" ' +
        'FROM "sales"."orders" AS "t2" WHERE "t2"."user_id" < $2)',
    );
  });

  it('works from "select" as well as "where", since both bind through the same bag', () => {
    const { db } = context();
    const vip = db.orders.select((o) => o.userId).asValues();

    const { text } = db.users
      .select((u, p) => ({ name: u.name, isVip: p.vip.includes(u.id) }), { vip })
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."name" AS "name", "t0"."id" IN (SELECT "t1"."user_id" AS "value" ' +
        'FROM "sales"."orders" AS "t1") AS "isVip" FROM "users" AS "t0"',
    );
  });

  it('rejects a query that still projects a row', () => {
    const { db } = context();

    expect(() => db.orders.asValues()).toThrow(
      /"asValues" works over a query that projects one value/,
    );
  });

  it('rejects, defensively, a query reaching the compiler with more than one column', () => {
    const { db } = context();
    const notReallyValues = db.orders as unknown as readonly number[];

    const query = () =>
      db.users.where((u, p) => p.vip.includes(u.id), { vip: notReallyValues }).toSQL();

    expect(query).toThrow(/"includes" over a query needs it to project exactly one value/);
  });

  it('rejects a query from a different context', () => {
    const { db } = context();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { orders: Order },
    });
    const vip = other.orders.select((o) => o.userId).asValues();

    const query = () => db.users.where((u, p) => p.vip.includes(u.id), { vip });

    expect(query).toThrow(/must come from the same context/);
  });
});

describe('indexOf', () => {
  it('becomes a POSITION counting from zero', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u, p) => ({ at: u.name.indexOf(p.needle) }), { needle: 'a' })
      .toSQL();

    // POSITION counts from one and answers zero for a substring it did not
    // find; subtracting one gives both of JavaScript's answers at once.
    expect(text).toBe('SELECT POSITION($1 IN "t0"."name") - 1 AS "at" FROM "users" AS "t0"');
    expect(values).toEqual(['a']);
  });

  it('compares against -1 for a substring that is not there', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.name.indexOf('z') === -1).toSQL();

    expect(text).toContain('WHERE POSITION($1 IN "t0"."name") - 1 = $2');
    expect(values).toEqual(['z', -1]);
  });

  it('refuses an index to start searching from', () => {
    const { db } = context();
    const query = () =>
      db.users.select((u, p) => ({ at: u.name.indexOf(p.needle, 2) }), { needle: 'a' }).toSQL();

    expect(query).toThrow(/"indexOf" expects one value to search for/);
    expect(query).toThrow(/cannot be honoured/);
  });

  it('leaves ordinary functions comma-separated', () => {
    // Only the functions the standard spells with a keyword are printed that
    // way, and the map that says which is not consulted for anything else.
    const { db } = context();
    const { text } = db.users.select((u) => ({ p: Math.pow(u.age, 2) })).toSQL();

    expect(text).toContain('POWER("t0"."age", $1)');
  });
});

describe('getMilliseconds', () => {
  it('is left to the provider, since EXTRACT stops at seconds', () => {
    // The standard's EXTRACT knows YEAR through SECOND and nothing finer, so a
    // millisecond is each database's own invention: PostgreSQL's MILLISECONDS,
    // MySQL's MICROSECOND, SQL Server's DATEPART.
    const { db } = context();

    expect(() => db.users.select((u) => ({ ms: u.createdAt.getMilliseconds() })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "getMilliseconds\(\.\.\.\)"/,
    );
  });
});

describe('Math.sign', () => {
  it('asks the database for the sign rather than spelling out a CASE', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ s: Math.sign(u.age) })).toSQL();

    expect(text).toContain('SIGN("t0"."age") AS "s"');
  });

  it('is a filter like any other, so it reaches a WHERE', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => Math.sign(u.age) === p.one, { one: 1 })
      .toSQL();

    expect(text).toContain('SIGN("t0"."age") = $1');
    expect(values).toEqual([1]);
  });
});

describe('Math.sin', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ s: Math.sin(u.age) })).toSQL();

    expect(text).toBe('SELECT SIN("t0"."age") AS "s" FROM "users" AS "t0"');
  });
});

describe('Math.cos', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ c: Math.cos(u.age) })).toSQL();

    expect(text).toBe('SELECT COS("t0"."age") AS "c" FROM "users" AS "t0"');
  });
});

describe('Math.exp', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ e: Math.exp(u.age) })).toSQL();

    expect(text).toBe('SELECT EXP("t0"."age") AS "e" FROM "users" AS "t0"');
  });
});

describe('Math.tan', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ t: Math.tan(u.age) })).toSQL();

    expect(text).toBe('SELECT TAN("t0"."age") AS "t" FROM "users" AS "t0"');
  });
});

describe('Math.atan', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ a: Math.atan(u.age) })).toSQL();

    expect(text).toBe('SELECT ATAN("t0"."age") AS "a" FROM "users" AS "t0"');
  });
});

describe('Math.asin', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ a: Math.asin(u.age) })).toSQL();

    expect(text).toBe('SELECT ASIN("t0"."age") AS "a" FROM "users" AS "t0"');
  });
});

describe('Math.acos', () => {
  it('is a portable name, so it lives in the base dialect rather than a provider', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ a: Math.acos(u.age) })).toSQL();

    expect(text).toBe('SELECT ACOS("t0"."age") AS "a" FROM "users" AS "t0"');
  });
});

describe('Math.trunc', () => {
  it('rounds toward zero with the two functions every database has', () => {
    // No two databases name a truncation alike, so it is built from FLOOR and
    // CEILING, which they do agree on.
    const { db } = context();
    const { text } = db.users.select((u) => ({ t: Math.trunc(u.age) })).toSQL();

    expect(text).toContain(
      'CASE WHEN "t0"."age" < 0 THEN CEILING("t0"."age") ELSE FLOOR("t0"."age") END AS "t"',
    );
  });

  it('does not compile to the FLOOR its neighbour does', () => {
    // The whole reason for the CASE: the two part company below zero, where
    // Math.trunc(-2.5) is -2 and Math.floor(-2.5) is -3.
    const { db } = context();
    const truncated = db.users.select((u) => ({ t: Math.trunc(u.age) })).toSQL().text;
    const floored = db.users.select((u) => ({ t: Math.floor(u.age) })).toSQL().text;

    expect(truncated).not.toEqual(floored);
    expect(floored).toContain('FLOOR("t0"."age") AS "t"');
  });
});

describe('Math.hypot', () => {
  it('sums squares under a square root, built from ANSI functions rather than a name of its own', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ len: Math.hypot(u.age, u.id) })).toSQL();

    expect(text).toBe(
      'SELECT SQRT(POWER("t0"."age", 2) + POWER("t0"."id", 2)) AS "len" FROM "users" AS "t0"',
    );
  });

  it('takes any number of arguments, since the function is variadic', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ len: Math.hypot(u.age, u.id, u.age) })).toSQL();

    expect(text).toContain(
      'SQRT(POWER("t0"."age", 2) + POWER("t0"."id", 2) + POWER("t0"."age", 2)) AS "len"',
    );
    expect(text).not.toContain('0 +');
  });

  it('answers zero for no arguments, as Math.hypot() itself does', () => {
    const { db } = context();
    const { text } = db.users.select(() => ({ len: Math.hypot() })).toSQL();

    expect(text).toBe('SELECT SQRT(0) AS "len" FROM "users" AS "t0"');
  });
});

describe('Math.cosh', () => {
  it('adds two exponentials under a division, built from EXP rather than a name of its own', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ c: Math.cosh(u.age) })).toSQL();

    expect(text).toBe(
      'SELECT (EXP("t0"."age") + EXP(0 - "t0"."age")) / 2 AS "c" FROM "users" AS "t0"',
    );
  });

  it('writes the negation as 0 - x rather than a bare unary minus', () => {
    // A bare unary minus on a bound parameter has nothing beside it to infer
    // a type from, the exact trap `at(-1)` fell into.
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => Math.cosh(p.rate) === u.age, { rate: 2 })
      .toSQL();

    expect(text).toContain('EXP(0 - $1)');
    expect(text).not.toContain('EXP(-$1)');
    expect(values).toEqual([2]);
  });
});

describe('Math.expm1', () => {
  it('is refused rather than translated as EXP(x) - 1, which loses precision near zero', () => {
    // The subtraction is the whole reason JavaScript has this function, so
    // emitting it here would answer the question `Math.expm1` exists to avoid.
    const { db } = context();

    expect(() => db.users.select((u) => ({ e: Math.expm1(u.age) })).toSQL()).toThrow(
      /"Math.expm1" cannot be translated precisely/,
    );
  });
});

describe('Math.log1p', () => {
  it('is refused rather than translated as LN(1 + x), which loses precision near zero', () => {
    // `1 + x` rounds back to 1 before LN sees it, the same trap `expm1`
    // sets for `EXP(x) - 1` read the other way round.
    const { db } = context();

    expect(() => db.users.select((u) => ({ l: Math.log1p(u.age) })).toSQL()).toThrow(
      /"Math.log1p" cannot be translated precisely/,
    );
  });
});

describe('codePointAt', () => {
  it('is left to the provider, since ASCII means different things', () => {
    // PostgreSQL returns a Unicode code point from ASCII over a UTF-8 database;
    // SQL Server's ASCII gives up outside ASCII and MySQL's answers zero.
    const { db } = context();

    expect(() => db.users.select((u) => ({ c: u.name.codePointAt(0) })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "codePointAt\(\.\.\.\)"/,
    );
  });
});

describe('toFixed', () => {
  it('is left to the provider, which alone knows what to cast through', () => {
    // PostgreSQL has no two-argument ROUND over a float, so the translation
    // needs a cast the base dialect has no portable spelling for.
    const { db } = context();

    expect(() => db.users.select((u) => ({ a: u.age.toFixed(2) })).toSQL()).toThrow(
      /The "test" dialect cannot translate the call "toFixed\(\.\.\.\)"/,
    );
  });
});

describe('zip', () => {
  const named = (db: ReturnType<typeof context>['db']) =>
    db.users.select((u) => ({ name: u.name })).orderBy((u) => u.name);
  const places = (db: ReturnType<typeof context>['db']) =>
    db.cities.select((c) => ({ city: c.name })).orderBy((c) => c.city);

  it('numbers each side over its own ordering and matches on the number', () => {
    const { db } = context();
    const { text } = named(db)
      .zip(places(db), (u, c) => ({ who: u.name, city: c.city }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."name" AS "who", "t3"."city" AS "city" FROM (' +
        'SELECT "t0"."name" AS "name", ROW_NUMBER() OVER (ORDER BY "t0"."name" ASC) ' +
        'AS "__sqlinqo_position" FROM "users" AS "t0") AS "t1" INNER JOIN (' +
        'SELECT "t2"."name" AS "city", ROW_NUMBER() OVER (ORDER BY "t2"."name" ASC) ' +
        'AS "__sqlinqo_position" FROM "cities" AS "t2") AS "t3" ' +
        'ON "t1"."__sqlinqo_position" = "t3"."__sqlinqo_position" ' +
        'ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('joins inner, which is what stops it at the shorter side', () => {
    // A position the other sequence never reaches matches nothing and the pair
    // is simply absent.
    const { db } = context();
    const { text } = named(db)
      .zip(places(db), (u, c) => ({ who: u.name, city: c.city }))
      .toSQL();

    expect(text).toContain('INNER JOIN');
    expect(text).not.toContain('LEFT JOIN');
  });

  it('orders the result by position', () => {
    const { db } = context();
    const { text } = named(db)
      .zip(places(db), (u, c) => ({ who: u.name, city: c.city }))
      .toSQL();

    expect(text).toMatch(/ORDER BY "t1"\."__sqlinqo_position" ASC$/);
  });

  it('keeps a paging bound inside its own side', () => {
    // The ordering has to stay where a limit depends on it, or the limit would
    // take an arbitrary set of rows to number.
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ name: u.name }))
      .orderBy((u) => u.name)
      .take(3)
      .orderBy((u) => u.name)
      .zip(places(db), (u, c) => ({ who: u.name, city: c.city }))
      .toSQL();

    expect(text).toMatch(/ORDER BY "t0"\."name" ASC LIMIT 3/);
  });

  it('filters the pairs rather than either side', () => {
    const { db } = context();
    const { text, values } = named(db)
      .zip(places(db), (u, c) => ({ who: u.name, city: c.city }))
      .where((row) => row.city === 'x')
      .toSQL();

    expect(text).toContain('WHERE "t3"."city" = $1');
    expect(values).toEqual(['x']);
  });

  it('renumbers the parameter bag of the zipped query', () => {
    const { db } = context();
    const { values } = db.users
      .where((u, p) => u.age > p.n, { n: 1 })
      .select((u) => ({ name: u.name }))
      .orderBy((u) => u.name)
      .zip(
        db.cities
          .where((c, p) => c.id > p.n, { n: 2 })
          .select((c) => ({ city: c.name }))
          .orderBy((c) => c.city),
        (u, c) => ({ who: u.name, city: c.city }),
      )
      .toSQL();

    expect(values).toEqual([1, 2]);
  });

  it('refuses to zip a query from another context', () => {
    const { db } = context();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { cities: City },
    });

    expect(() =>
      named(db).zip(
        other.cities.select((c) => ({ city: c.name })).orderBy((c) => c.city),
        (u, c) => ({ who: u.name, city: c.city }),
      ),
    ).toThrow(/"zip"/);
  });

  describe('with a third sequence', () => {
    const amounts = (db: ReturnType<typeof context>['db']) =>
      db.orders.select((o) => ({ total: o.total })).orderBy((o) => o.total);

    it('pairs it in alongside the first two, numbered and joined the same way', () => {
      const { db } = context();
      const { text } = named(db)
        .zip(places(db), amounts(db), (u, c, o) => ({ who: u.name, city: c.city, total: o.total }))
        .toSQL();

      expect(text).toContain(
        'SELECT "t1"."name" AS "who", "t3"."city" AS "city", "t5"."total" AS "total"',
      );
      expect(text.match(/INNER JOIN/g)).toHaveLength(2);
      expect(text).toContain('"t1"."__sqlinqo_position" = "t5"."__sqlinqo_position"');
    });

    it('renumbers the parameter bags of every zipped query', () => {
      const { db } = context();
      const { values } = db.users
        .where((u, p) => u.age > p.n, { n: 1 })
        .select((u) => ({ name: u.name }))
        .orderBy((u) => u.name)
        .zip(
          db.cities
            .where((c, p) => c.id > p.n, { n: 2 })
            .select((c) => ({ city: c.name }))
            .orderBy((c) => c.city),
          db.orders
            .where((o, p) => o.id > p.n, { n: 3 })
            .select((o) => ({ total: o.total }))
            .orderBy((o) => o.total),
          (u, c, o) => ({ who: u.name, city: c.city, total: o.total }),
        )
        .toSQL();

      expect(values).toEqual([1, 2, 3]);
    });

    it('refuses a third query from another context', () => {
      const { db } = context();
      const other = createDbContext({
        driver: new FakeDriver(),
        dialect: testDialect,
        entities: { orders: Order },
      });

      expect(() =>
        named(db).zip(
          places(db),
          other.orders.select((o) => ({ total: o.total })).orderBy((o) => o.total),
          (u, c, o) => ({ who: u.name, city: c.city, total: o.total }),
        ),
      ).toThrow(/"zip"/);
    });
  });
});

describe('normalize', () => {
  it('folds a string into its normal form', () => {
    const { db } = context();
    const { text } = db.users.select((u) => ({ n: u.name.normalize() })).toSQL();

    // `NORMALIZE` is the SQL standard's spelling, and its default form is NFC,
    // which is JavaScript's default too, so the bare call needs no argument on
    // either side.
    expect(text).toBe('SELECT NORMALIZE("t0"."name") AS "n" FROM "users" AS "t0"');
  });

  it('refuses a form, which cannot be bound as a value', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          n: (u.name as unknown as { normalize(f: string): string }).normalize('NFD'),
        }))
        .toSQL();

    // The form is a keyword in SQL rather than a value, and a literal argument
    // reaches a dialect as a bound parameter, which can never become one. So it
    // is refused rather than dropped, as `indexOf` refuses its start index.
    expect(query).toThrow(/The form is a keyword in SQL rather than a value/);
  });
});

describe('replaceAll', () => {
  it('translates to REPLACE, which changes every occurrence', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u, p) => ({ n: u.name.replaceAll(p.from, p.to) }), { from: 'a', to: 'X' })
      .toSQL();

    expect(text).toBe('SELECT REPLACE("t0"."name", $1, $2) AS "n" FROM "users" AS "t0"');
    expect(values).toEqual(['a', 'X']);
  });

  it('filters on the replaced value', () => {
    const { db } = context();
    const { text, values } = db.users.where((u) => u.name.replaceAll('a', 'X') === 'Y').toSQL();

    expect(text).toContain('WHERE REPLACE("t0"."name", $1, $2) = $3');
    expect(values).toEqual(['a', 'X', 'Y']);
  });

  it('refuses "replace", which stops at the first occurrence', () => {
    // SQL's REPLACE is `replaceAll`. Emitting it for `replace` would answer a
    // different question, so the mistake is named instead.
    const { db } = context();

    expect(() => db.users.select((u) => ({ n: u.name.replace('a', 'X') })).toSQL()).toThrow(
      /"replace" changes only the first occurrence/,
    );
  });

  it('rejects a call given the wrong number of arguments', () => {
    const { db } = context();
    const query = () =>
      db.users
        .select((u) => ({
          n: (u.name as unknown as { replaceAll(a: string): string }).replaceAll('a'),
        }))
        .toSQL();

    expect(query).toThrow(/"replaceAll" expects 2 argument\(s\)/);
  });
});

describe('average', () => {
  it('averages the projected value through a wrapping subquery', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '34.5', count: '2' }]);

    const mean = await db.users.average((u) => u.age);

    expect(mean).toBe(34.5);
    // The selector becomes an ordinary projection and the aggregate sits
    // outside it, which is what lets the operator carry no plan node.
    expect(driver.lastStatement.text).toBe(
      'SELECT AVG("t1"."value") AS "average", COUNT(*) AS "count" FROM ' +
        '(SELECT "t0"."age" AS "value" FROM "users" AS "t0") AS "t1"',
    );
  });

  it('averages the rows paging kept, not every row', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '30', count: '10' }]);

    await db.users
      .orderBy((u) => u.id)
      .take(10)
      .average((u) => u.age);

    // Two wrappings: one the projection needs because the query is paged, one
    // the aggregate needs. Folding AVG into the paged query would have applied
    // LIMIT to the single aggregated row instead of to the rows going into it.
    expect(driver.lastStatement.text).toBe(
      'SELECT AVG("t2"."value") AS "average", COUNT(*) AS "count" FROM ' +
        '(SELECT "t1"."age" AS "value" FROM (SELECT "t0"."id" AS "id", "t0"."name" AS "name", ' +
        '"t0"."email" AS "email", "t0"."age" AS "age", "t0"."city_id" AS "cityId", ' +
        '"t0"."is_active" AS "isActive", "t0"."created_at" AS "createdAt" FROM "users" AS "t0" ' +
        'ORDER BY "t0"."id" ASC LIMIT 10) AS "t1") AS "t2"',
    );
  });

  it('keeps DISTINCT meaning distinct rows rather than distinct values', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '34', count: '3' }]);

    await db.users.distinct().average((u) => u.age);

    // The DISTINCT stays on the full row inside its own derived table. Pushing
    // the projection into it would have averaged the distinct ages instead.
    expect(driver.lastStatement.text).toContain('(SELECT DISTINCT "t0"."id" AS "id"');
    expect(driver.lastStatement.text).toMatch(/^SELECT AVG\("t2"\."value"\) AS "average"/);
  });

  it('follows a navigation in the selector, as select does', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '41', count: '3' }]);

    await db.orders.average((o) => o.user.age);

    expect(driver.lastStatement.text).toContain('INNER JOIN "users" AS "t1"');
  });

  it('parameterises a computed selector', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '69', count: '3' }]);

    await db.users.average((u) => u.age * 2);

    expect(driver.lastStatement.text).toContain('"t0"."age" * $1 AS "value"');
    expect(driver.lastStatement.values).toEqual([2]);
  });

  it('binds a value from the parameter bag', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '10', count: '1' }]);

    await db.users.average((u, p) => u.age - p.offset, { offset: 5 });

    expect(driver.lastStatement.values).toEqual([5]);
  });

  it('normalises the string an exact numeric arrives as', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: '34.5', count: '2' }]);

    const mean = await db.users.average((u) => u.age);

    // AVG means a number in SQL, so the terminal converts rather than handing
    // back the string node-postgres uses to protect numeric precision.
    expect(typeof mean).toBe('number');
    expect(mean).toBe(34.5);
  });

  it('faults an empty query rather than answering zero', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: null, count: '0' }]);

    await expect(db.users.average((u) => u.age)).rejects.toThrow(
      /returned no rows but "average" requires at least one/,
    );
  });

  it('separates every value being null from there being no rows', async () => {
    const { db, driver } = context();
    driver.setRows([{ average: null, count: '3' }]);

    // AVG answers null for both, which is the whole reason COUNT(*) rides
    // along: the rows were there, so this is not the empty-query error.
    await expect(db.users.average((u) => u.cityId)).rejects.toThrow(
      /Every row the query returned had a null value/,
    );
  });

  it('rejects a selector that projects more than one value', async () => {
    const { db } = context();

    // Faulted as "average" rather than as the "select" it would have become.
    await expect(db.users.average((u) => ({ age: u.age }) as unknown as number)).rejects.toThrow(
      /"average" expects a selector choosing one value/,
    );
  });
});

describe('countDistinct', () => {
  it('counts the different values a selector takes', async () => {
    const { db, driver } = context();
    driver.setRows([{ countDistinct: '4' }]);

    const cities = await db.users.countDistinct((u) => u.cityId);

    expect(cities).toBe(4);
    expect(driver.lastStatement.text).toBe(
      'SELECT COUNT(DISTINCT "t1"."value") + ' +
        'CASE WHEN COUNT("t1"."value") < COUNT(*) THEN 1 ELSE 0 END AS "countDistinct" ' +
        'FROM (SELECT "t0"."city_id" AS "value" FROM "users" AS "t0") AS "t1"',
    );
  });

  it('counts null as a value, once, as LINQ does', async () => {
    const { db, driver } = context();
    driver.setRows([{ countDistinct: '4' }]);

    await db.users.countDistinct((u) => u.cityId);

    // `COUNT(DISTINCT ...)` skips nulls where LINQ counts one. The two counts
    // differ exactly when a null is present, which is the one it left out.
    expect(driver.lastStatement.text).toContain(
      'CASE WHEN COUNT("t1"."value") < COUNT(*) THEN 1 ELSE 0 END',
    );
  });

  it('normalises a count the driver returned as a string', async () => {
    const { db, driver } = context();
    driver.setRows([{ countDistinct: '7' }]);

    const answer = await db.users.countDistinct((u) => u.cityId);

    expect(answer).toBe(7);
    expect(typeof answer).toBe('number');
  });

  it('answers zero rather than faulting when nothing came back', async () => {
    const { db, driver } = context();
    driver.setRows([]);

    await expect(db.users.countDistinct((u) => u.cityId)).resolves.toBe(0);
  });

  it('projects a navigation before counting it', async () => {
    const { db, driver } = context();
    driver.setRows([{ countDistinct: '2' }]);

    await db.users.countDistinct((u) => u.city.name);

    // The projection is what turns the navigation into a join, which is why
    // this operator needs no plan node of its own.
    expect(driver.lastStatement.text).toContain('LEFT JOIN "cities" AS "t1"');
    expect(driver.lastStatement.text).toContain('SELECT "t1"."name" AS "value"');
  });

  it('counts within the rows paging settled on', async () => {
    const { db, driver } = context();
    driver.setRows([{ countDistinct: '3' }]);

    await db.users
      .orderBy((u) => u.id)
      .take(10)
      .countDistinct((u) => u.cityId);

    expect(driver.lastStatement.text).toContain('LIMIT 10');
  });

  it('rejects a selector that shapes a row rather than choosing a value', async () => {
    const { db } = context();

    await expect(
      db.users.countDistinct((u) => ({ a: u.cityId }) as unknown as number),
    ).rejects.toThrow(/"countDistinct" expects a selector choosing one value/);
  });
});

describe('sum', () => {
  it('totals the projected value, defaulting a null total to zero', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '122' }]);

    const total = await db.users.sum((u) => u.age);

    expect(total).toBe(122);
    // The COALESCE is the whole difference from `average`: SQL sums no rows to
    // null and LINQ sums them to zero, so the gap is closed in the statement.
    expect(driver.lastStatement.text).toBe(
      'SELECT COALESCE(SUM("t1"."value"), 0) AS "sum" FROM ' +
        '(SELECT "t0"."age" AS "value" FROM "users" AS "t0") AS "t1"',
    );
  });

  it('carries no COUNT alongside, as average has to', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '0' }]);

    await db.users.sum((u) => u.age);

    // An empty query and an all-null one both total zero, so unlike `average`
    // there is nothing here worth telling apart.
    expect(driver.lastStatement.text).not.toContain('COUNT(*)');
  });

  it('answers zero rather than faulting when nothing came back', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: null }]);

    await expect(db.users.sum((u) => u.age)).resolves.toBe(0);
  });

  it('totals the rows paging kept, not every row', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '81' }]);

    await db.users
      .orderBy((u) => u.id)
      .take(10)
      .sum((u) => u.age);

    expect(driver.lastStatement.text).toMatch(
      /^SELECT COALESCE\(SUM\("t2"\."value"\), 0\) AS "sum" FROM \(SELECT "t1"\."age" AS "value" FROM \(SELECT /,
    );
    expect(driver.lastStatement.text).toContain('LIMIT 10) AS "t1") AS "t2"');
  });

  it('follows a navigation in the selector', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '117' }]);

    await db.orders.sum((o) => o.user.age);

    expect(driver.lastStatement.text).toContain('INNER JOIN "users" AS "t1"');
  });

  it('parameterises a computed selector and a bag value', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '10' }]);

    await db.users.sum((u, p) => u.age * p.factor, { factor: 3 });

    expect(driver.lastStatement.text).toContain('"t0"."age" * $1 AS "value"');
    expect(driver.lastStatement.values).toEqual([3]);
  });

  it('normalises the string an exact numeric arrives as', async () => {
    const { db, driver } = context();
    driver.setRows([{ sum: '122' }]);

    const total = await db.users.sum((u) => u.age);

    expect(typeof total).toBe('number');
  });

  it('rejects a selector that projects more than one value', async () => {
    const { db } = context();

    await expect(db.users.sum((u) => ({ age: u.age }) as unknown as number)).rejects.toThrow(
      /"sum" expects a selector choosing one value/,
    );
  });
});

describe('min', () => {
  it('takes the smallest projected value through a wrapping subquery', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: 36, count: '3' }]);

    const smallest = await db.users.min((u) => u.age);

    expect(smallest).toBe(36);
    expect(driver.lastStatement.text).toBe(
      'SELECT MIN("t1"."value") AS "min", COUNT(*) AS "count" FROM ' +
        '(SELECT "t0"."age" AS "value" FROM "users" AS "t0") AS "t1"',
    );
  });

  it('neither casts nor coalesces, unlike sum and average', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: 36, count: '3' }]);

    await db.users.min((u) => u.age);

    // MIN returns a value that was already in the column, so there is nothing
    // to widen and no empty-case default to fold in.
    expect(driver.lastStatement.text).not.toContain('COALESCE');
    expect(driver.lastStatement.text).not.toContain('::');
  });

  it('hands back what the driver gave, rather than normalising to a number', async () => {
    const { db, driver } = context();
    const earliest = new Date('2024-01-15T09:00:00Z');
    driver.setRows([{ min: earliest, count: '3' }]);

    // Normalising the way `count` does would turn this into a number, and the
    // smallest name into NaN.
    await expect(db.users.min((u) => u.createdAt)).resolves.toBe(earliest);
  });

  it('takes the smallest of a text column', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: 'Ada', count: '3' }]);

    await expect(db.users.min((u) => u.name)).resolves.toBe('Ada');
  });

  it('faults an empty query', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: null, count: '0' }]);

    await expect(db.users.min((u) => u.age)).rejects.toThrow(
      /returned no rows but "min" requires at least one/,
    );
  });

  it('answers null when the rows were there but every value was null', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: null, count: '3' }]);

    // Where `average` raises a second error, `min` has a return type that can
    // carry the answer LINQ gives: the smallest of nothing but nulls is null.
    await expect(db.users.min((u) => u.cityId)).resolves.toBeNull();
  });

  it('takes the smallest of the rows paging kept', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: 36, count: '10' }]);

    await db.users
      .orderBy((u) => u.id)
      .take(10)
      .min((u) => u.age);

    expect(driver.lastStatement.text).toContain('LIMIT 10) AS "t1") AS "t2"');
  });

  it('follows a navigation and binds a bag value', async () => {
    const { db, driver } = context();
    driver.setRows([{ min: 36, count: '3' }]);

    await db.orders.min((o) => o.user.age);
    expect(driver.lastStatement.text).toContain('INNER JOIN "users" AS "t1"');

    driver.setRows([{ min: 1, count: '3' }]);
    await db.users.min((u, p) => u.age - p.offset, { offset: 5 });
    expect(driver.lastStatement.values).toEqual([5]);
  });

  it('rejects a selector that projects more than one value', async () => {
    const { db } = context();

    await expect(db.users.min((u) => ({ age: u.age }))).rejects.toThrow(
      /"min" expects a selector choosing one value/,
    );
  });
});

describe('max', () => {
  it('takes the largest projected value, sharing min compilation', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: 45, count: '3' }]);

    const largest = await db.users.max((u) => u.age);

    expect(largest).toBe(45);
    // The same statement as `min` with one word changed, which is what
    // measuring the two against the database licensed.
    expect(driver.lastStatement.text).toBe(
      'SELECT MAX("t1"."value") AS "max", COUNT(*) AS "count" FROM ' +
        '(SELECT "t0"."age" AS "value" FROM "users" AS "t0") AS "t1"',
    );
  });

  it('neither casts nor coalesces', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: 45, count: '3' }]);

    await db.users.max((u) => u.age);

    expect(driver.lastStatement.text).not.toContain('COALESCE');
    expect(driver.lastStatement.text).not.toContain('::');
  });

  it('hands back a date untouched, as min does', async () => {
    const { db, driver } = context();
    const latest = new Date('2024-12-01T23:45:59Z');
    driver.setRows([{ max: latest, count: '3' }]);

    await expect(db.users.max((u) => u.createdAt)).resolves.toBe(latest);
  });

  it('takes the largest of a text column', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: 'Grace', count: '3' }]);

    await expect(db.users.max((u) => u.name)).resolves.toBe('Grace');
  });

  it('faults an empty query', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: null, count: '0' }]);

    await expect(db.users.max((u) => u.age)).rejects.toThrow(
      /returned no rows but "max" requires at least one/,
    );
  });

  it('answers null when the rows were there but every value was null', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: null, count: '3' }]);

    await expect(db.users.max((u) => u.cityId)).resolves.toBeNull();
  });

  it('takes the largest of the rows paging kept', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: 45, count: '10' }]);

    await db.users
      .orderBy((u) => u.id)
      .take(10)
      .max((u) => u.age);

    expect(driver.lastStatement.text).toContain('LIMIT 10) AS "t1") AS "t2"');
  });

  it('follows a navigation and binds a bag value', async () => {
    const { db, driver } = context();
    driver.setRows([{ max: 45, count: '3' }]);

    await db.orders.max((o) => o.user.age);
    expect(driver.lastStatement.text).toContain('INNER JOIN "users" AS "t1"');

    driver.setRows([{ max: 40, count: '3' }]);
    await db.users.max((u, p) => u.age - p.offset, { offset: 5 });
    expect(driver.lastStatement.values).toEqual([5]);
  });

  it('names itself, not min, when the selector projects more than one value', async () => {
    const { db } = context();

    await expect(db.users.max((u) => ({ age: u.age }))).rejects.toThrow(
      /"max" expects a selector choosing one value/,
    );
  });
});

describe('minBy', () => {
  const ada = {
    id: 1,
    name: 'Ada',
    email: 'ada@example.com',
    age: 36,
    cityId: null,
    isActive: true,
    createdAt: new Date(0),
  };

  it('is orderBy and first, answering the whole row rather than the key alone', async () => {
    const { db, driver } = context();
    driver.setRows([ada]);

    await expect(db.users.minBy((u) => u.age)).resolves.toEqual(ada);

    const { text } = driver.lastStatement;
    expect(text).toContain('ORDER BY "t0"."age" ASC');
    expect(text).toContain('LIMIT 1');
  });

  it('faults an empty query, as first does', async () => {
    const { db } = context();

    await expect(db.users.minBy((u) => u.age)).rejects.toThrow(
      /returned no rows but "first" requires at least one/,
    );
  });
});

describe('maxBy', () => {
  it('is minBy read the other way, ordering descending rather than ascending', async () => {
    const { db, driver } = context();
    const grace = {
      id: 2,
      name: 'Grace',
      email: 'grace@example.com',
      age: 45,
      cityId: null,
      isActive: true,
      createdAt: new Date(0),
    };
    driver.setRows([grace]);

    await expect(db.users.maxBy((u) => u.age)).resolves.toEqual(grace);
    expect(driver.lastStatement.text).toContain('ORDER BY "t0"."age" DESC');
  });
});

describe('order', () => {
  it('sorts a scalar projection by itself, ascending', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => u.age)
      .order()
      .toSQL();

    expect(text).toBe('SELECT "t0"."age" AS "value" FROM "users" AS "t0" ORDER BY "t0"."age" ASC');
  });

  it('keeps working after distinct, which preserves the scalar shape', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => u.age)
      .distinct()
      .order()
      .toSQL();

    expect(text).toContain('SELECT DISTINCT');
    expect(text).toContain('ORDER BY "t0"."age" ASC');
  });

  it('rejects a query that still projects a row', () => {
    const { db } = context();
    const query = () => db.users.order();

    expect(query).toThrow(/"order" works over a query that projects one value/);
  });
});

describe('orderDescending', () => {
  it('sorts a scalar projection by itself, descending', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => u.age)
      .orderDescending()
      .toSQL();

    expect(text).toBe('SELECT "t0"."age" AS "value" FROM "users" AS "t0" ORDER BY "t0"."age" DESC');
  });

  it('rejects a query that still projects a row', () => {
    const { db } = context();
    const query = () => db.users.orderDescending();

    expect(query).toThrow(/"order" works over a query that projects one value/);
  });
});

describe('contains', () => {
  it('asks any about the rows equal to the value, in one statement', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '1' }]);

    await expect(db.users.select((u) => u.email).contains('ada@example.com')).resolves.toBe(true);

    expect(driver.statements).toHaveLength(1);
    const { text, values } = driver.lastStatement;
    expect(text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
    expect(text).toContain('LIMIT 1');
    expect(values).toEqual(['ada@example.com']);
  });

  it('is false when no row carries the value', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '0' }]);

    await expect(db.users.select((u) => u.age).contains(36)).resolves.toBe(false);
  });

  it('compares in a way a null survives, since null is a value here', async () => {
    const { db, driver } = context();
    driver.setRows([{ count: '1' }]);

    await db.users.select((u) => u.cityId).contains(null);

    // A plain `= $1` is unknown against a null parameter, so the rows sharing
    // a null would never be found by it.
    expect(driver.lastStatement.text).toContain('IS NULL');
    expect(driver.lastStatement.values).toEqual([null]);
  });

  it('rejects a query that still projects a row', async () => {
    const { db } = context();

    await expect(db.users.contains({} as never)).rejects.toThrow(
      /"contains" works over a query that projects one value/,
    );
  });
});

describe('chunkBy generation', () => {
  /** The statements one walk of the runs issues, with no rows to walk. */
  async function statementsFor(
    build: (db: ReturnType<typeof context>['db']) => AsyncIterableIterator<unknown[]>,
    pages: Record<string, unknown>[][] = [[]],
  ) {
    const driver = new PagingDriver(pages);
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, orders: Order, cities: City, posts: Post, comments: Comment },
    });
    for await (const run of build(db)) void run;
    return driver.statements;
  }

  it('numbers the runs of a key and asks for one of them', async () => {
    const [statement] = await statementsFor((db) =>
      db.users
        .select((u) => ({ id: u.id, cityId: u.cityId }))
        .orderBy((u) => u.id)
        .chunkBy((u) => u.cityId),
    );

    expect(statement?.text).toBe(
      'SELECT "t2"."id" AS "id", "t2"."cityId" AS "cityId" FROM (' +
        'SELECT "t1"."id" AS "id", "t1"."cityId" AS "cityId", ' +
        '"t1"."__sqlinqo_position" AS "__sqlinqo_position", ' +
        'SUM("t1"."__sqlinqo_break") OVER (ORDER BY "t1"."__sqlinqo_position" ASC ' +
        'ROWS UNBOUNDED PRECEDING) AS "__sqlinqo_chunk" FROM (' +
        'SELECT "t0"."id" AS "id", "t0"."city_id" AS "cityId", ' +
        'CASE WHEN ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) > 1 AND (' +
        '"t0"."city_id" = LAG("t0"."city_id") OVER (ORDER BY "t0"."id" ASC) OR ' +
        '"t0"."city_id" IS NULL AND ' +
        'LAG("t0"."city_id") OVER (ORDER BY "t0"."id" ASC) IS NULL) THEN 0 ELSE 1 END ' +
        'AS "__sqlinqo_break", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1") AS "t2" ' +
        'WHERE "t2"."__sqlinqo_chunk" = 1 ORDER BY "t2"."__sqlinqo_position" ASC',
    );
  });

  it('settles the break a level below the sum, since windows do not nest', async () => {
    const [statement] = await statementsFor((db) =>
      db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId),
    );

    // The running sum is over a plain column, not over the `LAG` that produced
    // it. PostgreSQL rejects a window function inside another one outright, so
    // this is the reason for the second derived table rather than a preference.
    expect(statement?.text).toContain('SUM("t1"."__sqlinqo_break") OVER');
    expect(statement?.text).not.toMatch(/SUM\([^)]*LAG/);
  });

  it('holds two null keys together, where an equality alone would cut between them', async () => {
    const [statement] = await statementsFor((db) =>
      db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId),
    );

    // `NULL = NULL` is unknown rather than true, and the `CASE` reads unknown
    // as a break, so a run of rows with no city would be cut between every pair
    // of them. LINQ's default comparer holds them together, and asking about
    // the null as well is what agrees with it.
    expect(statement?.text).toContain(
      '"t0"."city_id" IS NULL AND LAG("t0"."city_id") OVER (ORDER BY "t0"."id" ASC) IS NULL',
    );
  });

  it('starts a run at the first row whatever its key', async () => {
    const [statement] = await statementsFor((db) =>
      db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId),
    );

    // Without this the rule above turns on the first row of a table: there is
    // no row before it, `LAG` answers null, and a first row whose own key is
    // null would match a previous row that does not exist. The first run would
    // then be numbered zero and the walk would start at the second.
    expect(statement?.text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) > 1 AND');
  });

  it('breaks the run when any part of an object key changes', async () => {
    const [statement] = await statementsFor((db) =>
      db.users.orderBy((u) => u.id).chunkBy((u) => ({ city: u.cityId, active: u.isActive })),
    );

    // One key with two parts, as `groupBy` reads such a key, so the run
    // continues only while both of them do.
    expect(statement?.text).toContain(
      '("t0"."city_id" = LAG("t0"."city_id") OVER (ORDER BY "t0"."id" ASC) OR ' +
        '"t0"."city_id" IS NULL AND ' +
        'LAG("t0"."city_id") OVER (ORDER BY "t0"."id" ASC) IS NULL) AND (' +
        '"t0"."is_active" = LAG("t0"."is_active") OVER (ORDER BY "t0"."id" ASC) OR ',
    );
  });

  it('parenthesises a comparison key against the lagged one', async () => {
    const [statement] = await statementsFor((db) =>
      db.users.orderBy((u) => u.id).chunkBy((u) => u.age > 30),
    );

    // Comparison does not associate in SQL, so `age > $1 = LAG(...)` is a
    // syntax error in PostgreSQL rather than the comparison of a comparison
    // that was meant. This is the first operator to nest one inside another.
    expect(statement?.text).toContain('("t0"."age" > $1) = LAG("t0"."age" > $1) OVER');
    expect(statement?.values).toEqual([30]);
  });

  it('asks for the next run by number, one statement each', async () => {
    const statements = await statementsFor(
      (db) => db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId),
      [[{ id: 1 }], [{ id: 2 }], []],
    );

    expect(statements).toHaveLength(3);
    expect(
      statements.map((statement) => /__sqlinqo_chunk" = \d+/.exec(statement.text)?.[0]),
    ).toEqual(['__sqlinqo_chunk" = 1', '__sqlinqo_chunk" = 2', '__sqlinqo_chunk" = 3']);
  });

  it('reads the runs back in the order the query asked for', async () => {
    const ascending = await statementsFor((db) =>
      db.users.orderBy((u) => u.createdAt).chunkBy((u) => u.cityId),
    );
    const descending = await statementsFor((db) =>
      db.users.orderByDescending((u) => u.createdAt).chunkBy((u) => u.cityId),
    );

    // Only the sort direction differs, and it decides both which rows are next
    // to each other and which run comes first.
    expect(descending[0]?.text).toBe(
      ascending[0]?.text.replaceAll('"t0"."created_at" ASC', '"t0"."created_at" DESC'),
    );
  });

  it('lags over every sort key, in order', async () => {
    const [statement] = await statementsFor((db) =>
      db.users
        .orderBy((u) => u.age)
        .thenByDescending((u) => u.id)
        .chunkBy((u) => u.cityId),
    );

    expect(statement?.text).toContain(
      'LAG("t0"."city_id") OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC)',
    );
  });

  it('joins a navigation the key follows', async () => {
    const [statement] = await statementsFor((db) =>
      db.orders.orderBy((o) => o.id).chunkBy((o) => o.user.name),
    );

    // The join lives inside the innermost derived table, which is the only
    // place the `LAG` can see it.
    expect(statement?.text).toContain(
      'FROM "sales"."orders" AS "t0" INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id") AS "t2"',
    );
    expect(statement?.text).toContain('LAG("t1"."name")');
  });

  it('keeps the bookkeeping columns out of the result', async () => {
    const [statement] = await statementsFor((db) =>
      db.users
        .select((u) => ({ id: u.id, cityId: u.cityId }))
        .orderBy((u) => u.id)
        .chunkBy((u) => u.cityId),
    );

    expect(statement?.text).toMatch(
      /^SELECT "t2"\."id" AS "id", "t2"\."cityId" AS "cityId" FROM \(/,
    );
  });

  it('refuses a plan built without an ordering', () => {
    // The typed API only offers the operator on an ordered query, so the guard
    // is reachable only by handing the compiler a plan built by hand. Without
    // an ordering no two rows are consecutive and every run would be whatever
    // the database happened to return next to what.
    const compile = () =>
      compileQuery(
        {
          kind: 'chunkBy',
          source: { kind: 'source', entity: User },
          key: toExpression((u: UserRow) => u.cityId, { rowParameterCount: 1 }),
          index: 0,
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"chunkBy" needs an ordering/);
  });

  it('refuses a plan asking for a run that could not exist', () => {
    const compile = () =>
      compileQuery(
        {
          kind: 'chunkBy',
          source: {
            kind: 'orderBy',
            source: { kind: 'source', entity: User },
            keys: [
              {
                key: toExpression((u: UserRow) => u.id, { rowParameterCount: 1 }),
                descending: false,
              },
            ],
          },
          key: toExpression((u: UserRow) => u.cityId, { rowParameterCount: 1 }),
          index: -1,
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"chunkBy" expects a non-negative integer/);
  });
});

describe('exceptBy generation', () => {
  it('subtracts with a correlated NOT EXISTS', () => {
    const { db } = context();
    const { text } = db.users
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    expect(text).toBe(
      'SELECT "t0"."id" AS "id", "t0"."name" AS "name", "t0"."email" AS "email", ' +
        '"t0"."age" AS "age", "t0"."city_id" AS "cityId", "t0"."is_active" AS "isActive", ' +
        '"t0"."created_at" AS "createdAt" FROM "users" AS "t0" ' +
        'WHERE NOT EXISTS (SELECT 1 AS "__sqlinqo_exists" FROM "cities" AS "t1" ' +
        'WHERE "t0"."city_id" = "t1"."id" OR "t0"."city_id" IS NULL AND "t1"."id" IS NULL)',
    );
  });

  it('is not NOT IN, which a single null on the other side would empty', () => {
    const { db } = context();
    const { text } = db.users
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    // `x NOT IN (..., NULL)` is unknown for every row, so the whole query
    // returns nothing, silently and only when the data happens to hold a null.
    // `NOT EXISTS` asks about rows rather than values and has no such cliff.
    expect(text).toContain('NOT EXISTS');
    expect(text).not.toContain('NOT IN');
  });

  it('treats two null keys as a match, as EXCEPT and LINQ both do', () => {
    const { db } = context();
    const { text } = db.users
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    expect(text).toContain('"t0"."city_id" IS NULL AND "t1"."id" IS NULL');
  });

  it('pairs the parts of an object key by name, not by position', () => {
    const { db } = context();
    const declared = db.users
      .exceptBy(
        db.cities,
        (u) => ({ ref: u.cityId, label: u.name }),
        (c) => ({ ref: c.id, label: c.name }),
      )
      .toSQL().text;
    const reversed = db.users
      .exceptBy(
        db.cities,
        (u) => ({ ref: u.cityId, label: u.name }),
        (c) => ({ label: c.name, ref: c.id }),
      )
      .toSQL().text;

    // Both selectors are a `TKey` whatever order they declare, which the type
    // system cannot see. Pairing positionally would compare the city against
    // the name, which is the mistake `alignColumns` already made once.
    expect(reversed).toBe(declared);
    expect(declared).toContain(
      'WHERE ("t0"."city_id" = "t1"."id" OR "t0"."city_id" IS NULL AND "t1"."id" IS NULL) AND ' +
        '("t0"."name" = "t1"."name" OR "t0"."name" IS NULL AND "t1"."name" IS NULL)',
    );
  });

  it('refuses two keys that do not have the same parts', () => {
    const { db } = context();
    const compile = () =>
      db.users
        .exceptBy(
          db.cities,
          (u) => ({ ref: u.cityId }),
          // The property names differ, which `TKey` alone does not catch.
          (c) => ({ other: c.id }) as unknown as { ref: number | null },
        )
        .toSQL();

    expect(compile).toThrow(/"exceptBy" compares the two keys part by part/);
  });

  it('refuses an object key against a key of one value', () => {
    const { db } = context();
    const compile = () =>
      db.users
        .exceptBy(
          db.cities,
          (u) => ({ ref: u.cityId }),
          (c) => c.id as unknown as { ref: number | null },
        )
        .toSQL();

    expect(compile).toThrow(/has no counterpart in/);
  });

  it('pushes a filtered other side into its own derived table', () => {
    const { db } = context();
    const { text, values } = db.users
      .exceptBy(
        db.cities.where((c) => c.country === 'uk'),
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    expect(text).toContain(
      'FROM (SELECT "t1"."id" AS "id", "t1"."name" AS "name", "t1"."country" AS "country" ' +
        'FROM "cities" AS "t1" WHERE "t1"."country" = $1) AS "t2"',
    );
    expect(values).toEqual(['uk']);
  });

  it('subtracts from the rows paging kept, not from the ones behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(2)
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    // The limit is settled first, so this drops rows from the two that survived
    // rather than promoting a third into their place.
    expect(text).toContain('LIMIT 2) AS "t1" WHERE NOT EXISTS');
  });

  it('joins a navigation this side follows outside the subquery', () => {
    const { db } = context();
    const { text } = db.orders
      .exceptBy(
        db.cities,
        (o) => o.user.name,
        (c) => c.name,
      )
      .toSQL();

    expect(text).toContain(
      'FROM "sales"."orders" AS "t0" INNER JOIN "users" AS "t2" ON "t0"."user_id" = "t2"."id" ' +
        'WHERE NOT EXISTS',
    );
    expect(text).toContain('"t2"."name" = "t1"."name"');
  });

  it('joins a navigation the other side follows inside the subquery', () => {
    const { db } = context();
    const { text } = db.users
      .exceptBy(
        db.orders,
        (u) => u.name,
        (o) => o.user.name,
      )
      .toSQL();

    // The join belongs to the subquery, which is the only place its columns are
    // in scope.
    expect(text).toContain(
      'FROM "sales"."orders" AS "t1" INNER JOIN "users" AS "t2" ON "t1"."user_id" = "t2"."id" ' +
        'WHERE "t0"."name" = "t2"."name"',
    );
  });

  it('keeps the two sides and their bound values apart', () => {
    const { db } = context();
    const { text, values } = db.users
      .where((u, p) => u.age > p.min, { min: 18 })
      .exceptBy(
        db.cities.where((c, p) => c.country === p.country, { country: 'uk' }),
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    // Both queries numbered their bags from zero, so the other side's are
    // renumbered past this one's before the two plans are combined.
    expect(text).toContain('WHERE "t0"."age" > $1');
    expect(values).toEqual([18, 'uk']);
  });

  it('filters and pages what survived', () => {
    const { db } = context();
    const { text } = db.users
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .where((u) => u.isActive)
      .take(5)
      .toSQL();

    expect(text).toContain('IS NULL) AND "t0"."is_active" LIMIT 5');
  });

  it('needs no ordering, unlike the operators that ask a positional question', () => {
    const { db } = context();

    // Whether a key appears somewhere is a question about a set, so nothing
    // here depends on which row comes first and no window is involved.
    const { text } = db.users
      .exceptBy(
        db.cities,
        (u) => u.cityId,
        (c) => c.id,
      )
      .toSQL();

    expect(text).not.toContain('ROW_NUMBER');
    expect(text).not.toContain('ORDER BY');
  });
});

describe('pairwise generation', () => {
  it('carries a lagged copy of every column and drops the first row by position', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.id)
      .pairwise((before, now) => ({ at: now.id, change: now.age - before.age }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."id" AS "at", "t1"."age" - "t1"."__sqlinqo_prev_age" AS "change" FROM (' +
        'SELECT "t0"."id" AS "id", "t0"."age" AS "age", ' +
        'LAG("t0"."id") OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_prev_id", ' +
        'LAG("t0"."age") OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_prev_age", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_position" > 1 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('drops the first row by position rather than by testing the lagged columns', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .pairwise((before, now) => now.age - before.age)
      .toSQL();

    // `LAG` answers null for the first row, which is indistinguishable from a
    // real earlier row whose columns were null. Only the position can tell them
    // apart, so only the position is asked.
    expect(text).toContain('WHERE "t1"."__sqlinqo_position" > 1');
    expect(text).not.toContain('"__sqlinqo_prev_age" IS NULL');
  });

  it('lags a projected expression rather than the column behind it', () => {
    const { db } = context();
    const { text, values } = db.users
      .select((u) => ({ old: u.age > 30 }))
      .orderBy((u) => u.old)
      .pairwise((before, now) => ({ was: before.old, is: now.old }))
      .toSQL();

    expect(text).toContain('LAG("t0"."age" > $1) OVER');
    expect(values).toEqual([30]);
  });

  it('lags over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .pairwise((before, now) => now.age - before.age)
      .toSQL();

    expect(text).toContain('LAG("t0"."age") OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC)');
  });

  it('pairs each row with the one after it when the ordering is reversed', () => {
    const { db } = context();
    const forwards = db.users
      .orderBy((u) => u.createdAt)
      .pairwise((before, now) => now.age - before.age)
      .toSQL().text;
    const backwards = db.users
      .orderByDescending((u) => u.createdAt)
      .pairwise((before, now) => now.age - before.age)
      .toSQL().text;

    // Only the sort direction differs, and it is what decides which row is
    // "before" as well as which pair comes first.
    expect(backwards).toBe(forwards.replaceAll('"t0"."created_at" ASC', '"t0"."created_at" DESC'));
  });

  it('hands back the earlier row whole, under its own property names', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.id)
      .pairwise((before) => before)
      .toSQL();

    // The prefix is the compiler's business, so a projection of the earlier row
    // reads as the row it stands for.
    expect(text).toMatch(
      /^SELECT "t1"\."__sqlinqo_prev_id" AS "id", "t1"\."__sqlinqo_prev_age" AS "age" FROM \(/,
    );
  });

  it('unwraps a projection of one value, as any other query does', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .pairwise((before, now) => now.age - before.age)
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."age" - "t1"\."__sqlinqo_prev_age" AS "value" FROM \(/);
  });

  it('pairs the rows paging kept, not the ones behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(2)
      .orderBy((u) => u.id)
      .pairwise((before, now) => now.age - before.age)
      .toSQL();

    // The limit is settled first, so the pair that would have spanned the edge
    // of the page is not made at all.
    expect(text).toContain('LIMIT 2) AS "t1"');
    expect(text).toContain('LAG("t1"."age") OVER');
  });

  it('filters the pairs, not the rows they were made from', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.id)
      .pairwise((before, now) => ({ at: now.id, change: now.age - before.age }))
      .where((pair) => pair.change > 1)
      .toSQL();

    // A row dropped here still contributed the pair behind it, which is what
    // makes this different from filtering before pairing.
    expect(text).toContain(
      'WHERE "t1"."__sqlinqo_position" > 1 AND "t1"."age" - "t1"."__sqlinqo_prev_age" > $1',
    );
  });

  it('keeps the bookkeeping columns out of the result', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id }))
      .orderBy((u) => u.id)
      .pairwise((before, now) => ({ was: before.id, is: now.id }))
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."__sqlinqo_prev_id" AS "was", "t1"\."id" AS "is" FROM \(/);
    // The position is aliased once, inside the derived table, and is read
    // outside it only by the filter and the ordering.
    expect(text.split('AS "__sqlinqo_position"')).toHaveLength(2);
  });

  it('refuses a plan built without an ordering', () => {
    // The typed API only offers the operator on an ordered query, so the guard
    // is reachable only by handing the compiler a plan built by hand. Without
    // an ordering no row is before any other and there is nothing to pair.
    const compile = () =>
      compileQuery(
        {
          kind: 'pairwise',
          source: { kind: 'source', entity: User },
          projector: toExpression((a: UserRow, b: UserRow) => b.age - a.age, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"pairwise" needs an ordering/);
  });

  it('refuses a navigation off either row, naming what is in scope', () => {
    const { db } = context();

    // Both rows are read back out of a derived table, which is where the entity
    // they came from stops being available. `zip`'s projector has the same
    // limit for the same reason.
    expect(() =>
      db.orders
        .orderBy((o) => o.id)
        .pairwise((before, now) => ({ who: before.user.name, at: now.id }))
        .toSQL(),
    ).toThrow(/"user" is not a property of pairwise/);
  });
});

describe('windowed generation', () => {
  it('reduces a frame of the run and drops the short runs by position', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run, row) => ({ at: row.id, mean: run.average((r) => r.age) }))
      .toSQL();

    expect(text).toBe(
      'SELECT "t1"."at" AS "at", "t1"."mean" AS "mean" FROM (' +
        'SELECT "t0"."id" AS "at", ' +
        'AVG("t0"."age") OVER (ORDER BY "t0"."id" ASC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) ' +
        'AS "mean", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_position" >= 3 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('frames one row fewer than the run holds, the current row being the other', () => {
    const { db } = context();
    const framed = (size: number) =>
      db.users
        .orderBy((u) => u.id)
        .windowed(size, (run) => run.sum((r) => r.age))
        .toSQL().text;

    // A run of `size` rows is `size - 1` preceding rows and the one it ends at,
    // so the two numbers a frame carries never match the size directly.
    expect(framed(1)).toContain('ROWS BETWEEN 0 PRECEDING AND CURRENT ROW');
    expect(framed(2)).toContain('ROWS BETWEEN 1 PRECEDING AND CURRENT ROW');
    expect(framed(30)).toContain('ROWS BETWEEN 29 PRECEDING AND CURRENT ROW');
  });

  it('drops the rows with no full run behind them, and only those', () => {
    const { db } = context();
    const dropped = (size: number) =>
      db.users
        .orderBy((u) => u.id)
        .windowed(size, (run) => run.sum((r) => r.age))
        .toSQL().text;

    // `n` rows make `n - size + 1` runs, so the test keeps the rows from the
    // `size`th onward. At two that is `pairwise`'s own "all but the first".
    expect(dropped(2)).toContain('WHERE "t1"."__sqlinqo_position" >= 2');
    expect(dropped(5)).toContain('WHERE "t1"."__sqlinqo_position" >= 5');
  });

  it('drops them by position rather than by testing the aggregate for null', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.average((r) => r.age))
      .toSQL();

    // A run over a column of nulls averages to null whether it is full or
    // short, so only the position can tell the two apart. This is `pairwise`'s
    // reason for dropping its first row the same way.
    expect(text).not.toContain('IS NULL');
  });

  it('filters after the frames are computed, not before', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.average((r) => r.age))
      .toSQL();

    // The test on the position sits outside the derived table the windows are
    // computed in. Applied inside it, it would shorten the very frames it is
    // meant to select from and the first surviving row would average over
    // itself alone.
    expect(text).toMatch(/AS "__sqlinqo_position" FROM "users" AS "t0"\) AS "t1" WHERE/);
  });

  it('counts every row of the run with a star, which COUNT() alone is not', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(4, (run) => run.count())
      .toSQL();

    // `SqlOver` prints the arguments it is given, where `SqlAggregate` spells
    // an absent one as a star itself, so the star is passed here. The answer is
    // the size for every row that comes back, the short runs having been
    // dropped, which is worth generating correctly and rarely worth asking.
    expect(text).toContain('COUNT(*) OVER (ORDER BY "t0"."id" ASC ROWS BETWEEN 3 PRECEDING');
  });

  it('reads back every row of the run when asked for the run itself', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.id)
      .windowed(3, (run, row) => ({ at: row.id, rows: run.toArray() }))
      .toSQL();

    // The same `json_agg` a group's `toArray` builds, over a frame instead of a
    // GROUP BY, which is the literal reading of "every run of three rows".
    expect(text).toContain(
      'json_agg(json_build_object($1 :: text, "t0"."id", $2 :: text, "t0"."age")) OVER (',
    );
    expect(text).toContain('ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS "rows"');
  });

  it('frames over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .windowed(3, (run) => run.sum((r) => r.age))
      .toSQL();

    expect(text).toContain(
      'SUM("t0"."age") OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC ROWS BETWEEN 2 PRECEDING',
    );
  });

  it('runs ahead of each row instead of behind it when the ordering is reversed', () => {
    const { db } = context();
    const forwards = db.users
      .orderBy((u) => u.createdAt)
      .windowed(3, (run) => run.average((r) => r.age))
      .toSQL().text;
    const backwards = db.users
      .orderByDescending((u) => u.createdAt)
      .windowed(3, (run) => run.average((r) => r.age))
      .toSQL().text;

    // Only the sort direction differs, and it is what decides which rows are
    // behind a row as well as which run comes first.
    expect(backwards).toBe(forwards.replaceAll('"t0"."created_at" ASC', '"t0"."created_at" DESC'));
  });

  it('unwraps a projection of one value, as any other query does', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.average((r) => r.age))
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."value" AS "value" FROM \(/);
  });

  it('frames the rows paging kept, not the ones behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(4)
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.sum((r) => r.age))
      .toSQL();

    // The limit is settled first, so a run that would have reached back past
    // the edge of the page is not made at all.
    expect(text).toContain('LIMIT 4) AS "t1"');
    expect(text).toContain('SUM("t1"."age") OVER');
  });

  it('filters the runs, not the rows they were made from', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run, row) => ({ at: row.id, mean: run.average((r) => r.age) }))
      .where((w) => w.mean > 30)
      .toSQL();

    // A row dropped here still contributed to the runs around it, which is what
    // makes this different from filtering before windowing.
    expect(text).toContain('WHERE "t1"."__sqlinqo_position" >= 3 AND "t1"."mean" > $1');
  });

  it('keeps the bookkeeping column out of the result', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowed(2, (run, row) => ({ id: row.id, total: run.sum((r) => r.age) }))
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."id" AS "id", "t1"\."total" AS "total" FROM \(/);
    // The position is aliased once, inside the derived table, and is read
    // outside it only by the filter and the ordering.
    expect(text.split('AS "__sqlinqo_position"')).toHaveLength(2);
  });

  it('follows a navigation off the row, which pairwise cannot', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .windowed(3, (run, row) => ({ who: row.user.name, mean: run.average((r) => r.total) }))
      .toSQL();

    // Both the run and the row read the query's own rows rather than a derived
    // table's columns, so the entity a navigation needs is still there. This is
    // the one thing `windowed` can do that `pairwise` cannot.
    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
  });

  it('refuses a run used as a value, naming the aggregate to reach for', () => {
    const { db } = context();

    expect(() =>
      db.users
        .orderBy((u) => u.id)
        // A run is many rows and has no column, which is a group's own limit.
        .windowed(3, (run) => run as unknown as number)
        .toSQL(),
    ).toThrow(/"run" is a group, not a row\. Project an aggregate of it, such as run\.count\(\)\./);
  });

  it('refuses countDistinct over a run, which SQL does not define', () => {
    const { db } = context();

    // The type already keeps this off a run, so it is reachable only by casting
    // past it or by building the IR another way. PostgreSQL would answer a
    // syntax error, which names neither the operator nor the method.
    expect(() =>
      db.users
        .orderBy((u) => u.id)
        .windowed(3, (run) =>
          (run as unknown as { countDistinct(v: (r: UserRow) => number): number }).countDistinct(
            (r) => r.age,
          ),
        )
        .toSQL(),
    ).toThrow(/"countDistinct" is not defined over a window/);
  });

  it('refuses a plan built without an ordering', () => {
    // The typed API only offers the operator on an ordered query, so the guard
    // is reachable only by handing the compiler a plan built by hand. Without
    // an ordering no rows are consecutive and there is no run to reduce.
    const compile = () =>
      compileQuery(
        {
          kind: 'windowed',
          source: { kind: 'source', entity: User },
          size: 3,
          projector: toExpression((_run: { count(): number }, row: UserRow) => row.age, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"windowed" needs an ordering/);
  });
});

describe('expanding generation', () => {
  it('reduces a run reaching back to the start of the ordering, dropping nothing', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar, row) => ({ at: row.id, total: sofar.sum((r) => r.age) }))
      .toSQL();

    // `windowed`'s statement with two differences and no others: the frame
    // starts unbounded, and there is no test on the position because every row
    // has a run up to it.
    expect(text).toBe(
      'SELECT "t1"."at" AS "at", "t1"."total" AS "total" FROM (' +
        'SELECT "t0"."id" AS "at", ' +
        'SUM("t0"."age") OVER (ORDER BY "t0"."id" ASC ' +
        'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) ' +
        'AS "total", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('differs from a fixed run in the frame text alone', () => {
    const { db } = context();
    const running = db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL().text;
    const moving = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.sum((r) => r.age))
      .toSQL().text;

    // The two share a compilation, so the generated statements have to agree
    // everywhere the operators do. What is left over is the frame and the test
    // on the position, which is exactly what each operator was given to say.
    expect(running).toBe(
      moving
        .replace('ROWS BETWEEN 2 PRECEDING', 'ROWS BETWEEN UNBOUNDED PRECEDING')
        .replace(' WHERE "t1"."__sqlinqo_position" >= 3', ''),
    );
  });

  it('keeps every row, so it tests no position at all', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL();

    // A run up to the first row is that row alone, which is a run. There is
    // nothing short to drop, and a `>= 1` would be true of every row and read
    // as though it were selecting something.
    expect(text).not.toContain('WHERE');
  });

  it('carries the position out even though nothing filters on it', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.createdAt)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL();

    // The column earns its place twice over for `windowed` and once here: a
    // derived table does not carry an ordering out, so the ordering is
    // reapplied outside from the number computed inside.
    expect(text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."created_at" ASC)');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC');
  });

  it('counts the rows up to each one, which is its position rather than a constant', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.count())
      .toSQL();

    // The same `COUNT(*)` a fixed run takes, over a frame that grows. Over a
    // fixed run it answers the size for every row and says nothing; here it
    // answers the row position, which is worth asking for.
    expect(text).toContain(
      'COUNT(*) OVER (ORDER BY "t0"."id" ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
    );
  });

  it('reads back every row up to each one when asked for the run itself', () => {
    const { db } = context();
    const { text } = db.users
      .select((u) => ({ id: u.id, age: u.age }))
      .orderBy((u) => u.id)
      .expanding((sofar, row) => ({ at: row.id, rows: sofar.toArray() }))
      .toSQL();

    // The `json_agg` a group's `toArray` builds, over a growing frame, so each
    // row carries one more row than the row before it.
    expect(text).toContain(
      'json_agg(json_build_object($1 :: text, "t0"."id", $2 :: text, "t0"."age")) OVER (',
    );
    expect(text).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "rows"');
  });

  it('frames over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .thenByDescending((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL();

    expect(text).toContain(
      'SUM("t0"."age") OVER (ORDER BY "t0"."age" ASC, "t0"."id" DESC ROWS BETWEEN UNBOUNDED',
    );
  });

  it('accumulates from the other end when the ordering is reversed', () => {
    const { db } = context();
    const forwards = db.users
      .orderBy((u) => u.createdAt)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL().text;
    const backwards = db.users
      .orderByDescending((u) => u.createdAt)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL().text;

    // Only the sort direction differs, and it is what decides which rows come
    // before a row as well as which running value comes first.
    expect(backwards).toBe(forwards.replaceAll('"t0"."created_at" ASC', '"t0"."created_at" DESC'));
  });

  it('unwraps a projection of one value, as any other query does', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."value" AS "value" FROM \(/);
  });

  it('frames the rows paging kept, not the ones behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .take(4)
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL();

    // The limit is settled first, so the running total starts at the top of the
    // page rather than at the top of the table.
    expect(text).toContain('LIMIT 4) AS "t1"');
    expect(text).toContain('SUM("t1"."age") OVER');
  });

  it('filters the running values, not the rows they were made from', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar, row) => ({ at: row.id, total: sofar.sum((r) => r.age) }))
      .where((w) => w.total > 100)
      .toSQL();

    // A row dropped here still counted towards the totals after it, which is
    // what makes this different from filtering before accumulating. The filter
    // is the whole of the outer `WHERE`, there being no position test to join.
    expect(text).toContain('AS "t1" WHERE "t1"."total" > $1');
  });

  it('keeps the bookkeeping column out of the result', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expanding((sofar, row) => ({ id: row.id, total: sofar.sum((r) => r.age) }))
      .toSQL();

    expect(text).toMatch(/^SELECT "t1"\."id" AS "id", "t1"\."total" AS "total" FROM \(/);
    // Aliased once, inside the derived table, and read outside it only by the
    // ordering.
    expect(text.split('AS "__sqlinqo_position"')).toHaveLength(2);
  });

  it('follows a navigation off the row, as windowed does', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .expanding((sofar, row) => ({ who: row.user.name, total: sofar.sum((r) => r.total) }))
      .toSQL();

    // Both the run and the row read the query's own rows rather than a derived
    // table's columns, so the entity a navigation needs is still there.
    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
  });

  it('refuses a run used as a value, naming the aggregate to reach for', () => {
    const { db } = context();

    expect(() =>
      db.users
        .orderBy((u) => u.id)
        // A run is many rows and has no column, which is a group's own limit.
        .expanding((sofar) => sofar as unknown as number)
        .toSQL(),
    ).toThrow(
      /"sofar" is a group, not a row\. Project an aggregate of it, such as sofar\.count\(\)\./,
    );
  });

  it('refuses countDistinct over a run, which SQL does not define', () => {
    const { db } = context();

    // The type keeps this off a run whichever operator produced it, so it is
    // reachable only by casting past it. The frame reaching further back makes
    // no difference: DISTINCT is not defined over a window at all.
    expect(() =>
      db.users
        .orderBy((u) => u.id)
        .expanding((sofar) =>
          (sofar as unknown as { countDistinct(v: (r: UserRow) => number): number }).countDistinct(
            (r) => r.age,
          ),
        )
        .toSQL(),
    ).toThrow(/"countDistinct" is not defined over a window/);
  });

  it('refuses a plan built without an ordering', () => {
    // The typed API only offers the operator on an ordered query, so the guard
    // is reachable only by handing the compiler a plan built by hand. Without an
    // ordering no row comes before another and there is nothing to accumulate.
    const compile = () =>
      compileQuery(
        {
          kind: 'expanding',
          source: { kind: 'source', entity: User },
          projector: toExpression((_run: { count(): number }, row: UserRow) => row.age, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"expanding" needs an ordering/);
  });
});

describe('windowedBy generation', () => {
  it('partitions the frame and counts the run within the key', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowedBy(
        (u) => u.cityId,
        3,
        (run, row) => ({ at: row.id, mean: run.average((r) => r.age) }),
      )
      .toSQL();

    // Two row numbers, which is the whole cost of partitioning: the frame and
    // the short-run test restart per key, and the ordering must not, so the
    // unpartitioned number carries the ordering out and the partitioned one is
    // what the test reads. This is `distinctBy`'s own rank-beside-position.
    expect(text).toBe(
      'SELECT "t1"."at" AS "at", "t1"."mean" AS "mean" FROM (' +
        'SELECT "t0"."id" AS "at", ' +
        'AVG("t0"."age") OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."id" ASC ' +
        'ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) ' +
        'AS "mean", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position", ' +
        'ROW_NUMBER() OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."id" ASC) ' +
        'AS "__sqlinqo_rank" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'WHERE "t1"."__sqlinqo_rank" >= 3 ORDER BY "t1"."__sqlinqo_position" ASC',
    );
  });

  it('differs from the unpartitioned spelling only by the partition and the counter', () => {
    const { db } = context();
    const keyed = db.users
      .orderBy((u) => u.id)
      .windowedBy(
        (u) => u.cityId,
        3,
        (run) => run.sum((r) => r.age),
      )
      .toSQL().text;
    const plain = db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.sum((r) => r.age))
      .toSQL().text;

    // `windowed` is the same node with a null partition, so nothing else about
    // the statement may move. Adding the key back to the plain statement and
    // repointing the test is the entire difference.
    expect(keyed).toBe(
      plain
        .replace(
          'SUM("t0"."age") OVER (ORDER BY',
          'SUM("t0"."age") OVER (PARTITION BY "t0"."city_id" ORDER BY',
        )
        .replace(
          'AS "__sqlinqo_position" FROM',
          'AS "__sqlinqo_position", ROW_NUMBER() OVER (PARTITION BY "t0"."city_id" ' +
            'ORDER BY "t0"."id" ASC) AS "__sqlinqo_rank" FROM',
        )
        .replace('WHERE "t1"."__sqlinqo_position" >= 3', 'WHERE "t1"."__sqlinqo_rank" >= 3'),
    );
  });

  it('tests the partitioned number, so a short key drops rather than the query head', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowedBy(
        (u) => u.cityId,
        4,
        (run) => run.sum((r) => r.age),
      )
      .toSQL();

    // The test names the rank and never the position. Reading the position here
    // would drop the first three rows of the query and keep the first three of
    // every key after them, which is the bug this assertion exists to catch.
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" >= 4');
    expect(text).not.toContain('"__sqlinqo_position" >= ');
  });

  it('orders by the unpartitioned number, so rows come back interleaved', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowedBy(
        (u) => u.cityId,
        2,
        (run) => run.sum((r) => r.age),
      )
      .toSQL();

    // A partition says which rows are behind a row, not where the row itself
    // sits. Ordering by the rank instead would group the result by key and
    // quietly change what the operator returns against `windowed`.
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC');
    expect(text).not.toContain('ORDER BY "t1"."__sqlinqo_rank"');
  });

  it('partitions on every expression of a composite key', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .windowedBy(
        (u) => ({ city: u.cityId, active: u.isActive }),
        2,
        (run) => run.sum((r) => r.age),
      )
      .toSQL();

    // An object key is several expressions, as it is for `groupBy` and
    // `distinctBy`, and both windows have to carry all of them.
    expect(text).toContain('PARTITION BY "t0"."city_id", "t0"."is_active" ORDER BY');
    expect(text.split('PARTITION BY "t0"."city_id", "t0"."is_active"')).toHaveLength(3);
  });

  it('joins a navigation the key followed inside the derived table', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .windowedBy(
        (o) => o.user.name,
        2,
        (run) => run.sum((r) => r.total),
      )
      .toSQL();

    // The key is translated in the same pass as the projector, so its join
    // lands where the projector's would and the partition reads the joined
    // column. Outside the derived table there is no entity left to follow.
    expect(text).toContain('INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id"');
    expect(text).toContain('PARTITION BY "t1"."name"');
  });

  it('refuses a run size that is not a whole number, naming the operator written', () => {
    const { db } = context();

    // The node is shared with `windowed`, so the message has to come from the
    // spelling the caller used rather than from the node.
    expect(() =>
      db.users
        .orderBy((u) => u.id)
        .windowedBy(
          (u) => u.cityId,
          0,
          (run) => run.count(),
        ),
    ).toThrow(/"windowedBy" expects a positive integer run size but received 0\./);
  });

  it('names the operator written when the plan has no ordering', () => {
    // Reachable only by hand, as `windowed`'s own guard is. The node cannot say
    // which spelling built it except by whether it carries a partition, which
    // is what the message is read off.
    const compile = () =>
      compileQuery(
        {
          kind: 'windowed',
          source: { kind: 'source', entity: User },
          size: 3,
          partition: toExpression((u: UserRow) => u.cityId, { rowParameterCount: 1 }),
          projector: toExpression((_run: { count(): number }, row: UserRow) => row.age, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"windowedBy" needs an ordering/);
  });
});

describe('expandingBy generation', () => {
  it('partitions the frame and carries no second number', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expandingBy(
        (u) => u.cityId,
        (sofar, row) => ({ at: row.id, total: sofar.sum((r) => r.age) }),
      )
      .toSQL();

    // Partitioning costs `windowedBy` a second row number because its test has
    // to count within the key. There is no test here, so the partition costs
    // nothing but the `PARTITION BY` itself.
    expect(text).toBe(
      'SELECT "t1"."at" AS "at", "t1"."total" AS "total" FROM (' +
        'SELECT "t0"."id" AS "at", ' +
        'SUM("t0"."age") OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."id" ASC ' +
        'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) ' +
        'AS "total", ' +
        'ROW_NUMBER() OVER (ORDER BY "t0"."id" ASC) AS "__sqlinqo_position" ' +
        'FROM "users" AS "t0") AS "t1" ' +
        'ORDER BY "t1"."__sqlinqo_position" ASC',
    );
    expect(text).not.toContain('__sqlinqo_rank');
    expect(text).not.toContain('WHERE');
  });

  it('differs from the unpartitioned spelling by the partition alone', () => {
    const { db } = context();
    const keyed = db.users
      .orderBy((u) => u.id)
      .expandingBy(
        (u) => u.cityId,
        (sofar) => sofar.sum((r) => r.age),
      )
      .toSQL().text;
    const plain = db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toSQL().text;

    expect(keyed).toBe(
      plain.replace('OVER (ORDER BY', 'OVER (PARTITION BY "t0"."city_id" ORDER BY'),
    );
  });

  it('counts the rows up to each one within its key', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.id)
      .expandingBy(
        (u) => u.cityId,
        (sofar) => sofar.count(),
      )
      .toSQL();

    // The same `COUNT(*)` over a growing frame, restarted per key, so it is the
    // position within the key rather than within the query.
    expect(text).toContain(
      'COUNT(*) OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."id" ASC ' +
        'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
    );
  });

  it('names the operator written when the plan has no ordering', () => {
    const compile = () =>
      compileQuery(
        {
          kind: 'expanding',
          source: { kind: 'source', entity: User },
          partition: toExpression((u: UserRow) => u.cityId, { rowParameterCount: 1 }),
          projector: toExpression((_run: { count(): number }, row: UserRow) => row.age, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile).toThrow(/"expandingBy" needs an ordering/);
  });
});

describe('rank generation', () => {
  it('ranks over the ordering and carries a row number for the result order', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .rank((u, place) => ({ name: u.name, place }))
      .toSQL();

    // Two windows over one ordering, which PostgreSQL sorts once. The rank is
    // the value and cannot order the result, ties sharing it; the row number
    // exists only to settle that order.
    expect(text).toContain('RANK() OVER (ORDER BY "t0"."age" DESC) AS "__sqlinqo_rank"');
    expect(text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."age" DESC) AS "__sqlinqo_position"');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC');
  });

  it('hands the place over without subtracting, unlike index', () => {
    const { db } = context();
    const ranked = db.users
      .orderBy((u) => u.age)
      .rank((_u, place) => place)
      .toSQL().text;
    const numbered = db.users
      .orderBy((u) => u.age)
      .index((_u, position) => position)
      .toSQL().text;

    // `index` closes a gap between `ROW_NUMBER` counting from one and LINQ
    // counting from zero. A place counts from one on both sides, so there is no
    // gap and no arithmetic: the `- 1` is exactly what separates the two.
    expect(ranked).toContain('CAST("t1"."__sqlinqo_rank" AS INTEGER) AS "value"');
    expect(ranked).not.toContain('- 1');
    expect(numbered).toContain('- 1');
  });

  it('names DENSE_RANK for the dense spelling and nothing else changes', () => {
    const { db } = context();
    const sparse = db.users
      .orderByDescending((u) => u.age)
      .rank((u, place) => ({ name: u.name, place }))
      .toSQL().text;
    const dense = db.users
      .orderByDescending((u) => u.age)
      .denseRank((u, place) => ({ name: u.name, place }))
      .toSQL().text;

    // One node with a flag, so the statements may differ by the function name
    // and by nothing at all besides. That is the test that keeps the flag
    // honest as the compilation grows.
    expect(dense).toBe(sparse.replace('RANK() OVER', 'DENSE_RANK() OVER'));
  });

  it('keeps the place filterable, which is what a leaderboard needs', () => {
    const { db } = context();
    const { text, values } = db.users
      .orderByDescending((u) => u.age)
      .rank((u, place) => ({ name: u.name, place }))
      .where((r) => r.place <= 10)
      .toSQL();

    // The window sits a level down, so the filter is an ordinary `WHERE` over
    // the derived table. Computed in place it would have been a window in a
    // `WHERE`, which SQL does not allow.
    expect(text).toContain('AS "t1" WHERE CAST("t1"."__sqlinqo_rank" AS INTEGER) <= $1');
    expect(values).toEqual([10]);
  });

  it('ranks over every sort key, in order', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .thenBy((u) => u.name)
      .rank((u, place) => ({ name: u.name, place }))
      .toSQL();

    // What ties is what the ordering says, so every key has to reach the window
    // or two rows would tie on a key the query meant to separate them by.
    expect(text).toContain('RANK() OVER (ORDER BY "t0"."age" DESC, "t0"."name" ASC)');
  });

  it('unwraps a projection of the place alone, as index does', () => {
    const { db } = context();
    const { text } = db.users
      .orderBy((u) => u.age)
      .rank((_u, place) => place)
      .toSQL();

    // A bare second parameter is the number rather than the row, which is the
    // one question `isScalarIndexProjection` exists to answer and is the same
    // question here.
    expect(text).toMatch(/^SELECT CAST\("t1"\."__sqlinqo_rank" AS INTEGER\) AS "value" FROM \(/);
  });

  it('ranks the rows paging kept, not the ones behind them', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .take(5)
      .orderByDescending((u) => u.age)
      .rank((u, place) => ({ name: u.name, place }))
      .toSQL();

    // The limit is settled first, so the top of the page is first place.
    expect(text).toContain('LIMIT 5) AS "t1"');
    expect(text).toContain('RANK() OVER (ORDER BY "t1"."age" DESC)');
  });

  it('follows a navigation off the row, as index does', () => {
    const { db } = context();
    const { text } = db.orders
      .orderByDescending((o) => o.total)
      .rank((o, place) => ({ who: o.user.name, place }))
      .toSQL();

    // `rank` took `index`' mechanics and got this with them: the scope over the
    // derived table stands for the entity, so the row a place is handed beside
    // can still be navigated off.
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
  });

  it('refuses a plan built without an ordering, naming the spelling written', () => {
    // Reachable only by hand, the typed API offering both on an ordered query
    // only. Without an ordering every row ties with every other.
    const compile = (dense: boolean) => () =>
      compileQuery(
        {
          kind: 'rank',
          source: { kind: 'source', entity: User },
          dense,
          projector: toExpression((_row: UserRow, place: number) => place, {
            rowParameterCount: 2,
          }),
          // The generic entity type is narrower than the plan node declares.
        } as unknown as QueryPlan,
        { dialect: testDialect, bags: {} },
      );

    expect(compile(false)).toThrow(/"rank" needs an ordering to rank the rows by/);
    expect(compile(true)).toThrow(/"denseRank" needs an ordering to rank the rows by/);
  });
});

describe('takeBy and skipBy generation', () => {
  it('numbers rows within each key and keeps the first count', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .takeBy((u) => u.cityId, 3)
      .toSQL();

    // `distinctBy`'s window with its `= 1` widened into a range, which is why
    // there was nothing to add to the compiler for this.
    expect(text).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "t0"."city_id" ORDER BY "t0"."age" DESC) ' +
        'AS "__sqlinqo_rank"',
    );
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" <= 3');
  });

  it('keeps everything past the first count when skipping', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .skipBy((u) => u.cityId, 3)
      .toSQL();

    // A window open at the far end, which is what a null `take` means. The two
    // operators differ in that and in nothing else.
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" > 3');
    expect(text).not.toContain('<=');
  });

  it('differs from the complement by the comparison alone', () => {
    const { db } = context();
    const kept = db.users
      .orderByDescending((u) => u.age)
      .takeBy((u) => u.cityId, 3)
      .toSQL().text;
    const dropped = db.users
      .orderByDescending((u) => u.age)
      .skipBy((u) => u.cityId, 3)
      .toSQL().text;

    // One compilation, one window, and the cut read from either side. This is
    // the test that keeps that claim true as the compilation grows.
    expect(dropped).toBe(kept.replace('"__sqlinqo_rank" <= 3', '"__sqlinqo_rank" > 3'));
  });

  it('leaves distinctBy exactly as it was', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .distinctBy((u) => u.cityId)
      .toSQL();

    // Three operators now build this node, so the statement the first of them
    // produced has to be untouched by the other two arriving. `= 1` is the case
    // `keptPerKey` spells for one row rather than a range of one.
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" = 1');
  });

  it('keeps the whole query filterable afterwards', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .takeBy((u) => u.cityId, 2)
      .where((u) => u.isActive)
      .toSQL();

    // The window sits inside the derived table, so a later filter joins the
    // test on the rank rather than replacing it. Filtering first would have
    // narrowed the rows the numbering counted.
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" <= 2 AND "t1"."isActive"');
  });

  it('partitions on every expression of a composite key', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .takeBy((u) => ({ city: u.cityId, active: u.isActive }), 2)
      .toSQL();

    expect(text).toContain(
      'PARTITION BY "t0"."city_id", "t0"."is_active" ORDER BY "t0"."age" DESC',
    );
  });

  it('carries the ordering out unpartitioned, so keys come back interleaved', () => {
    const { db } = context();
    const { text } = db.users
      .orderByDescending((u) => u.age)
      .takeBy((u) => u.cityId, 2)
      .toSQL();

    // The rank restarts per key and the ordering must not, which is the same
    // two-number shape `windowedBy` needed. Ordering by the rank would group
    // the result by key.
    expect(text).toContain('ROW_NUMBER() OVER (ORDER BY "t0"."age" DESC) AS "__sqlinqo_position"');
    expect(text).toContain('ORDER BY "t1"."__sqlinqo_position" ASC');
  });

  it('names the operator the caller wrote in an error about its rows', () => {
    const { db } = context();

    // The node is shared by three operators that a caller writes and one the
    // library builds for itself, so the name has to travel with it: the numbers
    // alone cannot say which was meant, `takeBy(key, 1)` and `distinctBy(key)`
    // building the same window. A navigation no longer shows this, now that one
    // resolves, so the test asks for a name that is genuinely not there.
    const missing = (build: () => unknown) => build;

    expect(
      missing(() =>
        db.orders
          .orderByDescending((o) => o.total)
          .takeBy((o) => o.userId, 2)
          .select((o) => ({ nope: (o as unknown as { nope: string }).nope }))
          .toSQL(),
      ),
    ).toThrow(/"nope" is not a property of takeBy/);

    expect(
      missing(() =>
        db.orders
          .orderByDescending((o) => o.total)
          .skipBy((o) => o.userId, 2)
          .select((o) => ({ nope: (o as unknown as { nope: string }).nope }))
          .toSQL(),
      ),
    ).toThrow(/"nope" is not a property of skipBy/);
  });

  it('follows a navigation off a row the window kept', () => {
    const { db } = context();
    const { text } = db.orders
      .orderByDescending((o) => o.total)
      .takeBy((o) => o.userId, 2)
      .select((o) => ({ who: o.user.name }))
      .toSQL();

    // The join is emitted after the window rather than before it, which is the
    // reading that makes it useful: the two largest orders of each user, and
    // then their user's name, rather than a join that the numbering counted.
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" <= 2');
  });

  it('refuses a write through the window, naming the family', async () => {
    const { db } = context();

    // Three of the four callers are operators a caller writes, so the clause
    // this names can no longer be `distinctBy` alone. A write refuses from the
    // terminal, so this rejects rather than throwing.
    await expect(
      db.users
        .orderByDescending((u) => u.age)
        .takeBy((u) => u.cityId, 2)
        .update({ isActive: false }),
    ).rejects.toThrow(/a distinctBy, takeBy or skipBy/);
  });
});

describe('a navigation across a derived table', () => {
  it('resolves after a page, which used to be refused', () => {
    const { db } = context();
    const { text } = db.orders
      .take(5)
      .select((o) => ({ who: o.user.name }))
      .toSQL();

    // `take` pushes the query into a derived table, and the scope over it used
    // to be a bag of column names. The foreign key came out under its own
    // name all along; what was missing was a scope willing to say so.
    expect(text).toContain('LIMIT 5) AS "t1"');
    expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
  });

  it('resolves after distinct, skip, and sample too, being one derived table', () => {
    const { db } = context();
    const shapes = [
      db.orders
        .distinct()
        .select((o) => ({ who: o.user.name }))
        .toSQL().text,
      db.orders
        .skip(2)
        .select((o) => ({ who: o.user.name }))
        .toSQL().text,
      db.orders
        .sample(2)
        .select((o) => ({ who: o.user.name }))
        .toSQL().text,
    ];

    // All four are the same `materialize` call, so none of them is a separate
    // capability to add or a separate one to forget.
    for (const text of shapes) {
      expect(text).toContain('INNER JOIN "users" AS "t2" ON "t1"."userId" = "t2"."id"');
    }
  });

  it('resolves after a per-key window, joining outside it', () => {
    const { db } = context();
    const { text } = db.orders
      .orderBy((o) => o.id)
      .distinctBy((o) => o.userId)
      .select((o) => ({ who: o.user.name }))
      .toSQL();

    // Where the join sits is the point. The window numbered the rows of the
    // orders table; the join happens to what survived, so it cannot change
    // which rows the numbering counted.
    expect(text).toMatch(/AS "t1" INNER JOIN "users" AS "t2"/);
    expect(text).toContain('WHERE "t1"."__sqlinqo_rank" = 1');
  });

  it('reads a collection through one as well as a reference', () => {
    const { db } = context();
    const { text } = db.users
      .take(5)
      .select((u) => ({ posts: u.posts.count() }))
      .toSQL();

    // A collection is correlated rather than joined, and the key it correlates
    // on is the primary key on this side, which survives a derived table the
    // way a foreign key does. Nothing extra was needed for it.
    expect(text).toContain('"t2"."user_id" = "t1"."id"');
  });

  it('refuses one after defaultIfEmpty, which withholds it deliberately', () => {
    const { db } = context();

    // The one operator that could answer and must not. Its extra row is all
    // nulls, foreign key included, so a required reference would join it away
    // with an INNER JOIN and undo the one guarantee the operator makes. An
    // error is a sentence the caller can act on; the alternative is a missing
    // row nobody notices.
    expect(() =>
      db.orders
        .defaultIfEmpty()
        // `defaultIfEmpty` makes every column nullable, the navigation included,
        // which is the type-level shadow of the very reason it withholds it.
        .select((o) => ({ who: (o.user as unknown as { name: string }).name }))
        .toSQL(),
    ).toThrow(/"user" is not a property of defaultIfEmpty/);
  });

  it('refuses one after a projection, which has no entity to offer', () => {
    const { db } = context();

    // The chain stops itself here rather than being stopped. A projection
    // answers types from the expressions it projected and has no relation to
    // hand on, so every scope built over one says no without being told to.
    expect(() =>
      db.orders
        .select((o) => ({ id: o.id, userId: o.userId }))
        .take(5)
        .select((row) => ({ who: (row as unknown as { user: { name: string } }).user.name }))
        .toSQL(),
    ).toThrow(/"user" is not a property of/);
  });

  it('reuses one join for two reads of the same navigation', () => {
    const { db } = context();
    const { text } = db.orders
      .take(5)
      .select((o) => ({ who: o.user.name, city: o.user.cityId }))
      .toSQL();

    // The join is cached per row and property, and the row a navigation starts
    // from is the derived table rather than the table inside it. Naming the
    // inner alias would have let two levels share a join whose `ON` only one
    // of them can see.
    expect(text.split('INNER JOIN "users"')).toHaveLength(2);
  });
});
