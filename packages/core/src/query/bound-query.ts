import type { QueryPlan } from './plan.js';

const MARK: unique symbol = Symbol('boundQuery');

/**
 * A query passed as a parameter bag's value, marked so the compiler can tell
 * it apart from an ordinary value once a lambda reads it back through
 * `p.someName`.
 *
 * A query cannot travel through the bag as the `Queryable` a caller built: by
 * the time a lambda names it, its own parameter bags need to already be
 * folded into the query that captured it, the same renumbering `join` and
 * `selectMany` already do before either ever reaches the compiler. What is
 * stored here is that already-renumbered plan, read back and compiled the
 * ordinary way once the compiler finds one sitting in the bag.
 */
export interface BoundQuery {
  readonly [MARK]: true;
  readonly plan: QueryPlan;
}

export function boundQuery(plan: QueryPlan): BoundQuery {
  return { [MARK]: true, plan };
}

export function isBoundQuery(value: unknown): value is BoundQuery {
  return typeof value === 'object' && value !== null && MARK in value;
}
