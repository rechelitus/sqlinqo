import { defineEntity, createDbContext, UnsupportedExpressionError } from '@sqlinqo/core';
import type { Driver, PreparedStatement, ResultRow } from '@sqlinqo/core';
import { describe, expect, it } from 'vitest';
import { mssqlDialect } from '../src/dialect.js';

class NullDriver implements Driver {
  readonly name = 'null';
  async execute(_statement: PreparedStatement): Promise<ResultRow[]> {
    return [];
  }
  async close(): Promise<void> {}
}

const Product = defineEntity({
  name: 'Product',
  table: 'products',
  columns: {
    id: { type: 'int', primaryKey: true },
    sku: { type: 'text' },
    title: { type: 'text' },
    price: { type: 'decimal' },
    releasedAt: { type: 'timestamp', column: 'released_at' },
  },
});

const db = createDbContext({
  driver: new NullDriver(),
  dialect: mssqlDialect,
  entities: { products: Product },
});

describe('MssqlDialect', () => {
  it('quotes identifiers with brackets and doubles an embedded bracket', () => {
    expect(mssqlDialect.quoteIdentifier('user]name')).toBe('[user]]name]');
  });

  it('numbers placeholders from @p0', () => {
    expect(mssqlDialect.parameterPlaceholder(0)).toBe('@p0');
    expect(mssqlDialect.parameterPlaceholder(4)).toBe('@p4');
  });

  it('uses LEN for a string length', () => {
    expect(db.products.where((p) => p.sku.length > 3).toSQL().text).toContain('LEN([t0].[sku])');
  });

  it('concatenates with the + operator', () => {
    const { text, values } = db.products
      .where((p, args) => p.title.endsWith(args.suffix), { suffix: 'pro' })
      .toSQL();

    expect(text).toContain(`LIKE '%' + @p0`);
    expect(values).toEqual(['pro']);
  });

  it('converts a JavaScript substring range into SUBSTRING position and length', () => {
    const { text, values } = db.products.select((p) => ({ prefix: p.sku.substring(0, 3) })).toSQL();

    expect(text).toContain('SUBSTRING([t0].[sku], @p0 + 1, @p1 - @p0)');
    expect(values).toEqual([0, 3]);
  });

  it('extracts a year from a timestamp column through DATEPART', () => {
    const { text } = db.products
      .where((p, args) => p.releasedAt.getFullYear() === args.year, { year: 2024 })
      .toSQL();

    expect(text).toContain('DATEPART(year, [t0].[released_at]) = @p0');
  });

  it('extracts a zero-based month, matching what a JavaScript Date reports', () => {
    const { text } = db.products.select((p) => ({ m: p.releasedAt.getMonth() })).toSQL();

    // No cast and so no wrapping parentheses either, unlike PostgreSQL's own
    // test for the same translation: node-postgres needs no int cast to
    // protect a numeric-as-string the way EXTRACT's result does there, so
    // there is no `::int` outside the subtraction to force one.
    expect(text).toContain('DATEPART(month, [t0].[released_at]) - 1 AS [m]');
  });

  it('aliases getUTCFullYear onto the same DATEPART as getFullYear', () => {
    const plain = db.products.select((p) => ({ y: p.releasedAt.getFullYear() })).toSQL().text;
    const utc = db.products.select((p) => ({ y: p.releasedAt.getUTCFullYear() })).toSQL().text;

    // A datetime2 column never carries a zone, so there is nothing for
    // getUTCFullYear to convert that getFullYear has not already answered.
    expect(utc).toBe(plain);
    expect(utc).toContain('DATEPART(year, [t0].[released_at])');
  });

  it('computes the day of the week independently of @@DATEFIRST', () => {
    const { text } = db.products.select((p) => ({ d: p.releasedAt.getDay() })).toSQL();

    expect(text).toContain('(DATEPART(weekday, [t0].[released_at]) + @@DATEFIRST - 1) % 7');
  });

  it('reads milliseconds since the epoch through DATEDIFF_BIG', () => {
    const { text } = db.products.select((p) => ({ t: p.releasedAt.getTime() })).toSQL();

    expect(text).toContain(`DATEDIFF_BIG(millisecond, '1970-01-01', [t0].[released_at])`);
  });

  it('renders toISOString as ISO 8601 text with an asserted Z', () => {
    const { text } = db.products.select((p) => ({ iso: p.releasedAt.toISOString() })).toSQL();

    expect(text).toContain(`CONVERT(varchar(23), [t0].[released_at], 126) + 'Z'`);
  });

  it('pads through REPLICATE, measuring the string with its own LEN spelling', () => {
    const { text, values } = db.products.select((p) => ({ code: p.sku.padStart(8, '0') })).toSQL();

    // The pad string is REPLICATE's own first argument, so it is printed (and
    // its placeholder allocated) before the width it shares with GREATEST,
    // even though `padStart(8, '0')` names the width first.
    expect(text).toContain('RIGHT(REPLICATE(@p0, GREATEST(@p1, LEN([t0].[sku]))) + [t0].[sku]');
    expect(values).toEqual(['0', 8]);
  });

  it('pages with OFFSET and FETCH NEXT', () => {
    const { text } = db.products
      .orderBy((p) => p.id)
      .skip(10)
      .take(5)
      .toSQL();

    expect(text).toContain('OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY');
  });

  it('reads a last position through CHARINDEX and REVERSE', () => {
    const { text } = db.products.select((p) => ({ i: p.title.lastIndexOf('a') })).toSQL();

    expect(text).toContain('CHARINDEX(REVERSE(@p0), REVERSE([t0].[title]))');
    expect(text).not.toContain('POSITION');
  });

  it('reads the character at an index', () => {
    const { text, values } = db.products.select((p) => ({ c: p.title.charAt(0) })).toSQL();

    expect(text).toContain('SUBSTRING([t0].[title], @p0 + 1, 1)');
    expect(values).toEqual([0]);
  });

  it('slices from the end for a negative start', () => {
    const { text, values } = db.products.select((p) => ({ s: p.title.slice(-3) })).toSQL();

    expect(text).toContain('CASE WHEN @p0 < 0 THEN GREATEST(LEN([t0].[title]) + @p0, 0)');
    expect(text).toContain('ELSE LEAST(@p0, LEN([t0].[title])) END + 1');
    expect(values).toEqual([-3]);
  });

  it('rounds a number to a fixed number of digits through FORMAT', () => {
    const { text, values } = db.products.select((p) => ({ f: p.id.toFixed(2) })).toSQL();

    expect(text).toContain(`FORMAT([t0].[id], 'F' + CAST(@p0 AS nvarchar(10)), 'en-US')`);
    expect(values).toEqual([2]);
  });

  it('reads a code point through UNICODE', () => {
    const { text } = db.products.select((p) => ({ c: p.title.codePointAt(0) })).toSQL();

    expect(text).toContain('UNICODE(SUBSTRING([t0].[title], @p0 + 1, 1))');
  });

  it('repeats a string through REPLICATE', () => {
    const { text } = db.products.select((p) => ({ r: p.sku.repeat(3) })).toSQL();

    expect(text).toContain('REPLICATE([t0].[sku], @p0)');
  });

  it('seeds RAND with a fresh NEWID so it varies per row', () => {
    const { text } = db.products.select((p) => ({ r: Math.random() + p.id })).toSQL();

    expect(text).toContain('RAND(CHECKSUM(NEWID()))');
  });

  it('builds Math.cbrt from SIGN and POWER of the magnitude', () => {
    const { text } = db.products.select((p) => ({ c: Math.cbrt(p.id) })).toSQL();

    expect(text).toContain('SIGN([t0].[id]) * POWER(ABS([t0].[id]), 0.3333333333333333)');
  });

  it('spells Math.log2 with the value first and the base second', () => {
    const { text } = db.products.select((p) => ({ l: Math.log2(p.id) })).toSQL();

    expect(text).toContain('LOG([t0].[id], 2)');
  });

  it('spells Math.atan2 as ATN2', () => {
    const { text } = db.products
      .select((p) => ({ a: Math.atan2(p.id, p.price as unknown as number) }))
      .toSQL();

    expect(text).toContain('ATN2([t0].[id]');
  });

  it('rejects Math.sinh, which T-SQL has no stable spelling for', () => {
    const query = () => db.products.select((p) => ({ s: Math.sinh(p.id) })).toSQL();

    expect(query).toThrow(/no numerically stable T-SQL spelling/);
  });

  it('truncates through the ROUND truncating overload', () => {
    const { text } = db.products.select((p) => ({ t: Math.trunc(p.id) })).toSQL();

    expect(text).toContain('ROUND([t0].[id], 0, 1)');
  });

  it('refuses to read rows back, since OUTPUT sits in a different place per statement', async () => {
    // insert/insertMany are async, so the refusal surfaces as a rejection
    // rather than a synchronous throw, even though it is raised while
    // printing the statement and before anything reaches the driver.
    await expect(
      db.products.insert({ id: 1, sku: 'a', title: 'A', price: '1', releasedAt: new Date() }),
    ).rejects.toThrow(UnsupportedExpressionError);
    await expect(
      db.products.insert({ id: 1, sku: 'a', title: 'A', price: '1', releasedAt: new Date() }),
    ).rejects.toThrow(/RETURNING/);
  });

  it('refuses upsert, which has no single-statement T-SQL spelling', async () => {
    await expect(
      db.products.upsert({ id: 1, sku: 'a', title: 'A', price: '1', releasedAt: new Date() }),
    ).rejects.toThrow(/single-statement upsert/);
  });
});
