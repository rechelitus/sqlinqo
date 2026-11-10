import type { ColumnType, MethodTranslation, SqlExpression, SqlFrom } from '@sqlinqo/core';
import { BaseDialect, sql, UnsupportedExpressionError } from '@sqlinqo/core';

/**
 * PostgreSQL flavour of the ANSI base dialect.
 *
 * Only the places where PostgreSQL genuinely differs are overridden, which is
 * the pattern a new provider should follow: start from `BaseDialect`, override
 * quoting and placeholders, then add the handful of functions your database
 * spells differently.
 */
export class PostgresDialect extends BaseDialect {
  readonly name = 'postgres';

  /**
   * PostgreSQL folds unquoted identifiers to lower case, so everything is
   * quoted. An embedded double quote is escaped by doubling it, which is the
   * only escape the standard defines for delimited identifiers.
   */
  override quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  /** node-postgres uses ordinal placeholders starting at `$1`. */
  override parameterPlaceholder(index: number): string {
    return `$${index + 1}`;
  }

  override translateMember(
    target: SqlExpression,
    property: string,
    columnType?: ColumnType | null,
  ): SqlExpression | null {
    // LENGTH is the idiomatic spelling in PostgreSQL and is indexable the same
    // way CHAR_LENGTH is. It is a string function, though: an array falls
    // through to the base dialect's CARDINALITY, since PostgreSQL has no
    // `length` over an array at all.
    if (property === 'length' && columnType !== 'array') {
      return sql.sqlFunction('LENGTH', [target]);
    }
    return super.translateMember(target, property, columnType);
  }

  /** Date parts that come back through `EXTRACT`, which PostgreSQL types as numeric. */
  private static readonly DATE_PARTS = new Set([
    'getFullYear',
    'getUTCFullYear',
    'getMonth',
    'getUTCMonth',
    'getDate',
    'getUTCDate',
    'getDay',
    'getUTCDay',
    'getHours',
    'getUTCHours',
    'getMinutes',
    'getUTCMinutes',
    'getSeconds',
    'getUTCSeconds',
  ]);

  override translateMethod(translation: MethodTranslation): SqlExpression | null {
    const { target, method, args, targetType, regex } = translation;

    if (target !== null && method === 'match') {
      return this.matchesRegex(target, regex!);
    }

    if (target !== null && method === 'search') {
      return this.searchesRegex(target, regex!);
    }

    // `EXTRACT` yields numeric, and node-postgres returns numeric as a string
    // to protect a precision that a year or a month cannot have. Casting to int
    // makes the value the number its TypeScript type already claims it is.
    // Unlike a `decimal` column, nothing can be lost on the way. `getSeconds`
    // and `getUTCSeconds` are in the set because the fraction PostgreSQL puts
    // there has already been floored away, by the base dialect for the first
    // and by `extraDatePart` for the second; the cast rounds, so it is those
    // FLOORs and not this line that keep 59.75 seconds from reading as a
    // sixtieth one. Measured both ways: the cast alone answers 60.
    if (target !== null && PostgresDialect.DATE_PARTS.has(method)) {
      const extracted = this.extraDatePart(translation) ?? super.translateMethod(translation);
      return extracted && sql.sqlBinary('::', extracted, sql.sqlLiteral('int'));
    }

    if (target !== null && method === 'toISOString') {
      this.expectArity(method, args, 0);
      return this.isoText(target);
    }

    if (target !== null && method === 'getMilliseconds') {
      this.expectArity(method, args, 0);
      return this.millisecondOfSecond(target);
    }

    if (target !== null && method === 'getTime') {
      this.expectArity(method, args, 0);
      return this.epochMilliseconds(target);
    }

    if (target !== null && method === 'at') {
      this.expectArity(method, args, 1);
      return this.element(target, args[0]!);
    }

    if (target !== null && targetType === 'array' && method === 'flat') {
      if (args.length > 0) {
        throw new UnsupportedExpressionError(
          '"flat" flattens exactly one level here, since a column can be declared no deeper than ' +
            'an array of arrays; a depth argument cannot be honoured beyond that default.',
        );
      }
      return this.flattenedArray(target);
    }

    if (target !== null && method === 'flatMap') {
      return this.flatMappedArray(target, translation.flatMap!);
    }

    if (target !== null && targetType === 'array' && method === 'includes') {
      this.expectArity(method, args, 1);
      return this.arrayContains(target, args[0]!);
    }

    if (target !== null && targetType === 'array' && method === 'concat') {
      return this.arrayConcat(target, args);
    }

    if (target !== null && targetType === 'array' && method === 'indexOf') {
      // A second argument is the index to start searching from, which
      // `array_position` has no room for, exactly as `POSITION` has none for
      // the string reading of this method.
      if (args.length !== 1) {
        throw new UnsupportedExpressionError(
          `"indexOf" expects one value to search for in a query but received ` +
            `${args.length} argument(s). An index to start searching from cannot be honoured, ` +
            'since array_position searches the whole array.',
        );
      }
      return this.arrayPosition(target, args[0]!);
    }

    if (target !== null && method === 'split') {
      // A second argument caps how many pieces come back, which
      // `string_to_array` has no room for: it always splits the whole string.
      // Dropping it would answer a different question than the one asked, as
      // dropping `indexOf`'s start index would.
      if (args.length !== 1) {
        throw new UnsupportedExpressionError(
          `"split" expects one separator in a query but received ${args.length} argument(s). ` +
            'A limit on how many pieces to return cannot be honoured, since string_to_array ' +
            'splits the whole string.',
        );
      }
      return sql.sqlFunction('string_to_array', [target, args[0]!]);
    }

    if (target !== null && method === 'join') {
      if (args.length > 1) {
        throw new UnsupportedExpressionError(
          `"join" expects at most one argument, the separator, but received ${args.length}.`,
        );
      }
      // JavaScript separates with a comma when called bare.
      return this.joined(target, args[0] ?? sql.sqlLiteral("','"));
    }

    if (target !== null && method === 'charAt') {
      if (args.length > 1) {
        throw new UnsupportedExpressionError(
          `"charAt" expects at most one argument, the index, but received ${args.length}.`,
        );
      }
      // JavaScript reads the first character when called bare.
      return this.characterAt(target, args[0] ?? sql.sqlLiteral('0'));
    }

    if (target !== null && targetType === 'array' && method === 'slice') {
      if (args.length !== 1 && args.length !== 2) {
        throw new UnsupportedExpressionError(
          `"slice" expects a start and an optional end in a query but received ` +
            `${args.length} argument(s).`,
        );
      }
      return this.arraySlice(target, args[0]!, args[1]);
    }

    if (target !== null && method === 'slice') {
      if (args.length !== 1 && args.length !== 2) {
        throw new UnsupportedExpressionError(
          `"slice" expects a start and an optional end in a query but received ` +
            `${args.length} argument(s).`,
        );
      }
      return this.sliced(target, args[0]!, args[1]);
    }

    if (target !== null && method === 'repeat') {
      this.expectArity(method, args, 1);
      return this.repeated(target, args[0]!);
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
      // JavaScript defaults to no digits at all when called bare.
      return this.fixed(target, args[0] ?? sql.sqlLiteral('0'));
    }

    if (target !== null && method === 'substring' && args.length === 2) {
      // JavaScript takes a half-open [start, end) range with a zero-based
      // start; SUBSTRING takes a one-based start and a length.
      //
      // Both bounds are cast to int. Left untyped, `$2 - $3` puts an unknown
      // on either side of the operator and PostgreSQL cannot choose among its
      // many `-` overloads, failing with "operator is not unique".
      const asInt = (expression: SqlExpression): SqlExpression =>
        sql.sqlBinary('::', expression, sql.sqlLiteral('int'));
      const start = sql.sqlBinary('+', asInt(args[0]!), sql.sqlLiteral('1'));
      const length = sql.sqlBinary('-', asInt(args[1]!), asInt(args[0]!));
      return sql.sqlFunction('SUBSTRING', [target, start, length]);
    }

    return super.translateMethod(translation);
  }

  /**
   * A regular expression test, as `String.prototype.match` used for a
   * yes-or-no question rather than for its capture groups asks it.
   *
   * `~` takes POSIX extended regular expressions, which agree with the common
   * JavaScript syntax for anchors, character classes, and quantifiers, but not
   * with everything: a lookahead or a named group has no POSIX reading and
   * reaches PostgreSQL as literal text it will refuse to compile with its own
   * error, rather than one this library could give in its place.
   *
   * The `i` flag is the one JavaScript flag POSIX has room for, as the
   * case-insensitive `~*` rather than as a rewritten pattern, so it is read
   * here and used to choose the operator instead of being folded into the
   * text. Every other flag changes a question `~` cannot answer at all: `g`
   * asks for every match rather than one, `m` and `s` change what `^`, `$`,
   * and `.` mean, and neither `u` nor `y` has a POSIX counterpart, so a pattern
   * carrying one is refused rather than silently answered under the plain
   * reading.
   */
  private matchesRegex(
    target: SqlExpression,
    regex: { pattern: SqlExpression; flags: string },
  ): SqlExpression {
    const insensitive = this.checkedRegexFlags('match', regex.flags);
    return sql.sqlBinary(insensitive ? '~*' : '~', target, regex.pattern);
  }

  /**
   * Where a regular expression literal first matches a column, as
   * `String.prototype.search` answers it.
   *
   * `regexp_instr` is PostgreSQL's, added in PostgreSQL 15, and it is what
   * this needs precisely because it answers the question POSIX's `~` cannot:
   * not merely whether a match exists but where the leftmost one starts.
   *
   * The tempting ANSI-looking alternative — extracting the match with
   * `SUBSTRING(x FROM pattern)` and asking `POSITION` where that text sits —
   * is a trap rather than a portable spelling, and the reason lives in `$`.
   * `POSITION` searches for the extracted text itself, forgetting the
   * position the regex engine found it at, so a pattern anchored to the end
   * would have its match reported at the substring's first literal
   * occurrence rather than at the last one, which is where `$` alone could
   * ever have matched. `regexp_instr` has no such gap, because it never stops
   * being the regex engine's own answer.
   *
   * `regexp_instr` counts from one and answers zero for no match, where
   * JavaScript counts from zero and answers -1; subtracting one closes both
   * gaps at once; this is `indexOf`'s own trick, reused because the shape of
   * the disagreement is identical.
   */
  private searchesRegex(
    target: SqlExpression,
    regex: { pattern: SqlExpression; flags: string },
  ): SqlExpression {
    const insensitive = this.checkedRegexFlags('search', regex.flags);
    const args = insensitive
      ? [
          target,
          regex.pattern,
          sql.sqlLiteral('1'),
          sql.sqlLiteral('1'),
          sql.sqlLiteral('0'),
          sql.sqlLiteral("'i'"),
        ]
      : [target, regex.pattern];

    return sql.sqlBinary('-', sql.sqlFunction('regexp_instr', args), sql.sqlLiteral('1'));
  }

  /**
   * The flags `match` and `search` share the reading of: only `i` has a
   * POSIX counterpart, as the case-insensitive operator or flag argument
   * rather than as a rewritten pattern, so it is read here and used by the
   * caller to choose between the two spellings. Every other flag changes a
   * question neither translation can answer at all: `g` asks for every match
   * rather than one, `m` and `s` change what `^`, `$`, and `.` mean, and
   * neither `u` nor `y` has a POSIX counterpart, so a pattern carrying one is
   * refused rather than silently answered under the plain reading.
   */
  private checkedRegexFlags(method: string, flags: string): boolean {
    const unsupported = [...new Set(flags)].filter((flag) => flag !== 'i');
    if (unsupported.length > 0) {
      throw new UnsupportedExpressionError(
        `"${method}" does not translate the regular expression flag(s) "${unsupported.join('')}"; ` +
          'only "i" (case-insensitive) is translated here.',
      );
    }

    return flags.includes('i');
  }

  /**
   * The millisecond within the second, which is what `getMilliseconds` answers.
   *
   * This is a provider translation because the standard's `EXTRACT` knows only
   * YEAR through SECOND, and every database invented its own way past that:
   * PostgreSQL has a `MILLISECONDS` field, MySQL a `MICROSECOND` one, and SQL
   * Server spells the whole thing `DATEPART(millisecond, x)`. The base dialect
   * declines by name rather than guessing, as it does for `getDay`.
   *
   * There is an ANSI-looking way to write it — the fractional part of
   * `EXTRACT(SECOND ...)`, times a thousand — and it is a trap rather than a
   * portable spelling. It works here only because PostgreSQL answers `SECOND`
   * with its fraction; a database that answers a whole second, as MySQL does,
   * would compute zero for every row and say nothing about it. A translation
   * that is silently wrong on another database is worse in `BaseDialect` than an
   * error is.
   *
   * PostgreSQL's field is the seconds *including* full seconds, multiplied by a
   * thousand, so 59.75 seconds extracts as 59750: the whole second has to come
   * back off, which is what the `MOD` is for. The `FLOOR` comes before the cast
   * for `getSeconds`'s reason, that a cast rounds — 59750.9 would become 59751
   * and answer a millisecond the clock never showed — and JavaScript truncates
   * the microseconds it has no room for.
   */
  private millisecondOfSecond(target: SqlExpression): SqlExpression {
    const withSeconds = sql.sqlFunction('FLOOR', [
      sql.sqlFunction('EXTRACT', [sql.sqlLiteral('MILLISECONDS'), target]),
    ]);

    return sql.sqlFunction('MOD', [
      sql.sqlBinary('::', withSeconds, sql.sqlLiteral('int')),
      sql.sqlLiteral('1000'),
    ]);
  }

  /**
   * The sign as an `int`, which is what its TypeScript type already claims.
   *
   * PostgreSQL has `sign(numeric)` and `sign(double precision)`, so an integer
   * column goes through `numeric` and node-postgres hands the answer back as a
   * string. Casting is safe here in the way it is for the date parts and not for
   * a `decimal` column: the value is one of -1, 0, and 1, and nothing else can
   * come out of it. Null survives the cast as null.
   */
  protected override translateGlobal(
    method: string,
    args: readonly SqlExpression[],
  ): SqlExpression | null {
    // `Math.cbrt` lives here rather than in `BaseDialect` for `Math.trunc`'s
    // own reason read the other way: that one could be built from functions
    // every database has, and this one cannot. `POWER(x, 1.0 / 3)` looks like
    // the ANSI spelling and is wrong for a negative argument, since a
    // fractional power of a negative base is not a real number to the
    // function that computes it, where `Math.cbrt(-8)` is plainly -2.
    // PostgreSQL's own `CBRT` answers negative arguments correctly and is not
    // a name every database agrees on, which is `repeat`'s test for a
    // provider translation rather than a portable one.
    if (method === 'Math.cbrt') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('CBRT', args);
    }

    if (method === 'Math.log2') {
      this.expectArity(method, args, 1);
      return this.logarithm(args[0]!, '2');
    }

    if (method === 'Math.log10') {
      this.expectArity(method, args, 1);
      return this.logarithm(args[0]!, '10');
    }

    // The natural logarithm. SQL Server has no `LN` at all, spelling it and
    // `log10` both through the single-argument `LOG`, so this is `repeat`'s
    // test for a provider translation rather than a portable one: not every
    // targeted database would understand this name. Unlike `log2` and
    // `log10`, no two-argument dance is needed here, since PostgreSQL's `LN`
    // already has a `double precision` overload beside its `numeric` one; only
    // the answer is cast, for `Math.sign`'s own reason, since an int column
    // resolves to the `numeric` overload here too.
    if (method === 'Math.log') {
      this.expectArity(method, args, 1);
      return sql.sqlBinary('::', sql.sqlFunction('LN', args), sql.sqlLiteral('double precision'));
    }

    // The angle of a vector, as `Math.atan2(y, x)` computes it. PostgreSQL,
    // MySQL, and Oracle all spell this `ATAN2(y, x)`, in the same order
    // JavaScript takes it, which would make it a line in `MATH_FUNCTIONS`, but
    // SQL Server calls the same function `ATN2` instead. That is `repeat`'s
    // test for a provider translation rather than a portable one: the question
    // is not whether every database can compute this, but whether every one
    // would understand this text, and SQL Server would not understand
    // `ATAN2`. So it lives here rather than in `BaseDialect`, beside `getDay`.
    if (method === 'Math.atan2') {
      this.expectArity(method, args, 2);
      return sql.sqlFunction('ATAN2', args);
    }

    // `(EXP(x) - EXP(-x)) / 2` is the ANSI-looking identity and is `expm1`'s
    // trap again: for an `x` near zero, `EXP(x)` and `EXP(-x)` both round to
    // very nearly 1, and subtracting them throws away most of the significant
    // digits of an answer that is itself close to `x`. PostgreSQL's own
    // `SINH` (PostgreSQL 12+) is exact, and it is not a name every database
    // agrees on, since MySQL and SQL Server have neither `SINH` nor a
    // portable substitute, which is `repeat`'s test for a provider
    // translation rather than a portable one.
    if (method === 'Math.sinh') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('SINH', args);
    }

    // `SINH(x) / COSH(x)` would still carry `SINH`'s own cancellation near
    // zero into the numerator, the same trap a hand-built `(EXP(x) -
    // EXP(-x)) / (EXP(x) + EXP(-x))` falls into twice over. PostgreSQL's own
    // `TANH` (PostgreSQL 12+, the same release as `SINH`) is exact and is
    // `SINH`'s own case for living here rather than in `BaseDialect`: MySQL
    // and SQL Server have neither it nor a portable substitute.
    if (method === 'Math.tanh') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('TANH', args);
    }

    // `LN(x + SQRT(x * x + 1))` is the ANSI-looking identity, and it falls
    // into `sinh`'s own trap from a different direction: for a large
    // negative `x`, `SQRT(x * x + 1)` is nearly `-x`, so adding it to `x`
    // cancels most of the significant digits of an answer that is itself
    // large in magnitude. PostgreSQL's own `ASINH` (PostgreSQL 12+, the same
    // release as `SINH` and `TANH`) is exact, and MySQL and SQL Server have
    // neither it nor a portable substitute.
    if (method === 'Math.asinh') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('ASINH', args);
    }

    // `LN(x + SQRT(x * x - 1))` is the ANSI-looking identity, and its trap is
    // `asinh`'s own read backwards: for an `x` near the domain's edge at one,
    // `x * x` is itself near one, so subtracting one from it cancels most of
    // the significant digits before `SQRT` ever sees them, the same way
    // `x * x - 1` would ruin `Math.expm1`'s own identity near zero.
    // PostgreSQL's own `ACOSH` (PostgreSQL 12+, the same release as `SINH`,
    // `TANH`, and `ASINH`) is exact, and MySQL and SQL Server have neither it
    // nor a portable substitute.
    if (method === 'Math.acosh') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('ACOSH', args);
    }

    // `0.5 * LN((1 + x) / (1 - x))` is the ANSI-looking identity, and it is
    // `Math.log1p`'s own trap wearing a ratio: for an `x` near zero the
    // quotient is near one, so `LN` is handed a value whose distance from one
    // is exactly the part that rounded away, and the answer comes back zero
    // rather than the small but real arctangent. PostgreSQL's own `ATANH`
    // (PostgreSQL 12+, the same release as the rest of this family) is exact,
    // and MySQL and SQL Server have neither it nor a portable substitute.
    if (method === 'Math.atanh') {
      this.expectArity(method, args, 1);
      return sql.sqlFunction('ATANH', args);
    }

    const translated = super.translateGlobal(method, args);
    if (method !== 'Math.sign' || translated === null) return translated;
    return sql.sqlBinary('::', translated, sql.sqlLiteral('int'));
  }

  /**
   * A logarithm to a fixed base, as `Math.log2` and `Math.log10` ask for one.
   *
   * This is a provider translation for `getMilliseconds`'s reason rather than
   * `getDay`'s: the text is not merely unportable, it is portable and means
   * something else elsewhere. The standard writes `LOG(base, value)` and
   * PostgreSQL, Oracle, and MySQL agree, while SQL Server's `LOG` takes the
   * value first and the base second, so `LOG(2, x)` would compile there and
   * quietly answer the logarithm of two. Single-argument `LOG` is worse again:
   * base ten in PostgreSQL and natural in SQL Server and MySQL, which is also
   * why `Math.log10` is a call here rather than `LOG(x)` on its own, even
   * though PostgreSQL's single-argument form already means base ten: relying
   * on that would be true of this database and false of two others reading
   * the same text.
   *
   * The near neighbour that looks portable is `LN(x) / LN(2)`, and it is the
   * `FLOOR`-for-`Math.trunc` trap in another costume: it agrees to within a
   * rounding error everywhere except the powers of two anyone would test with,
   * where a double divides to 2.9999999999999996 rather than to 3. Being off
   * by an ulp exactly at the values that look right is why JavaScript has
   * `Math.log2` at all, so the exact function is the one to reach for; the same
   * risk sits at the powers of ten behind `Math.log10`.
   *
   * Two casts, both earning their place. `log(numeric, numeric)` is the only
   * two-argument form PostgreSQL has, and a `double precision` column does not
   * reach it on its own, since the cast that would take it there is an
   * assignment rather than an implicit one. The result then comes back
   * `numeric`, which node-postgres hands over as a string, where both
   * functions return a `number`, so it is cast back out, which loses nothing
   * a double was ever going to carry and keeps the type honest. That is
   * `getTime`'s trade, one function along.
   */
  private logarithm(value: SqlExpression, base: string): SqlExpression {
    const exact = sql.sqlFunction('LOG', [
      sql.sqlLiteral(base),
      sql.sqlBinary('::', value, sql.sqlLiteral('numeric')),
    ]);

    return sql.sqlBinary('::', exact, sql.sqlLiteral('double precision'));
  }

  /**
   * `Math.trunc` in PostgreSQL's own spelling of it.
   *
   * The base dialect builds the truncation from `FLOOR` and `CEILING` because
   * no two databases name the function alike, and pays for that with a `CASE`
   * that prints its argument three times. PostgreSQL has `TRUNC` for both
   * `numeric` and `double precision`, so the argument is evaluated and printed
   * once here, which is the whole reason to override a translation that was
   * already correct.
   */
  protected override truncated(value: SqlExpression): SqlExpression {
    return sql.sqlFunction('TRUNC', [value]);
  }

  /**
   * One element of an array column, counted the way `Array.prototype.at` counts.
   *
   * Two things separate the two. PostgreSQL subscripts from one where
   * JavaScript counts from zero, and a negative subscript is simply out of
   * range in PostgreSQL where JavaScript reads back from the end. Both are
   * settled in the index rather than left to the caller, so `at(-1)` is the
   * last element here as well.
   *
   * The sign cannot be known while compiling, since even a literal index
   * reaches a dialect as a bound parameter, so the `CASE` decides it per row.
   * An index past either end lands outside the array and reads as null, which
   * is what `at` returns for one too.
   */
  private element(target: SqlExpression, index: SqlExpression): SqlExpression {
    // Untyped, `$1 < 0` leaves PostgreSQL unable to choose among its many `<`
    // overloads, the same way an untyped `substring` bound does.
    const at = sql.sqlBinary('::', index, sql.sqlLiteral('int'));
    const one = sql.sqlLiteral('1');

    const fromStart = sql.sqlBinary('+', at, one);
    const fromEnd = sql.sqlBinary(
      '+',
      sql.sqlBinary('+', sql.sqlFunction('array_length', [target, one]), at),
      one,
    );

    return {
      kind: 'subscript',
      target,
      index: {
        kind: 'case',
        branches: [{ condition: sql.sqlBinary('<', at, sql.sqlLiteral('0')), result: fromEnd }],
        otherwise: fromStart,
      },
    };
  }

  /**
   * Part of an array column, as `Array.prototype.slice` reads it.
   *
   * The same two differences `at` settles, settled again over a pair of bounds:
   * PostgreSQL subscripts from one, and a negative subscript is out of range
   * where JavaScript reads back from the end. The sign of either bound is
   * unknowable while compiling, since even a literal reaches a dialect as a
   * bound parameter, so a `CASE` decides each one per row.
   *
   * The two bounds are adjusted differently, which is the thing to get right
   * rather than to copy from each other. JavaScript takes a half-open range of
   * zero-based indices and PostgreSQL an inclusive range of one-based
   * positions, so the start gains one and the end gains nothing: `slice(1, 3)`
   * is positions 2 through 3. An omitted end runs to the last element.
   *
   * Nothing clamps the bounds here, because PostgreSQL clamps a slice itself:
   * a range reaching past either end yields the elements that exist, and one
   * that has crossed over yields an empty array, which is what JavaScript
   * answers for both. That is the opposite of the string `slice`, whose
   * `SUBSTRING` needs a length that cannot go negative.
   *
   * The length is `CARDINALITY` rather than `array_length` for the reason the
   * base dialect gives: it answers zero for an empty array where the other
   * answers null, and a null bound would turn a slice of an empty array into a
   * null rather than into the empty array JavaScript returns.
   */
  private arraySlice(
    target: SqlExpression,
    start: SqlExpression,
    end: SqlExpression | undefined,
  ): SqlExpression {
    // Never null for an array: the base dialect answers CARDINALITY, and this
    // dialect does not override the array reading of length.
    const count =
      this.translateMember(target, 'length', 'array') ?? sql.sqlFunction('CARDINALITY', [target]);
    const zero = sql.sqlLiteral('0');

    // A bound counted from the end when negative, in PostgreSQL's positions.
    // `offset` is what the two ends differ by: a start becomes the position
    // after the index it names, an end is already the position it names.
    const bound = (value: SqlExpression, offset: number): SqlExpression => {
      const at = sql.sqlBinary('::', value, sql.sqlLiteral('int'));
      const shifted = (base: SqlExpression) =>
        offset === 0 ? base : sql.sqlBinary('+', base, sql.sqlLiteral(String(offset)));

      return {
        kind: 'case',
        branches: [
          {
            condition: sql.sqlBinary('<', at, zero),
            result: shifted(sql.sqlBinary('+', count, at)),
          },
        ],
        otherwise: shifted(at),
      };
    };

    return {
      kind: 'subscript',
      target,
      index: bound(start, 1),
      to: end === undefined ? count : bound(end, 0),
    };
  }

  /**
   * A number rounded to a fixed number of digits, as text.
   *
   * `toFixed` returns a string, so the result is cast to one rather than left a
   * number: a rounded `numeric` keeps its scale, which is what puts the trailing
   * zeros of `1.50` back that a float would have dropped.
   *
   * The cast to `numeric` is not decoration. PostgreSQL has no
   * `round(double precision, integer)` at all, so rounding a `float` column to a
   * number of digits fails outright without it. That, and the spelling of
   * `text`, are why this is not in the base dialect.
   *
   * The rounding itself is not adjusted and cannot portably be. JavaScript
   * rounds the binary double, where `1.005` is really 1.00499…, and answers
   * `1.00`; `numeric` is exact decimal and answers `1.01`. PostgreSQL is the
   * more defensible of the two, and it is not the same.
   */
  private fixed(target: SqlExpression, digits: SqlExpression): SqlExpression {
    const rounded = sql.sqlFunction('ROUND', [
      sql.sqlBinary('::', target, sql.sqlLiteral('numeric')),
      sql.sqlBinary('::', digits, sql.sqlLiteral('int')),
    ]);

    return sql.sqlBinary('::', rounded, sql.sqlLiteral('text'));
  }

  /**
   * The code point of the character at an index.
   *
   * `ASCII` is misnamed in PostgreSQL: over a UTF-8 database it returns the
   * Unicode code point of the first character, which is what `codePointAt`
   * reports. It is here rather than in the base dialect because that is not
   * true of the same name elsewhere, where `ASCII` gives up on anything outside
   * ASCII and a separate function handles the rest.
   *
   * Two adjustments. `SUBSTRING` counts from one where JavaScript counts from
   * zero, and reading outside a string gives an empty string here and
   * `undefined` there, so an empty result is turned back into null rather than
   * reaching `ASCII`, which would answer zero.
   *
   * What is not adjusted is which unit the index counts. PostgreSQL counts
   * characters and JavaScript counts UTF-16 code units, so the two agree for
   * text in the basic plane and part company after an astral character, where
   * JavaScript sees two units and PostgreSQL sees one.
   */
  private codePoint(target: SqlExpression, index: SqlExpression): SqlExpression {
    const at = sql.sqlBinary('::', index, sql.sqlLiteral('int'));
    const one = sql.sqlLiteral('1');
    const character = sql.sqlFunction('SUBSTRING', [target, sql.sqlBinary('+', at, one), one]);

    return sql.sqlFunction('ASCII', [sql.sqlFunction('NULLIF', [character, sql.sqlLiteral("''")])]);
  }

  /**
   * One level of nesting removed from an array column, as
   * `Array.prototype.flat` removes it from a JavaScript array.
   *
   * `unnest` is what does the removing, applied to the column and rebuilt into
   * an array with `ARRAY(...)`: every element of every inner array comes back
   * in one flat sequence. The metadata model allows exactly one level of `of`
   * and no deeper, so there is never a second level left for `unnest` to
   * remove by mistake the way it would over a genuinely deep structure.
   *
   * The translation is also the identity for a column that was never nested at
   * all, which is what `flat` answers for a plain array too: unnesting an
   * ordinary array and rebuilding it from what came back is the same array.
   *
   * `unnest` of a null array returns no rows rather than a null one, so
   * `ARRAY(SELECT unnest(x))` alone would turn a null column into `{}`. An
   * empty array is not what a missing one becomes anywhere else here, so the
   * null is read back explicitly instead of being lost to the rebuild.
   */
  private flattenedArray(target: SqlExpression): SqlExpression {
    const flattened: SqlExpression = {
      kind: 'subquery',
      prefix: 'ARRAY',
      select: {
        kind: 'select',
        distinct: false,
        columns: [{ expression: sql.sqlFunction('unnest', [target]), alias: 'element' }],
        from: { kind: 'unit', alias: 'unnest_src' },
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
    };

    return {
      kind: 'case',
      branches: [
        { condition: { kind: 'nullTest', operand: target, negated: false }, result: sql.SQL_NULL },
      ],
      otherwise: flattened,
    };
  }

  /**
   * `flatMap`'s own assembly, once the compiler has bound the callback to a
   * row over the unnested elements and translated it.
   *
   * The shape is `flat`'s with one more unnest folded in: rather than
   * rebuilding the elements themselves, the callback's translation is
   * unnested again over the row source the compiler built, so a callback
   * returning several elements per input contributes all of them rather than
   * one. `split` is the case the name suggests; a callback returning a plain
   * value has no reading here and reaches PostgreSQL as an argument `unnest`
   * does not accept, which the database refuses rather than this library
   * guessing at what was meant.
   *
   * The null guard is `flat`'s own: `unnest` of a null array returns no rows
   * rather than a null one, so the rebuild would otherwise turn a null column
   * into `{}`.
   */
  private flatMappedArray(
    target: SqlExpression,
    { elements, mapped }: { elements: SqlFrom; mapped: SqlExpression },
  ): SqlExpression {
    const flattened: SqlExpression = {
      kind: 'subquery',
      prefix: 'ARRAY',
      select: {
        kind: 'select',
        distinct: false,
        columns: [{ expression: sql.sqlFunction('unnest', [mapped]), alias: 'flattened' }],
        from: elements,
        joins: [],
        where: null,
        groupBy: [],
        having: null,
        setOperations: [],
        orderBy: [],
        limit: null,
        offset: null,
      },
    };

    return {
      kind: 'case',
      branches: [
        { condition: { kind: 'nullTest', operand: target, negated: false }, result: sql.SQL_NULL },
      ],
      otherwise: flattened,
    };
  }

  /**
   * Whether an array column holds a value, as `Array.prototype.includes` asks.
   *
   * `= ANY(...)` over an array is PostgreSQL's rather than the standard's,
   * which knows `ANY` only over a subquery, so this lives here. It is the
   * spelling to prefer over the containment operator `@>`, which would need the
   * value wrapped in an array of its own first.
   *
   * `includes` is the second method whose meaning depends on what it is called
   * on, after `indexOf`, and the first this library can tell apart: the
   * compiler now looks the declared column type up and hands it over, so a
   * `text` column still reaches the base dialect's `LIKE` and only a genuine
   * array comes here.
   *
   * Two edges part company with JavaScript, and both follow from null being
   * unknown rather than a value in SQL. An array holding a null answers null
   * rather than false for a value it does not hold, so a row is neither kept
   * nor rejected by a filter; and looking for null itself always answers null,
   * where JavaScript would have found it. An array with no elements at all
   * answers false, which is what JavaScript answers.
   */
  private arrayContains(target: SqlExpression, value: SqlExpression): SqlExpression {
    return sql.sqlBinary('=', value, sql.sqlFunction('ANY', [target]));
  }

  /**
   * Two arrays joined end to end, which is what `Array.prototype.concat` does
   * with an array argument.
   *
   * The base dialect refuses this method over an array and is right to keep
   * refusing it, since a database with no array type has nothing to spell it
   * with. What has changed is only that PostgreSQL has both an array type and
   * `targetType` to recognise one by, so the receiver's half of the old
   * refusal is answered; the argument's half is not, and is the reason this
   * translates one of `concat`'s two readings rather than both.
   *
   * JavaScript picks between them by looking at the argument as it runs: an
   * array is spliced in and anything else is appended whole. Nothing here can
   * look. `MethodTranslation` carries the type of the column the call was made
   * on and says nothing about the arguments, so an expression that is a bound
   * parameter could be either, and this takes the array reading — the one
   * `concat` is reached for — rather than guessing per call.
   *
   * `array_cat` rather than the `||` the same job is usually written with, and
   * the difference is not style. PostgreSQL resolves `||` over an array by the
   * argument's own type, choosing between `anyarray || anyarray` and
   * `anyarray || anyelement`, which is the very fork this cannot see. A bound
   * parameter reaches the database as an untyped literal, so both candidates
   * would match it and PostgreSQL would refuse the statement as ambiguous
   * rather than pick. `array_cat` takes two arrays and nothing else, so the
   * parameter is coerced to the receiver's own array type and the reading is
   * settled here rather than left to an inference that may not converge.
   *
   * The variadic form folds, since `array_cat` joins two arrays where
   * `concat` joins as many as it is given, and no argument at all answers the
   * receiver, which is what `[].concat()` does.
   */
  private arrayConcat(target: SqlExpression, args: readonly SqlExpression[]): SqlExpression {
    return args.reduce<SqlExpression>(
      (joined, next) => sql.sqlFunction('array_cat', [joined, next]),
      target,
    );
  }

  /**
   * An array column folded into one string, the way `Array.prototype.join`
   * folds an array.
   *
   * `array_to_string` is the inverse of the `string_to_array` behind `split`
   * and is PostgreSQL's rather than the standard's, which is why this is here
   * and not in the base dialect. No receiver but an array has this method in
   * JavaScript, so unlike `includes` and `indexOf` there is no second reading
   * to tell apart and no need to ask what the column's type is.
   *
   * The third argument is what makes the two languages agree about nulls, and
   * it is the reason this is not a bare two-argument call. `array_to_string`
   * drops a null element, where JavaScript writes an empty string in its place:
   * `['a', null, 'b'].join(',')` is `a,,b` in JavaScript and would be `a,b`
   * here. Naming the empty string as the replacement makes both answer `a,,b`.
   *
   * The empty array needed no case of its own: both sides answer the empty
   * string for it, so the agreement fell out rather than being arranged.
   *
   * What is not reconciled is a null array, which stays null here where
   * JavaScript has no such value to join. That is the reading every other array
   * translation takes, and `arrayPosition` takes it deliberately too.
   */
  private joined(target: SqlExpression, separator: SqlExpression): SqlExpression {
    return sql.sqlFunction('array_to_string', [target, separator, sql.sqlLiteral("''")]);
  }

  /**
   * Where an array column first holds a value, counted from zero.
   *
   * `array_position` is PostgreSQL's, and it counts from one and answers null
   * for a value it did not find, where JavaScript counts from zero and answers
   * -1. Subtracting one settles the first and a `COALESCE` the second, which is
   * one more step than the string reading of `indexOf` needs: `POSITION`
   * answers zero rather than null for an absent substring, so there the
   * subtraction lands on both edges at once.
   *
   * The `COALESCE` cannot stand alone, because `array_position` answers null
   * for two different questions: a value that is not there, and an array that
   * is not there. Only the second should stay null, so the `CASE` asks about
   * the array itself and lets the `COALESCE` speak for the value. That is the
   * distinction `lastIndexOf` makes with its own `CASE`, one argument along.
   *
   * Searching for null works and agrees with JavaScript. `array_position`
   * compares with `IS NOT DISTINCT FROM` semantics, so a null in the array is
   * found rather than merely unknown, which is what `[null].indexOf(null)`
   * answers too.
   */
  private arrayPosition(target: SqlExpression, value: SqlExpression): SqlExpression {
    const zeroBased = sql.sqlBinary(
      '-',
      sql.sqlFunction('array_position', [target, value]),
      sql.sqlLiteral('1'),
    );

    return {
      kind: 'case',
      branches: [
        {
          condition: { kind: 'nullTest', operand: target, negated: true },
          result: sql.sqlFunction('COALESCE', [zeroBased, sql.sqlLiteral('-1')]),
        },
      ],
      // No `ELSE`, so a null array reads as null rather than as "not found".
      otherwise: null,
    };
  }

  /**
   * The one character at an index, as `String.prototype.charAt` reads it.
   *
   * This is `slice`'s simple case and needs none of its machinery, because a
   * single character is a length of one and there is no second bound to
   * normalise. The index only has to move from zero-based to one-based, which
   * is the same shift `substring` makes.
   *
   * Every out-of-range index falls out as the empty string without a case of
   * its own, which is what JavaScript answers too. `SUBSTRING` takes the
   * characters a range covers, and a range past the end covers none; a negative
   * index puts the range before the string, where it covers none either. That
   * is the rarer kind of edge, where two languages disagree about everything
   * except the answer.
   *
   * The index is cast to int for the reason `substring`'s bounds are: left
   * untyped, a parameter beside an operator leaves PostgreSQL unable to choose
   * among its overloads.
   */
  private characterAt(target: SqlExpression, index: SqlExpression): SqlExpression {
    const at = sql.sqlBinary('::', index, sql.sqlLiteral('int'));

    return sql.sqlFunction('SUBSTRING', [
      target,
      sql.sqlBinary('+', at, sql.sqlLiteral('1')),
      sql.sqlLiteral('1'),
    ]);
  }

  /**
   * A half-open slice of a string, counted the way `String.prototype.slice`
   * counts.
   *
   * This is `substring`'s harder sibling. Both take a `[start, end)` range that
   * SQL spells as a start and a length, but `substring` clamps a negative bound
   * to zero where `slice` reads it back from the end, so each bound needs
   * normalising before the length can be worked out at all.
   *
   * Writing `n` for the string's length, a bound `b` becomes `n + b` when it is
   * negative and `b` otherwise, and is then held inside `[0, n]`. The slice is
   * `SUBSTRING(str, s + 1, e - s)`, where the one is `SUBSTRING` counting from
   * one, and the length is floored at zero so a range that ends before it
   * begins is the empty string rather than an error.
   *
   * The sign cannot be known while compiling, since even a literal bound
   * reaches a dialect as a parameter, so the `CASE` deciding it is emitted for
   * every bound rather than only the negative ones. That is `at`'s lesson, and
   * the reason this is longer than it reads.
   *
   * Both bounds are cast to int for the reason `substring`'s are: left untyped,
   * a parameter on either side of an operator leaves PostgreSQL unable to
   * choose among its overloads.
   */
  private sliced(
    target: SqlExpression,
    start: SqlExpression,
    end: SqlExpression | undefined,
  ): SqlExpression {
    const length = this.lengthOf(target);
    const zero = sql.sqlLiteral('0');

    // A bound counted from the end when negative, and held inside the string
    // either way, so nothing downstream has to think about it again.
    const bound = (value: SqlExpression): SqlExpression => {
      const at = sql.sqlBinary('::', value, sql.sqlLiteral('int'));
      return {
        kind: 'case',
        branches: [
          {
            condition: sql.sqlBinary('<', at, zero),
            result: sql.sqlFunction('GREATEST', [sql.sqlBinary('+', length, at), zero]),
          },
        ],
        otherwise: sql.sqlFunction('LEAST', [at, length]),
      };
    };

    const from = bound(start);
    // An omitted end runs to the end of the string, which is what JavaScript
    // does and what needs no normalising.
    const to = end === undefined ? length : bound(end);

    return sql.sqlFunction('SUBSTRING', [
      target,
      sql.sqlBinary('+', from, sql.sqlLiteral('1')),
      sql.sqlFunction('GREATEST', [sql.sqlBinary('-', to, from), zero]),
    ]);
  }

  /**
   * A string repeated, as `String.prototype.repeat` repeats it.
   *
   * `REPEAT` is PostgreSQL's and MySQL's spelling of a function the SQL
   * standard does not define at all: SQL Server calls it `REPLICATE` and Oracle
   * has no such function, so this lives here rather than in the base dialect,
   * as `getDay` does.
   *
   * The count is cast to int for the reason `substring`'s bounds are. Left
   * untyped, a bound parameter reaches `REPEAT` as an unknown and PostgreSQL
   * cannot choose between its overloads.
   *
   * Two edges part company with JavaScript, and neither can be closed here,
   * because a count reaches a dialect as a bound parameter rather than as a
   * literal and nothing downstream can branch on its value. A negative count
   * throws a `RangeError` in JavaScript and answers the empty string here, and
   * a fractional one is truncated there and rounded by the cast. Zero agrees:
   * both give the empty string.
   */
  private repeated(target: SqlExpression, count: SqlExpression): SqlExpression {
    return sql.sqlFunction('REPEAT', [target, sql.sqlBinary('::', count, sql.sqlLiteral('int'))]);
  }

  /**
   * The date as ISO 8601 text, which is what `Date.prototype.toISOString`
   * returns.
   *
   * `to_char` and its format model are PostgreSQL's; SQL Server spells the job
   * `FORMAT` or `CONVERT` with a numbered style, and no two format models agree
   * on a single letter. So this lives here rather than in the base dialect, as
   * `getDay` and `getTime` do.
   *
   * The format is JavaScript's exactly: four-digit year, `T`, a 24-hour clock,
   * three digits of milliseconds, and a literal `Z`. The double quotes inside
   * the model are what make `T` and `Z` literal text rather than fields.
   *
   * That `Z` is the part to be careful about, because it is an assertion rather
   * than a conversion. `to_char` renders a `timestamp` as stored and a
   * `timestamp with time zone` in the session's zone, so the text says UTC
   * whichever it was. It is therefore right for a `timestamp` column holding
   * UTC, which is the usual convention and what this library's own mappings
   * produce, and right for a `timestamptz` only when the session is UTC. A
   * dialect is handed an expression and not a type, so it cannot tell the two
   * apart and cannot choose the conversion for you; that is `indexOf`'s
   * predicament, and it is answered the same way, by saying in the README which
   * reading was taken.
   */
  private isoText(target: SqlExpression): SqlExpression {
    return sql.sqlFunction('to_char', [target, sql.sqlLiteral(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)]);
  }

  /**
   * Milliseconds since the Unix epoch, which is what `Date.prototype.getTime`
   * answers.
   *
   * `EPOCH` is PostgreSQL's own `EXTRACT` field rather than one the standard
   * defines, which is why this lives here and not in the base dialect, as
   * `getDay` does. It yields seconds carrying a fraction, so milliseconds are a
   * multiplication, and the part below a millisecond is floored away for the
   * reason `getSeconds` floors its own: it gives the millisecond the value is
   * in, where rounding could give one the value never reached.
   *
   * The cast is to double rather than to the int the other date parts take.
   * Milliseconds since the epoch passed two billion in 1970 and would overflow
   * an int. `bigint` would hold it and node-postgres would return it as a
   * string, protecting a precision that is not at risk here: a double carries
   * every integer up to two to the fifty-third exactly, and a millisecond count
   * is four orders of magnitude short of that.
   *
   * What the count is relative to is the divergence to know about. PostgreSQL
   * reads `EPOCH` from a `timestamp` as though the value were already UTC,
   * while node-postgres parses that same column into a `Date` in the machine's
   * zone, so the two disagree by the offset unless the column carries a time
   * zone or the process runs in UTC.
   */
  private epochMilliseconds(target: SqlExpression): SqlExpression {
    const seconds = sql.sqlFunction('EXTRACT', [sql.sqlLiteral('EPOCH'), target]);
    const milliseconds = sql.sqlBinary('*', seconds, sql.sqlLiteral('1000'));

    return sql.sqlBinary(
      '::',
      sql.sqlFunction('FLOOR', [milliseconds]),
      sql.sqlLiteral('double precision'),
    );
  }

  /**
   * Date parts the base dialect cannot spell, either because the standard has
   * no field for them or because reaching them takes a conversion no two
   * databases agree on.
   *
   * `getDay` is the first kind. `EXTRACT` in the standard knows only YEAR
   * through SECOND and the timezone fields, so a day of the week is each
   * database's own invention and they do not agree: MySQL numbers `DAYOFWEEK`
   * from one, SQL Server's `DATEPART` follows whatever `DATEFIRST` is set to.
   * `DOW` happens to number the week the way JavaScript does, Sunday zero
   * through Saturday six, so it needs no adjustment the way `getMonth` does.
   * `ISODOW` is the one to avoid: it calls Sunday seven.
   *
   * The `getUTC*` family is the second, and one reason covers all of it. YEAR
   * through SECOND are as standard as `EXTRACT` fields get and the base
   * dialect already extracts each of them for the plain counterpart;
   * what is not standard is pinning which zone it is read in, and that is
   * `getDay`'s lesson in its sharper form. `AT TIME ZONE` is portable text
   * that means opposite things either side of it: PostgreSQL turns a
   * `timestamptz` into a naive `timestamp` rendered in the named zone, while
   * SQL Server turns a naive `datetime2` into a `datetimeoffset`. The same
   * statement would compile everywhere and answer a different question in each
   * place, which is worse than the error the base dialect raises instead.
   *
   * What differs across the family is the second adjustment, not this one, and
   * the members were checked apart rather than read off each other. That
   * second adjustment is not always the same kind of thing either:
   * `getUTCMonth` subtracts one, because JavaScript numbers months from zero
   * and `EXTRACT` from one; `getUTCSeconds` floors, because SECOND is the one
   * field `EXTRACT` may answer with a fraction and PostgreSQL does; and the
   * three between them need neither, a day of the month, an hour of the day,
   * and a minute of the hour being numbered the same in both languages and
   * whole on both sides.
   *
   * `getUTCDay` is where the two kinds meet, and it is the only member that
   * belongs here twice over: a day of the week is not an `EXTRACT` field the
   * standard defines, so it would live in this dialect even without a zone to
   * pin, and pinning the zone is unportable on its own account. Neither
   * reason makes the other redundant, and it needs no second adjustment for
   * `getDay`'s reason rather than for the conversion's: DOW numbers Sunday
   * zero, which is what JavaScript numbers it.
   */
  private extraDatePart({ target, method, args }: MethodTranslation): SqlExpression | null {
    if (target === null) return null;

    if (method === 'getDay') {
      this.expectArity(method, args, 0);
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('DOW'), target]);
    }

    if (method === 'getUTCDay') {
      this.expectArity(method, args, 0);
      // The conversion and nothing else, and the two halves were measured
      // apart rather than one read off the other. DOW numbers Sunday zero
      // through Saturday six either side of a conversion, which is what
      // JavaScript numbers them, so there is nothing to adjust; ISODOW is
      // still the field to avoid, calling Sunday seven.
      //
      // That the conversion is needed at all was worth checking too, since a
      // weekday is a coarser thing than an hour and might have looked immune.
      // It is not: a session offset moves the date boundary, so the same
      // instant reads Tuesday in New York and Wednesday in UTC. A weekday is
      // the day of the month's answer inherited, for the same slice of rows.
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('DOW'), this.inUtc(target)]);
    }

    if (method === 'getUTCFullYear') {
      this.expectArity(method, args, 0);
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('YEAR'), this.inUtc(target)]);
    }

    if (method === 'getUTCMonth') {
      this.expectArity(method, args, 0);
      // Two adjustments, and they are independent: the conversion decides which
      // month the instant falls in, and the subtraction decides what that month
      // is called. `getUTCFullYear` needs only the first because a year has no
      // offset between the two languages, and the base dialect's `getMonth`
      // needs only the second because it does not pin the zone. Neither is a
      // reason to skip the other, and dropping the subtraction here would make
      // `getUTCMonth() === 0` find nothing at all, which is `getMonth`'s own
      // lesson arriving a second time.
      return sql.sqlBinary(
        '-',
        sql.sqlFunction('EXTRACT', [sql.sqlLiteral('MONTH'), this.inUtc(target)]),
        sql.sqlLiteral('1'),
      );
    }

    if (method === 'getUTCDate') {
      this.expectArity(method, args, 0);
      // The conversion alone, and for `getDate`'s reason rather than
      // `getUTCFullYear`'s: DAY and `getUTCDate` both number the month from
      // one, so there is nothing here to subtract the way `getUTCMonth` has to.
      // The day of the month is also the field where pinning the zone changes
      // the most answers. A session offset moves the year boundary for a few
      // hours out of a year and the day boundary for those same hours out of
      // every day, so an eastern session reads a different date from the same
      // `timestamptz` for a whole slice of the rows in a table rather than for
      // the handful sitting either side of New Year.
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('DAY'), this.inUtc(target)]);
    }

    if (method === 'getUTCHours') {
      this.expectArity(method, args, 0);
      // The conversion alone again, and this is the field the conversion was
      // most obviously for: HOUR and `getUTCHours` both count 0 through 23, so
      // there is nothing to subtract, and a session offset moves the hour for
      // every row of a table rather than for the slice sitting either side of a
      // date boundary. Where the calendar fields differ from UTC for a few
      // hours a day, an hour differs always.
      //
      // The field was still checked rather than read off `getUTCDate` sitting
      // above it. The `getUTC*` methods look like one job repeated and the rest
      // of the family does not agree, which is what the case below this one
      // measured for itself rather than reading off this one.
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('HOUR'), this.inUtc(target)]);
    }

    if (method === 'getUTCMinutes') {
      this.expectArity(method, args, 0);
      // MINUTE is standard and both sides count 0 through 59, so this is the
      // conversion alone, as `getUTCHours` is. What made it worth measuring is
      // the reverse of what made `getUTCHours` worth measuring: an hour is the
      // field a zone obviously moves, and a minute looks like the field a zone
      // cannot. It can. Kolkata is half an hour off UTC and Kathmandu three
      // quarters, so a session in either reads a different minute from the same
      // instant, and dropping the conversion here on the grounds that offsets
      // come in whole hours would be wrong for entire time zones rather than for
      // an edge case. This is the field where the case for the conversion is
      // least obvious and still holds, which is the argument for measuring a
      // member of a family rather than assuming the family agrees.
      return sql.sqlFunction('EXTRACT', [sql.sqlLiteral('MINUTE'), this.inUtc(target)]);
    }

    if (method === 'getUTCSeconds') {
      this.expectArity(method, args, 0);
      // Both halves, and the first member of the family to need a second
      // adjustment that is not a subtraction. SECOND is the one field EXTRACT
      // may answer with a fraction and PostgreSQL takes it up either side of
      // the conversion, so the FLOOR `getSeconds` needs is needed here too and
      // for its own reason rather than by inheritance.
      //
      // The conversion is the half whose case nearly runs out. Every zone in
      // use today is a whole number of minutes off UTC, so a session reads the
      // same second as UTC whatever it is set to, and `getUTCMinutes`' argument
      // about Kolkata and Kathmandu buys nothing a field further down. What is
      // left of the case is the pre-standard-time offsets PostgreSQL still
      // carries: an 1870 instant read in Amsterdam, Dublin, New York, or
      // Kolkata comes back with a second of 47, 56, 15, or 27 against UTC's 17,
      // those local mean times being seconds rather than minutes off. The
      // conversion is what makes the translation agree with JavaScript over
      // such a row, which is a narrow case and a real one.
      return sql.sqlFunction('FLOOR', [
        sql.sqlFunction('EXTRACT', [sql.sqlLiteral('SECOND'), this.inUtc(target)]),
      ]);
    }

    return null;
  }

  /**
   * The value read in UTC, so a date part taken from it does not depend on the
   * session that happens to be asking.
   *
   * This is what separates `getUTCFullYear` from `getFullYear`, and it is only
   * a difference for a column that carries a time zone. PostgreSQL stores a
   * `timestamptz` as an instant and renders it in the session's `TimeZone`
   * whenever anything looks at it, so a bare `EXTRACT(YEAR ...)` answers 2025
   * or 2024 for one and the same row depending on who is connected. `AT TIME
   * ZONE 'UTC'` converts the instant to a naive `timestamp` in UTC first, and
   * the extraction that follows has no zone left to vary with.
   *
   * A naive `timestamp` column is the reading this does *not* serve, and the
   * README says so rather than the translation guessing. Such a column is not
   * an instant at all, so there is no zone to convert from; PostgreSQL reads
   * `AT TIME ZONE 'UTC'` over one as an assertion instead — take this wall
   * clock to be UTC and give me the instant — and hands back a `timestamptz`
   * that the extraction then renders in the session's zone, putting back the
   * very dependence this exists to remove. For a naive column holding UTC,
   * which is this library's own convention, `getFullYear` already answers the
   * UTC year and is the method to reach for.
   *
   * The zone is a literal rather than a bound parameter because it has to be:
   * `AT TIME ZONE` takes a zone and not a value, and a placeholder there is a
   * syntax error rather than a slower way to say the same thing. Nothing the
   * caller wrote reaches it, so there is no text to escape.
   */
  private inUtc(target: SqlExpression): SqlExpression {
    return sql.sqlBinary('AT TIME ZONE', target, sql.sqlLiteral(`'UTC'`));
  }
}

/** Shared instance. The dialect is stateless, so one is enough per process. */
export const postgresDialect = new PostgresDialect();
