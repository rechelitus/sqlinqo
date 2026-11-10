import type { Driver, ExecutedStatement } from './driver.js';
import { ModelError } from './errors.js';
import type { AnyEntity } from './metadata/entity.js';
import type { EntitySet, QueryRuntime } from './query/queryable.js';
import { queryableFor } from './query/queryable.js';
import type { SqlDialect } from './sql/dialect.js';

export interface DbContextOptions<TEntities extends Record<string, AnyEntity>> {
  readonly driver: Driver;
  readonly dialect: SqlDialect;
  /** Entity set name to entity definition, for example `{ users: User }`. */
  readonly entities: TEntities;
  /** Called after each statement. Handy for logging generated SQL in tests. */
  readonly logger?: (statement: ExecutedStatement) => void;
}

/** Members the context exposes alongside its entity sets. */
export interface DbContextInternals {
  readonly $driver: Driver;
  readonly $dialect: SqlDialect;
  /** Releases the underlying driver's connections. */
  $close(): Promise<void>;
}

/** The transactional half, separated only so the entity sets can be added to it. */
export interface DbContextTransaction<TEntities extends Record<string, AnyEntity>> {
  /**
   * Runs `body` against a context whose statements share one transaction,
   * committing when it returns and rolling back when it throws.
   *
   * ```ts
   * const [rows, total] = await db.$transaction(async (tx) => [
   *   await tx.users.orderBy((u) => u.id).toArray(),
   *   await tx.users.count(),
   * ]);
   * ```
   *
   * The context handed to `body` reads the same entities through the same
   * dialect, so a query written against one works against the other unchanged.
   * What it adds is that several statements see one snapshot, which is what the
   * operators that issue more than one — `chunk`, `chunkBy`, and `include` —
   * ask for when the rows behind them are moving.
   *
   * Use only the context handed in. Statements issued on the outer one during
   * the body run on a different connection and are outside the transaction.
   */
  $transaction<TResult>(body: (tx: DbContext<TEntities>) => Promise<TResult>): Promise<TResult>;
}

/**
 * The root object an application queries through.
 *
 * Infrastructure members are prefixed with `$` so that an entity set can be
 * named `driver`, `dialect`, or anything else a real schema happens to contain
 * without colliding with the context's own API.
 */
export type DbContext<TEntities extends Record<string, AnyEntity>> = {
  readonly [K in keyof TEntities]: EntitySet<TEntities[K]>;
} & DbContextInternals &
  DbContextTransaction<TEntities>;

const RESERVED = new Set<string>(['$driver', '$dialect', '$close', '$transaction']);

/**
 * Wires a set of entities to a driver and a dialect.
 *
 * The entity sets are created eagerly and are plain immutable `Queryable`
 * instances, so holding on to `db.users` and branching from it later costs
 * nothing and cannot leak state between requests.
 */
export function createDbContext<TEntities extends Record<string, AnyEntity>>(
  options: DbContextOptions<TEntities>,
): DbContext<TEntities> {
  const runtime: QueryRuntime = options.logger
    ? { driver: options.driver, dialect: options.dialect, logger: options.logger }
    : { driver: options.driver, dialect: options.dialect };

  const context: Record<string, unknown> = {
    $driver: options.driver,
    $dialect: options.dialect,
    $close: () => options.driver.close(),

    // The transactional context is this one rebuilt over the driver the
    // transaction handed out, so every entity set, the dialect, and the logger
    // are the same and a query written for one runs against the other.
    $transaction: <TResult>(
      body: (tx: DbContext<TEntities>) => Promise<TResult>,
    ): Promise<TResult> => {
      const begin = options.driver.transaction;
      if (!begin) {
        // Rejected rather than thrown, so a caller who wrote `await` or
        // `.catch` finds out the way every other failure here arrives.
        return Promise.reject(
          new ModelError(
            `The "${options.driver.name}" driver does not support transactions, so ` +
              '"$transaction" has nothing to run the body inside. Running it anyway would ' +
              'look like a transaction and protect nothing.',
          ),
        );
      }

      return begin.call<Driver, [(driver: Driver) => Promise<TResult>], Promise<TResult>>(
        options.driver,
        (driver) => body(createDbContext({ ...options, driver })),
      );
    },
  };

  for (const [name, entity] of Object.entries(options.entities)) {
    if (RESERVED.has(name)) {
      throw new ModelError(`"${name}" is reserved by the context and cannot name an entity set.`);
    }
    context[name] = queryableFor(runtime, entity);
  }

  return context as DbContext<TEntities>;
}
