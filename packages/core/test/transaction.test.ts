import { describe, expect, it } from 'vitest';
import { createDbContext, ModelError } from '../src/index.js';
import type { Driver, PreparedStatement, ResultRow } from '../src/index.js';
import { FakeDriver, testDialect, User } from './support.js';

/**
 * A driver that records the shape of a transaction rather than holding one.
 *
 * What the core owes a provider here is narrow: call `transaction`, run every
 * statement of the body on the driver it hands back, and let a throw through.
 * That is what these assert; whether `BEGIN` and `COMMIT` reach a database is
 * the provider's half and is covered by the integration suite.
 */
class RecordingDriver implements Driver {
  readonly name = 'recording';
  readonly log: string[] = [];
  /** Set to make the driver hand the body a different driver, as a pool would. */
  inner: Driver = this;

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    this.log.push(`execute:${statement.text.startsWith('SELECT') ? 'select' : 'other'}`);
    return [];
  }

  async close(): Promise<void> {
    this.log.push('close');
  }

  async transaction<TResult>(body: (driver: Driver) => Promise<TResult>): Promise<TResult> {
    this.log.push('begin');
    try {
      const result = await body(this.inner);
      this.log.push('commit');
      return result;
    } catch (error) {
      this.log.push('rollback');
      throw error;
    }
  }
}

const context = (driver: Driver) =>
  createDbContext({ driver, dialect: testDialect, entities: { users: User } });

describe('$transaction', () => {
  it('runs the body between begin and commit', async () => {
    const driver = new RecordingDriver();

    await context(driver).$transaction(async (tx) => {
      await tx.users.toArray();
    });

    expect(driver.log).toEqual(['begin', 'execute:select', 'commit']);
  });

  it('hands back what the body returned', async () => {
    const driver = new RecordingDriver();

    const answer = await context(driver).$transaction(async () => 'done');

    expect(answer).toBe('done');
  });

  it('rolls back when the body throws, and rethrows what it threw', async () => {
    const driver = new RecordingDriver();
    const boom = new Error('boom');

    await expect(
      context(driver).$transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The original error, not a rollback failure on top of it.
    expect(driver.log).toEqual(['begin', 'rollback']);
  });

  it('runs every statement of the body on the driver the transaction handed out', async () => {
    const outer = new RecordingDriver();
    const inner = new RecordingDriver();
    outer.inner = inner;

    await context(outer).$transaction(async (tx) => {
      await tx.users.toArray();
      await tx.users.count();
    });

    // Both statements went to the transaction connection and none to the pool.
    expect(inner.log).toEqual(['execute:select', 'execute:select']);
    expect(outer.log).toEqual(['begin', 'commit']);
  });

  it('gives the body the same entity sets, dialect, and logger', async () => {
    const driver = new RecordingDriver();
    const logged: string[] = [];
    const db = createDbContext({
      driver,
      dialect: testDialect,
      entities: { users: User },
      logger: (statement) => logged.push(statement.text),
    });

    await db.$transaction(async (tx) => {
      expect(tx.$dialect).toBe(db.$dialect);
      await tx.users.where((u) => u.isActive).toArray();
    });

    // A query written against the outer context runs against this one unchanged,
    // logger included.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('WHERE "t0"."is_active"');
  });

  it('refuses a driver that has no transactions rather than running unprotected', async () => {
    const db = context(new FakeDriver());

    // Running the body anyway would look like a transaction and protect
    // nothing, which is the dangerous half of doing nothing.
    await expect(db.$transaction(async () => 1)).rejects.toThrow(ModelError);
    await expect(db.$transaction(async () => 1)).rejects.toThrow(
      /"fake" driver does not support transactions/,
    );
  });

  it('reserves its own name against an entity set called $transaction', () => {
    expect(() =>
      createDbContext({
        driver: new FakeDriver(),
        dialect: testDialect,
        entities: { $transaction: User },
      }),
    ).toThrow(/"\$transaction" is reserved by the context/);
  });
});
