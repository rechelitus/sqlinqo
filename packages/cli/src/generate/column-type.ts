import type { ColumnType, ScalarColumnType } from '@sqlinqo/core';
import type { ColumnInfo } from '../schema/types.js';

/** A logical column type, in the shape `defineEntity` takes it. */
export interface MappedColumnType {
  readonly type: ColumnType;
  /** Element type, present only when `type` is `array`. */
  readonly of?: ScalarColumnType;
}

/**
 * PostgreSQL type names to the engine's logical types.
 *
 * The rule for adding an entry is what the driver hands back, not what the
 * column is called. `time` and `inet` are here because node-postgres returns
 * them as strings, so `text` is the honest description of the value a query
 * will actually see. `bytea` and `interval` are absent for the same reason
 * read the other way: they come back as a `Buffer` and as an object, and no
 * logical type says so, which is why they are refused rather than guessed at.
 */
const SCALAR_TYPES: Readonly<Record<string, ScalarColumnType>> = {
  // Integers. `int2` and `int4` both fit a JavaScript number; `int8` does not,
  // which is the whole reason `bigint` is a separate logical type.
  int2: 'int',
  int4: 'int',
  int8: 'bigint',

  // Floating point. `numeric` and `money` are decimal instead: both are
  // arbitrary precision, and the engine maps `decimal` to a string on purpose
  // rather than silently rounding a financial column into a float.
  float4: 'float',
  float8: 'float',
  numeric: 'decimal',
  money: 'decimal',

  // Character data, and the types the driver hands back as strings.
  text: 'text',
  varchar: 'text',
  bpchar: 'text',
  char: 'text',
  name: 'text',
  citext: 'text',
  xml: 'text',
  time: 'text',
  timetz: 'text',
  inet: 'text',
  cidr: 'text',
  macaddr: 'text',
  macaddr8: 'text',

  uuid: 'uuid',
  bool: 'boolean',
  date: 'date',

  // Both timestamps map to `timestamp`, since node-postgres returns a Date for
  // either. What differs is what the instant is relative to, which is a caveat
  // about the column rather than about the type.
  timestamp: 'timestamp',
  timestamptz: 'timestamp',

  json: 'json',
  jsonb: 'json',
};

/**
 * The logical type for a column, or null when there is no honest answer.
 *
 * Returning null rather than falling back to `text` is the same bargain the
 * dialects make: a caller that gets null can say precisely which column it
 * could not map, where a guess would have compiled and then read the wrong
 * value back at runtime.
 */
export function mapColumnType(column: ColumnInfo): MappedColumnType | null {
  const scalar = mapScalarType(column.udtName, column.typeCategory);
  if (scalar === null) return null;
  return column.isArray ? { type: 'array', of: scalar } : { type: scalar };
}

/**
 * The logical type for one value of a named PostgreSQL type.
 *
 * An enum is mapped by its category rather than by its name, since the name is
 * whatever the schema author chose. Every enum reads back as a string, so
 * `text` is exactly right and needs no per-schema configuration.
 */
export function mapScalarType(
  udtName: string,
  typeCategory: string | null,
): ScalarColumnType | null {
  if (typeCategory === 'e') return 'text';
  return SCALAR_TYPES[udtName] ?? null;
}
