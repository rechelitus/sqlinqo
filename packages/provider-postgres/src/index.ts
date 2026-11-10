/**
 * @sqlinqo/postgres
 *
 * PostgreSQL provider for `@sqlinqo/core`. Supplies the dialect, a node-postgres
 * backed driver, and a one-call context factory.
 */

import type { AnyEntity, DbContext, ExecutedStatement } from '@sqlinqo/core';
import { createDbContext } from '@sqlinqo/core';
import { postgresDialect } from './dialect.js';
import type { PostgresDriverOptions } from './driver.js';
import { PostgresDriver } from './driver.js';

export { PostgresDialect, postgresDialect } from './dialect.js';
export { PostgresDriver } from './driver.js';
export type { PostgresDriverOptions } from './driver.js';

export interface PostgresContextOptions<
  TEntities extends Record<string, AnyEntity>,
> extends PostgresDriverOptions {
  readonly entities: TEntities;
  readonly logger?: (statement: ExecutedStatement) => void;
}

/**
 * Creates a context wired to PostgreSQL.
 *
 * This is the shortest path from a model to a running query:
 *
 * ```ts
 * const db = createPostgresContext({
 *   connectionString: process.env.DATABASE_URL,
 *   entities: { users: User },
 * });
 *
 * const adults = await db.users.where((u, p) => u.age >= p.min, { min: 18 }).toArray();
 * ```
 */
export function createPostgresContext<TEntities extends Record<string, AnyEntity>>(
  options: PostgresContextOptions<TEntities>,
): DbContext<TEntities> {
  const { entities, logger, ...driverOptions } = options;

  return createDbContext({
    driver: new PostgresDriver(driverOptions),
    dialect: postgresDialect,
    entities,
    ...(logger ? { logger } : {}),
  });
}
