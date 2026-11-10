import type { ColumnType, MethodTranslation, SqlExpression } from '@sqlinqo/core';
import { BaseDialect, sql, UnsupportedExpressionError } from '@sqlinqo/core';

/**
 * SQL Server flavour of the ANSI base dialect.
 *
 * Where PostgreSQL mostly adds to what the base dialect already emits, T-SQL
 * mostly replaces it: `POSITION`, `EXTRACT`, and `CHAR_LENGTH` are ANSI
 * spellings SQL Server never implemented, so almost every translation
 * `BaseDialect` builds from them needs its own T-SQL wording here rather than
 * an addition beside it. What *is* portable unchanged — `LOWER`, `UPPER`,
 * `TRIM`, `REPLACE`, `ABS`, `SQRT`, `POWER`, the trig functions, `localeCompare`'s
 * three-way `CASE` — is left to the base dialect exactly as PostgreSQL leaves it.
 *
 * This targets SQL Server 2022 and Azure SQL Database, which is what is
 * assumed wherever a translation reaches for `GREATEST`, `LEAST`, or
 * `NORMALIZE`: all three were added in that release, and an older instance
 * refuses them at the database rather than here.
 *
 * Every text comparison and search here — `LIKE`, `CHARINDEX`, `REPLACE`,
 * `=` — runs under the column's own collation rather than under JavaScript's
 * own case-sensitive, code-unit equality, exactly as `localeCompare` already
 * documents for ordering in the base dialect. Most installations default to a
 * case-insensitive collation, so `'Ada'.indexOf('a')` is 2 in JavaScript and 0
 * here, matching the capital letter a case-sensitive search would skip. This
 * is a database setting this library cannot see or override from an
 * expression, so it is a caveat rather than something a translation adjusts
 * for.
 *
 * `RETURNING` has no T-SQL equivalent in a position this library's printer
 * can reach: `insert`, `insertMany`, `insertFrom`, `upsert`, `upsertMany`, and
 * a `where(...).update(...)` or `where(...).delete()` that reads rows back
 * are therefore all refused by `formatReturning` and `formatUpsert` below
 * rather than given a clause that reads nearly right. Reading, including
 * inside `$transaction`, is unaffected; only writing through this library's
 * own operators is not yet supported. Issue the write with a raw statement
 * through `$driver.execute(...)` in the meantime.
 */
export class MssqlDialect extends BaseDialect {
  readonly name = 'mssql';

  /**
   * SQL Server delimits an identifier with brackets rather than double quotes.
   * A `]` inside one is doubled, the only escape bracketed identifiers define,
   * exactly as `"` is doubled for PostgreSQL's own quoting.
   */
  override quoteIdentifier(identifier: string): string {
    return `[${identifier.replace(/]/g, ']]')}]`;
  }

  /**
   * The `mssql` driver binds parameters by name rather than by position, so a
   * placeholder is `@p0`, `@p1`, and so on rather than a bare ordinal. Naming
   * them is also what lets `sharesParameters` stay at its default of true: two
   * mentions of one value can share `@p0` the way two mentions share `$1` on
   * PostgreSQL.
   */
  override parameterPlaceholder(index: number): string {
    return `@p${index}`;
  }

  /**
   * T-SQL concatenates with `+`, not `||`. This single override is also what
   * makes `LIKE`, `String.prototype.concat`, and the compiled `+` operator all
   * read correctly here without three separate changes: every one of them is
   * built by the base dialect out of a call to `concat`.
   *
   * `+` propagates null the same way `||` does, so a joined string is still
   * null if any part is, which is the reading the README already commits to.
   */
  override concat(parts: readonly SqlExpression[]): SqlExpression {
    if (parts.length === 0) return sql.valueParameter('');
    return parts.reduce((left, right) => sql.sqlBinary('+', left, right));
  }

  /**
   * `OFFSET ... FETCH NEXT ... ROWS ONLY` is the only paging clause T-SQL has,
   * and unlike `LIMIT`/`OFFSET` it is not optional on its own: SQL Server
   * refuses `OFFSET` without a preceding `ORDER BY`. That requirement is not
   * repeated here, because nothing reaches this hook that knows whether an
   * `ORDER BY` was printed — the printer calls it with only the already-printed
   * limit and offset text, after deciding for itself whether to print an
   * `ORDER BY` at all. A query paged with no ordering therefore fails at the
   * database with SQL Server's own error naming the missing `ORDER BY`, rather
   * than being silently reordered here to make one up: add `orderBy` before any
   * of `take`, `skip`, `elementAt`, `chunk`, or the other operators that page.
   *
   * `OFFSET 0 ROWS` is printed even for a bare `take`, since `FETCH NEXT`
   * cannot appear without an `OFFSET` in front of it.
   */
  override formatPaging(limit: string | null, offset: string | null): string {
    if (limit === null && offset === null) return '';
    const clauses = [`OFFSET ${offset ?? '0'} ROWS`];
    if (limit !== null) clauses.push(`FETCH NEXT ${limit} ROWS ONLY`);
    return clauses.join(' ');
  }

  /**
   * `RETURNING` has no T-SQL counterpart at all; the nearest thing, `OUTPUT`,
   * sits in a different place in each of the three statements that need it —
   * before `VALUES` in an `INSERT`, after `SET` in an `UPDATE`, after `FROM` in
   * a `DELETE` — where this hook is asked only for the columns and always
   * appended after the rest of the statement. Answering with text that reads
   * nearly right would compile in none of the three positions this printer
   * puts it, so `insert`, `insertMany`, `insertFrom`, `upsert`, and a
   * `where(...).update(...)` or `where(...).delete()` that reads rows back are
   * all refused here rather than given a clause that means something else.
   */
  override formatReturning(_columns: readonly string[]): string {
    throw new UnsupportedExpressionError(
      'SQL Server has no RETURNING clause. Its OUTPUT clause is the nearest equivalent and sits in ' +
        'a different place in an INSERT, an UPDATE, and a DELETE, which this hook has no way to say, ' +
        'so reading rows back is not translated here for any of the three.',
    );
  }

  /**
   * SQL Server has no single-statement upsert. `MERGE` can express one, but it
   * is a statement of its own rather than a clause an `INSERT` can carry, and
   * it is also documented by Microsoft as unsafe under concurrent access
   * without care this hook cannot add on the caller's behalf. `upsert` and
   * `upsertMany` are refused here rather than given a `MERGE` that reads
   * nearly right and is not equivalent.
   */
  override formatUpsert(
    _conflictColumns: readonly string[],
    _updateColumns: readonly string[],
  ): string {
    throw new UnsupportedExpressionError(
      'SQL Server has no single-statement upsert. MERGE can express one but is a statement of its ' +
        'own rather than a clause this hook can add to an INSERT, and needs care around concurrent ' +
        'access this library cannot supply on the caller\'s behalf, so "upsert" is not translated here.',
    );
  }

  /**
   * `LEN` rather than `CHAR_LENGTH`, which T-SQL does not have.
   *
   * `LEN` trims trailing spaces before counting, where JavaScript's `.length`
   * counts every character: a column holding `'ab  '` reports 2 here and 4
   * there. `DATALENGTH` counts every byte instead, which is the count that
   * keeps trailing spaces and is not the count of characters either, since
   * `nvarchar` stores two bytes per UTF-16 unit; there is no primitive that
   * agrees with JavaScript on a string that ends in spaces, and `LEN` is the
   * closer of the two for ordinary text.
   *
   * SQL Server has no array column type, so `columnType` is never `'array'`
   * for an entity mapped through this provider; declaring one anyway and
   * reading its `length` reaches the database as this same `LEN` call, which
   * fails there rather than here.
   */
  override translateMember(
    target: SqlExpression,
    property: string,
    columnType?: ColumnType | null,
  ): SqlExpression | null {
    if (property === 'length') return sql.sqlFunction('LEN', [target]);
    return super.translateMember(target, property, columnType);
  }

  /** Date parts read through `DATEPART`, in T-SQL's own field names. */
  private static readonly DATE_PART_FIELDS: Record<string, string> = {
    getFullYear: 'year',
    getMonth: 'month',
    getDate: 'day',
    getHours: 'hour',
    getMinutes: 'minute',
    getSeconds: 'second',
    getMilliseconds: 'millisecond',
  };

  /**
   * `getUTC*` aliased onto its plain counterpart.
   *
   * PostgreSQL's `timestamptz` carries a zone and is rendered in the session's
   * whenever anything reads it, which is the dependency `getUTCFullYear` and
   * the rest of that family exist to remove there. SQL Server's `datetime2` —
   * what this library's `timestamp` column type maps onto here — never carries
   * a zone at all, so there is no session-dependent reading to remove: a
   * `datetime2` gives back exactly the value stored, to every session alike.
   * Under this library's own convention of storing a naive value already in
   * UTC, that stored value already is the UTC reading, which is what makes each
   * `getUTC*` method the same translation as its plain counterpart rather than
   * a conversion of it.
   */
  private static readonly DATE_METHOD_ALIASES: Record<string, string> = {
    getUTCFullYear: 'getFullYear',
    getUTCMonth: 'getMonth',
    getUTCDate: 'getDate',
    getUTCDay: 'getDay',
    getUTCHours: 'getHours',
    getUTCMinutes: 'getMinutes',
    getUTCSeconds: 'getSeconds',
  };

  override translateMethod(translation: MethodTranslation): SqlExpression | null {
    const { target, method, args, targetType } = translation;

    if (target !== null) {
      const canonical = MssqlDialect.DATE_METHOD_ALIASES[method] ?? method;
      const field = MssqlDialect.DATE_PART_FIELDS[canonical];

      if (field) {
        this.expectArity(method, args, 0);
        const part = sql.sqlFunction('DATEPART', [sql.sqlLiteral(field), target]);
        // JavaScript numbers months from zero and DATEPART from one; every
        // other field here is numbered the same way on both sides.
        return canonical === 'getMonth' ? sql.sqlBinary('-', part, sql.sqlLiteral('1')) : part;
      }

      if (canonical === 'getDay') {
        this.expectArity(method, args, 0);
        return this.weekday(target);
      }

      if (canonical === 'getTime') {
        this.expectArity(method, args, 0);
        return this.epochMilliseconds(target);
      }

      if (method === 'toISOString') {
        this.expectArity(method, args, 0);
        return this.isoText(target);
      }
    }

    if (target !== null && method === 'indexOf') {
      // POSITION has no T-SQL spelling; CHARINDEX takes its arguments in the
      // same order and needle-not-found reads the same way, zero rather than
      // -1, so the arithmetic that follows is the base dialect's own.
      if (args.length !== 1) {
        throw new UnsupportedExpressionError(
          `"indexOf" expects one value to search for in a query but received ` +
            `${args.length} argument(s). An index to start searching from cannot be honoured, ` +
            'since CHARINDEX searches the whole string.',
        );
      }
      return sql.sqlBinary(
        '-',
        sql.sqlFunction('CHARINDEX', [args[0]!, target]),
        sql.sqlLiteral('1'),
      );
    }

    if (target !== null && method === 'padStart') {
      return this.padded(target, args, true);
    }

    if (target !== null && method === 'padEnd') {
      return this.padded(target, args, false);
    }

    if (target !== null && method === 'repeat') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('REPLICATE', [target, args[0]!]);
    }

    if (target !== null && method === 'charAt') {
      if (args.length > 1) {
        throw new UnsupportedExpressionError(
          `"charAt" expects at most one argument, the index, but received ${args.length}.`,
        );
      }
      return this.characterAt(target, args[0] ?? sql.sqlLiteral('0'));
    }

    if (target !== null && method === 'slice' && targetType !== 'array') {
      if (args.length !== 1 && args.length !== 2) {
        throw new UnsupportedExpressionError(
          `"slice" expects a start and an optional end in a query but received ` +
            `${args.length} argument(s).`,
        );
      }
      return this.sliced(target, args[0]!, args[1]);
    }

    if (target !== null && method === 'substring' && args.length === 2) {
      const start = sql.sqlBinary('+', args[0]!, sql.sqlLiteral('1'));
      const length = sql.sqlBinary('-', args[1]!, args[0]!);
      return sql.sqlFunction('SUBSTRING', [target, start, length]);
    }

    if (target !== null && method === 'codePointAt') {
      this.expectArity(method, args, 1);
      return this.codePoint(target, args[0]!);
    }

    if (target !== null && method === 'toFixed') {
      if (args.length > 1) {
        throw new UnsupportedExpressionError(
          `"toFixed" expects at most one argument, the number of digits, but received ` +
            `${args.length}.`,
        );
      }
      return this.fixed(target, args[0] ?? sql.sqlLiteral('0'));
    }

    return super.translateMethod(translation);
  }

  protected override translateGlobal(
    method: string,
    args: readonly SqlExpression[],
  ): SqlExpression | null {
    // `RAND()` with no argument is evaluated once for the whole statement, not
    // once per row, which the base dialect's `random: 'RANDOM'` entry assumes
    // is not how a database's plain random function behaves. Seeding it from
    // `NEWID()`, which T-SQL does generate fresh per row, forces a fresh seed
    // and therefore a fresh value on every row instead.
    if (method === 'Math.random') {
      this.expectArity(method, args, 0);
      return sql.sqlFunction('RAND', [sql.sqlFunction('CHECKSUM', [sql.sqlFunction('NEWID', [])])]);
    }

    // T-SQL has no CBRT. `POWER(x, 1/3)` is wrong for a negative `x`, the same
    // trap PostgreSQL's own CBRT exists to avoid, so the sign is taken out
    // first and reapplied after the fractional power of the magnitude alone.
    if (method === 'Math.cbrt') {
      this.expectArity(method, args, 1);
      const value = args[0]!;
      return sql.sqlBinary(
        '*',
        sql.sqlFunction('SIGN', [value]),
        sql.sqlFunction('POWER', [
          sql.sqlFunction('ABS', [value]),
          sql.sqlLiteral('0.3333333333333333'),
        ]),
      );
    }

    // T-SQL's two-argument LOG takes the value first and the base second,
    // `LOG(value, base)`, the opposite order from PostgreSQL's own two-argument
    // form; getting this backwards would compile and answer a different
    // logarithm.
    if (method === 'Math.log2') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('LOG', [args[0]!, sql.sqlLiteral('2')]);
    }

    // LOG10 is its own function in T-SQL, exact rather than a division by
    // LN(10) that would drift an ulp off at the powers of ten, `Math.log2`'s
    // own reason for reaching past `LN(x) / LN(2)`.
    if (method === 'Math.log10') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('LOG10', args);
    }

    // Single-argument LOG is the natural logarithm in T-SQL, matching
    // PostgreSQL's own single-argument LN exactly.
    if (method === 'Math.log') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('LOG', args);
    }

    // T-SQL spells the two-argument arctangent ATN2 rather than ATAN2, taking
    // its arguments in the same (y, x) order as JavaScript's Math.atan2.
    if (method === 'Math.atan2') {
      this.expectArity(method, args, 2);
      return sql.sqlFunction('ATN2', args);
    }

    // T-SQL has no hyperbolic functions at all, unlike PostgreSQL 12+, and none
    // of the ANSI-looking identities are numerically stable near the values a
    // caller is likely to test with — the same cancellation `Math.expm1` and
    // `Math.log1p` are refused for in the base dialect. Refused by name rather
    // than answered with a translation that would be silently imprecise.
    if (
      method === 'Math.sinh' ||
      method === 'Math.tanh' ||
      method === 'Math.asinh' ||
      method === 'Math.acosh' ||
      method === 'Math.atanh'
    ) {
      throw new UnsupportedExpressionError(
        `"${method}" has no numerically stable T-SQL spelling: T-SQL has no hyperbolic functions, ` +
          'and the ANSI-looking identities built from EXP and LN cancel near the values they are ' +
          "usually called with, the same trap PostgreSQL's own SINH and TANH exist to avoid.",
      );
    }

    return super.translateGlobal(method, args);
  }

  /**
   * `Math.trunc` in T-SQL's own spelling.
   *
   * `ROUND(x, 0, 1)` is T-SQL's truncating form of `ROUND` — the third
   * argument turns rounding off — so the argument is printed once here rather
   * than the three times the base dialect's `CASE` over `FLOOR`/`CEILING`
   * needs, the same trade `PostgresDialect` makes with its own `TRUNC`.
   */
  protected override truncated(value: SqlExpression): SqlExpression {
    return sql.sqlFunction('ROUND', [value, sql.sqlLiteral('0'), sql.sqlLiteral('1')]);
  }

  /**
   * The day of the week, 0 through 6 with Sunday first, the way JavaScript's
   * `getDay` numbers it.
   *
   * `DATEPART(weekday, x)` answers 1 through 7, but which day is 1 depends on
   * `@@DATEFIRST` — a session setting, a language setting, or a login default,
   * none of which this library controls or can read from an expression. Rather
   * than document a translation that is only correct under one `DATEFIRST`
   * value, as PostgreSQL's own `DOW` needs no such caveat, the session's actual
   * `DATEFIRST` is folded into the arithmetic instead: shifting `DATEPART`'s
   * answer by how many days that setting has already turned the week gives the
   * same zero-based, Sunday-first number regardless of what `@@DATEFIRST` is
   * set to. `@@DATEFIRST` is a system function taking no parentheses, which is
   * why it is built as a raw fragment rather than through `sqlFunction`.
   */
  private weekday(target: SqlExpression): SqlExpression {
    const part = sql.sqlFunction('DATEPART', [sql.sqlLiteral('weekday'), target]);
    const dateFirst: SqlExpression = { kind: 'raw', sql: '@@DATEFIRST' };
    const shifted = sql.sqlBinary('-', sql.sqlBinary('+', part, dateFirst), sql.sqlLiteral('1'));
    return sql.sqlBinary('%', shifted, sql.sqlLiteral('7'));
  }

  /**
   * Milliseconds since the Unix epoch, which is what `Date.prototype.getTime`
   * answers.
   *
   * Plain `DATEDIFF(millisecond, ...)` overflows its `int` result for any date
   * this far from 1970, the same overflow PostgreSQL's own `EPOCH * 1000`
   * would hit had node-postgres not already returned a string in its place.
   * `DATEDIFF_BIG` (SQL Server 2016+) answers a `bigint` instead, which the
   * `mssql` driver already returns as a JavaScript `number` for a value this
   * small, so nothing further has to convert it.
   */
  private epochMilliseconds(target: SqlExpression): SqlExpression {
    return sql.sqlFunction('DATEDIFF_BIG', [
      sql.sqlLiteral('millisecond'),
      sql.sqlLiteral("'1970-01-01'"),
      target,
    ]);
  }

  /**
   * The date as ISO 8601 text, matching `Date.prototype.toISOString`.
   *
   * `CONVERT(..., 126)` is T-SQL's ISO 8601 style, `yyyy-mm-ddThh:mi:ss.mmm`,
   * already the exact format JavaScript's own method produces short of the
   * trailing `Z`. That `Z` is appended as a literal rather than produced by the
   * database, which is the same assertion PostgreSQL's own translation makes
   * and carries the same caveat: it is a true reading of a `datetime2` column
   * holding UTC, this library's own convention, and not a conversion, since a
   * `datetime2` never carries a zone to convert from in the first place.
   */
  private isoText(target: SqlExpression): SqlExpression {
    const iso = sql.sqlFunction('CONVERT', [
      sql.sqlLiteral('varchar(23)'),
      target,
      sql.sqlLiteral('126'),
    ]);
    return sql.sqlBinary('+', iso, sql.sqlLiteral("'Z'"));
  }

  /**
   * Pads a string to a width, as `padStart` and `padEnd` ask for.
   *
   * T-SQL has neither `LPAD` nor `RPAD`. `REPLICATE(pad, width)` repeats the
   * whole pad string `width` times, which is at least `width` characters long
   * whenever the pad string is not empty, so taking the last (or first)
   * `width` characters of that run appended to (or prepended to) the target
   * always lands on an exact width — this works for a multi-character pad
   * string too, unlike a naive single-character assumption would need to.
   *
   * `width` is `GREATEST(requested, LEN(target))`, `padWidth`'s own guard
   * against `RIGHT`/`LEFT` truncating a target already longer than what was
   * asked for, which is what makes an already-long target come back untouched
   * rather than cut down to size, matching `padStart`/`padEnd` themselves.
   */
  private padded(
    target: SqlExpression,
    args: readonly SqlExpression[],
    start: boolean,
  ): SqlExpression {
    if (args.length < 1 || args.length > 2) {
      throw new UnsupportedExpressionError(
        `"${start ? 'padStart' : 'padEnd'}" expects a target length and an optional pad string in a ` +
          `query but received ${args.length} argument(s).`,
      );
    }

    const width = this.padWidth(target, args[0]!);
    const pad = args[1] ?? sql.sqlLiteral("' '");
    const filled = sql.sqlFunction('REPLICATE', [pad, width]);

    return start
      ? sql.sqlFunction('RIGHT', [sql.sqlBinary('+', filled, target), width])
      : sql.sqlFunction('LEFT', [sql.sqlBinary('+', target, filled), width]);
  }

  /**
   * The one character at an index, as `String.prototype.charAt` reads it.
   *
   * `SUBSTRING` counts from one where JavaScript counts from zero, so the
   * index is shifted by one; every out-of-range index — negative, or past the
   * end — falls out as the empty string without a case of its own, which is
   * what `SUBSTRING` answers for a range covering no characters and what
   * `charAt` itself answers.
   */
  private characterAt(target: SqlExpression, index: SqlExpression): SqlExpression {
    return sql.sqlFunction('SUBSTRING', [
      target,
      sql.sqlBinary('+', index, sql.sqlLiteral('1')),
      sql.sqlLiteral('1'),
    ]);
  }

  /**
   * A half-open slice of a string, counted the way `String.prototype.slice`
   * counts. See `PostgresDialect.sliced` for the arithmetic this mirrors;
   * nothing here differs but the function names, since no cast is needed —
   * the `mssql` driver types a bound numeric parameter as `int` or `float`
   * from the JavaScript value handed to it, rather than leaving it untyped the
   * way an unadorned PostgreSQL placeholder is.
   */
  private sliced(
    target: SqlExpression,
    start: SqlExpression,
    end: SqlExpression | undefined,
  ): SqlExpression {
    const length = this.lengthOf(target);
    const zero = sql.sqlLiteral('0');

    const bound = (value: SqlExpression): SqlExpression => ({
      kind: 'case',
      branches: [
        {
          condition: sql.sqlBinary('<', value, zero),
          result: sql.sqlFunction('GREATEST', [sql.sqlBinary('+', length, value), zero]),
        },
      ],
      otherwise: sql.sqlFunction('LEAST', [value, length]),
    });

    const from = bound(start);
    const to = end === undefined ? length : bound(end);

    return sql.sqlFunction('SUBSTRING', [
      target,
      sql.sqlBinary('+', from, sql.sqlLiteral('1')),
      sql.sqlFunction('GREATEST', [sql.sqlBinary('-', to, from), zero]),
    ]);
  }

  /**
   * A number rounded to a fixed number of digits, as text.
   *
   * `DECIMAL`'s scale has to be a compile-time constant in T-SQL, and the
   * number of digits never reaches a dialect as one: every argument arrives as
   * a bound parameter, even one written as a literal in the query, so
   * `CAST(x AS decimal(38, n))` is not an option here at all. `FORMAT`'s second
   * argument is an ordinary expression rather than a compile-time constant, so
   * the format spec is assembled at the SQL level instead: `'F'` concatenated
   * with the digit count read back as text, giving `FORMAT`'s fixed-point
   * style with exactly that many decimal places.
   *
   * The `'en-US'` culture is not decoration. `FORMAT` without one renders under
   * the server's default culture, which is a comma for the decimal point in
   * a great many of them; naming the culture explicitly is what keeps the
   * output a JavaScript-looking `"1.50"` regardless of where the database
   * happens to be configured.
   */
  private fixed(target: SqlExpression, digits: SqlExpression): SqlExpression {
    const spec = sql.sqlBinary(
      '+',
      sql.sqlLiteral("'F'"),
      sql.sqlFunction('CAST', [digits, sql.sqlLiteral('nvarchar(10)')]),
    );
    return sql.sqlFunction('FORMAT', [target, spec, sql.sqlLiteral("'en-US'")]);
  }

  /**
   * The code point of the character at an index.
   *
   * `UNICODE` answers the UTF-16 code unit of a string's first character —
   * unlike PostgreSQL's `ASCII`, which despite its name answers a full Unicode
   * code point over a UTF-8 database, T-SQL's `nvarchar` is UTF-16 storage
   * throughout, so `UNICODE` agrees with `codePointAt` exactly as far as
   * JavaScript's own UTF-16 code units go and parts company the same way
   * JavaScript's own `charCodeAt` would: past the basic plane, an astral
   * character is two code units to both sides rather than the one code point
   * `codePointAt` would report for a genuine Unicode code point. `UNICODE` of
   * an empty string is null already, which is what an out-of-range index reads
   * as here without a case built for it.
   */
  private codePoint(target: SqlExpression, index: SqlExpression): SqlExpression {
    const character = sql.sqlFunction('SUBSTRING', [
      target,
      sql.sqlBinary('+', index, sql.sqlLiteral('1')),
      sql.sqlLiteral('1'),
    ]);
    return sql.sqlFunction('UNICODE', [character]);
  }

  /**
   * The position of the last occurrence of a substring, counted from zero.
   *
   * The same reversed search `BaseDialect.lastPosition` builds from `POSITION`
   * and `REVERSE`, spelled with `CHARINDEX` instead of `POSITION` since T-SQL
   * has no `POSITION`. `CHARINDEX` takes its arguments in the same
   * needle-then-haystack order and answers zero for "not found" exactly as
   * `POSITION` does, so the arithmetic is unchanged from the base dialect's own
   * — only the function name differs.
   */
  protected override lastPosition(target: SqlExpression, search: SqlExpression): SqlExpression {
    const found = sql.sqlFunction('CHARINDEX', [
      sql.sqlFunction('REVERSE', [search]),
      sql.sqlFunction('REVERSE', [target]),
    ]);

    const start = sql.sqlBinary(
      '-',
      sql.sqlBinary(
        '+',
        sql.sqlBinary('-', this.lengthOf(target), this.lengthOf(search)),
        sql.sqlLiteral('1'),
      ),
      found,
    );

    return {
      kind: 'case',
      branches: [
        { condition: sql.sqlBinary('=', found, sql.sqlLiteral('0')), result: sql.sqlLiteral('-1') },
      ],
      otherwise: start,
    };
  }
}

/** Shared instance. The dialect is stateless, so one is enough per process. */
export const mssqlDialect = new MssqlDialect();
