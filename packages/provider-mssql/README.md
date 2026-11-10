# @sqlinqo/mssql

SQL Server provider for [`@sqlinqo/core`](https://www.npmjs.com/package/@sqlinqo/core): the dialect, an
[`mssql`](https://www.npmjs.com/package/mssql) backed driver, and a one-call context factory.

```bash
npm install @sqlinqo/core @sqlinqo/mssql mssql
```

`mssql` is a peer dependency, so your application controls the client version.

```ts
import { defineEntity } from '@sqlinqo/core';
import { createMssqlContext } from '@sqlinqo/mssql';

const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    age: { type: 'int' },
  },
});

const db = createMssqlContext({
  server: 'localhost',
  database: 'sqlinqo',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { trustServerCertificate: true },
  entities: { users: User },
});

const adults = await db.users.where((u, p) => u.age >= p.min, { min: 18 }).toArray();
await db.$close();
```

Pass an existing `ConnectionPool` as `pool` to share one with the rest of your application. When you
do, `$close()` leaves that pool open, since its lifetime belongs to whoever created it.

This provider targets **SQL Server 2022 and Azure SQL Database**. `Math.min`, `Math.max`,
`.normalize()`, and `toFixed`'s culture-aware `FORMAT` all rely on additions from that release; an
older instance refuses those statements at the database rather than here.

See the [repository README](https://github.com/rechelitus/sqlinqo#readme) for the full guide to
the query API. What follows is specific to T-SQL.

## What is not translated yet

**Writing through this library's own operators is not supported.** `insert`, `insertMany`,
`insertFrom`, `upsert`, `upsertMany`, and a `where(...).update(...)` or `where(...).delete()` that
reads rows back all rely on `SqlDialect.formatReturning`, which every one of those statements calls
unconditionally so the row it wrote can be read back. T-SQL's nearest equivalent, `OUTPUT`, sits in
a different place in each of the three statement kinds — before `VALUES` in an `INSERT`, after `SET`
in an `UPDATE`, after `FROM` in a `DELETE` — where this hook is asked only for the column list and is
always appended after the rest of the statement, a position `OUTPUT` cannot occupy in any of the
three. Answering with text that reads nearly right would compile in none of them, so every write
operator is refused here instead, exactly as the hook's own documentation asks a provider to do when
it cannot honour the contract.

Reading is unaffected, including inside `$transaction`. Issue a write with a raw statement through
the escape hatch in the meantime:

```ts
await db.$driver.execute({
  text: 'INSERT INTO users (name, age) OUTPUT inserted.id VALUES (@p0, @p1)',
  values: ['Ada', 36],
});
```

Supporting the write operators properly needs `SqlDialect` to say _where_ a returning clause goes,
not only what it says, which is a change to the shared printer rather than to this provider alone —
see `packages/core/src/sql/printer.ts`'s `insert`, `update`, and `delete` methods, each of which
currently appends `formatReturning`'s text at a fixed position of its own.

## Collation, not JavaScript equality

Every text comparison and search here — `LIKE`, `CHARINDEX`, `REPLACE`, `=` — runs under the
column's own collation rather than under JavaScript's case-sensitive, code-unit equality. Most
installations default to a case-insensitive collation, so:

```ts
db.users.select((u) => ({ i: u.name.indexOf('a') }));
```

reads 2 for a row named `'Ada'` in JavaScript and 0 here, matching the capital letter a
case-sensitive search would have skipped. This is a database setting no expression can see or
override, so it is a caveat rather than something a translation adjusts for — the same reading
`localeCompare` already gives for ordering, arriving here for search.

## Paging needs an ordering

`OFFSET ... FETCH NEXT ... ROWS ONLY` is the only paging clause T-SQL has, and unlike `LIMIT`/`OFFSET`
it cannot appear without a preceding `ORDER BY` — SQL Server refuses the statement outright rather
than returning an arbitrary page. Add `orderBy` before `take`, `skip`, `elementAt`, `chunk`, or any
other operator that pages; a query that pages with no ordering compiles here and fails at the
database with SQL Server's own error naming the missing `ORDER BY`.

## Date parts

`EXTRACT` has no T-SQL spelling; every date part goes through `DATEPART` instead, and `getDay` folds
in the session's `@@DATEFIRST` setting so the answer is 0 (Sunday) through 6 (Saturday) the way
JavaScript numbers it regardless of what that setting is. `datetime2`, what this library's
`timestamp` column type maps onto here, never carries a time zone, so `getUTCFullYear` and the rest
of that family are the same translation as their plain counterparts — there is no session-dependent
reading to remove, since a `datetime2` always answers the value stored. That is right for a column
holding UTC, this library's own convention, and is not a conversion the way it is on a database whose
timestamp type can carry a zone.

`getTime` reads through `DATEDIFF_BIG`, added in SQL Server 2016, which answers a `bigint` rather
than overflowing the `int` a plain `DATEDIFF` would past 1970. `toISOString` renders through
`CONVERT(..., 126)` with a literal `'Z'` appended, which is an assertion that the column holds UTC
rather than a conversion, for `datetime2`'s own reason: there is no zone stored to convert from.

## Strings

`LEN` stands in for `CHAR_LENGTH`, and trims trailing spaces before counting where JavaScript's
`.length` counts every character — a column holding `'ab  '` reports 2 here and 4 there.
`DATALENGTH` keeps the spaces but counts bytes, doubled for `nvarchar`'s UTF-16 storage, so neither
primitive agrees with JavaScript on a string ending in spaces; `LEN` is the closer of the two for
ordinary text.

`padStart`/`padEnd` are built from `REPLICATE`, `RIGHT`, and `LEFT`, since T-SQL has neither `LPAD`
nor `RPAD`. `toFixed` is built from `FORMAT` with an `'en-US'` culture pinned explicitly, since
`DECIMAL`'s scale must be a compile-time constant in T-SQL and the number of digits never reaches a
dialect as one — every argument arrives as a bound parameter, even one written as a literal in the
query — and `FORMAT` without a named culture renders under the server's own, which is a comma for
the decimal point in a great many of them.

`codePointAt` reads through `UNICODE`, which — unlike PostgreSQL's `ASCII`, despite the name — agrees
with JavaScript exactly as far as UTF-16 code units go and parts company the same way
`String.prototype.charCodeAt` would, past the basic multilingual plane.

## Numbers

T-SQL has no hyperbolic functions and none of the ANSI-looking identities built from `EXP` and `LN`
are numerically stable near the values they are usually tested with, so `Math.sinh`, `Math.cosh`'s
neighbours `Math.tanh`, `Math.asinh`, `Math.acosh`, and `Math.atanh` are refused by name. `Math.cbrt`
is built from `SIGN` and `POWER` of the magnitude, since `POWER(x, 1/3)` alone is wrong for a
negative `x`. `Math.log2` and the two-argument form generally take the value first and the base
second in T-SQL, the opposite order from PostgreSQL's, which the translation accounts for rather than
leaving to look portable. `Math.random()` seeds `RAND` from a fresh `NEWID()` per row, since a bare
`RAND()` is evaluated once for the whole statement rather than once per row.

There is no array column type in SQL Server, so an entity declaring one is not something this
provider can honour: do not declare `array` columns against it.
