import type { Driver, PreparedStatement, ResultRow } from '@sqlinqo/core';
import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';

// `pg` is CommonJS, so the named exports are read off the default import. This
// is the form that works unchanged under both ESM and CJS consumers.
const { Pool: PgPool } = pg;

export interface PostgresDriverOptions extends PoolConfig {
  /**
   * An existing pool to use instead of creating one.
   *
   * When supplied, `close()` leaves it open: whoever created the pool owns its
   * lifetime, and silently tearing down a pool shared with the rest of an
   * application would be a surprising thing for a query library to do.
   */
  readonly pool?: Pool;
}

/**
 * Executes compiled statements against PostgreSQL through node-postgres.
 */
export class PostgresDriver implements Driver {
  readonly name = 'postgres';

  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private closed = false;

  constructor(options: PostgresDriverOptions = {}) {
    const { pool, ...config } = options;
    this.pool = pool ?? new PgPool(config);
    this.ownsPool = pool === undefined;
  }

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    const result = await this.pool.query({
      text: statement.text,
      values: [...statement.values],
    });
    return result.rows as ResultRow[];
  }

  async close(): Promise<void> {
    if (!this.ownsPool || this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  /**
   * Runs `body` on one connection inside `BEGIN` and `COMMIT`.
   *
   * The connection is checked out for the whole body rather than per statement,
   * which is what makes several statements one snapshot: PostgreSQL scopes a
   * transaction to a session, and a pool hands out a different session each
   * time it is asked.
   *
   * A body that throws rolls back and the error is rethrown untouched, so the
   * caller sees what actually went wrong rather than a rollback failure on top
   * of it. The rollback itself is guarded, because a connection that has
   * already died cannot be rolled back and reporting that instead would bury
   * the original.
   */
  async transaction<TResult>(body: (driver: Driver) => Promise<TResult>): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await body(new PostgresTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Escape hatch for statements the query engine does not yet cover. */
  get connectionPool(): Pool {
    return this.pool;
  }
}

/**
 * A driver bound to one checked-out connection, for the length of one
 * transaction.
 *
 * `close` releases nothing here. The connection belongs to the `transaction`
 * call that checked it out and is returned when the body finishes, so a context
 * built on this can be closed without taking the pool with it, and closing it
 * halfway through cannot strand the transaction.
 *
 * Nesting is not offered: `transaction` is absent, so a body that asks for
 * another one is told the driver has none rather than being given a `BEGIN`
 * inside a `BEGIN`, which PostgreSQL warns about and ignores.
 */
class PostgresTransaction implements Driver {
  readonly name = 'postgres';

  constructor(private readonly client: PoolClient) {}

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    const result = await this.client.query({
      text: statement.text,
      values: [...statement.values],
    });
    return result.rows as ResultRow[];
  }

  async close(): Promise<void> {
    // Deliberately nothing: see the note above.
  }
}
