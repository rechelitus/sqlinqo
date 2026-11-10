import { defineEntity, createDbContext } from '@sqlinqo/core';
import type { Driver, PreparedStatement, ResultRow } from '@sqlinqo/core';
import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../src/dialect.js';

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

const Post = defineEntity({
  name: 'Post',
  table: 'posts',
  columns: {
    id: { type: 'int', primaryKey: true },
    tags: { type: 'array', of: 'text' },
    grid: { type: 'array', of: { type: 'array', of: 'text' } },
  },
});

const db = createDbContext({
  driver: new NullDriver(),
  dialect: postgresDialect,
  entities: { products: Product, posts: Post },
});

describe('PostgresDialect', () => {
  it('quotes identifiers and doubles embedded quotes', () => {
    expect(postgresDialect.quoteIdentifier('user"name')).toBe('"user""name"');
  });

  it('numbers placeholders from $1', () => {
    expect(postgresDialect.parameterPlaceholder(0)).toBe('$1');
    expect(postgresDialect.parameterPlaceholder(4)).toBe('$5');
  });

  it('uses LENGTH for a string length', () => {
    expect(db.products.where((p) => p.sku.length > 3).toSQL().text).toContain('LENGTH("t0"."sku")');
  });

  it('concatenates with the || operator', () => {
    const { text, values } = db.products
      .where((p, args) => p.title.endsWith(args.suffix), { suffix: 'pro' })
      .toSQL();

    expect(text).toContain(`LIKE '%' || $1`);
    expect(values).toEqual(['pro']);
  });

  it('converts a JavaScript substring range into SUBSTRING position and length', () => {
    const { text, values } = db.products.select((p) => ({ prefix: p.sku.substring(0, 3) })).toSQL();

    // The start bound is mentioned twice but bound once, so both mentions read
    // `$1` and the statement carries two values rather than three.
    expect(text).toContain('SUBSTRING("t0"."sku", $1 :: int + 1, $2 :: int - $1 :: int)');
    expect(values).toEqual([0, 3]);
  });

  it('extracts a year from a timestamp column', () => {
    const { text } = db.products
      .where((p, args) => p.releasedAt.getFullYear() === args.year, {
        year: 2024,
      })
      .toSQL();

    // Cast to int so the value arrives as a number: node-postgres returns the
    // numeric EXTRACT yields as a string, and a year loses nothing by casting.
    expect(text).toContain('EXTRACT(YEAR FROM "t0"."released_at") :: int = $1');
  });

  it('extracts a zero-based month, matching what a JavaScript Date reports', () => {
    const { text } = db.products.select((p) => ({ m: p.releasedAt.getMonth() })).toSQL();

    expect(text).toContain('(EXTRACT(MONTH FROM "t0"."released_at") - 1) :: int AS "m"');
  });

  it('pads through LPAD, measuring the string with its own LENGTH spelling', () => {
    const { text, values } = db.products.select((p) => ({ code: p.sku.padStart(8, '0') })).toSQL();

    expect(text).toContain('LPAD("t0"."sku", GREATEST($1, LENGTH("t0"."sku")), $2)');
    expect(values).toEqual([8, '0']);
  });

  it('pages with LIMIT and OFFSET', () => {
    const { text } = db.products
      .orderBy((p) => p.id)
      .skip(10)
      .take(5)
      .toSQL();

    expect(text).toContain('LIMIT 5 OFFSET 10');
  });

  it('reads a last position through the dialect own spelling of length', () => {
    const { text } = db.products.select((p) => ({ i: p.title.lastIndexOf('a') })).toSQL();

    // `LENGTH` rather than `CHAR_LENGTH`, because the translation asks the
    // dialect for the length rather than hard-coding the ANSI name.
    expect(text).toContain('LENGTH("t0"."title") - LENGTH($1) + 1');
    expect(text).not.toContain('CHAR_LENGTH');
  });

  it('reads the character at an index', () => {
    const { text, values } = db.products.select((p) => ({ c: p.title.charAt(0) })).toSQL();

    // A single character is a length of one, so this is `slice` without any of
    // the bound normalising: only the shift from zero-based to one-based.
    expect(text).toContain('SUBSTRING("t0"."title", $1 :: int + 1, 1)');
    expect(values).toEqual([0]);
  });

  it('reads the first character when called bare', () => {
    const { text } = db.products
      .select((p) => ({ c: (p.title as unknown as { charAt(): string }).charAt() }))
      .toSQL();

    expect(text).toContain('SUBSTRING("t0"."title", 0 :: int + 1, 1)');
  });

  it('rejects a second argument', () => {
    const query = () =>
      db.products
        .select((p) => ({
          c: (p.title as unknown as { charAt(i: number, n: number): string }).charAt(0, 1),
        }))
        .toSQL();

    expect(query).toThrow(/"charAt" expects at most one argument/);
  });

  it('folds an array column into one string', () => {
    const { text, values } = db.posts.select((p) => ({ all: p.tags.join(', ') })).toSQL();

    // The third argument is not decoration. Without it `array_to_string` drops a
    // null element where JavaScript writes an empty string in its place.
    expect(text).toContain(`array_to_string("t0"."tags", $1, '')`);
    expect(values).toEqual([', ']);
  });

  it('separates with a comma when called bare', () => {
    const { text } = db.posts
      .select((p) => ({ all: (p.tags as unknown as { join(): string }).join() }))
      .toSQL();

    expect(text).toContain(`array_to_string("t0"."tags", ',', '')`);
  });

  it('rejects a second argument to join', () => {
    const query = () =>
      db.posts
        .select((p) => ({
          all: (p.tags as unknown as { join(a: string, b: string): string }).join(',', '!'),
        }))
        .toSQL();

    expect(query).toThrow(/"join" expects at most one argument/);
  });

  it('slices from the end for a negative start', () => {
    const { text, values } = db.products.select((p) => ({ s: p.title.slice(-3) })).toSQL();

    // The sign is unknowable while compiling, since a literal bound reaches the
    // dialect as a parameter, so the CASE is emitted for every bound.
    expect(text).toContain(
      'CASE WHEN $1 :: int < 0 THEN GREATEST(LENGTH("t0"."title") + $1 :: int, 0)',
    );
    expect(text).toContain('ELSE LEAST($1 :: int, LENGTH("t0"."title")) END + 1');
    expect(values).toEqual([-3]);
  });

  it('runs an omitted end to the end of the string', () => {
    const { text } = db.products.select((p) => ({ s: p.title.slice(-3) })).toSQL();

    // Nothing to normalise, so the length stands in for the bound directly.
    expect(text).toContain('GREATEST(LENGTH("t0"."title") - CASE WHEN $1 :: int < 0');
  });

  it('normalises both bounds when an end is given', () => {
    const { text, values } = db.products.select((p) => ({ s: p.title.slice(1, 3) })).toSQL();

    // Three, not two: the start is normalised once for the start and again for
    // the length, since `e - s` needs it too and SQL has nowhere to put a name
    // for it without a LATERAL or a CTE. The end appears once.
    expect(text.match(/CASE WHEN/g)).toHaveLength(3);
    expect(values).toEqual([1, 3]);
  });

  it('floors the length so a backwards range is empty rather than an error', () => {
    const { text } = db.products.select((p) => ({ s: p.title.slice(4, 2) })).toSQL();

    expect(text).toContain(', 0)) AS "s"');
  });

  it('rejects a slice given no bounds at all', () => {
    const query = () =>
      db.products
        .select((p) => ({ s: (p.title as unknown as { slice(): string }).slice() }))
        .toSQL();

    expect(query).toThrow(/"slice" expects a start and an optional end/);
  });

  it('repeats a string', () => {
    const { text, values } = db.products.select((p) => ({ r: p.title.repeat(3) })).toSQL();

    // The count is cast to int for the reason `substring`'s bounds are: an
    // untyped bound leaves PostgreSQL unable to choose an overload.
    expect(text).toContain('REPEAT("t0"."title", $1 :: int) AS "r"');
    expect(values).toEqual([3]);
  });

  it('repeats by a bound parameter', () => {
    const { text, values } = db.products
      .select((p, args) => ({ r: p.title.repeat(args.times) }), { times: 2 })
      .toSQL();

    expect(text).toContain('REPEAT("t0"."title", $1 :: int)');
    expect(values).toEqual([2]);
  });

  it('rejects a repeat given no count', () => {
    const query = () =>
      db.products
        .select((p) => ({ r: (p.title as unknown as { repeat(): string }).repeat() }))
        .toSQL();

    expect(query).toThrow(/"repeat" expects 1 argument\(s\)/);
  });

  it('formats a date as ISO 8601 text', () => {
    const { text } = db.products.select((p) => ({ s: p.releasedAt.toISOString() })).toSQL();

    // JavaScript's format exactly: four-digit year, T, a 24-hour clock, three
    // digits of milliseconds, and a literal Z.
    expect(text).toContain(`to_char("t0"."released_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  });

  it('quotes the T and Z so they are text rather than fields', () => {
    const { text } = db.products.select((p) => ({ s: p.releasedAt.toISOString() })).toSQL();

    // Unquoted, `T` and `Z` would be read as parts of the format model.
    expect(text).toContain('"T"');
    expect(text).toContain('"Z"');
  });

  it('rejects a format given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          s: (p.releasedAt as unknown as { toISOString(n: number): string }).toISOString(1),
        }))
        .toSQL();

    expect(query).toThrow(/"toISOString" expects 0 argument\(s\)/);
  });

  it('reads milliseconds since the epoch, floored to a whole one', () => {
    const { text } = db.products.select((p) => ({ t: p.releasedAt.getTime() })).toSQL();

    // EXTRACT(EPOCH ...) answers seconds carrying a fraction, so milliseconds
    // are a multiplication and the part below one is floored away, as
    // `getSeconds` floors its own.
    expect(text).toContain(
      'FLOOR(EXTRACT(EPOCH FROM "t0"."released_at") * 1000) :: double precision AS "t"',
    );
  });

  it('casts an epoch to double, not to the int the date parts take', () => {
    const { text } = db.products.select((p) => ({ t: p.releasedAt.getTime() })).toSQL();

    // Milliseconds since the epoch passed two billion in 1970, so an int would
    // overflow. A double carries every integer up to two to the fifty-third.
    expect(text).toContain(':: double precision');
    expect(text).not.toContain(':: int');
  });

  it('filters on an epoch', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getTime() > 0).toSQL();

    expect(text).toContain(
      'WHERE FLOOR(EXTRACT(EPOCH FROM "t0"."released_at") * 1000) :: double precision > $1',
    );
    expect(values).toEqual([0]);
  });

  it('rejects an epoch given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          t: (p.releasedAt as unknown as { getTime(n: number): number }).getTime(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getTime" expects 0 argument\(s\)/);
  });

  it('casts an extracted day of the month to int, as it does the other date parts', () => {
    const { text } = db.products.select((p) => ({ day: p.releasedAt.getDate() })).toSQL();

    // DAY is a whole number in PostgreSQL, so the int cast only undoes the
    // numeric node-postgres would otherwise hand back as a string.
    expect(text).toContain('EXTRACT(DAY FROM "t0"."released_at") :: int AS "day"');
  });

  it('keeps the day of the month and the day of the week apart', () => {
    const dayOfMonth = db.products.select((p) => ({ d: p.releasedAt.getDate() })).toSQL().text;
    const dayOfWeek = db.products.select((p) => ({ d: p.releasedAt.getDay() })).toSQL().text;

    // Two methods one letter apart that mean different things. `getDate` is the
    // ANSI DAY field and `getDay` is PostgreSQL's DOW.
    expect(dayOfMonth).toContain('EXTRACT(DAY FROM');
    expect(dayOfWeek).toContain('EXTRACT(DOW FROM');
    expect(dayOfMonth).not.toBe(dayOfWeek);
  });

  it('extracts a day of the week, which PostgreSQL numbers as JavaScript does', () => {
    const { text } = db.products.select((p) => ({ day: p.releasedAt.getDay() })).toSQL();

    // DOW runs Sunday zero through Saturday six, matching `Date.getDay`, so
    // nothing is added or subtracted. ISODOW would call Sunday seven.
    expect(text).toContain('EXTRACT(DOW FROM "t0"."released_at") :: int AS "day"');
  });

  it('filters on a day of the week', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getDay() === 0).toSQL();

    expect(text).toContain('WHERE EXTRACT(DOW FROM "t0"."released_at") :: int = $1');
    expect(values).toEqual([0]);
  });

  it('rejects a day of the week given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          day: (p.releasedAt as unknown as { getDay(n: number): number }).getDay(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getDay" expects 0 argument\(s\)/);
  });

  it('reads a UTC year through AT TIME ZONE rather than the session zone', () => {
    const { text } = db.products.select((p) => ({ year: p.releasedAt.getUTCFullYear() })).toSQL();

    // PostgreSQL renders a `timestamptz` in the session's own zone whenever
    // anything looks at it, so a bare extraction answers 2024 or 2025 for one
    // and the same row depending on who is connected. Converting to UTC first
    // leaves the extraction no zone to vary with.
    expect(text).toContain(
      `EXTRACT(YEAR FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int AS "year"`,
    );
  });

  it('keeps the UTC year and the session-zone year apart', () => {
    const utc = db.products.select((p) => ({ y: p.releasedAt.getUTCFullYear() })).toSQL().text;
    const local = db.products.select((p) => ({ y: p.releasedAt.getFullYear() })).toSQL().text;

    // The same field through the same function, differing only in what it is
    // read relative to. A translation that compiled to the plain extraction
    // would be a method that says something and does nothing.
    expect(local).toContain('EXTRACT(YEAR FROM "t0"."released_at") :: int');
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('casts a UTC year to int, as it does the other date parts', () => {
    const { text, values } = db.products
      .where((p) => p.releasedAt.getUTCFullYear() === 2024)
      .toSQL();

    // The zone is a literal and not a placeholder, since `AT TIME ZONE` takes a
    // zone rather than a value, so the year is still the only bound value here.
    expect(text).toContain(
      `WHERE EXTRACT(YEAR FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int = $1`,
    );
    expect(values).toEqual([2024]);
  });

  it('rejects a UTC year given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          year: (p.releasedAt as unknown as { getUTCFullYear(n: number): number }).getUTCFullYear(
            1,
          ),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCFullYear" expects 0 argument\(s\)/);
  });

  it('reads a UTC month, adjusted to count from zero as JavaScript does', () => {
    const { text } = db.products.select((p) => ({ month: p.releasedAt.getUTCMonth() })).toSQL();

    // Two adjustments that answer different questions: the conversion decides
    // which month the instant falls in, the subtraction what that month is
    // called. `getUTCFullYear` takes only the first and `getMonth` only the
    // second, and this one needs both.
    expect(text).toContain(
      `(EXTRACT(MONTH FROM "t0"."released_at" AT TIME ZONE 'UTC') - 1) :: int AS "month"`,
    );
  });

  it('finds January by zero, as a bare extraction would not', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getUTCMonth() === 0).toSQL();

    // Without the subtraction this comparison would match nothing at all,
    // since PostgreSQL numbers months from one.
    expect(text).toContain(
      `WHERE (EXTRACT(MONTH FROM "t0"."released_at" AT TIME ZONE 'UTC') - 1) :: int = $1`,
    );
    expect(values).toEqual([0]);
  });

  it('keeps the UTC month and the session-zone month apart', () => {
    const utc = db.products.select((p) => ({ m: p.releasedAt.getUTCMonth() })).toSQL().text;
    const local = db.products.select((p) => ({ m: p.releasedAt.getMonth() })).toSQL().text;

    // Both subtract one; only one pins the zone.
    expect(local).toContain(`(EXTRACT(MONTH FROM "t0"."released_at") - 1) :: int`);
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('rejects a UTC month given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          month: (p.releasedAt as unknown as { getUTCMonth(n: number): number }).getUTCMonth(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCMonth" expects 0 argument\(s\)/);
  });

  it('reads a UTC day of the month, with nothing to adjust after the conversion', () => {
    const { text } = db.products.select((p) => ({ day: p.releasedAt.getUTCDate() })).toSQL();

    // The conversion alone. Both DAY and `getUTCDate` number the month from
    // one, so this takes the half `getUTCFullYear` takes and not the
    // subtraction `getUTCMonth` needs on top of it.
    expect(text).toContain(
      `EXTRACT(DAY FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int AS "day"`,
    );
    expect(text).not.toContain('- 1');
  });

  it('keeps the UTC day and the session-zone day apart', () => {
    const utc = db.products.select((p) => ({ d: p.releasedAt.getUTCDate() })).toSQL().text;
    const local = db.products.select((p) => ({ d: p.releasedAt.getDate() })).toSQL().text;

    // The same field through the same function, differing only in what it is
    // read relative to, which is the whole of what the method adds. This is
    // also the field the difference reaches most often: an offset moves the
    // day boundary once a day where it moves the year boundary once a year.
    expect(local).toContain('EXTRACT(DAY FROM "t0"."released_at") :: int');
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('keeps the UTC day and the UTC day of the week apart', () => {
    const date = db.products.select((p) => ({ d: p.releasedAt.getUTCDate() })).toSQL().text;
    const day = db.products.select((p) => ({ d: p.releasedAt.getDay() })).toSQL().text;

    // One letter apart in JavaScript and two different EXTRACT fields here, so
    // this is `getDate` and `getDay`'s own test arriving a second time.
    expect(date).toContain('EXTRACT(DAY FROM');
    expect(day).toContain('EXTRACT(DOW FROM');
    expect(date).not.toBe(day);
  });

  it('finds the first of the month by one, as a zero-based reading would not', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getUTCDate() === 1).toSQL();

    expect(text).toContain(
      `WHERE EXTRACT(DAY FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int = $1`,
    );
    expect(values).toEqual([1]);
  });

  it('rejects a UTC day given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          day: (p.releasedAt as unknown as { getUTCDate(n: number): number }).getUTCDate(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCDate" expects 0 argument\(s\)/);
  });

  it('reads a UTC hour of the day, with nothing to adjust after the conversion', () => {
    const { text } = db.products.select((p) => ({ hour: p.releasedAt.getUTCHours() })).toSQL();

    // The conversion alone, for `getHours`' reason rather than `getUTCMonth`'s:
    // HOUR and `getUTCHours` both count 0 through 23, so this takes the half
    // `getUTCFullYear` and `getUTCDate` take and no subtraction on top of it.
    expect(text).toContain(
      `EXTRACT(HOUR FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int AS "hour"`,
    );
    expect(text).not.toContain('- 1');
  });

  it('keeps the UTC hour and the session-zone hour apart', () => {
    const utc = db.products.select((p) => ({ h: p.releasedAt.getUTCHours() })).toSQL().text;
    const local = db.products.select((p) => ({ h: p.releasedAt.getHours() })).toSQL().text;

    // The same field through the same function, differing only in what it is
    // read relative to. This is the field the difference reaches furthest: a
    // session offset moves the hour for every row in a table, where it moves
    // the day boundary for a few hours out of each day.
    expect(local).toContain('EXTRACT(HOUR FROM "t0"."released_at") :: int');
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('finds midnight by zero, as the hour is counted from zero on both sides', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getUTCHours() === 0).toSQL();

    expect(text).toContain(
      `WHERE EXTRACT(HOUR FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int = $1`,
    );
    expect(values).toEqual([0]);
  });

  it('rejects a UTC hour given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          hour: (p.releasedAt as unknown as { getUTCHours(n: number): number }).getUTCHours(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCHours" expects 0 argument\(s\)/);
  });
  it('reads a UTC minute of the hour, with nothing to adjust after the conversion', () => {
    const { text } = db.products.select((p) => ({ minute: p.releasedAt.getUTCMinutes() })).toSQL();

    // MINUTE is standard and both sides count 0 through 59, so this takes the
    // conversion and no subtraction, which is `getUTCHours`' shape rather than
    // `getUTCMonth`'s.
    expect(text).toContain(
      `EXTRACT(MINUTE FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int AS "minute"`,
    );
    expect(text).not.toContain('- 1');
  });

  it('keeps the UTC minute and the session-zone minute apart', () => {
    const utc = db.products.select((p) => ({ m: p.releasedAt.getUTCMinutes() })).toSQL().text;
    const local = db.products.select((p) => ({ m: p.releasedAt.getMinutes() })).toSQL().text;

    // The field where the two statements are most tempting to collapse into
    // one, since a whole-hour offset moves no minute at all. Kolkata is half an
    // hour off UTC and Kathmandu three quarters, so the conversion is what an
    // entire time zone depends on rather than an edge case.
    expect(local).toContain('EXTRACT(MINUTE FROM "t0"."released_at") :: int');
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('finds the top of the hour by zero, as the minute is counted from zero on both sides', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getUTCMinutes() === 0).toSQL();

    expect(text).toContain(
      `WHERE EXTRACT(MINUTE FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int = $1`,
    );
    expect(values).toEqual([0]);
  });

  it('rejects a UTC minute given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          minute: (p.releasedAt as unknown as { getUTCMinutes(n: number): number }).getUTCMinutes(
            1,
          ),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCMinutes" expects 0 argument\(s\)/);
  });

  it('casts an extracted UTC minute to int, as it does the other date parts', () => {
    const { text } = db.products.select((p) => ({ minute: p.releasedAt.getUTCMinutes() })).toSQL();

    // The conversion does not take the field out of the set that casts: EXTRACT
    // still yields numeric and node-postgres still returns numeric as a string.
    expect(text).toContain("AT TIME ZONE 'UTC') :: int");
  });
  it('floors a UTC second inside the conversion, as getSeconds floors without one', () => {
    const { text } = db.products.select((p) => ({ second: p.releasedAt.getUTCSeconds() })).toSQL();

    // Both halves, and the first member of the family whose second adjustment
    // is not a subtraction. SECOND is the one EXTRACT field allowed a fraction
    // and PostgreSQL takes it either side of the conversion, so the FLOOR is
    // needed here for `getSeconds`' own reason rather than by inheritance.
    expect(text).toContain(
      'FLOOR(EXTRACT(SECOND FROM "t0"."released_at" AT TIME ZONE \'UTC\')) :: int AS "second"',
    );
  });

  it('keeps the FLOOR inside the cast, since the cast alone would round to sixty', () => {
    const { text } = db.products.select((p) => ({ second: p.releasedAt.getUTCSeconds() })).toSQL();

    // Measured rather than assumed: a bare cast of 59.75 answers 60, a second
    // no clock shows. The FLOOR has to run first and the printed order is what
    // says it does.
    expect(text).toMatch(/FLOOR\(EXTRACT\(SECOND FROM .* AT TIME ZONE 'UTC'\)\) :: int/);
  });

  it('keeps the UTC second and the session-zone second apart', () => {
    const utc = db.products.select((p) => ({ s: p.releasedAt.getUTCSeconds() })).toSQL().text;
    const local = db.products.select((p) => ({ s: p.releasedAt.getSeconds() })).toSQL().text;

    // Two statements that agree for every zone in use today and part company
    // over an instant old enough to predate standard time, which is the whole
    // of what the conversion still buys at this field.
    expect(local).toContain('FLOOR(EXTRACT(SECOND FROM "t0"."released_at")) :: int');
    expect(local).not.toContain('AT TIME ZONE');
    expect(utc).not.toBe(local);
  });

  it('rejects a UTC second given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          second: (p.releasedAt as unknown as { getUTCSeconds(n: number): number }).getUTCSeconds(
            1,
          ),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCSeconds" expects 0 argument\(s\)/);
  });
  it('reads a UTC day of the week through DOW, with nothing to adjust', () => {
    const { text } = db.products.select((p) => ({ day: p.releasedAt.getUTCDay() })).toSQL();

    // The conversion alone. DOW numbers Sunday zero through Saturday six either
    // side of a conversion, which is what JavaScript numbers them, so this is
    // `getDay`'s numbering with `getUTCHours`' pinning and no arithmetic.
    expect(text).toContain(
      `EXTRACT(DOW FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int AS "day"`,
    );
    expect(text).not.toContain('- 1');
    expect(text).not.toContain('ISODOW');
  });

  it('keeps the UTC weekday apart from the day of the month and the session weekday', () => {
    const utcDay = db.products.select((p) => ({ d: p.releasedAt.getUTCDay() })).toSQL().text;
    const utcDate = db.products.select((p) => ({ d: p.releasedAt.getUTCDate() })).toSQL().text;
    const localDay = db.products.select((p) => ({ d: p.releasedAt.getDay() })).toSQL().text;

    // Three statements that a one-letter slip would collapse into each other.
    // `getUTCDay` against `getUTCDate` is `getDay` against `getDate` all over
    // again, and `getUTCDay` against `getDay` is the conversion.
    expect(utcDay).toContain('EXTRACT(DOW FROM');
    expect(utcDate).toContain('EXTRACT(DAY FROM');
    expect(localDay).not.toContain('AT TIME ZONE');
    expect(utcDay).not.toBe(utcDate);
    expect(utcDay).not.toBe(localDay);
  });

  it('finds Sunday by zero, as both sides number the week from Sunday', () => {
    const { text, values } = db.products.where((p) => p.releasedAt.getUTCDay() === 0).toSQL();

    expect(text).toContain(
      `WHERE EXTRACT(DOW FROM "t0"."released_at" AT TIME ZONE 'UTC') :: int = $1`,
    );
    expect(values).toEqual([0]);
  });

  it('rejects a UTC weekday given arguments', () => {
    const query = () =>
      db.products
        .select((p) => ({
          day: (p.releasedAt as unknown as { getUTCDay(n: number): number }).getUTCDay(1),
        }))
        .toSQL();

    expect(query).toThrow(/"getUTCDay" expects 0 argument\(s\)/);
  });

  it('casts an extracted hour to int, as it does the other date parts', () => {
    const { text } = db.products.select((p) => ({ hour: p.releasedAt.getHours() })).toSQL();

    // EXTRACT yields numeric, which node-postgres returns as a string. An hour
    // cannot lose anything on the way to an int.
    expect(text).toContain('EXTRACT(HOUR FROM "t0"."released_at") :: int AS "hour"');
  });

  it('casts an extracted minute to int, as it does the other date parts', () => {
    const { text } = db.products.select((p) => ({ minute: p.releasedAt.getMinutes() })).toSQL();

    // MINUTE is a whole number in PostgreSQL, unlike SECOND, so the int cast
    // loses nothing here either.
    expect(text).toContain('EXTRACT(MINUTE FROM "t0"."released_at") :: int AS "minute"');
  });

  it('casts an extracted second to int, with the base dialect FLOOR inside it', () => {
    const { text } = db.products.select((p) => ({ second: p.releasedAt.getSeconds() })).toSQL();

    // A cast to int rounds, so 59.75 seconds would come back as 60 with the
    // cast alone. The FLOOR runs first and leaves the cast nothing to lose.
    expect(text).toContain('FLOOR(EXTRACT(SECOND FROM "t0"."released_at")) :: int AS "second"');
  });

  it('splits a string into an array on a separator', () => {
    const { text, values } = db.products.select((p) => ({ parts: p.title.split(',') })).toSQL();

    expect(text).toContain('string_to_array("t0"."title", $1) AS "parts"');
    expect(values).toEqual([',']);
  });

  it('splits on a separator from the parameter bag', () => {
    const { text, values } = db.products
      .select((p, args) => ({ parts: p.title.split(args.on) }), { on: '~~' })
      .toSQL();

    expect(text).toContain('string_to_array("t0"."title", $1)');
    expect(values).toEqual(['~~']);
  });

  it('rejects a limit on how many pieces to return', () => {
    const query = () =>
      db.products
        .select((p) => ({
          parts: (p.title as unknown as { split(s: string, n: number): string[] }).split(',', 2),
        }))
        .toSQL();

    expect(query).toThrow(/"split" expects one separator/);
  });

  it('finds the position of an element in an array column', () => {
    const { text, values } = db.posts.select((p) => ({ i: p.tags.indexOf('x') })).toSQL();

    // `array_position` counts from one and answers null for an absent element,
    // where the string reading of `indexOf` gets both edges from one subtraction.
    expect(text).toContain(
      'CASE WHEN "t0"."tags" IS NOT NULL THEN COALESCE(array_position("t0"."tags", $1) - 1, -1) END',
    );
    expect(values).toEqual(['x']);
  });

  it('leaves a null array null rather than calling the element absent', () => {
    const { text } = db.posts.select((p) => ({ i: p.tags.indexOf('x') })).toSQL();

    // `array_position` answers null for an element that is not there and for an
    // array that is not there, so the CASE asks about the array and lets the
    // COALESCE speak for the element.
    expect(text).toContain('CASE WHEN "t0"."tags" IS NOT NULL');
    expect(text).not.toContain('ELSE');
  });

  it('still searches a text column for a substring', () => {
    const { text } = db.products.select((p) => ({ i: p.title.indexOf('x') })).toSQL();

    expect(text).toContain('POSITION($1 IN "t0"."title") - 1');
    expect(text).not.toContain('array_position');
  });

  it('rejects an index to start searching from', () => {
    const query = () =>
      db.posts
        .select((p) => ({
          i: (p.tags as unknown as { indexOf(v: string, n: number): number }).indexOf('x', 1),
        }))
        .toSQL();

    expect(query).toThrow(/since array_position searches the whole array/);
  });

  it('tests an array column for a value with ANY', () => {
    const { text, values } = db.posts.where((p) => p.tags.includes('x')).toSQL();

    // `= ANY(...)` over an array is PostgreSQL's; the standard knows `ANY` only
    // over a subquery.
    expect(text).toContain('WHERE $1 = ANY("t0"."tags")');
    expect(values).toEqual(['x']);
  });

  it('joins an array column to a bound list with array_cat', () => {
    const { text, values } = db.posts
      .select((p, a) => ({ all: p.tags.concat(a.more) }), { more: ['x', 'y'] })
      .toSQL();

    // `array_cat` rather than the `||` this job is usually written with, and
    // not for style. PostgreSQL resolves `||` over an array by the argument's
    // own type, choosing between `anyarray || anyarray` and `anyarray ||
    // anyelement`; a bound parameter arrives untyped and matches both, so the
    // statement would be refused as ambiguous. `array_cat` takes two arrays and
    // nothing else, so the parameter is coerced to the receiver's array type.
    expect(text).toContain('array_cat("t0"."tags", $1)');
    expect(values).toEqual([['x', 'y']]);
  });

  it('folds a variadic join, which array_cat takes two at a time', () => {
    const { text } = db.posts
      .select((p, a) => ({ all: p.tags.concat(a.one, a.two) }), { one: ['a'], two: ['b'] })
      .toSQL();

    expect(text).toContain('array_cat(array_cat("t0"."tags", $1), $2)');
  });

  it('answers the receiver untouched when given nothing to join', () => {
    const { text } = db.posts.select((p) => ({ all: p.tags.concat() })).toSQL();

    // What `[].concat()` answers, and it falls out of the fold rather than
    // needing a case of its own.
    expect(text).toContain('"t0"."tags" AS "all"');
    expect(text).not.toContain('array_cat');
  });

  it('still joins two strings with the concatenation operator', () => {
    const { text } = db.products.select((p) => ({ t: p.title.concat('!') })).toSQL();

    // The same method name, told apart by the column's declared type, which is
    // `includes` and `indexOf`'s fork arriving a third time.
    expect(text).toContain('"t0"."title" || $1');
    expect(text).not.toContain('array_cat');
  });

  it('still searches a text column for a substring', () => {
    const { text } = db.products.where((p) => p.title.includes('x')).toSQL();

    // The same method name, told apart by the column's declared type rather
    // than guessed at from the expression.
    expect(text).toContain("LIKE '%' || $1 || '%'");
    expect(text).not.toContain('ANY');
  });

  it('still expands a bound list into an IN', () => {
    const { text, values } = db.posts
      .where((p, args) => args.ids.includes(p.id), { ids: [1, 2] })
      .toSQL();

    // A list from the parameter bag is settled before the dialect is asked at
    // all, so the third reading of `includes` is untouched by the other two.
    expect(text).toContain('WHERE "t0"."id" IN ($1, $2)');
    expect(values).toEqual([1, 2]);
  });

  it('keeps the array reading through a projection', () => {
    const { text } = db.posts
      .select((p) => ({ tags: p.tags }))
      .where((r) => r.tags.includes('x'))
      .toSQL();

    // The type is read off the expression the projected column came from, so
    // the array reading survives the rename.
    expect(text).toContain('$1 = ANY("t0"."tags")');
    expect(text).not.toContain('LIKE');
  });

  it('counts the elements of an array column rather than its characters', () => {
    const { text } = db.posts.select((p) => ({ n: p.tags.length })).toSQL();

    // PostgreSQL has no `length` over an array at all, so this falls through to
    // the base dialect's ANSI `CARDINALITY` rather than to its own `LENGTH`.
    expect(text).toContain('CARDINALITY("t0"."tags")');
    expect(text).not.toContain('LENGTH("t0"."tags")');
  });

  it('subscripts an array, shifting from zero-based to one-based', () => {
    const { text, values } = db.posts.select((p) => ({ first: p.tags.at(0) })).toSQL();

    expect(text).toContain(
      '"t0"."tags"[CASE WHEN $1 :: int < 0 THEN array_length("t0"."tags", 1) + $1 :: int + 1 ' +
        'ELSE $1 :: int + 1 END] AS "first"',
    );
    expect(values).toEqual([0]);
  });

  it('counts a negative index back from the end, which PostgreSQL alone would not', () => {
    const { text, values } = db.posts.select((p) => ({ last: p.tags.at(-1) })).toSQL();

    // The literal is folded, so the index is a plain bound -1 rather than a
    // minus applied to an untyped placeholder.
    expect(text).toContain('"t0"."tags"[CASE WHEN $1 :: int < 0 THEN');
    expect(values).toEqual([-1]);
  });

  it('takes the index from the parameter bag', () => {
    const { text, values } = db.posts
      .select((p, args) => ({ nth: p.tags.at(args.n) }), { n: 2 })
      .toSQL();

    expect(text).toContain('"t0"."tags"[CASE WHEN $1 :: int < 0 THEN');
    expect(values).toEqual([2]);
  });

  it('rejects a subscript given no index', () => {
    const query = () =>
      db.posts.select((p) => ({ first: (p.tags as unknown as { at(): string }).at() })).toSQL();

    expect(query).toThrow(/"at" expects 1 argument\(s\)/);
  });

  it('reads a code point through ASCII, counting the index from zero', () => {
    const { text, values } = db.products.select((p) => ({ c: p.sku.codePointAt(0) })).toSQL();

    expect(text).toContain(`ASCII(NULLIF(SUBSTRING("t0"."sku", $1 :: int + 1, 1), '')) AS "c"`);
    expect(values).toEqual([0]);
  });

  it('reads outside the string as null rather than as zero', () => {
    // NULLIF is doing the work: ASCII of an empty string is 0 in PostgreSQL,
    // where `codePointAt` past the end is undefined.
    const { text } = db.products.select((p) => ({ c: p.sku.codePointAt(99) })).toSQL();

    expect(text).toContain(`NULLIF(SUBSTRING("t0"."sku", $1 :: int + 1, 1), '')`);
  });

  it('takes the index from the parameter bag', () => {
    const { text, values } = db.products
      .select((p, args) => ({ c: p.sku.codePointAt(args.n) }), { n: 2 })
      .toSQL();

    expect(text).toContain('SUBSTRING("t0"."sku", $1 :: int + 1, 1)');
    expect(values).toEqual([2]);
  });

  it('rejects a call with no index', () => {
    const query = () =>
      db.products
        .select((p) => ({ c: (p.sku as unknown as { codePointAt(): number }).codePointAt() }))
        .toSQL();

    expect(query).toThrow(/"codePointAt" expects 1 argument\(s\)/);
  });

  it('rounds to a number of digits and returns text', () => {
    const { text, values } = db.products.select((p) => ({ n: p.id.toFixed(2) })).toSQL();

    expect(text).toContain('ROUND("t0"."id" :: numeric, $1 :: int) :: text AS "n"');
    expect(values).toEqual([2]);
  });

  it('defaults to no digits when called bare', () => {
    const { text, values } = db.products.select((p) => ({ n: p.id.toFixed() })).toSQL();

    expect(text).toContain('ROUND("t0"."id" :: numeric, 0 :: int) :: text');
    expect(values).toEqual([]);
  });

  it('casts to numeric, which PostgreSQL has no two-argument ROUND without', () => {
    // `round(double precision, integer)` does not exist, so a float column
    // would fail outright on a bare ROUND.
    const { text } = db.products.select((p) => ({ n: p.id.toFixed(1) })).toSQL();

    expect(text).toContain('"t0"."id" :: numeric');
  });

  it('rejects more arguments than a digit count', () => {
    const query = () =>
      db.products
        .select((p) => ({
          n: (p.id as unknown as { toFixed(a: number, b: number): string }).toFixed(2, 3),
        }))
        .toSQL();

    expect(query).toThrow(/"toFixed" expects at most one argument/);
  });

  it('slices an array column, shifting from a half-open range to an inclusive one', () => {
    const { text, values } = db.posts.select((p) => ({ t: p.tags.slice(1, 3) })).toSQL();

    // JavaScript takes zero-based indices and excludes the end; PostgreSQL takes
    // one-based positions and includes it, so the start gains one and the end
    // gains nothing.
    expect(text).toContain(
      '"t0"."tags"[CASE WHEN $1 :: int < 0 THEN CARDINALITY("t0"."tags") + $1 :: int + 1 ' +
        'ELSE $1 :: int + 1 END:CASE WHEN $2 :: int < 0 THEN CARDINALITY("t0"."tags") + $2 :: int ' +
        'ELSE $2 :: int END]',
    );
    expect(values).toEqual([1, 3]);
  });

  it('runs an omitted end to the last element', () => {
    const { text } = db.posts.select((p) => ({ t: p.tags.slice(1) })).toSQL();

    // CARDINALITY rather than array_length, which answers null for an empty
    // array and would have made a slice of one null rather than empty.
    expect(text).toContain('END:CARDINALITY("t0"."tags")]');
  });

  it('still reads a text column as a substring', () => {
    const { text } = db.products.select((p) => ({ s: p.sku.slice(1, 3) })).toSQL();

    // One method name, two readings, told apart by the column's declared type.
    expect(text).toContain('SUBSTRING(');
    expect(text).not.toContain('CARDINALITY');
  });

  it('rejects a slice given neither a start nor an end', () => {
    const query = () =>
      db.posts.select((p) => ({ t: (p.tags as unknown as { slice(): string[] }).slice() })).toSQL();

    expect(query).toThrow(/"slice" expects a start and an optional end/);
  });

  it('reads the millisecond within the second, not since the second zero', () => {
    const { text } = db.products.select((p) => ({ ms: p.releasedAt.getMilliseconds() })).toSQL();

    // PostgreSQL's MILLISECONDS field includes the whole seconds, so 59.75
    // seconds extracts as 59750 and the MOD is what takes the second back off.
    expect(text).toBe(
      'SELECT MOD(FLOOR(EXTRACT(MILLISECONDS FROM "t0"."released_at")) :: int, 1000) AS "ms" ' +
        'FROM "products" AS "t0"',
    );
  });

  it('rejects a millisecond given an argument', () => {
    const query = () =>
      db.products
        .select((p) => ({
          ms: (p.releasedAt as unknown as { getMilliseconds(a: number): number }).getMilliseconds(
            1,
          ),
        }))
        .toSQL();

    expect(query).toThrow(/"getMilliseconds" expects 0 argument\(s\)/);
  });

  it('casts a sign to int, since sign of an integer yields numeric', () => {
    const { text } = db.products.select((p) => ({ s: Math.sign(p.id) })).toSQL();

    // node-postgres returns numeric as a string, and -1, 0, and 1 lose nothing
    // on the way to an int.
    expect(text).toBe('SELECT SIGN("t0"."id") :: int AS "s" FROM "products" AS "t0"');
  });

  it('truncates with TRUNC rather than the base dialect CASE', () => {
    const { text } = db.products.select((p) => ({ t: Math.trunc(p.id) })).toSQL();

    // PostgreSQL has the function, so the argument is printed once where the
    // portable spelling prints it three times.
    expect(text).toBe('SELECT TRUNC("t0"."id") AS "t" FROM "products" AS "t0"');
    expect(text).not.toContain('CEILING');
  });

  it('takes a cube root with CBRT, which answers a negative argument correctly', () => {
    const { text } = db.products.select((p) => ({ c: Math.cbrt(p.id) })).toSQL();

    // POWER(x, 1.0 / 3) looks ANSI and is wrong for a negative x, since a
    // fractional power of a negative base is not a real number.
    expect(text).toBe('SELECT CBRT("t0"."id") AS "c" FROM "products" AS "t0"');
    expect(text).not.toContain('POWER');
  });

  it('takes a base-2 logarithm with the exact two-argument LOG', () => {
    const { text } = db.products.select((p) => ({ l: Math.log2(p.id) })).toSQL();

    // `LN(x) / LN(2)` looks portable and divides to 2.9999999999999996 at the
    // powers of two, which is the whole reason JavaScript has `Math.log2`.
    expect(text).toBe(
      'SELECT LOG(2, "t0"."id" :: numeric) :: double precision AS "l" FROM "products" AS "t0"',
    );
    expect(text).not.toContain('LN(');
  });

  it('casts the argument in, since the two-argument LOG is numeric only', () => {
    // A `decimal` column reads back as a string, so the cast here is the test's
    // rather than the caller's; what it exercises is the SQL a column that is
    // not an `int` produces.
    const { text } = db.products
      .select((p) => ({ l: Math.log2(p.price as unknown as number) }))
      .toSQL();

    // A `decimal` column is already numeric and a `float8` one would not reach
    // `log(numeric, numeric)` without this, since that cast is not implicit.
    expect(text).toContain('LOG(2, "t0"."price" :: numeric)');
  });

  it('takes a base-10 logarithm with the exact two-argument LOG', () => {
    const { text } = db.products.select((p) => ({ l: Math.log10(p.id) })).toSQL();

    // The same LOG(base, value) call log2 makes, with the base that names the
    // function swapped: the shared helper is what keeps the two from drifting.
    expect(text).toBe(
      'SELECT LOG(10, "t0"."id" :: numeric) :: double precision AS "l" FROM "products" AS "t0"',
    );
  });

  it('takes a natural logarithm with LN directly, needing no two-argument LOG', () => {
    const { text } = db.products.select((p) => ({ l: Math.log(p.id) })).toSQL();

    // Unlike log2 and log10, LN already has a double precision overload, so
    // there is no numeric cast to force it: only the answer is cast.
    expect(text).toBe('SELECT LN("t0"."id") :: double precision AS "l" FROM "products" AS "t0"');
  });

  it('rejects a second argument to cbrt', () => {
    const query = () =>
      db.products
        .select((p) => ({
          c: (Math.cbrt as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.cbrt" expects 1 argument\(s\)/);
  });

  it('computes the angle of a vector with ATAN2, in the same y, x order Math.atan2 takes', () => {
    const { text, values } = db.products.select((p) => ({ angle: Math.atan2(p.id, 2) })).toSQL();

    // SQL Server spells this ATN2 rather than ATAN2, which is why it is not a
    // line in MATH_FUNCTIONS: the base dialect only names functions every
    // targeted database would understand by that text.
    expect(text).toBe('SELECT ATAN2("t0"."id", $1) AS "angle" FROM "products" AS "t0"');
    expect(values).toEqual([2]);
  });

  it('rejects a third argument to atan2', () => {
    const query = () =>
      db.products
        .select((p) => ({
          angle: (Math.atan2 as unknown as (a: number, b: number, c: number) => number)(p.id, 2, 3),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.atan2" expects 2 argument\(s\)/);
  });

  it('takes a hyperbolic sine with SINH, which stays exact near zero', () => {
    const { text } = db.products.select((p) => ({ s: Math.sinh(p.id) })).toSQL();

    // (EXP(x) - EXP(-x)) / 2 looks ANSI and loses precision near x = 0, since
    // both terms round to nearly 1 before the subtraction ever sees the
    // difference that matters.
    expect(text).toBe('SELECT SINH("t0"."id") AS "s" FROM "products" AS "t0"');
    expect(text).not.toContain('EXP');
  });

  it('rejects a second argument to sinh', () => {
    const query = () =>
      db.products
        .select((p) => ({
          s: (Math.sinh as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.sinh" expects 1 argument\(s\)/);
  });

  it('takes a hyperbolic tangent with TANH, rather than SINH over COSH', () => {
    const { text } = db.products.select((p) => ({ t: Math.tanh(p.id) })).toSQL();

    // A ratio of the other two would still carry SINH's own cancellation
    // near zero into its numerator.
    expect(text).toBe('SELECT TANH("t0"."id") AS "t" FROM "products" AS "t0"');
    expect(text).not.toContain('SINH');
    expect(text).not.toContain('COSH');
  });

  it('rejects a second argument to tanh', () => {
    const query = () =>
      db.products
        .select((p) => ({
          t: (Math.tanh as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.tanh" expects 1 argument\(s\)/);
  });

  it('takes a hyperbolic arcsine with ASINH, which stays exact for a large negative input', () => {
    const { text } = db.products.select((p) => ({ a: Math.asinh(p.id) })).toSQL();

    // LN(x + SQRT(x * x + 1)) looks ANSI and cancels for a large negative x,
    // since SQRT(x * x + 1) is then nearly -x.
    expect(text).toBe('SELECT ASINH("t0"."id") AS "a" FROM "products" AS "t0"');
    expect(text).not.toContain('SQRT');
  });

  it('rejects a second argument to asinh', () => {
    const query = () =>
      db.products
        .select((p) => ({
          a: (Math.asinh as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.asinh" expects 1 argument\(s\)/);
  });

  it('takes a hyperbolic arccosine with ACOSH, which stays exact near the domain edge', () => {
    const { text } = db.products.select((p) => ({ a: Math.acosh(p.id) })).toSQL();

    // LN(x + SQRT(x * x - 1)) looks ANSI and cancels for an x near one, since
    // x * x is then nearly one and subtracting one loses most of its digits.
    expect(text).toBe('SELECT ACOSH("t0"."id") AS "a" FROM "products" AS "t0"');
    expect(text).not.toContain('SQRT');
  });

  it('rejects a second argument to acosh', () => {
    const query = () =>
      db.products
        .select((p) => ({
          a: (Math.acosh as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.acosh" expects 1 argument\(s\)/);
  });

  it('takes a hyperbolic arctangent with ATANH, which stays exact near zero', () => {
    const { text } = db.products.select((p) => ({ a: Math.atanh(p.id) })).toSQL();

    // 0.5 * LN((1 + x) / (1 - x)) looks ANSI and loses the answer for an x
    // near zero, where the quotient rounds back to one before LN sees it.
    expect(text).toBe('SELECT ATANH("t0"."id") AS "a" FROM "products" AS "t0"');
    expect(text).not.toContain('LN');
  });

  it('rejects a second argument to atanh', () => {
    const query = () =>
      db.products
        .select((p) => ({
          a: (Math.atanh as unknown as (a: number, b: number) => number)(p.id, 2),
        }))
        .toSQL();

    expect(query).toThrow(/"Math.atanh" expects 1 argument\(s\)/);
  });
});

describe('match', () => {
  it('tests a column against a regular expression with ~', () => {
    const { text, values } = db.products.where((p) => !!p.title.match(/^A/)).toSQL();

    expect(text).toContain('"t0"."title" ~ $1');
    expect(values).toEqual(['^A']);
  });

  it('uses the case-insensitive operator for the "i" flag', () => {
    const { text, values } = db.products.where((p) => !!p.title.match(/^a/i)).toSQL();

    expect(text).toContain('"t0"."title" ~* $1');
    expect(values).toEqual(['^a']);
  });

  it('rejects a flag POSIX has no reading for', () => {
    const query = () => db.products.where((p) => !!p.title.match(/^a/g)).toSQL();

    expect(query).toThrow(/does not translate the regular expression flag\(s\) "g"/);
  });
});

describe('search', () => {
  it('finds where a regular expression first matches, zero-based', () => {
    const { text, values } = db.products.select((p) => ({ at: p.title.search(/^A/) })).toSQL();

    expect(text).toContain('regexp_instr("t0"."title", $1) - 1');
    expect(values).toEqual(['^A']);
  });

  it('answers -1 through the same arithmetic regexp_instr already gives for no match', () => {
    // regexp_instr counts from one and answers zero for no match; JavaScript
    // counts from zero and answers -1. Subtracting one closes both gaps at
    // once, the way indexOf's own POSITION does.
    const { text } = db.products.select((p) => ({ at: p.title.search(/x/) })).toSQL();

    expect(text).not.toContain('CASE');
  });

  it("passes the case-insensitive flag through as regexp_instr's own argument", () => {
    const { text, values } = db.products.select((p) => ({ at: p.title.search(/^a/i) })).toSQL();

    expect(text).toContain(`regexp_instr("t0"."title", $1, 1, 1, 0, 'i') - 1`);
    expect(values).toEqual(['^a']);
  });

  it('rejects a flag POSIX has no reading for', () => {
    const query = () => db.products.select((p) => ({ at: p.title.search(/^a/g) })).toSQL();

    expect(query).toThrow(/does not translate the regular expression flag\(s\) "g"/);
  });
});

describe('flat', () => {
  it('flattens a nested array column with unnest rebuilt into an array', () => {
    const { text } = db.posts.select((p) => ({ flat: p.grid.flat() })).toSQL();

    expect(text).toContain(
      'CASE WHEN "t0"."grid" IS NULL THEN NULL ' +
        'ELSE ARRAY(SELECT unnest("t0"."grid") AS "element" FROM (SELECT 1) AS "unnest_src") ' +
        'END AS "flat"',
    );
  });

  it('is the identity for a column that was never nested', () => {
    const { text } = db.posts.select((p) => ({ flat: p.tags.flat() })).toSQL();

    expect(text).toContain('ARRAY(SELECT unnest("t0"."tags")');
  });

  it('reads a null array back as null rather than as an empty one', () => {
    const { text } = db.posts.select((p) => ({ flat: p.grid.flat() })).toSQL();

    expect(text).toMatch(/CASE WHEN "t0"."grid" IS NULL THEN NULL ELSE/);
  });

  it('rejects a depth argument', () => {
    const query = () =>
      db.posts
        .select((p) => ({
          flat: (p.grid as unknown as { flat(depth: number): string[] }).flat(1),
        }))
        .toSQL();

    expect(query).toThrow(/flattens exactly one level/);
  });
});

describe('flatMap', () => {
  it('maps each element through the callback and flattens the result', () => {
    const { text, values } = db.posts
      .select((p) => ({ parts: p.tags.flatMap((tag) => tag.split('-')) }))
      .toSQL();

    expect(text).toContain(
      'CASE WHEN "t0"."tags" IS NULL THEN NULL ELSE ARRAY(' +
        'SELECT unnest(string_to_array("t1"."element", $1)) AS "flattened" ' +
        'FROM (SELECT unnest("t0"."tags") AS "element" FROM (SELECT 1) AS "t2") AS "t1"' +
        ') END AS "parts"',
    );
    expect(values).toEqual(['-']);
  });

  it('reads a null array back as null rather than as an empty one', () => {
    const { text } = db.posts
      .select((p) => ({ parts: p.tags.flatMap((tag) => tag.split('-')) }))
      .toSQL();

    expect(text).toMatch(/CASE WHEN "t0"."tags" IS NULL THEN NULL ELSE/);
  });

  it('rejects more than one callback argument', () => {
    const query = () =>
      db.posts
        .select((p) => ({
          parts: (
            p.tags as unknown as {
              flatMap(fn: (tag: string) => string[], thisArg: unknown): string[];
            }
          ).flatMap((tag) => tag.split('-'), null),
        }))
        .toSQL();

    expect(query).toThrow(/"flatMap" expects one callback/);
  });
});
