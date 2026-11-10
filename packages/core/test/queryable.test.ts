import { describe, expect, it, vi } from 'vitest';
import { createDbContext, InvalidQueryError, ModelError, SequenceError } from '../src/index.js';
import { City, FakeDriver, Order, PagingDriver, testDialect, User } from './support.js';

function context(rows: Record<string, unknown>[] = []) {
  const driver = new FakeDriver(rows);
  const db = createDbContext({ driver, dialect: testDialect, entities: { users: User } });
  return { db, driver };
}

const ada = {
  id: 1,
  name: 'Ada',
  email: 'ada@example.com',
  age: 36,
  cityId: null,
  isActive: true,
  createdAt: new Date(0),
};
const grace = { ...ada, id: 2, name: 'Grace', age: 45 };

describe('execution', () => {
  it('returns rows keyed by property name', async () => {
    const { db } = context([ada]);
    await expect(db.users.toArray()).resolves.toEqual([ada]);
  });

  it('unwraps a scalar projection', async () => {
    const { db } = context([{ value: 'Ada' }]);
    await expect(db.users.select((u) => u.name).toArray()).resolves.toEqual(['Ada']);
  });

  it('keeps an object projection as a row', async () => {
    const { db } = context([{ id: 1, label: 'Ada' }]);
    await expect(db.users.select((u) => ({ id: u.id, label: u.name })).toArray()).resolves.toEqual([
      { id: 1, label: 'Ada' },
    ]);
  });

  it('reads the query into a Map keyed by the selector', async () => {
    const { db } = context([ada, grace]);
    const byId = await db.users.toDictionary((u) => u.id);

    expect(byId.get(ada.id)).toEqual(ada);
    expect(byId.get(grace.id)).toEqual(grace);
    expect(byId.size).toBe(2);
  });

  it('throws when two rows share a key', async () => {
    const { db } = context([ada, { ...grace, id: ada.id }]);
    await expect(db.users.toDictionary((u) => u.id)).rejects.toBeInstanceOf(SequenceError);
  });

  it('groups rows sharing a key into one array, in the order they were read', async () => {
    const { db } = context([ada, grace, { ...ada, id: 3, name: 'Alan', isActive: false }]);
    const byActive = await db.users.toLookup((u) => u.isActive);

    expect(byActive.get(true)).toEqual([ada, grace]);
    expect(byActive.get(false)).toEqual([{ ...ada, id: 3, name: 'Alan', isActive: false }]);
  });

  it('answers undefined rather than an empty array for a key nothing mapped to', async () => {
    const { db } = context([ada]);
    const byActive = await db.users.toLookup((u) => u.isActive);

    expect(byActive.has(false)).toBe(false);
    expect(byActive.get(false)).toBeUndefined();
  });

  it('discards a duplicate scalar value in toHashSet', async () => {
    const { db } = context([{ value: 'Paris' }, { value: 'Paris' }, { value: 'Rome' }]);
    const cities = await db.users.select((u) => u.name).toHashSet();

    expect(cities).toEqual(new Set(['Paris', 'Rome']));
  });

  it('keeps two rows with the same columns apart in toHashSet, since objects compare by reference', async () => {
    const { db } = context([ada, { ...ada }]);
    const rows = await db.users.toHashSet();

    expect(rows.size).toBe(2);
  });

  it('folds the query into one value with a seed and an accumulator', async () => {
    const { db } = context([{ value: 3 }, { value: 4 }, { value: 5 }]);
    const total = await db.users.select((u) => u.age).aggregate(0, (sum, age) => sum + age);

    expect(total).toBe(12);
  });

  it('runs the accumulator over rows in the order toArray returns them', async () => {
    const { db } = context([{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
    const joined = await db.users
      .select((u) => u.name)
      .aggregate('', (acc, letter) => acc + letter);

    expect(joined).toBe('abc');
  });

  it('folds each group with its own seed and accumulator', async () => {
    const { db } = context([ada, grace, { ...ada, id: 3, name: 'Alan', isActive: false }]);
    const totals = await db.users.aggregateBy(
      (u) => u.isActive,
      0,
      (sum, u) => sum + u.age,
    );

    expect(totals.get(true)).toBe(ada.age + grace.age);
    expect(totals.get(false)).toBe(ada.age);
  });

  it('starts every key from the same seed rather than sharing one running total', async () => {
    const { db } = context([ada, grace]);
    const names = await db.users.aggregateBy(
      (u) => u.isActive,
      '',
      (acc, u) => acc + u.name,
    );

    expect(names.get(true)).toBe('AdaGrace');
  });

  it('answers no entry for a key nothing mapped to', async () => {
    const { db } = context([ada]);
    const totals = await db.users.aggregateBy(
      (u) => u.isActive,
      0,
      (sum, u) => sum + u.age,
    );

    expect(totals.has(false)).toBe(false);
  });

  it('reads rows from a raw SQL fragment and binds its interpolated values', async () => {
    const { db, driver } = context([ada]);
    const minAge = 18;

    await expect(
      db.users.fromSql`SELECT * FROM users WHERE age >= ${minAge}`.toArray(),
    ).resolves.toEqual([ada]);
    expect(driver.lastStatement.text).toContain('FROM (SELECT * FROM users WHERE age >= $1)');
    expect(driver.lastStatement.values).toEqual([18]);
  });

  it('applies LIMIT 1 for first', async () => {
    const { db, driver } = context([ada]);
    await expect(db.users.first()).resolves.toEqual(ada);
    expect(driver.lastStatement.text).toContain('LIMIT 1');
  });

  it('throws when first finds nothing', async () => {
    const { db } = context([]);
    await expect(db.users.first()).rejects.toBeInstanceOf(SequenceError);
  });

  it('returns null instead of throwing for firstOrDefault', async () => {
    const { db } = context([]);
    await expect(db.users.firstOrDefault()).resolves.toBeNull();
  });

  it('asks for two rows so single can detect ambiguity', async () => {
    const { db, driver } = context([ada, grace]);
    await expect(db.users.single()).rejects.toBeInstanceOf(SequenceError);
    expect(driver.lastStatement.text).toContain('LIMIT 2');
  });

  it('reverses the ordering and applies LIMIT 1 for last', async () => {
    const { db, driver } = context([ada]);
    await expect(db.users.orderBy((u) => u.age).last()).resolves.toEqual(ada);
    expect(driver.lastStatement.text).toContain('DESC');
    expect(driver.lastStatement.text).toContain('LIMIT 1');
  });

  it('throws when last finds nothing', async () => {
    const { db } = context([]);
    await expect(db.users.orderBy((u) => u.age).last()).rejects.toBeInstanceOf(SequenceError);
  });

  it('returns null instead of throwing for lastOrDefault', async () => {
    const { db } = context([]);
    await expect(db.users.orderBy((u) => u.age).lastOrDefault()).resolves.toBeNull();
  });

  it('reports whether any row matches', async () => {
    const { db } = context([{ count: '0' }]);
    await expect(db.users.any()).resolves.toBe(false);
  });

  it('reads longCount back as a bigint rather than a number', async () => {
    const { db } = context([{ count: '3' }]);
    await expect(db.users.longCount()).resolves.toBe(3n);
  });

  it('answers 0n for longCount over an empty query', async () => {
    const { db } = context([{ count: '0' }]);
    await expect(db.users.longCount()).resolves.toBe(0n);
  });

  it('reports each executed statement to the logger', async () => {
    const driver = new FakeDriver([ada]);
    const logger = vi.fn();
    const db = createDbContext({ driver, dialect: testDialect, entities: { users: User }, logger });

    await db.users.toArray();

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]?.[0]).toMatchObject({ rowCount: 1 });
  });

  it('closes the driver through the context', async () => {
    const { db, driver } = context();
    await db.$close();
    expect(driver.closed).toBe(true);
  });
});

describe('all', () => {
  it('looks for one row that fails and stops there', async () => {
    const { db, driver } = context([{ count: '0' }]);

    await expect(db.users.all((u) => u.age >= 18)).resolves.toBe(true);

    const { text } = driver.lastStatement;
    // The question is asked inside out: no count of the rows that pass, and no
    // row read past the first failure.
    expect(text).toContain('WHERE NOT "t0"."age" >= $1 OR ("t0"."age" >= $1) IS NULL LIMIT 1');
    expect(text).toMatch(/^SELECT COUNT\(\*\) AS "count" FROM \(SELECT /);
  });

  it('is false as soon as one row fails', async () => {
    const { db } = context([{ count: '1' }]);
    await expect(db.users.all((u) => u.age >= 18)).resolves.toBe(false);
  });

  it('counts a predicate that is null as a failure', async () => {
    const { db, driver } = context([{ count: '0' }]);

    await db.users.all((u) => u.isActive);

    // `NOT` alone would let such a row through: `NOT` of unknown is unknown, so
    // the row would answer neither the predicate nor its negation.
    expect(driver.lastStatement.text).toContain(
      'WHERE NOT "t0"."is_active" OR "t0"."is_active" IS NULL',
    );
  });

  it('binds a value from the parameter bag', async () => {
    const { db, driver } = context([{ count: '0' }]);

    await db.users.all((u, p) => u.age >= p.min, { min: 18 });

    // One value, mentioned twice, bound once.
    expect(driver.lastStatement.values).toEqual([18]);
  });

  it('asks about the rows the query settled on', async () => {
    const { db, driver } = context([{ count: '0' }]);

    await db.users.take(5).all((u) => u.isActive);

    // The paging is resolved into a derived table first, so the question is
    // about those five rows rather than about every row in the table.
    expect(driver.lastStatement.text).toContain('LIMIT 5) AS "t1" WHERE NOT "t1"."isActive"');
  });
});

describe('immutability', () => {
  it('leaves the source query untouched when a branch is derived', () => {
    const { db } = context();
    const base = db.users.where((u) => u.isActive);
    const branch = base.where((u) => u.age > 18);

    expect(base.toSQL().text).toContain('WHERE "t0"."is_active"');
    expect(base.toSQL().text).not.toContain('"t0"."age" >');
    expect(branch.toSQL().text).toContain('WHERE "t0"."is_active" AND "t0"."age" > $1');
  });
});

describe('context construction', () => {
  it('refuses an entity set that shadows a context member', () => {
    const driver = new FakeDriver();
    expect(() =>
      createDbContext({
        driver,
        dialect: testDialect,
        entities: { $close: User } as never,
      }),
    ).toThrow(ModelError);
  });
});

describe('join', () => {
  function joinContext(rows: Record<string, unknown>[] = []) {
    const driver = new FakeDriver(rows);
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, orders: Order },
    });
    return { db, driver };
  }

  it('materializes the shape the result selector declared', async () => {
    const { db } = joinContext([{ name: 'Ada', total: '10.00' }]);

    const rows = await db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      )
      .toArray();

    expect(rows).toEqual([{ name: 'Ada', total: '10.00' }]);
  });

  it('unwraps a scalar result selector', async () => {
    const { db } = joinContext([{ value: 'Ada' }]);

    const names = await db.users
      .join(
        db.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, _o) => u.name,
      )
      .toArray();

    expect(names).toEqual(['Ada']);
  });

  it('leaves both source queries untouched', () => {
    const { db } = joinContext();
    const users = db.users.where((u) => u.isActive);
    const orders = db.orders.where((o) => o.userId > 0);

    users.join(
      orders,
      (u) => u.id,
      (o) => o.userId,
      (u, o) => ({ name: u.name, total: o.total }),
    );

    expect(users.toSQL().text).not.toContain('JOIN');
    expect(orders.toSQL().text).not.toContain('JOIN');
  });

  it('refuses to join across two contexts', () => {
    const { db } = joinContext();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { orders: Order },
    });

    expect(() =>
      db.users.join(
        other.orders,
        (u) => u.id,
        (o) => o.userId,
        (u, o) => ({ name: u.name, total: o.total }),
      ),
    ).toThrow(InvalidQueryError);
  });
});

describe('groupBy', () => {
  it('materializes the shape the result selector declared', async () => {
    const { db } = context([{ city: 1, headcount: '2' }]);

    const rows = await db.users
      .groupBy(
        (u) => u.cityId,
        (city, users) => ({ city, headcount: users.count() }),
      )
      .toArray();

    expect(rows).toEqual([{ city: 1, headcount: '2' }]);
  });

  it('unwraps a lone scalar key', async () => {
    const { db } = context([{ value: 1 }, { value: 2 }]);

    const cities = await db.users
      .groupBy(
        (u) => u.cityId,
        (city) => city,
      )
      .toArray();

    expect(cities).toEqual([1, 2]);
  });

  it('leaves the source query untouched', () => {
    const { db } = context();
    const active = db.users.where((u) => u.isActive);

    active.groupBy(
      (u) => u.cityId,
      (city, users) => ({ city, headcount: users.count() }),
    );

    expect(active.toSQL().text).not.toContain('GROUP BY');
  });
});

describe('groupBy without a result selector', () => {
  function paging(pages: Record<string, unknown>[][]) {
    const driver = new PagingDriver(pages);
    const db = createDbContext({ driver, dialect: testDialect, entities: { users: User } });
    return { db, driver };
  }

  async function drain<TKey>(groups: AsyncIterableIterator<readonly unknown[] & { key: TKey }>) {
    const seen: (readonly unknown[] & { key: TKey })[] = [];
    for await (const group of groups) seen.push(group);
    return seen;
  }

  it('yields one lazy grouping per distinct key', async () => {
    const { db } = paging([[{ value: 1 }, { value: 2 }], [ada], [grace]]);

    const groups = await drain(db.users.groupBy((u) => u.cityId));

    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe(1);
    expect(Array.from(groups[0]!)).toEqual([ada]);
    expect(groups[1]!.key).toBe(2);
    expect(Array.from(groups[1]!)).toEqual([grace]);
  });

  it('reads the keys with one statement and each group with one more', async () => {
    const { db, driver } = paging([[{ value: 1 }, { value: 2 }], [ada], [grace]]);

    await drain(db.users.groupBy((u) => u.cityId));

    expect(driver.statements).toHaveLength(3);
  });

  it('yields nothing for a query that matches no rows', async () => {
    const { db, driver } = paging([[]]);

    await expect(drain(db.users.groupBy((u) => u.cityId))).resolves.toEqual([]);
    expect(driver.statements).toHaveLength(1);
  });

  it('reads no further than the loop asks it to', async () => {
    const { db, driver } = paging([[{ value: 1 }, { value: 2 }], [ada]]);

    for await (const group of db.users.groupBy((u) => u.cityId)) {
      expect(Array.from(group)).toEqual([ada]);
      break;
    }

    expect(driver.statements).toHaveLength(2);
  });

  it('groups a null key together, rather than losing it to a null-unsafe comparison', async () => {
    const { db, driver } = paging([[{ value: null }], [ada]]);

    const groups = await drain(db.users.groupBy((u) => u.cityId));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBeNull();
    expect(Array.from(groups[0]!)).toEqual([ada]);
    // The filter has to test the key for null on both sides rather than
    // comparing it with a plain `=`, which a null parameter never satisfies.
    expect(driver.statements[1]!.text).toMatch(/IS NULL/);
  });

  it('groups by a composite key, matched part by part', async () => {
    const { db, driver } = paging([[{ cityId: null, isActive: true }], [ada]]);

    const groups = await drain(
      db.users.groupBy((u) => ({ cityId: u.cityId, isActive: u.isActive })),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toEqual({ cityId: null, isActive: true });
    expect(Array.from(groups[0]!)).toEqual([ada]);
    expect(driver.statements[1]!.text).toContain('"t0"."is_active"');
  });

  it('carries the filter already on the query into every statement', async () => {
    const { db, driver } = paging([[{ value: 1 }], [ada]]);

    await drain(db.users.where((u) => u.isActive).groupBy((u) => u.cityId));

    for (const statement of driver.statements) {
      expect(statement.text).toContain('"t0"."is_active"');
    }
  });

  it('leaves the source query untouched', () => {
    const { db } = context();
    const active = db.users.where((u) => u.isActive);

    void active.groupBy((u) => u.cityId);

    expect(active.toSQL().text).not.toContain('GROUP BY');
  });
});

describe('elementAt', () => {
  const rows = [ada, grace, { ...ada, id: 3, name: 'Alan' }];

  it('offsets to the index and fetches one row', async () => {
    const { db, driver } = context([grace]);

    await expect(db.users.elementAt(1)).resolves.toEqual(grace);
    expect(driver.lastStatement.text).toContain('LIMIT 1 OFFSET 1');
  });

  it('reads index zero without an OFFSET of its own', async () => {
    const { db, driver } = context([ada]);

    await expect(db.users.elementAt(0)).resolves.toEqual(ada);
    expect(driver.lastStatement.text).toContain('LIMIT 1 OFFSET 0');
  });

  it('throws when the index is past the end', async () => {
    const { db } = context([]);
    await expect(db.users.elementAt(9)).rejects.toBeInstanceOf(SequenceError);
  });

  it('returns null instead of throwing for elementAtOrDefault', async () => {
    const { db } = context([]);
    await expect(db.users.elementAtOrDefault(9)).resolves.toBeNull();
  });

  it('rejects an index that could not name a row', async () => {
    const { db } = context(rows);

    await expect(db.users.elementAt(-1)).rejects.toBeInstanceOf(InvalidQueryError);
    await expect(db.users.elementAt(1.5)).rejects.toThrow(/non-negative integer index/);
    // The message names the operator the caller wrote, not the `skip` it became.
    await expect(db.users.elementAtOrDefault(-1)).rejects.toThrow(/"elementAtOrDefault"/);
  });

  it('keeps an ordering, which is what makes an index mean anything', async () => {
    const { db, driver } = context([grace]);

    await db.users.orderBy((u) => u.id).elementAt(1);
    expect(driver.lastStatement.text).toContain('ORDER BY "t0"."id" ASC LIMIT 1 OFFSET 1');
  });

  it('counts a negative index from the end on an ordered query', async () => {
    const { db, driver } = context([grace]);

    await expect(db.users.orderBy((u) => u.id).elementAt(-1)).resolves.toEqual(grace);
    // The same statement `last` reaches: the order flipped, then no OFFSET.
    expect(driver.lastStatement.text).toContain('ORDER BY "t0"."id" DESC LIMIT 1 OFFSET 0');
  });

  it('counts further back for a more negative index', async () => {
    const { db, driver } = context([grace]);

    await db.users.orderBy((u) => u.id).elementAt(-3);
    expect(driver.lastStatement.text).toContain('LIMIT 1 OFFSET 2');
  });

  it('still requires an integer, negative or not', async () => {
    const { db } = context([]);
    await expect(db.users.orderBy((u) => u.id).elementAt(-1.5)).rejects.toThrow(/integer index/);
  });

  it('answers null rather than throwing for elementAtOrDefault past the start', async () => {
    const { db } = context([]);
    await expect(db.users.orderBy((u) => u.id).elementAtOrDefault(-1)).resolves.toBeNull();
  });
});

describe('skip after take', () => {
  it('skips within the rows take limited, not before them', () => {
    // `.take(10).skip(2)` is the first ten rows less the first two, which is
    // eight. Folded into one select it would read as `LIMIT 10 OFFSET 2`: ten
    // rows starting at the third, which is neither the same count nor the same
    // rows.
    const { db } = context();
    const { text } = db.users.take(10).skip(2).toSQL();

    expect(text).toMatch(/^SELECT .* FROM \(SELECT .* LIMIT 10\) AS "t1" OFFSET 2$/);
  });

  it('still folds skip before take into one select', () => {
    const { db } = context();
    const { text } = db.users.skip(2).take(10).toSQL();

    expect(text).toContain('LIMIT 10 OFFSET 2');
    expect(text).not.toContain('FROM (SELECT');
  });
});

describe('chunk', () => {
  const alan = { ...ada, id: 3, name: 'Alan' };

  function paging(pages: Record<string, unknown>[][]) {
    const driver = new PagingDriver(pages);
    const db = createDbContext({ driver, dialect: testDialect, entities: { users: User } });
    return { db, driver };
  }

  async function drain(batches: AsyncIterableIterator<unknown[]>) {
    const seen: unknown[][] = [];
    for await (const batch of batches) seen.push(batch);
    return seen;
  }

  const pagingOf = (statement: { text: string }) =>
    /LIMIT \d+ OFFSET \d+/.exec(statement.text)?.[0];

  it('yields the rows in batches of the requested size', async () => {
    const { db } = paging([[ada, grace], [alan]]);

    await expect(drain(db.users.chunk(2))).resolves.toEqual([[ada, grace], [alan]]);
  });

  it('pages each batch with its own LIMIT and OFFSET', async () => {
    const { db, driver } = paging([[ada, grace], [alan]]);
    await drain(db.users.chunk(2));

    expect(driver.statements.map(pagingOf)).toEqual(['LIMIT 2 OFFSET 0', 'LIMIT 2 OFFSET 2']);
  });

  it('costs one more statement when the rows divide exactly', async () => {
    // A full last batch could have more behind it, so it takes an empty page to
    // learn otherwise.
    const { db, driver } = paging([[ada, grace], []]);

    await expect(drain(db.users.chunk(2))).resolves.toEqual([[ada, grace]]);
    expect(driver.statements).toHaveLength(2);
  });

  it('yields nothing for a query that matches nothing', async () => {
    const { db, driver } = paging([[]]);

    await expect(drain(db.users.chunk(2))).resolves.toEqual([]);
    expect(driver.statements).toHaveLength(1);
  });

  it('reads no further than the loop asks it to', async () => {
    const { db, driver } = paging([[ada], [grace], [alan]]);

    for await (const batch of db.users.chunk(1)) {
      expect(batch).toEqual([ada]);
      break;
    }

    expect(driver.statements).toHaveLength(1);
  });

  it('carries the filter and ordering into every batch', async () => {
    const { db, driver } = paging([[ada], []]);

    await drain(
      db.users
        .where((u) => u.isActive)
        .orderBy((u) => u.id)
        .chunk(1),
    );

    expect(driver.statements).toHaveLength(2);
    for (const statement of driver.statements) {
      expect(statement.text).toContain('WHERE "t0"."is_active"');
      expect(statement.text).toContain('ORDER BY "t0"."id" ASC');
    }
  });

  it('rejects a size that could not make a batch', () => {
    const { db } = paging([]);

    // Eagerly, rather than on the first `next()` long after the mistake.
    expect(() => db.users.chunk(0)).toThrow(InvalidQueryError);
    expect(() => db.users.chunk(-1)).toThrow(/positive integer batch size/);
    expect(() => db.users.chunk(1.5)).toThrow(/positive integer batch size/);
  });
});

describe('chunkBy', () => {
  const alan = { ...ada, id: 3, name: 'Alan' };

  function paging(pages: Record<string, unknown>[][]) {
    const driver = new PagingDriver(pages);
    const db = createDbContext({ driver, dialect: testDialect, entities: { users: User } });
    return { db, driver };
  }

  async function drain(runs: AsyncIterableIterator<unknown[]>) {
    const seen: unknown[][] = [];
    for await (const run of runs) seen.push(run);
    return seen;
  }

  it('yields one array per run of the key', async () => {
    const { db } = paging([[ada, grace], [alan], []]);

    await expect(drain(db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId))).resolves.toEqual([
      [ada, grace],
      [alan],
    ]);
  });

  it('reads one run per statement', async () => {
    const { db, driver } = paging([[ada, grace], [alan], []]);
    await drain(db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId));

    expect(driver.statements).toHaveLength(3);
  });

  it('stops at the first empty answer rather than counting the runs first', async () => {
    // The runs are numbered without gaps, so an empty one is past the end and
    // not a hole to read through. That is what `chunk` cannot assume of a short
    // page, and it is why nothing here asks the database how many there are.
    const { db, driver } = paging([[ada], [], [grace]]);

    await expect(drain(db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId))).resolves.toEqual([
      [ada],
    ]);
    expect(driver.statements).toHaveLength(2);
  });

  it('reads no further than the loop asks it to', async () => {
    const { db, driver } = paging([[ada], [grace], [alan]]);

    for await (const run of db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId)) {
      expect(run).toEqual([ada]);
      break;
    }

    expect(driver.statements).toHaveLength(1);
  });

  it('yields nothing for a query that matches nothing', async () => {
    const { db, driver } = paging([[]]);

    await expect(drain(db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId))).resolves.toEqual(
      [],
    );
    expect(driver.statements).toHaveLength(1);
  });

  it('carries the filter and the ordering into every statement', async () => {
    const { db, driver } = paging([[ada], []]);

    await drain(
      db.users
        .where((u) => u.isActive)
        .orderBy((u) => u.id)
        .chunkBy((u) => u.cityId),
    );

    expect(driver.statements).toHaveLength(2);
    for (const statement of driver.statements) {
      expect(statement.text).toContain('WHERE "t0"."is_active"');
      expect(statement.text).toContain('ORDER BY "t0"."id" ASC');
    }
  });

  it('keeps the shape of a projection', async () => {
    const { db } = paging([[{ who: 'Ada' }], []]);

    await expect(
      drain(
        db.users
          .select((u) => ({ who: u.name }))
          .orderBy((u) => u.who)
          .chunkBy((u) => u.who),
      ),
    ).resolves.toEqual([[{ who: 'Ada' }]]);
  });

  it('rejects a selector it cannot translate, before any statement', () => {
    const { db, driver } = paging([]);
    const captured = 3;

    // Eagerly, rather than on the first `next()` long after the mistake, which
    // is why the lambda is parsed outside the generator. `chunk` checks its
    // batch size in the same place and for the same reason.
    expect(() => db.users.orderBy((u) => u.id).chunkBy((u) => u.cityId === captured)).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('sequenceEqual', () => {
  it('answers in one statement, built from a FULL JOIN on position and a NOT EXISTS', async () => {
    const { db, driver } = context([{ value: true }]);

    await expect(
      db.users.orderBy((u) => u.id).sequenceEqual(db.users.orderBy((u) => u.id)),
    ).resolves.toBe(true);

    expect(driver.statements).toHaveLength(1);
    const { text } = driver.lastStatement;
    expect(text).toMatch(/^SELECT NOT EXISTS \(SELECT 1 AS "x" FROM/);
    expect(text).toContain('FULL JOIN');
    expect(text).toContain('__sqlinqo_position');
  });

  it('is false when the driver reports a differing position', async () => {
    const { db } = context([{ value: false }]);

    await expect(
      db.users.orderBy((u) => u.id).sequenceEqual(db.users.orderBy((u) => u.id)),
    ).resolves.toBe(false);
  });

  it('rejects two queries that project different columns, before any statement', () => {
    // Unreachable through the typed API, which requires the same `T` on both
    // sides, but the plan itself carries no such guarantee.
    const { db, driver } = context();
    const named = db.users.select((u) => ({ name: u.name })).orderBy((u) => u.name);
    const emailed = db.users.select((u) => ({ email: u.email })).orderBy((u) => u.email);

    const query = () => named.sequenceEqual(emailed as unknown as typeof named);

    expect(query).toThrow(/project different columns/);
    expect(driver.statements).toHaveLength(0);
  });
});

describe('exceptBy', () => {
  function pair(rows: Record<string, unknown>[] = []) {
    const driver = new FakeDriver(rows);
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User, cities: City },
    });
    return { db, driver };
  }

  it('reads the surviving rows in one statement', async () => {
    const { db, driver } = pair([ada]);

    await expect(
      db.users
        .exceptBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .toArray(),
    ).resolves.toEqual([ada]);
    expect(driver.statements).toHaveLength(1);
  });

  it('needs no ordering and returns a plain query', async () => {
    const { db } = pair([ada, grace]);

    // The result is a `Queryable` like any other, so the operators that follow
    // are the ones that follow a `where`.
    await expect(
      db.users
        .exceptBy(
          db.cities,
          (u) => u.cityId,
          (c) => c.id,
        )
        .where((u) => u.isActive)
        .toArray(),
    ).resolves.toEqual([ada, grace]);
  });

  it('refuses two queries built on different contexts', () => {
    const { db } = pair();
    const other = createDbContext({
      driver: new FakeDriver(),
      dialect: testDialect,
      entities: { cities: City },
    });

    // One statement reaches one database, so this could only ever name a table
    // the connection cannot see.
    expect(() =>
      db.users.exceptBy(
        other.cities,
        (u) => u.cityId,
        (c) => c.id,
      ),
    ).toThrow(/Both sides of an? "exceptBy" must come from the same context/);
  });

  it('rejects a selector it cannot translate, before any statement', () => {
    const { db, driver } = pair();
    const captured = 3;

    expect(() =>
      db.users.exceptBy(
        db.cities,
        (u) => u.cityId === captured,
        (c) => c.id === captured,
      ),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('pairwise', () => {
  it('returns the projected pairs in one statement', async () => {
    const { db, driver } = context([{ at: 2, change: 9 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .pairwise((before, now) => ({ at: now.id, change: now.age - before.age }))
        .toArray(),
    ).resolves.toEqual([{ at: 2, change: 9 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('unwraps a projection of one value', async () => {
    const { db } = context([{ value: 9 }, { value: -4 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .pairwise((before, now) => now.age - before.age)
        .toArray(),
    ).resolves.toEqual([9, -4]);
  });

  it('keeps the earlier row whole when that is all the projector asks for', async () => {
    const { db } = context([ada]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .pairwise((before) => before)
        .toArray(),
    ).resolves.toEqual([ada]);
  });

  it('returns a plain query, so the pairs filter and page like any rows', async () => {
    const { db, driver } = context([{ value: 9 }]);

    await db.users
      .orderBy((u) => u.id)
      .pairwise((before, now) => now.age - before.age)
      .take(1)
      .toArray();

    expect(driver.lastStatement.text).toContain('LIMIT 1');
  });

  it('rejects a projector it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() =>
      db.users.orderBy((u) => u.id).pairwise((before, now) => now.age - before.age + captured),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('windowed', () => {
  it('returns the projected runs in one statement', async () => {
    const { db, driver } = context([{ at: 3, mean: 31 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .windowed(3, (run, row) => ({ at: row.id, mean: run.average((r) => r.age) }))
        .toArray(),
    ).resolves.toEqual([{ at: 3, mean: 31 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('unwraps a projection of one value', async () => {
    const { db } = context([{ value: 31 }, { value: 34 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .windowed(3, (run) => run.average((r) => r.age))
        .toArray(),
    ).resolves.toEqual([31, 34]);
  });

  it('returns a plain query, so the runs filter and page like any rows', async () => {
    const { db, driver } = context([{ value: 31 }]);

    await db.users
      .orderBy((u) => u.id)
      .windowed(3, (run) => run.average((r) => r.age))
      .take(1)
      .toArray();

    expect(driver.lastStatement.text).toContain('LIMIT 1');
  });

  it('refuses a size that is not a whole number of rows, before any statement', () => {
    const { db, driver } = context();

    // Checked where the caller wrote it, as `chunk` and `elementAt` check
    // theirs, so the error names `windowed` rather than the frame it became.
    for (const size of [0, -1, 2.5, Number.NaN]) {
      expect(() => db.users.orderBy((u) => u.id).windowed(size, (run) => run.count())).toThrow(
        /"windowed" expects a positive integer run size/,
      );
    }
    expect(driver.statements).toHaveLength(0);
  });

  it('rejects a projector it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() =>
      db.users.orderBy((u) => u.id).windowed(3, (run) => run.count() + captured),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('expanding', () => {
  it('returns the projected rows in one statement', async () => {
    const { db, driver } = context([{ at: 1, total: 36 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .expanding((sofar, row) => ({ at: row.id, total: sofar.sum((r) => r.age) }))
        .toArray(),
    ).resolves.toEqual([{ at: 1, total: 36 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('unwraps a projection of one value', async () => {
    const { db } = context([{ value: 36 }, { value: 81 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .expanding((sofar) => sofar.sum((r) => r.age))
        .toArray(),
    ).resolves.toEqual([36, 81]);
  });

  it('returns a plain query, so the running values filter and page like any rows', async () => {
    const { db, driver } = context([{ value: 36 }]);

    await db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .take(1)
      .toArray();

    expect(driver.lastStatement.text).toContain('LIMIT 1');
  });

  it('takes no size, so there is no number to reject', async () => {
    const { db, driver } = context([{ value: 36 }]);

    // `windowed` checks its size where the caller wrote it. There is nothing
    // here to check: the run reaches back to the start of the ordering, which
    // is not a number anyone can get wrong.
    await db.users
      .orderBy((u) => u.id)
      .expanding((sofar) => sofar.count())
      .toArray();

    expect(driver.lastStatement.text).toContain('ROWS BETWEEN UNBOUNDED PRECEDING');
  });

  it('rejects a projector it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() =>
      db.users.orderBy((u) => u.id).expanding((sofar) => sofar.count() + captured),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('windowedBy', () => {
  it('returns the projected runs in one statement', async () => {
    const { db, driver } = context([{ at: 3, mean: 31 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .windowedBy(
          (u) => u.cityId,
          3,
          (run, row) => ({ at: row.id, mean: run.average((r) => r.age) }),
        )
        .toArray(),
    ).resolves.toEqual([{ at: 3, mean: 31 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('refuses a size that is not a whole number of rows, naming itself', () => {
    const { db, driver } = context();

    // The plan node is shared with `windowed`, so the message has to name the
    // spelling the caller wrote rather than the node that carries it.
    for (const size of [0, -1, 2.5, Number.NaN]) {
      expect(() =>
        db.users
          .orderBy((u) => u.id)
          .windowedBy(
            (u) => u.cityId,
            size,
            (run) => run.count(),
          ),
      ).toThrow(/"windowedBy" expects a positive integer run size/);
    }
    expect(driver.statements).toHaveLength(0);
  });

  it('rejects a key it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    // The key is parsed where it is written, as the projector is, so a captured
    // variable in either one faults before a statement exists.
    expect(() =>
      db.users
        .orderBy((u) => u.id)
        .windowedBy(
          (u) => u.age + captured,
          2,
          (run) => run.count(),
        ),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('expandingBy', () => {
  it('returns the projected rows in one statement', async () => {
    const { db, driver } = context([{ at: 1, total: 36 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .expandingBy(
          (u) => u.cityId,
          (sofar, row) => ({ at: row.id, total: sofar.sum((r) => r.age) }),
        )
        .toArray(),
    ).resolves.toEqual([{ at: 1, total: 36 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('unwraps a projection of one value', async () => {
    const { db } = context([{ value: 36 }, { value: 45 }]);

    await expect(
      db.users
        .orderBy((u) => u.id)
        .expandingBy(
          (u) => u.cityId,
          (sofar) => sofar.sum((r) => r.age),
        )
        .toArray(),
    ).resolves.toEqual([36, 45]);
  });

  it('takes no size, so there is no number to reject', async () => {
    const { db, driver } = context([{ value: 1 }]);

    await db.users
      .orderBy((u) => u.id)
      .expandingBy(
        (u) => u.cityId,
        (sofar) => sofar.count(),
      )
      .toArray();

    expect(driver.lastStatement.text).toContain('PARTITION BY');
    expect(driver.lastStatement.text).toContain('ROWS BETWEEN UNBOUNDED PRECEDING');
  });

  it('rejects a key it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() =>
      db.users
        .orderBy((u) => u.id)
        .expandingBy(
          (u) => u.age + captured,
          (sofar) => sofar.count(),
        ),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('rank', () => {
  it('returns the projected rows in one statement', async () => {
    const { db, driver } = context([{ name: 'Ada', place: 1 }]);

    await expect(
      db.users
        .orderByDescending((u) => u.age)
        .rank((u, place) => ({ name: u.name, place }))
        .toArray(),
    ).resolves.toEqual([{ name: 'Ada', place: 1 }]);
    expect(driver.statements).toHaveLength(1);
  });

  it('unwraps a projection of the place alone', async () => {
    const { db } = context([{ value: 1 }, { value: 2 }]);

    await expect(
      db.users
        .orderByDescending((u) => u.age)
        .rank((_u, place) => place)
        .toArray(),
    ).resolves.toEqual([1, 2]);
  });

  it('returns a plain query, so the places filter and page like any rows', async () => {
    const { db, driver } = context([{ value: 1 }]);

    await db.users
      .orderByDescending((u) => u.age)
      .rank((_u, place) => place)
      .take(3)
      .toArray();

    expect(driver.lastStatement.text).toContain('LIMIT 3');
  });

  it('rejects a projector it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() =>
      db.users.orderByDescending((u) => u.age).rank((_u, place) => place + captured),
    ).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});

describe('denseRank', () => {
  it('is the same query with one function name changed', async () => {
    const { db, driver } = context([{ value: 1 }]);

    await db.users
      .orderByDescending((u) => u.age)
      .rank((_u, place) => place)
      .toArray();
    const sparse = driver.lastStatement.text;

    await db.users
      .orderByDescending((u) => u.age)
      .denseRank((_u, tier) => tier)
      .toArray();
    const dense = driver.lastStatement.text;

    expect(dense).toBe(sparse.replace('RANK() OVER', 'DENSE_RANK() OVER'));
  });
});

describe('takeBy and skipBy', () => {
  it('returns the rows in one statement', async () => {
    const { db, driver } = context([ada]);

    await expect(
      db.users
        .orderByDescending((u) => u.age)
        .takeBy((u) => u.cityId, 2)
        .toArray(),
    ).resolves.toEqual([ada]);
    expect(driver.statements).toHaveLength(1);
  });

  it('refuses a count that is not a whole number of rows, naming itself', () => {
    const { db, driver } = context();

    // The node is shared, so each operator has to name itself rather than the
    // window it became, and the shared validator has to be told which one is
    // asking rather than assuming an included collection as it once did.
    for (const count of [-1, 2.5, Number.NaN]) {
      expect(() => db.users.orderBy((u) => u.id).takeBy((u) => u.cityId, count)).toThrow(
        /"takeBy" expects a non-negative integer/,
      );
      expect(() => db.users.orderBy((u) => u.id).skipBy((u) => u.cityId, count)).toThrow(
        /"skipBy" expects a non-negative integer/,
      );
    }
    expect(driver.statements).toHaveLength(0);
  });

  it('still names an included collection when that is what was written', () => {
    const { db } = context();

    // The validator lost its hardcoded subject when it gained callers that are
    // not collections. What it must not lose is the disambiguation the message
    // had, since `take` and `skip` exist on a query as well.
    expect(() =>
      db.users.include(
        (u) => u.posts,
        (posts) => posts.orderBy((p) => p.id).take(-1),
      ),
    ).toThrow(/"take" on an included collection expects a non-negative integer/);
  });

  it('rejects a key it cannot translate, before any statement', () => {
    const { db, driver } = context();
    const captured = 3;

    expect(() => db.users.orderBy((u) => u.id).takeBy((u) => u.age + captured, 2)).toThrow();
    expect(driver.statements).toHaveLength(0);
  });
});
