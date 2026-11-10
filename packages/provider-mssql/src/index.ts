/**
 * @sqlinqo/mssql
 *
 * SQL Server provider for `@sqlinqo/core`. Supplies the dialect, an `mssql`
 * backed driver, and a one-call context factory.
 */

import type { AnyEntity, DbContext, ExecutedStatement } from '@sqlinqo/core';
import { createDbContext } from '@sqlinqo/core';
import { mssqlDialect } from './dialect.js';
import type { MssqlDriverOptions } from './driver.js';
import { MssqlDriver } from './driver.js';

export { MssqlDialect, mssqlDialect } from './dialect.js';
export { MssqlDriver } from './driver.js';
export type { MssqlDriverOptions } from './driver.js';

export interface MssqlContextOptions<
  TEntities extends Record<string, AnyEntity>,
> extends MssqlDriverOptions {
  readonly entities: TEntities;
  readonly logger?: (statement: ExecutedStatement) => void;
}

/**
 * Creates a context wired to SQL Server.
 *
 * This is the shortest path from a model to a running query:
 *
 * ```ts
 * const db = createMssqlContext({
 *   server: 'localhost',
 *   database: 'sqlinqo',
 *   user: process.env.DB_USER,
 *   password: process.env.DB_PASSWORD,
 *   options: { trustServerCertificate: true },
 *   entities: { users: User },
 * });
 *
 * const adults = await db.users.where((u, p) => u.age >= p.min, { min: 18 }).toArray();
 * ```
 */
export function createMssqlContext<TEntities extends Record<string, AnyEntity>>(
  options: MssqlContextOptions<TEntities>,
): DbContext<TEntities> {
  const { entities, logger, ...driverOptions } = options;

  return createDbContext({
    driver: new MssqlDriver(driverOptions),
    dialect: mssqlDialect,
    entities,
    ...(logger ? { logger } : {}),
  });
}
