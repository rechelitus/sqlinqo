import { UnsupportedExpressionError } from '../errors.js';
import type { ColumnType } from '../metadata/entity.js';
import type { SqlExpression, SqlFrom } from './nodes.js';
import { sqlBinary, sqlFunction, sqlLiteral, valueParameter } from './nodes.js';

export interface MethodTranslation {
  /** The receiver of the call, or `null` for a global such as `Math.abs`. */
  readonly target: SqlExpression | null;
  readonly method: string;
  readonly args: readonly SqlExpression[];
  /**
   * The declared type of the column the call is made on, when the compiler
   * could work it out.
   *
   * A column read directly off a row has one; a column read back out of a
   * projection or a derived table has forgotten it and arrives as `null`. It
   * exists because a dialect is handed an expression and not a type, and a
   * method name does not always mean one thing: `includes` searches a string
   * for a substring and an array for an element, and no two databases spell
   * both the same way.
   */
  readonly targetType?: ColumnType | null;

  /**
   * The pattern and flags of a regular expression literal, present only for
   * `match` and `search`.
   *
   * A regex's flags choose the operator or function a dialect prints, which
   * has to be known while compiling and not merely at execution time, so they
   * cannot travel through `args` the way an ordinary value does; `args` is
   * empty for these methods and `regex.pattern` carries the compiled form of
   * the pattern text instead, already a bound value the way any other string
   * argument would be.
   */
  readonly regex?: { readonly pattern: SqlExpression; readonly flags: string };

  /**
   * The pieces `flatMap` needs to rebuild its result, present only for that
   * method.
   *
   * `elements` is a row source producing one row per unnested element of the
   * array column, under the name `element`, and `mapped` is the callback's
   * own translation over that row — already a value a dialect can read from
   * directly, the way `regex.pattern` is, since binding the callback's
   * parameter to a row is compiling a lambda and only the compiler does that.
   */
  readonly flatMap?: { readonly elements: SqlFrom; readonly mapped: SqlExpression };
}

/**
 * Everything a provider must supply for the printer and compiler to emit valid
 * SQL for one database.
 *
 * A provider package normally extends `BaseDialect` and overrides only the
 * handful of members where its database differs from the ANSI defaults.
 */
export interface SqlDialect {
  readonly name: string;

  /** Quotes a table or column name for this database. */
  quoteIdentifier(identifier: string): string;

  /** Placeholder text for the parameter at the given zero-based ordinal. */
  parameterPlaceholder(index: number): string;

  /**
   * Whether one placeholder may appear more than once for a single bound value.
   *
   * True for numbered placeholders such as `$1` or `:1`, where an occurrence
   * names the value it wants. False for positional ones such as `?`, where each
   * occurrence consumes the next value in order and repeating a placeholder
   * would silently shift every value after it.
   *
   * The printer shares placeholders when it can, which is what keeps two
   * clauses compiled from one expression identical as text. PostgreSQL requires
   * exactly that to match a `GROUP BY` item against the projection it groups.
   */
  readonly sharesParameters: boolean;

  /** String concatenation, which differs between `||`, `+`, and `CONCAT`. */
  concat(parts: readonly SqlExpression[]): SqlExpression;

  /** Renders the paging clause from already-printed limit and offset fragments. */
  formatPaging(limit: string | null, offset: string | null): string;

  /**
   * Renders a source of exactly one row, under the alias given.
   *
   * `defaultIfEmpty` joins against this. A `SELECT` with no `FROM` is what most
   * databases accept and what the SQL standard does not, so a database that
   * insists on something to select from names its own: Oracle's `DUAL`, DB2's
   * `SYSIBM.SYSDUMMY1`.
   */
  formatUnitTable(alias: string): string;

  /**
   * Renders the clause that reads inserted rows back, from already-printed
   * column fragments.
   *
   * `RETURNING` is what PostgreSQL, SQLite, and MariaDB call it and what the
   * SQL standard does not have at all; SQL Server writes `OUTPUT` and puts it
   * before the values rather than after them, so a dialect for one of those
   * has more to change than this string and should say so by refusing the
   * operator rather than by returning something that reads nearly right.
   */
  formatReturning(columns: readonly string[]): string;

  /**
   * Renders the clause that turns an insert into an upsert: on a conflicting
   * value in `conflictColumns`, set every one of `updateColumns` to the value
   * the insert would have written, rather than refuse the row.
   *
   * Unlike `formatReturning`, both arguments are raw column names rather than
   * already-printed fragments, because the assignment itself is as
   * dialect-specific as the keyword introducing it: `ON CONFLICT (...) DO
   * UPDATE SET col = EXCLUDED.col` is PostgreSQL's and SQLite's own spelling,
   * `EXCLUDED` included, where MySQL writes `ON DUPLICATE KEY UPDATE col =
   * VALUES(col)` and names no columns for the conflict at all, and SQL Server
   * has no single-statement equivalent. A dialect for one of those has more to
   * change than this string and should say so by refusing the operator rather
   * than by returning something that reads nearly right.
   */
  formatUpsert(conflictColumns: readonly string[], updateColumns: readonly string[]): string;

  /**
   * Narrows a value to a plain integer.
   *
   * The counted columns the windowed operators produce are exact numerics wide
   * enough that a driver may hand them back as strings rather than lose
   * precision — node-postgres does for `bigint` — where the operator's own type
   * says `number`. The cast is what makes that true, and it is a spelling rather
   * than a computation: `CAST(x AS INTEGER)` is the standard's, PostgreSQL also
   * writes `x :: int`, and MySQL insists on `SIGNED` instead, so a dialect for
   * one of those overrides this.
   */
  castToInt(value: SqlExpression): SqlExpression;

  /**
   * Maps a JavaScript method call onto a SQL expression.
   *
   * Return `null` to signal "not handled here" so the caller can fall back to
   * the base implementation or raise a precise error.
   */
  translateMethod(translation: MethodTranslation): SqlExpression | null;

  /**
   * Maps a property access such as `u.name.length` onto a SQL expression.
   *
   * `columnType` is the declared type of the column the property is read off,
   * when the compiler could work it out: a column read directly off a row has
   * one, and a column read back out of a projection or a derived table has
   * forgotten it and arrives as `null`. It exists because a dialect is handed
   * an expression and not a type, and `length` means different functions over
   * text and over an array.
   */
  translateMember(
    target: SqlExpression,
    property: string,
    columnType?: ColumnType | null,
  ): SqlExpression | null;
}

/**
 * Math functions the databases spell as the JavaScript name once upper-cased.
 *
 * Most of these are the ANSI names. `SIGN` is not one: the standard has `ABS`
 * and `POWER` and no sign function at all, and it is here for the reason
 * `REVERSE` is used in `lastPosition` — PostgreSQL, MySQL, SQL Server, Oracle,
 * and SQLite all spell it that way, so it is text every database this library
 * targets understands. A database without it overrides `translateMethod` and
 * answers the three-way `CASE` itself, which is what `localeCompare` already
 * emits for the string reading of the same question.
 */
const MATH_FUNCTIONS: Record<string, string> = {
  abs: 'ABS',
  // -1, 0, or 1, and null for null, which the CASE spelling of this would have
  // had to be careful about: a comparison against null is unknown, so a two
  // branch CASE with an ELSE would answer 0 for a row that has no value.
  sign: 'SIGN',
  floor: 'FLOOR',
  ceil: 'CEILING',
  round: 'ROUND',
  sqrt: 'SQRT',
  pow: 'POWER',
  // `EXP` is `SIN`'s case again: every targeted database spells and computes
  // it the same way, unlike the natural logarithm undoing it.
  exp: 'EXP',
  // Radians in and radians out, as `Math.sin` itself works, and `SIN` is
  // spelled and behaves identically on every database this library targets,
  // unlike `ATAN2` and `LN`: a name every one of them agrees on belongs here
  // rather than behind a provider's own translation.
  sin: 'SIN',
  // `COS` agrees with `SIN`'s own reason: every targeted database spells and
  // computes it the same way, so it costs nothing more than the entry.
  cos: 'COS',
  // `TAN` completes the pair `SIN` and `COS` started, for their own reason.
  tan: 'TAN',
  // Single-argument `ATAN` has no reading to disagree about the way `ATAN2`
  // does, so it is a portable name for the same reason `SIN` is.
  atan: 'ATAN',
  // `ASIN` agrees with `ATAN`'s own reason: a single argument leaves nothing
  // for a database to spell differently.
  asin: 'ASIN',
  // `ACOS` completes the inverse trio `ASIN` and `ATAN` started, for their
  // own reason.
  acos: 'ACOS',
  min: 'LEAST',
  max: 'GREATEST',
  // Evaluated once per row, which is what `Math.random` means in JavaScript and
  // what `sample` needs to shuffle with. A database whose plain random function
  // is evaluated once per statement, as SQL Server's `RAND` is, has to override
  // this with something per-row such as `CHECKSUM(NEWID())`.
  random: 'RANDOM',
};

/**
 * String methods that take no arguments and map onto a one-argument function.
 *
 * The trims are the ANSI `TRIM(LEADING ...)` and `TRIM(TRAILING ...)` forms
 * under the names every one of these databases actually implements. They strip
 * spaces, where JavaScript strips every kind of whitespace; see the note on
 * `BaseDialect`.
 */
const STRING_FUNCTIONS: Record<string, string> = {
  toLowerCase: 'LOWER',
  toLocaleLowerCase: 'LOWER',
  toUpperCase: 'UPPER',
  toLocaleUpperCase: 'UPPER',
  trim: 'TRIM',
  trimStart: 'LTRIM',
  trimEnd: 'RTRIM',
  // The names these two carried before ES2019 renamed them.
  trimLeft: 'LTRIM',
  trimRight: 'RTRIM',
};

/**
 * ANSI SQL behaviour shared by every provider.
 *
 * Subclasses must supply identifier quoting and parameter placeholders, since
 * no two databases agree on either.
 *
 * One divergence runs through the trimming functions. `TRIM`, `LTRIM`, and
 * `RTRIM` strip spaces, while `trim`, `trimStart`, and `trimEnd` in JavaScript
 * strip every kind of whitespace, tabs and newlines included. A column holding
 * a tab keeps it here and would not in JavaScript. Widening that would mean
 * naming a character set that no two databases spell the same way, and would
 * still fall short of the Unicode whitespace JavaScript recognises, so the
 * portable spelling is what is emitted.
 *
 * Another runs through `localeCompare`, whose ordering is the collation of the
 * column being compared rather than the locale of the JavaScript runtime. The
 * two often agree and need not: under a `C` collation `'a' < 'B'` is false,
 * where `'a'.localeCompare('B')` is negative.
 */
export abstract class BaseDialect implements SqlDialect {
  abstract readonly name: string;

  abstract quoteIdentifier(identifier: string): string;

  abstract parameterPlaceholder(index: number): string;

  /**
   * Numbered placeholders are the common case, so sharing is the default. A
   * provider whose placeholders are positional, as `?` is, must set this to
   * false and accept one placeholder per mention.
   */
  readonly sharesParameters: boolean = true;

  concat(parts: readonly SqlExpression[]): SqlExpression {
    if (parts.length === 0) return valueParameter('');
    return parts.reduce((left, right) => sqlBinary('||', left, right));
  }

  formatPaging(limit: string | null, offset: string | null): string {
    const clauses: string[] = [];
    if (limit !== null) clauses.push(`LIMIT ${limit}`);
    if (offset !== null) clauses.push(`OFFSET ${offset}`);
    return clauses.join(' ');
  }

  formatUnitTable(alias: string): string {
    // Accepted by PostgreSQL, MySQL, SQL Server, and SQLite. A dialect whose
    // database insists on a table to select from overrides this.
    return `(SELECT 1) AS ${this.quoteIdentifier(alias)}`;
  }

  formatReturning(columns: readonly string[]): string {
    return `RETURNING ${columns.join(', ')}`;
  }

  formatUpsert(conflictColumns: readonly string[], updateColumns: readonly string[]): string {
    const target = conflictColumns.map((name) => this.quoteIdentifier(name)).join(', ');
    const assignments = updateColumns
      .map((name) => {
        const quoted = this.quoteIdentifier(name);
        return `${quoted} = EXCLUDED.${quoted}`;
      })
      .join(', ');
    return `ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
  }

  castToInt(value: SqlExpression): SqlExpression {
    // Built as an ordinary two-argument call, with the `AS` the standard puts
    // between them left to the printer's map of such functions, as `EXTRACT`'s
    // `FROM` is.
    return sqlFunction('CAST', [value, sqlLiteral('INTEGER')]);
  }

  translateMethod({ target, method, args, targetType }: MethodTranslation): SqlExpression | null {
    if (target === null) return this.translateGlobal(method, args);

    const stringFunction = STRING_FUNCTIONS[method];
    if (stringFunction) {
      this.expectArity(method, args, 0);
      return sqlFunction(stringFunction, [target]);
    }

    switch (method) {
      case 'startsWith':
        this.expectArity(method, args, 1);
        return this.like(target, [args[0]!, sqlLiteral("'%'")]);

      case 'endsWith':
        this.expectArity(method, args, 1);
        return this.like(target, [sqlLiteral("'%'"), args[0]!]);

      case 'includes':
        this.expectArity(method, args, 1);
        return this.like(target, [sqlLiteral("'%'"), args[0]!, sqlLiteral("'%'")]);

      case 'concat': {
        // `String.prototype.concat` joins any number of arguments onto the
        // receiver, and none at all is `'a'.concat()`, which answers the
        // receiver untouched. Both fall out of handing the whole list to the
        // dialect's own `concat`, since it reduces a single part to that part.
        // Going through it rather than writing `||` here is what keeps a
        // database that spells the join `+` or `CONCAT` spelling it that way
        // in this case too.
        //
        // A null part makes the whole answer null, as it does for the `+` the
        // compiler already routes here, where JavaScript would have written
        // "null" into the string. Coalescing each part to an empty string would
        // close that gap and lose the difference between a row with no middle
        // name and one whose middle name is empty, so the SQL reading stands
        // and the README says so.
        if (targetType === 'array') {
          // PostgreSQL's `||` would take an array on the left, but it splices
          // an array argument in where `Array.prototype.concat` flattens
          // exactly one level and appends a non-array argument whole. Which was
          // meant cannot be read off an expression, so the call is refused
          // rather than answered with whichever reading is easier to emit.
          throw new UnsupportedExpressionError(
            '"concat" over an array column is not translated, since nothing here can tell an ' +
              'array argument to splice in from an element to append. Concatenate the rows in ' +
              'JavaScript once they are read.',
          );
        }
        return this.concat([target, ...args]);
      }

      case 'indexOf': {
        // A second argument is the index to start searching from, which
        // POSITION has no room for: it always searches the whole string.
        // Dropping it would answer a different question than the one asked.
        if (args.length !== 1) {
          throw new UnsupportedExpressionError(
            `"indexOf" expects one value to search for in a query but received ` +
              `${args.length} argument(s). An index to start searching from cannot be honoured, ` +
              'since POSITION searches the whole string.',
          );
        }

        // POSITION counts from one and answers zero for a substring it did not
        // find, where JavaScript counts from zero and answers -1. Subtracting
        // one reconciles both at once, which is why there is no CASE here.
        // The printer renders POSITION with its `IN` keyword rather than a comma.
        return sqlBinary('-', sqlFunction('POSITION', [args[0]!, target]), sqlLiteral('1'));
      }

      case 'lastIndexOf': {
        // A second argument bounds the search, which POSITION has no room for,
        // exactly as it has none for `indexOf`'s.
        if (args.length !== 1) {
          throw new UnsupportedExpressionError(
            `"lastIndexOf" expects one value to search for in a query but received ` +
              `${args.length} argument(s). An index to stop searching at cannot be honoured, ` +
              'since POSITION searches the whole string.',
          );
        }

        return this.lastPosition(target, args[0]!);
      }

      case 'normalize': {
        // The form is a keyword in SQL, `NORMALIZE(x, NFD)`, and a literal
        // argument reaches a dialect as a bound parameter, which can never
        // become a keyword. So the form is refused rather than dropped: the
        // default is the one both languages already agree on, and any other
        // would silently be ignored.
        if (args.length > 0) {
          throw new UnsupportedExpressionError(
            `"normalize" expects no argument in a query but received ${args.length}. ` +
              'The form is a keyword in SQL rather than a value, so it cannot be bound; ' +
              'only the default NFC form is translated.',
          );
        }
        return sqlFunction('NORMALIZE', [target]);
      }

      case 'replaceAll':
        this.expectArity(method, args, 2);
        return sqlFunction('REPLACE', [target, args[0]!, args[1]!]);

      case 'replace':
        // `REPLACE` changes every occurrence, which is what `replaceAll` means
        // and not what `replace` does: given a string to look for, JavaScript
        // stops after the first. Answering with every occurrence would be a
        // different question, and expressing "only the first" needs `OVERLAY`,
        // whose keyword argument syntax the printer cannot spell yet.
        throw new UnsupportedExpressionError(
          '"replace" changes only the first occurrence, which SQL\'s REPLACE cannot express. ' +
            'Use "replaceAll" when every occurrence should change.',
        );

      case 'localeCompare': {
        // The extra arguments choose a locale and a sensitivity, neither of
        // which a database comparison can be told about: it compares under the
        // collation the column already has. Silently dropping them would answer
        // a different question than the one asked.
        if (args.length !== 1) {
          throw new UnsupportedExpressionError(
            `"localeCompare" expects one value to compare against in a query but received ` +
              `${args.length} argument(s). A locale or options cannot be honoured, since the ` +
              "comparison runs under the column's own collation.",
          );
        }

        const other = args[0]!;
        return {
          kind: 'case',
          branches: [
            { condition: sqlBinary('<', target, other), result: sqlLiteral('-1') },
            { condition: sqlBinary('>', target, other), result: sqlLiteral('1') },
          ],
          otherwise: sqlLiteral('0'),
        };
      }

      case 'padStart':
      case 'padEnd': {
        // The pad string is optional in JavaScript and defaults to a space,
        // which is also what LPAD and RPAD assume when it is left out. It is
        // passed explicitly so the emitted call reads the same either way.
        if (args.length < 1 || args.length > 2) {
          throw new UnsupportedExpressionError(
            `"${method}" expects a target length and an optional pad string in a query ` +
              `but received ${args.length} argument(s).`,
          );
        }
        return sqlFunction(method === 'padStart' ? 'LPAD' : 'RPAD', [
          target,
          this.padWidth(target, args[0]!),
          args[1] ?? sqlLiteral("' '"),
        ]);
      }

      case 'getDate':
        this.expectArity(method, args, 0);
        // The day of the month, which is what JavaScript's `getDate` answers;
        // the day of the week is `getDay` and is a different field entirely.
        // DAY is one of the fields the standard defines for EXTRACT and both
        // sides number the month from one, so this is the extraction alone. The
        // neighbouring `getMonth` subtracts and this does not, which is the
        // difference between a field JavaScript counts from zero and one it
        // does not: the two were checked apart rather than read off each other.
        return sqlFunction('EXTRACT', [sqlLiteral('DAY'), target]);

      case 'getFullYear':
        this.expectArity(method, args, 0);
        // The printer renders EXTRACT with its `FROM` keyword rather than a comma.
        return sqlFunction('EXTRACT', [sqlLiteral('YEAR'), target]);

      case 'getHours':
        this.expectArity(method, args, 0);
        // Both count 0 through 23 and neither adjusts, so unlike `getMonth`
        // this is the extraction and nothing else. Which hour it is remains the
        // database's reading of the column: a `timestamp` gives the hour as
        // stored, and one carrying a zone is converted to the session's zone
        // first, where JavaScript would have used the runtime's.
        return sqlFunction('EXTRACT', [sqlLiteral('HOUR'), target]);

      case 'getMinutes':
        this.expectArity(method, args, 0);
        // MINUTE is one of the fields the standard defines for EXTRACT, and
        // both sides count 0 through 59, so this is the extraction alone. It is
        // a copy of `getHours` because the counts were checked and matched, not
        // because the names rhyme: PostgreSQL answers EXTRACT(SECOND ...) with
        // the fraction included, so the next field down will not come out this
        // way.
        return sqlFunction('EXTRACT', [sqlLiteral('MINUTE'), target]);

      case 'getMonth':
        this.expectArity(method, args, 0);
        // JavaScript numbers months from zero and SQL from one, so the two are
        // reconciled here rather than left for every caller to remember. A bare
        // EXTRACT would quietly make `getMonth() === 0` match nothing at all.
        return sqlBinary(
          '-',
          sqlFunction('EXTRACT', [sqlLiteral('MONTH'), target]),
          sqlLiteral('1'),
        );

      case 'getSeconds':
        this.expectArity(method, args, 0);
        // SECOND is the one field the standard lets EXTRACT answer with a
        // fraction, and PostgreSQL takes it up: a column holding 59.75 seconds
        // extracts as 59.750000 where JavaScript reports 59. So this is not the
        // copy of `getHours` and `getMinutes` the name suggests, and the gap is
        // closed here rather than left to a cast: rounding 59.75 gives a
        // sixtieth second no clock shows, where FLOOR gives the second the
        // value is in. A database that already answers whole seconds loses
        // nothing to the FLOOR, so it stays ANSI rather than moving into a
        // provider.
        return sqlFunction('FLOOR', [sqlFunction('EXTRACT', [sqlLiteral('SECOND'), target])]);

      default:
        return null;
    }
  }

  translateMember(
    target: SqlExpression,
    property: string,
    columnType?: ColumnType | null,
  ): SqlExpression | null {
    if (property !== 'length') return null;

    // `CARDINALITY` counts the elements of an array and `CHAR_LENGTH` the
    // characters of a string. JavaScript spells both `length`, so which one is
    // meant is the column's type to say and not the expression's to guess.
    // PostgreSQL also has `array_length`, which answers null for an empty array
    // where JavaScript answers zero; `CARDINALITY` answers zero and is the ANSI
    // spelling besides.
    if (columnType === 'array') return sqlFunction('CARDINALITY', [target]);
    return sqlFunction('CHAR_LENGTH', [target]);
  }

  protected translateGlobal(method: string, args: readonly SqlExpression[]): SqlExpression | null {
    const [namespace, name] = method.split('.');
    if (namespace !== 'Math' || !name) return null;

    const mapped = MATH_FUNCTIONS[name];
    if (mapped) return sqlFunction(mapped, args);

    if (name === 'trunc') {
      this.expectArity(method, args, 1);
      return this.truncated(args[0]!);
    }

    // `Math.hypot` is variadic, so it is not a line in `MATH_FUNCTIONS`, which
    // only ever passes its arguments through to a name of the same arity. The
    // sum of squares under a `SQRT` is the ANSI reading of what it computes,
    // built from two functions this dialect already has rather than named as
    // one of its own, and it agrees with JavaScript at the edges an empty
    // argument list reaches: `POWER` and `SQRT` of nothing summed is zero,
    // which is what `Math.hypot()` itself answers.
    if (name === 'hypot') {
      const squares: SqlExpression[] = args.map((argument) =>
        sqlFunction('POWER', [argument, sqlLiteral('2')]),
      );
      const sumOfSquares =
        squares.length === 0
          ? sqlLiteral('0')
          : squares.reduce((sum, square) => sqlBinary('+', sum, square));
      return sqlFunction('SQRT', [sumOfSquares]);
    }

    // `(EXP(x) + EXP(-x)) / 2` looks like `Math.expm1`'s own trap and is not
    // one: the two terms are added rather than subtracted, and near zero both
    // round to nearly 1, so the sum is nearly 2 with nothing cancelling away.
    // Built from `EXP`, which every dialect already has, rather than reaching
    // for a name they might not agree on the way `Math.sinh` has to.
    //
    // The negation is written as `0 - x` rather than a bare unary minus, for
    // `at`'s own reason: an argument that reaches here as a bound parameter
    // carries no type of its own, and a unary minus with nothing beside it to
    // infer one from is exactly what made `at(-1)` read correctly and fail on
    // contact. The literal `0` gives the subtraction a known type to resolve
    // against on either side.
    if (name === 'cosh') {
      this.expectArity(method, args, 1);
      const value = args[0]!;
      const exp = (operand: SqlExpression): SqlExpression => sqlFunction('EXP', [operand]);
      return sqlBinary(
        '/',
        sqlBinary('+', exp(value), exp(sqlBinary('-', sqlLiteral('0'), value))),
        sqlLiteral('2'),
      );
    }

    // `EXP(x) - 1` looks like the ANSI spelling and reintroduces exactly the
    // cancellation `Math.expm1` exists to avoid: for an `x` near zero, `EXP(x)`
    // is so close to 1 that the subtraction throws away most of the
    // significant digits, which is `Math.log2`'s `LN(x) / LN(2)` trap read the
    // other way round. No SQL dialect this library targets has a numerically
    // stable primitive for it, so it is refused by name rather than answered
    // with a translation that would be silently imprecise near the value it
    // was written for.
    if (name === 'expm1') {
      throw new UnsupportedExpressionError(
        '"Math.expm1" cannot be translated precisely: "EXP(x) - 1" loses precision for an "x" near ' +
          'zero, which is the reason JavaScript has this function rather than leaving it to the ' +
          'caller. Use "Math.exp(x) - 1" directly if that loss of precision does not matter here.',
      );
    }

    // `LN(1 + x)` is `expm1`'s trap the other way round: for an `x` near
    // zero, `1 + x` rounds back to 1 before `LN` ever sees it, and the answer
    // comes back zero rather than the small but real logarithm. That loss is
    // exactly what `Math.log1p` exists to avoid, and no SQL dialect this
    // library targets has a numerically stable primitive for it, so it is
    // refused by name rather than answered with a translation that would be
    // silently imprecise near the value it was written for.
    if (name === 'log1p') {
      throw new UnsupportedExpressionError(
        '"Math.log1p" cannot be translated precisely: "LN(1 + x)" loses precision for an "x" near ' +
          'zero, which is the reason JavaScript has this function rather than leaving it to the ' +
          'caller. Use "Math.log(1 + x)" directly if that loss of precision does not matter here.',
      );
    }

    return null;
  }

  /**
   * Builds a `LIKE` comparison from literal and parameter fragments.
   *
   * Wildcards inside a caller-supplied value are not escaped, which mirrors how
   * Entity Framework Core translates `Contains`: a value of `"50%"` matches more
   * rows than a strict reading would suggest. Escape the value yourself when
   * that matters.
   */
  protected like(target: SqlExpression, patternParts: readonly SqlExpression[]): SqlExpression {
    return sqlBinary('LIKE', target, this.concat(patternParts));
  }

  /**
   * The width to pad to, guarded against `LPAD`'s truncation.
   *
   * `LPAD` and `RPAD` cut a string that is already longer than the requested
   * width, where `padStart` and `padEnd` return it untouched. Padding to the
   * greater of the two lengths erases that difference without a `CASE`, and
   * costs nothing once the string is short enough to actually be padded.
   *
   * The length goes through `translateMember` so a dialect that spells it its
   * own way, as PostgreSQL spells it `LENGTH`, keeps doing so here.
   */
  protected padWidth(target: SqlExpression, width: SqlExpression): SqlExpression {
    return sqlFunction('GREATEST', [width, this.lengthOf(target)]);
  }

  /**
   * The position of the last occurrence of a substring, counted from zero.
   *
   * SQL has no backwards `POSITION`, so the search is turned around instead:
   * reverse both strings and the last occurrence becomes the first. What comes
   * back is a position in the reversed string, which is converted to one in the
   * original by subtracting it from where the match would have to start.
   *
   * Writing `n` for the string's length, `m` for the substring's, and `p` for
   * the position found in the reversed pair, the answer is `n - m + 1 - p`.
   * The one accounts for `POSITION` counting from one where JavaScript counts
   * from zero, which is the same adjustment `indexOf` makes.
   *
   * Unlike `indexOf`, the "not found" answer does not fall out of that
   * arithmetic: `p` is zero and `n - m + 1` is a real-looking index rather than
   * the -1 JavaScript reports, so a `CASE` is needed here where none was there.
   * It is written as a test on `p` rather than as a `COALESCE` over a `NULLIF`
   * because a null string has to stay null: `p = 0` is unknown for a null and
   * takes the else branch, which is null all the way down, where a `COALESCE`
   * would have answered -1 and claimed the substring was merely absent.
   *
   * An empty substring needs no case of its own. `POSITION` answers one for it,
   * so the arithmetic gives `n`, which is the length of the string and exactly
   * what `''.lastIndexOf('')` and `'abc'.lastIndexOf('')` return.
   *
   * `REVERSE` is not in the SQL standard, but every database with a provider
   * here spells it that way, as `LPAD` and `LTRIM` are spelled. A database
   * without it overrides this.
   */
  protected lastPosition(target: SqlExpression, search: SqlExpression): SqlExpression {
    const found = sqlFunction('POSITION', [
      sqlFunction('REVERSE', [search]),
      sqlFunction('REVERSE', [target]),
    ]);

    const start = sqlBinary(
      '-',
      sqlBinary('+', sqlBinary('-', this.lengthOf(target), this.lengthOf(search)), sqlLiteral('1')),
      found,
    );

    return {
      kind: 'case',
      branches: [{ condition: sqlBinary('=', found, sqlLiteral('0')), result: sqlLiteral('-1') }],
      otherwise: start,
    };
  }

  /**
   * A number with its fractional part dropped, which is a round toward zero.
   *
   * There is no name for this to add to `MATH_FUNCTIONS`. Oracle and PostgreSQL
   * spell it `TRUNC`, MySQL `TRUNCATE`, and SQL Server has no such function at
   * all and asks for `ROUND(x, 0, 1)`. Capability is not portability, and the
   * question for `BaseDialect` is whether every database would understand the
   * text rather than whether every database could do the thing, so this is
   * built from two functions they do agree on: `FLOOR` rounds toward negative
   * infinity, which is the truncation of a value at or above zero, and
   * `CEILING` rounds toward positive infinity, which is the truncation below
   * it. `FLOOR` alone would have been right for half the number line and
   * quietly wrong for the other half, which is the whole difference between
   * `Math.trunc(-2.5)` and `Math.floor(-2.5)`.
   *
   * What the `CASE` costs is worth counting rather than assuming. SQL has
   * nowhere to name a value for reuse inside one expression, so the argument is
   * printed three times, once in the test and once in each branch, and a
   * subquery or a function call as the argument is written out three times with
   * it. A dialect whose database has the function should override this and
   * print the argument once, as `PostgresDialect` does.
   *
   * A null argument stays null: the comparison is unknown, so the `CASE` falls
   * to its else branch and `FLOOR` of null is null.
   */
  protected truncated(value: SqlExpression): SqlExpression {
    return {
      kind: 'case',
      branches: [
        {
          condition: sqlBinary('<', value, sqlLiteral('0')),
          result: sqlFunction('CEILING', [value]),
        },
      ],
      otherwise: sqlFunction('FLOOR', [value]),
    };
  }

  /** The string's length in the dialect's own spelling of it. */
  protected lengthOf(target: SqlExpression): SqlExpression {
    return this.translateMember(target, 'length') ?? sqlFunction('CHAR_LENGTH', [target]);
  }

  protected expectArity(method: string, args: readonly SqlExpression[], expected: number): void {
    if (args.length !== expected) {
      throw new UnsupportedExpressionError(
        `"${method}" expects ${expected} argument(s) in a query but received ${args.length}.`,
      );
    }
  }
}
