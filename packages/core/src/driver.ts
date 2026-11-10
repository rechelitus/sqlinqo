/**
 * The contract every provider package implements.
 *
 * It is deliberately narrow: the engine hands over finished SQL plus an ordered
 * value array and expects rows back. Connection pooling, retries, and type
 * coercion all belong to the provider, which keeps `@sqlinqo/core` free of any
 * database client dependency.
 */

/** A row as returned by the driver, keyed by the alias the compiler assigned. */
export type ResultRow = Record<string, unknown>;

export interface PreparedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface Driver {
  /** Provider name, used in diagnostics such as `postgres`. */
  readonly name: string;

  execute(statement: PreparedStatement): Promise<ResultRow[]>;

  /** Releases pooled connections. Safe to call more than once. */
  close(): Promise<void>;

  /**
   * Runs `body` with a driver whose statements share one connection and one
   * transaction, committing when it returns and rolling back when it throws.
   *
   * Optional, because a driver over something that has no transactions still
   * satisfies the rest of this contract. A context whose driver has none
   * refuses `$transaction` by name rather than running the body unprotected,
   * which would be the dangerous half of doing nothing.
   *
   * The driver handed to `body` must not outlive it. Its `close` releases the
   * connection back rather than tearing the pool down, so a context built on
   * it can be closed without taking the outer one with it.
   */
  transaction?<TResult>(body: (driver: Driver) => Promise<TResult>): Promise<TResult>;
}

/** Diagnostic record handed to the optional context logger. */
export interface ExecutedStatement extends PreparedStatement {
  readonly durationMs: number;
  readonly rowCount: number;
}
