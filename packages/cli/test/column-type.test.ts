import { describe, expect, it } from 'vitest';
import { mapColumnType } from '../src/generate/column-type.js';
import { column } from './support.js';

describe('mapColumnType', () => {
  it('maps the integer family by what fits a JavaScript number', () => {
    expect(mapColumnType(column('a', 'int2'))).toEqual({ type: 'int' });
    expect(mapColumnType(column('a', 'int4'))).toEqual({ type: 'int' });
    expect(mapColumnType(column('a', 'int8'))).toEqual({ type: 'bigint' });
  });

  it('keeps an arbitrary-precision number out of a float', () => {
    expect(mapColumnType(column('a', 'numeric'))).toEqual({ type: 'decimal' });
    expect(mapColumnType(column('a', 'money'))).toEqual({ type: 'decimal' });
    expect(mapColumnType(column('a', 'float8'))).toEqual({ type: 'float' });
  });

  it('maps both timestamps to one logical type', () => {
    // The driver returns a Date for either. What differs is the instant they
    // are relative to, which is a caveat about the column, not about the type.
    expect(mapColumnType(column('a', 'timestamp'))).toEqual({ type: 'timestamp' });
    expect(mapColumnType(column('a', 'timestamptz'))).toEqual({ type: 'timestamp' });
    expect(mapColumnType(column('a', 'date'))).toEqual({ type: 'date' });
  });

  it('maps a type the driver hands back as a string to text', () => {
    for (const udt of ['text', 'varchar', 'bpchar', 'citext', 'time', 'inet', 'xml']) {
      expect(mapColumnType(column('a', udt))).toEqual({ type: 'text' });
    }
  });

  it('reads an enum as text by its category rather than its name', () => {
    expect(mapColumnType(column('a', 'order_state', { typeCategory: 'e' }))).toEqual({
      type: 'text',
    });
  });

  it('carries an array element type through', () => {
    expect(mapColumnType(column('a', 'text', { isArray: true, dataType: 'text[]' }))).toEqual({
      type: 'array',
      of: 'text',
    });
    expect(mapColumnType(column('a', 'int4', { isArray: true, dataType: 'integer[]' }))).toEqual({
      type: 'array',
      of: 'int',
    });
  });

  it('refuses a type with no honest logical answer', () => {
    // `bytea` is a Buffer and `interval` is an object. Falling back to text
    // would compile and then read the wrong value back at runtime.
    expect(mapColumnType(column('a', 'bytea'))).toBeNull();
    expect(mapColumnType(column('a', 'interval'))).toBeNull();
    expect(mapColumnType(column('a', 'point'))).toBeNull();
  });

  it('refuses an array whose element it could not map', () => {
    expect(mapColumnType(column('a', 'bytea', { isArray: true }))).toBeNull();
  });
});
