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

describe('tag', () => {
  it('prints the comment before the statement', () => {
    const { db } = context();

    const { text } = db.users.tag('nightly digest').toSQL();

    expect(text).toBe(
      '/* nightly digest */ SELECT "t0"."id" AS "id", "t0"."name" AS "name", ' +
        '"t0"."email" AS "email", "t0"."age" AS "age", "t0"."city_id" AS "cityId", ' +
        '"t0"."is_active" AS "isActive", "t0"."created_at" AS "createdAt" FROM "users" AS "t0"',
    );
  });

  it('changes nothing else about the statement', () => {
    const { db } = context();

    const plain = db.users.where((u) => u.age > 18).toSQL();
    const tagged = db.users
      .where((u) => u.age > 18)
      .tag('audit')
      .toSQL();

    // The one operator that adds nothing but the comment, which is why it can
    // be written anywhere in a chain.
    expect(tagged.text).toBe(`/* audit */ ${plain.text}`);
    expect(tagged.values).toEqual(plain.values);
  });

  it('can be written before or after the clauses it accompanies', () => {
    const { db } = context();

    const before = db.users
      .tag('audit')
      .where((u) => u.age > 18)
      .toSQL();
    const after = db.users
      .where((u) => u.age > 18)
      .tag('audit')
      .toSQL();

    expect(before.text).toBe(after.text);
  });

  it('prints every tag, in the order they were written', () => {
    const { db } = context();

    const { text } = db.users
      .tag('first')
      .where((u) => u.age > 18)
      .tag('second')
      .toSQL();

    expect(text).toContain('/* first */ /* second */ SELECT');
  });

  it('reaches the top of a statement whose query became a subquery', () => {
    const { db } = context();

    const { text } = db.users
      .tag('paged')
      .orderBy((u) => u.id)
      .take(5)
      .select((u) => ({ name: u.name }))
      .toSQL();

    // A page pushes the query into a derived table, and the comment is worth
    // reading at the top of the statement rather than from the middle of it.
    expect(text.startsWith('/* paged */ SELECT')).toBe(true);
    expect(text.indexOf('/* paged */')).toBe(text.lastIndexOf('/* paged */'));
  });

  it('rides on a counting terminal rather than staying in the subquery', async () => {
    const { db, driver } = context([{ count: 2 }]);

    await db.users.tag('how many').count();

    expect(driver.lastStatement.text.startsWith('/* how many */ SELECT COUNT(*)')).toBe(true);
  });

  it('rides on an aggregate terminal too', async () => {
    const { db, driver } = context([{ average: 30, count: 2 }]);

    await db.users.tag('mean age').average((u) => u.age);

    expect(driver.lastStatement.text.startsWith('/* mean age */ SELECT AVG')).toBe(true);
  });

  it('survives a later sort key', () => {
    const { db } = context();

    const { text } = db.users
      .orderBy((u) => u.name)
      .tag('sorted twice')
      .thenBy((u) => u.age)
      .toSQL();

    // `thenBy` rebuilds the ordering from the plan it was applied to, so a tag
    // wrapped around that node would have been the one thing it threw away.
    expect(text).toContain('/* sorted twice */ SELECT');
    expect(text).toContain('ORDER BY "t0"."name" ASC, "t0"."age" ASC');
  });

  it('counts from either side of a set operation', () => {
    const { db } = context();

    const { text } = db.users.union(db.users.tag('the other half')).toSQL();

    // The compiler reaches every branch it folds in, where a walk down the
    // spine would have seen only the query the tag was written on.
    expect(text).toContain('/* the other half */ SELECT');
  });

  it('is carried by an update', async () => {
    const { db, driver } = context();

    await db.users
      .where((u) => u.age > 18)
      .tag('promote adults')
      .update({ isActive: true });

    // A slow write is exactly the statement worth finding in a log again, and a
    // tag says nothing about which rows are meant, so the write accepts it
    // where every other clause is refused.
    expect(driver.lastStatement.text.startsWith('/* promote adults */ UPDATE')).toBe(true);
  });

  it('is carried by a delete', async () => {
    const { db, driver } = context();

    await db.users
      .tag('purge')
      .where((u) => !u.isActive)
      .delete();

    expect(driver.lastStatement.text.startsWith('/* purge */ DELETE FROM')).toBe(true);
  });

  it('reaches the logger with the statement it tagged', async () => {
    const driver = new FakeDriver([{ id: 1 }]);
    const logged: string[] = [];
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User },
      logger: (statement) => logged.push(statement.text),
    });

    await db.users.tag('traced').toArray();

    expect(logged[0]).toContain('/* traced */');
  });

  it('leaves an untagged statement exactly as it was', () => {
    const { db } = context();

    expect(db.users.toSQL().text.startsWith('SELECT')).toBe(true);
  });
});

describe('tag refusals', () => {
  it('refuses text that would close the comment early', () => {
    const { db } = context();

    // The one thing a caller writes that reaches the statement as text rather
    // than as a bound value, so it is checked rather than trusted.
    expect(() => db.users.tag('done */ DROP TABLE users; --')).toThrow(
      /cannot carry a comment delimiter/,
    );
  });

  it('refuses text that would open a nested comment', () => {
    const { db } = context();

    // PostgreSQL nests block comments, so an opening pair is no safer than a
    // closing one: it would leave the outer comment unterminated.
    expect(() => db.users.tag('see /* here')).toThrow(/cannot carry a comment delimiter/);
  });

  it('refuses an empty tag, which would trace nothing', () => {
    const { db } = context();

    expect(() => db.users.tag('   ')).toThrow(/this tag is empty/);
  });

  it('names the operator that was written', () => {
    const { db } = context();

    expect(() => db.users.orderBy((u) => u.id).tag('')).toThrow(/"tag"/);
  });
});
