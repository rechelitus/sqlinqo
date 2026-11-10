import type { Driver, PreparedStatement, ResultRow } from '@sqlinqo/core';
import mssql from 'mssql';
import type { config as MssqlConfig, ConnectionPool, Transaction } from 'mssql';

// `mssql` is CommonJS, so the named exports are read off the default import,
// the same interop the PostgreSQL driver needs for `pg`.
const {
  ConnectionPool: MssqlConnectionPool,
  Transaction: MssqlTransaction,
  Request: MssqlRequest,
} = mssql;

export interface MssqlDriverOptions extends Omit<Partial<MssqlConfig>, 'pool'> {
  /**
   * An existing pool to use instead of creating one.
   *
   * When supplied, `close()` leaves it open: whoever created the pool owns its
   * lifetime, and silently tearing down a pool shared with the rest of an
   * application would be a surprising thing for a query library to do.
   *
   * Named the same as `config.pool` in `@types/mssql` but meaning something
   * different — a client pool rather than the options for one — so that
   * field is omitted from `Partial<MssqlConfig>` above rather than widened to
   * accept both.
   */
  readonly pool?: ConnectionPool;

  /**
   * A connection string, in either the ADO or the `mssql://` form the
   * `mssql` package itself parses. `config` has no top-level field for one —
   * `@types/mssql` nests it under `options.connectionString` instead — so it
   * is read here and passed to the constructor overload that takes a bare
   * string, which is the more convenient shape for the common case of one
   * environment variable naming the whole connection.
   */
  readonly connectionString?: string;
}

/**
 * Executes compiled statements against SQL Server through the `mssql` package.
 */
export class MssqlDriver implements Driver {
  readonly name = 'mssql';

  private readonly pool: ConnectionPool;
  private readonly ownsPool: boolean;
  private closed = false;
  private connecting: Promise<ConnectionPool> | null = null;

  constructor(options: MssqlDriverOptions = {}) {
    const { pool, connectionString, ...config } = options;

    if (pool) {
      this.pool = pool;
      this.ownsPool = false;
    } else {
      this.pool = new MssqlConnectionPool(connectionString ?? (config as MssqlConfig));
      this.ownsPool = true;
    }
  }

  /**
   * Connects the pool on first use and reuses that same connection afterwards.
   *
   * Unlike node-postgres's `Pool`, which connects lazily under every query,
   * the `mssql` package's `ConnectionPool` has to be told to `connect()`
   * before it will accept a request. Caching the promise rather than the
   * resolved pool is what keeps two statements issued back to back from
   * racing each other into a second `connect()` call.
   */
  private async ready(): Promise<ConnectionPool> {
    if (this.pool.connected) return this.pool;
    this.connecting ??= this.pool.connect();
    return this.connecting;
  }

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    const pool = await this.ready();
    const request = pool.request();
    statement.values.forEach((value, index) => request.input(`p${index}`, value));
    const result = await request.query(statement.text);
    return result.recordset as ResultRow[];
  }

  async close(): Promise<void> {
    if (!this.ownsPool || this.closed) return;
    this.closed = true;
    await this.pool.close();
  }

  /**
   * Runs `body` on one connection inside a transaction, committing what it
   * returns and rolling back what it throws.
   *
   * A body that throws rolls back and the error is rethrown untouched, so the
   * caller sees what actually went wrong rather than a rollback failure on top
   * of it. The rollback itself is guarded, because a connection that has
   * already died cannot be rolled back and reporting that instead would bury
   * the original.
   */
  async transaction<TResult>(body: (driver: Driver) => Promise<TResult>): Promise<TResult> {
    const pool = await this.ready();
    const transaction = new MssqlTransaction(pool);
    await transaction.begin();

    try {
      const result = await body(new MssqlTransactionDriver(transaction));
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  /** Escape hatch for statements the query engine does not yet cover. */
  get connectionPool(): ConnectionPool {
    return this.pool;
  }
}

/**
 * A driver bound to one open transaction.
 *
 * `close` releases nothing here, for the same reason `PostgresTransaction`'s
 * does not: the connection belongs to the `transaction` call that opened it
 * and is returned when the body finishes, so a context built on this can be
 * closed without taking the pool with it.
 *
 * Nesting is not offered: `transaction` is absent, so a body that asks for
 * another one is told the driver has none rather than being given a second
 * transaction the `mssql` package has no notion of nesting.
 */
class MssqlTransactionDriver implements Driver {
  readonly name = 'mssql';

  // Named `openTransaction` rather than `transaction`: `Driver.transaction` is
  // itself an optional method of that name, and a private field of the same
  // name would collide with it instead of merely shadowing it.
  constructor(private readonly openTransaction: Transaction) {}

  async execute(statement: PreparedStatement): Promise<ResultRow[]> {
    const request = new MssqlRequest(this.openTransaction);
    statement.values.forEach((value, index) => request.input(`p${index}`, value));
    const result = await request.query(statement.text);
    return result.recordset as ResultRow[];
  }

  async close(): Promise<void> {
    // Deliberately nothing: see the note above.
  }
}
