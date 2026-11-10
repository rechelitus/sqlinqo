# Sqlinqo

A LINQ-style, strongly typed query layer for TypeScript, in the spirit of Entity Framework Core.

You write an ordinary TypeScript arrow function. The library reads the function's own source,
parses it into an expression tree, and translates that tree into parameterised SQL.

```ts
const adults = await db.users
  .where((u, p) => u.age >= p.minimumAge && u.isActive, { minimumAge: 18 })
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, label: u.name }))
  .take(20)
  .toArray();
```

```sql
SELECT "t0"."id" AS "id", "t0"."name" AS "label"
FROM "users" AS "t0"
WHERE "t0"."age" >= $1 AND "t0"."is_active"
ORDER BY "t0"."name" ASC
LIMIT 20
```

## Packages

| Package                                           | Description                                                   |
| ------------------------------------------------- | ------------------------------------------------------------- |
| [`@sqlinqo/core`](packages/core)                  | Entity metadata, lambda parser, expression IR, SQL compiler.  |
| [`@sqlinqo/postgres`](packages/provider-postgres) | PostgreSQL dialect and driver, built on node-postgres.        |
| [`@sqlinqo/mssql`](packages/provider-mssql)       | SQL Server dialect and driver, built on the `mssql` package.  |
| [`@sqlinqo/cli`](packages/cli)                    | Scaffolds entity definitions from an existing schema.         |
| [`examples/basic-pg`](examples/basic-pg)          | A runnable tour of the query API for testing the PG provider. |

## Install

```bash
npm install @sqlinqo/core @sqlinqo/postgres pg
```

`pg` is a peer dependency, so your application controls the client version.

A SQL Server target reaches for [`@sqlinqo/mssql`](packages/provider-mssql) instead, whose own README
documents where T-SQL parts ways with the examples below: paging needs an ordering, string search
runs under the column's collation rather than JavaScript equality, and writing through this
library's own operators is not yet supported pending a change to the shared printer.

## Getting started

Describe the model once. The row type is derived from the mapping, so nothing is written twice.

```ts
import { defineEntity } from '@sqlinqo/core';
import type { EntityOf } from '@sqlinqo/core';
import { createPostgresContext } from '@sqlinqo/postgres';

const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    name: { type: 'text' },
    age: { type: 'int' },
    cityId: { type: 'int', column: 'city_id', nullable: true },
    isActive: { type: 'boolean', column: 'is_active' },
  },
});

type User = EntityOf<typeof User>;
// { id: number; name: string; age: number; cityId: number | null; isActive: boolean }

const db = createPostgresContext({
  connectionString: process.env.DATABASE_URL,
  entities: { users: User },
});
```

If the tables already exist, [`@sqlinqo/cli`](packages/cli) writes that model for you, reading the
schema and generating one file per table with a navigation for each end of every foreign key:

```bash
npx @sqlinqo/cli scaffold --url "$DATABASE_URL" --out src/entities
```

Then query it. Every operator returns a new query, and nothing reaches the database until a
terminal operator runs.

```ts
const page = await db.users
  .where((u) => u.cityId !== null)
  .orderByDescending((u) => u.age)
  .thenBy((u) => u.name)
  .skip(20)
  .take(10)
  .toArray();
```

`toSQL()` renders a query without running it, which is the fastest way to see what a lambda
translates into:

```ts
console.log(db.users.where((u) => u.age > 18).toSQL());
// { text: 'SELECT ... WHERE "t0"."age" > $1', values: [18] }
```

## The parameter bag

A lambda's source is all the library can see. A variable captured from the enclosing scope leaves
no trace in that source, so instead of guessing, the library asks for it explicitly through a
second lambda parameter:

```ts
const minimumAge = 18;

// Rejected: `minimumAge` cannot be recovered from the function source.
db.users.where((u) => u.age >= minimumAge);

// Correct: the value travels in the parameter bag.
db.users.where((u, p) => u.age >= p.minimumAge, { minimumAge });
```

This is not only a workaround. Bag references stay symbolic all the way through compilation, so
the same statement text is produced for every value of `minimumAge` and can be cached and reused,
which is how Entity Framework Core's query plan cache behaves. Values are always bound as
placeholders, never interpolated, so a query cannot be injected into.

A query can travel in the bag too, marked with `asValues` so a lambda elsewhere can test membership
against it the way it already tests membership in an array:

```ts
const vip = db.orders
  .where((o) => o.total > 1000)
  .select((o) => o.userId)
  .asValues();
const customers = await db.users.where((u, p) => p.vip.includes(u.id), { vip }).toArray();
// ... WHERE id IN (SELECT user_id FROM orders WHERE total > 1000)
```

`vip` is still a `Queryable`, not a captured array: `asValues` only changes what TypeScript sees it
as, and the query it names travels through the bag exactly as any other value does, renumbered
against this statement's own parameters rather than issued separately. It is built once and tested
against every row rather than recomputed per row, which is what tells it apart from a collection
navigation's own `some`/`every`: reach for those when the question is about rows matching this one,
and for `asValues` when it is about membership in a query built from scratch. Combine it with other
conditions the way any other predicate composes, since it is a value in the bag and not a whole
query on its own the way `intersectBy` is.

## What translates today

| JavaScript                                                                                              | SQL                                                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `u.age > 18`, `&&`, `\|\|`, `!`                                                                         | comparison, `AND`, `OR`, `NOT`                       |
| `u.cityId === null`                                                                                     | `IS NULL` / `IS NOT NULL`                            |
| `u.a ?? u.b`                                                                                            | `COALESCE`                                           |
| `u.age > 65 ? 'senior' : 'standard'`                                                                    | `CASE WHEN ... THEN ... ELSE ... END`                |
| `u.name.toLowerCase()`, `.toUpperCase()`, `.trim()`                                                     | `LOWER`, `UPPER`, `TRIM`                             |
| `u.name.trimStart()`, `.trimEnd()`                                                                      | `LTRIM`, `RTRIM`                                     |
| `u.name.replaceAll(a, b)`                                                                               | `REPLACE`, which changes every occurrence            |
| `u.name.normalize()`                                                                                    | `NORMALIZE(x)`, the NFC form                         |
| `u.name.split(',')`                                                                                     | `string_to_array(x, sep)`, PostgreSQL only           |
| `u.name.repeat(3)`                                                                                      | `REPEAT(x, n)`, PostgreSQL only                      |
| `u.name.localeCompare(x)`                                                                               | `CASE` yielding -1, 0, or 1                          |
| `u.name.indexOf(s)`                                                                                     | `POSITION(s IN x) - 1`, so -1 when absent            |
| `u.name.lastIndexOf(s)`                                                                                 | `POSITION` over both strings reversed                |
| `u.tags.at(0)`, `.at(-1)` on an array column                                                            | a subscript, PostgreSQL only                         |
| `u.tags.length` on an array column                                                                      | `CARDINALITY(x)`, zero for an empty array            |
| `u.tags.includes('x')` on an array column                                                               | `$1 = ANY(x)`, PostgreSQL only                       |
| `u.tags.indexOf('x')` on an array column                                                                | `array_position` less one, -1 when absent            |
| `u.tags.join(', ')` on an array column                                                                  | `array_to_string(x, sep, '')`, PostgreSQL only       |
| `u.tags.concat(other)` on an array column                                                               | `array_cat(x, y)`, an array argument only, PG only   |
| `u.name.startsWith(p.x)`, `.endsWith`, `.includes`                                                      | `LIKE` with `\|\|` concatenation                     |
| `u.name.match(/^A/)`                                                                                    | `~`, or `~*` for the `i` flag, PostgreSQL only       |
| `u.name.search(/^A/)`                                                                                   | `regexp_instr(x, p) - 1`, PostgreSQL 15+             |
| `u.name.concat(x, y)`                                                                                   | `\|\|` between every part, null if any is null       |
| `u.name.length`                                                                                         | `LENGTH` / `CHAR_LENGTH`                             |
| `u.name.codePointAt(i)`                                                                                 | `ASCII` of one character, PostgreSQL only            |
| `u.age.toFixed(2)`                                                                                      | `ROUND(x::numeric, n)::text`, PostgreSQL only        |
| `u.sku.substring(0, 3)`                                                                                 | `SUBSTRING(x, 1, 3)`                                 |
| `u.name.charAt(0)`                                                                                      | `SUBSTRING(x, i + 1, 1)`, PostgreSQL only            |
| `u.sku.slice(-3)`, `.slice(1, 3)`                                                                       | `SUBSTRING` with each bound normalised, PG only      |
| `u.sku.padStart(8, '0')`, `.padEnd`                                                                     | `LPAD` / `RPAD`, never truncating                    |
| `u.createdAt.getFullYear()`                                                                             | `EXTRACT(YEAR FROM x)`                               |
| `u.createdAt.getUTCFullYear()`                                                                          | `EXTRACT(YEAR FROM x AT TIME ZONE 'UTC')`, PG only   |
| `u.createdAt.getMonth()`                                                                                | `EXTRACT(MONTH FROM x) - 1`, zero-based              |
| `u.createdAt.getUTCMonth()`                                                                             | that minus one, read in UTC, PostgreSQL only         |
| `u.createdAt.getDate()`                                                                                 | `EXTRACT(DAY FROM x)`, the day of the month          |
| `u.createdAt.getUTCDate()`                                                                              | `EXTRACT(DAY FROM x AT TIME ZONE 'UTC')`, PG only    |
| `u.createdAt.getDay()`                                                                                  | `EXTRACT(DOW FROM x)`, PostgreSQL only               |
| `u.createdAt.getUTCDay()`                                                                               | `EXTRACT(DOW FROM x AT TIME ZONE 'UTC')`, PG only    |
| `u.createdAt.getHours()`                                                                                | `EXTRACT(HOUR FROM x)`, 0 through 23                 |
| `u.createdAt.getUTCHours()`                                                                             | `EXTRACT(HOUR FROM x AT TIME ZONE 'UTC')`, PG only   |
| `u.createdAt.getMinutes()`                                                                              | `EXTRACT(MINUTE FROM x)`, 0 through 59               |
| `u.createdAt.getUTCMinutes()`                                                                           | `EXTRACT(MINUTE FROM x AT TIME ZONE 'UTC')`, PG only |
| `u.createdAt.getSeconds()`                                                                              | `FLOOR(EXTRACT(SECOND FROM x))`, whole second        |
| `u.createdAt.getUTCSeconds()`                                                                           | `FLOOR(EXTRACT(SECOND ... AT TIME ZONE 'UTC'))`, PG  |
| `u.createdAt.getMilliseconds()`                                                                         | `MOD` of `EXTRACT(MILLISECONDS ...)`, PG only        |
| `u.createdAt.getTime()`                                                                                 | `FLOOR(EXTRACT(EPOCH ...) * 1000)`, PG only          |
| `u.createdAt.toISOString()`                                                                             | `to_char` with JavaScript's format, PG only          |
| `Math.abs`, `floor`, `ceil`, `round`, `sqrt`, `pow`, `sin`, `cos`, `tan`, `exp`, `asin`, `acos`, `atan` | `ABS`, `FLOOR`, `CEILING`, ...                       |
| `Math.trunc(u.score)`                                                                                   | `FLOOR` or `CEILING` by sign, `TRUNC` on PG          |
| `Math.sign(u.balance)`                                                                                  | `SIGN`, cast to `int` on PG                          |
| `Math.hypot(u.dx, u.dy)`                                                                                | `SQRT(POWER(x, 2) + POWER(y, 2) + ...)`              |
| `Math.cosh(u.x)`                                                                                        | `(EXP(x) + EXP(0 - x)) / 2`                          |
| `Math.cbrt(u.volume)`                                                                                   | `CBRT`, PostgreSQL only                              |
| `Math.sinh(u.x)`                                                                                        | `SINH`, PostgreSQL only                              |
| `Math.tanh(u.x)`                                                                                        | `TANH`, PostgreSQL only                              |
| `Math.asinh(u.x)`                                                                                       | `ASINH`, PostgreSQL only                             |
| `Math.acosh(u.x)`                                                                                       | `ACOSH`, PostgreSQL only                             |
| `Math.atanh(u.x)`                                                                                       | `ATANH`, PostgreSQL only                             |
| `Math.log2(u.value)`                                                                                    | `LOG(2, x :: numeric)`, PostgreSQL only              |
| `Math.atan2(u.dy, u.dx)`                                                                                | `ATAN2(y, x)`, PostgreSQL only                       |
| `Math.log10(u.value)`                                                                                   | `LOG(10, x :: numeric)`, PostgreSQL only             |
| `Math.log(u.value)`                                                                                     | `LN(x) :: double precision`, PostgreSQL only         |
| `p.ids.includes(u.id)`                                                                                  | `IN ($1, $2, ...)`                                   |
| `p.vipIds.includes(u.id)`, where `vipIds` is a query marked with `asValues`                             | `IN (subquery)`                                      |
| `where`, `select`, `orderBy`, `thenBy`, `skip`, `take`, `distinct`                                      | the matching SQL clauses                             |
| `order()`, `orderDescending()` over a scalar projection                                                 | `ORDER BY` the projected column itself               |
| `sample(n)`, `Math.random()`                                                                            | `ORDER BY RANDOM() LIMIT n`                          |
| `takeWhile`, `skipWhile` on an ordered query                                                            | a running count in a window                          |
| `zip` of two or three ordered queries                                                                   | `ROW_NUMBER` on each side, joined on it              |
| `sequenceEqual` of two ordered queries                                                                  | `ROW_NUMBER` each side, `FULL JOIN`, `NOT EXISTS`    |
| `distinctBy` on an ordered query                                                                        | `ROW_NUMBER` per key, keeping the first              |
| `takeBy(key, n)`, `skipBy(key, n)` on an ordered query                                                  | the same window, a range instead of the first        |
| `pairwise` on an ordered query                                                                          | `LAG` of every column, less the first row            |
| `windowed(n, ...)` on an ordered query                                                                  | `ROWS BETWEEN n - 1 PRECEDING AND CURRENT ROW`       |
| `expanding` on an ordered query                                                                         | `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`   |
| `windowedBy(key, n, ...)`, `expandingBy(key, ...)`                                                      | the same frames, plus `PARTITION BY`                 |
| `index` on an ordered query, or `select`/`where` with a second parameter                                | `ROW_NUMBER` over the ordering, less one             |
| `rank`, `denseRank` on an ordered query                                                                 | `RANK` / `DENSE_RANK` over the ordering              |
| `chunkBy` on an ordered query                                                                           | `LAG` for the break, `SUM` for the run               |
| `reverse` on an ordered query                                                                           | every sort key flipped                               |
| `last`, `lastOrDefault` on an ordered query                                                             | flipped keys, `first`/`firstOrDefault` of that       |
| `takeLast(n)` on an ordered query                                                                       | flipped keys and `LIMIT n`, sorted back              |
| `skipLast(n)` on an ordered query                                                                       | flipped keys and `OFFSET n`, sorted back             |
| `join`, `leftJoin`, `rightJoin`, `fullJoin`                                                             | `INNER` / `LEFT` / `RIGHT` / `FULL JOIN`             |
| `join(..., (o, u) => ({ order: o, user: u }))`                                                          | every embedded row's columns, prefixed and folded    |
| `groupJoin(other, key, otherKey, result)`                                                               | a correlated subquery per aggregate asked for        |
| `orders.toArray()` in a `groupJoin` or `groupBy` result selector                                        | `json_agg(json_build_object(...))`, PostgreSQL only  |
| `o.user.name` through a `reference`                                                                     | a join added by the clause that reads it             |
| `u.tags.slice(1, 3)` on an array column                                                                 | `x[i:j]`, PostgreSQL only                            |
| `u.grid.flat()` on an `array` of `array` column                                                         | `ARRAY(SELECT unnest(x))`, PostgreSQL only           |
| `u.tags.flatMap((tag) => tag.split('-'))` on an array column                                            | `ARRAY(SELECT unnest(f(x)))`, PostgreSQL only        |
| `u.orders.count()`, `.sum((o) => o.total)`, `.min`, `.max`, `.average`                                  | a correlated subquery per aggregate                  |
| `u.orders.some((o) => ...)`, `.every(...)` through a `collection`                                       | `EXISTS` / `NOT EXISTS` over a correlated subquery   |
| `include((u) => u.orders)`, `include((o) => o.user)`                                                    | a second statement with `IN` over the keys           |
| `thenInclude((o) => o.lines)` after an `include`                                                        | one more statement, per hop rather than per row      |
| `include((u) => u.orders, (q) => q.where(...))`                                                         | the filter inside the statement that reads them      |
| `include((u) => u.orders, (q) => q.orderBy(...).take(10))`                                              | `ROW_NUMBER` per parent, ten rows each               |
| `include((u) => u.orders).asSingleStatement()`                                                          | `LEFT JOIN`, matches recognised by primary key       |
| `selectMany` over a `collection` or a query                                                             | `INNER JOIN` on the key / `CROSS JOIN`               |
| `selectMany((u) => u.orders, (q) => q.orderBy(...).take(3), ...)`                                       | `CROSS JOIN LATERAL`, correlated per outer row       |
| `union`, `concat`, `intersect`, `except`                                                                | `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`          |
| `append(row)`, `prepend(row)`                                                                           | `UNION ALL` with a literal row, no table needed      |
| `defaultIfEmpty()`, `defaultIfEmpty(row)`                                                               | `LEFT JOIN` from a source of one row                 |
| `exceptBy(other, key, otherKey)`                                                                        | `NOT EXISTS` over a correlated subquery              |
| `intersectBy(other, key, otherKey)`                                                                     | `EXISTS` over a correlated subquery                  |
| `groupBy(key, result)`, and a filter after it                                                           | `GROUP BY ...`, `HAVING ...`                         |
| `groupBy(key)`, no result selector                                                                      | `SELECT DISTINCT key`, then one `WHERE` per key      |
| `countBy((u) => u.cityId)`                                                                              | `GROUP BY x` with a `COUNT(*)` beside it             |
| `sumBy((o) => o.userId, (o) => o.total)`                                                                | `GROUP BY x` with a `SUM(y)` beside it               |
| `g.count()`, `g.sum`, `g.average`, `g.min`, `g.max`                                                     | `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`                  |
| `g.countDistinct((row) => row.x)`                                                                       | `COUNT(DISTINCT x)`, counting null as a value        |
| `elementAt(i)`, `elementAtOrDefault(i)`                                                                 | `LIMIT 1 OFFSET i`                                   |
| `elementAt(-n)` on an ordered query                                                                     | flipped keys, `LIMIT 1 OFFSET n - 1`                 |
| `chunk(n)`                                                                                              | one `LIMIT n OFFSET ...` per batch                   |
| `after(row)` on an ordered query                                                                        | a lexicographic `WHERE` over the sort keys           |
| `before(row)` on an ordered query                                                                       | that comparison mirrored, over flipped sort keys     |
| `average((u) => u.age)`                                                                                 | `AVG(x)` over a wrapping subquery                    |
| `sum((u) => u.total)`                                                                                   | `COALESCE(SUM(x), 0)`, so empty is zero              |
| `min((u) => u.createdAt)`, `max`                                                                        | `MIN(x)` / `MAX(x)`, any orderable column            |
| `minBy((u) => u.age)`, `maxBy`                                                                          | `orderBy`/`orderByDescending` then `LIMIT 1`         |
| `countDistinct((u) => u.cityId)`                                                                        | `COUNT(DISTINCT x)`, counting null as a value        |
| `toArray`, `first`, `single`, `count`, `any`, `all`                                                     | execution                                            |
| `count((u) => u.isActive)`                                                                              | `count`'s own statement over the filter              |
| `longCount()`                                                                                           | `count`'s own statement, read back as a `bigint`     |
| `toDictionary(key)`                                                                                     | `toArray`, folded into a `Map` in JavaScript         |
| `toLookup(key)`                                                                                         | `toArray`, folded into a `Map` of arrays             |
| `toHashSet()`                                                                                           | `toArray`, folded into a `Set` in JavaScript         |
| `aggregate(seed, fn)`                                                                                   | `toArray`, reduced in JavaScript, no SQL involved    |
| `aggregateBy(key, seed, fn)`                                                                            | `toArray`, reduced per key in JavaScript             |
| `contains(value)` over a scalar projection                                                              | `COUNT(*)` over a null-tolerant `WHERE`, `LIMIT 1`   |
| `insert(row)`, `insertMany(rows)`                                                                       | `INSERT ... VALUES ... RETURNING`                    |
| `insertFrom(query)`                                                                                     | `INSERT ... SELECT ... RETURNING`                    |
| `upsert(row)`, `upsertMany(rows)`                                                                       | `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` |
| `where(...).update(values)`                                                                             | `UPDATE ... SET ... WHERE ... RETURNING`             |
| `where(...).update((u) => ({ score: u.score + 1 }))`                                                    | `SET` reading the row through its own alias          |
| `where(...).delete()`                                                                                   | `DELETE FROM ... WHERE ... RETURNING`                |
| `` db.users.fromSql`...${value}...` ``                                                                  | the fragment as a derived table, `value` bound       |
| a `filter` declared on the entity                                                                       | an automatic `WHERE`, and-ed with a caller's own     |
| `ignoreQueryFilters()`                                                                                  | the entity's own `filter`, if any, left out          |
| `tag(text)`                                                                                             | a leading block comment on the statement             |

A few caveats worth knowing:

- **`LIKE` wildcards are not escaped.** A value of `"50%"` passed to `startsWith` matches more
  rows than a strict reading suggests. Entity Framework Core behaves the same way; escape the
  value yourself when it matters.
- **`match` and `search` only take a regular expression literal written in the query, and only the
  `i` flag.** `.match(/^A/)`, not a pattern read out of a variable: the flags decide the operator or
  function PostgreSQL prints, which has to be settled while compiling. `g`, `m`, `s`, `u`, and `y`
  are refused outright, since POSIX has no reading for any of them. `search` needs PostgreSQL 15 or
  later, for `regexp_instr`.
- **A joined string is null if any part is null.** `concat`, and the `+` that compiles to the same
  operator, follow SQL rather than JavaScript here: `u.name.concat(u.city)` is null for a row with
  no city, where JavaScript would have written `"null"` into the string. Coalescing each part to an
  empty string would close the gap and lose the difference between a row with no city and one whose
  city is empty, so the SQL reading stands. A nullable column is `string | null` besides, which
  `String.prototype.concat` does not accept, so reaching one takes a cast that says as much. The
  `concat` further down the table is the unrelated set operator, which appends one query's rows to
  another's; a string is joined by the method on a column and rows are combined by the one on a
  query.
- **`concat` over an array splices, and never appends.** JavaScript picks between its two readings
  by looking at the argument as it runs: an array is spliced in, and anything else is appended
  whole. Nothing here can look, since a dialect is told the type of the column the call was made on
  and nothing about the arguments, so `p.tags.concat(x)` always takes `x` for an array — the reading
  `concat` is reached for. Wrap a single element to append it: `p.tags.concat([x])`. The emitted
  call is `array_cat` rather than the `||` this is usually written with, and that is not style:
  PostgreSQL resolves `||` over an array by the argument's own type, choosing between
  `anyarray || anyarray` and `anyarray || anyelement`, and a bound parameter arrives untyped and
  matches both, so the statement would be refused as ambiguous. `array_cat` takes two arrays and
  settles it here. An array column with no elements joins to the argument alone rather than to null.
- **`indexOf` searches a string, not an array.** JavaScript arrays have the method too, and
  PostgreSQL answers that one with `array_position`. A dialect is handed an expression rather than a
  type and cannot tell a `text` column from a `text[]` one, so an array receiver reaches the
  database as a string search and is rejected there.
- **`reverse` flips the order, not the rows.** Rows that tie on every sort key are left in
  whatever order the database returns them, before and after; LINQ reversing a list in memory would
  swap them. Add a tiebreaking key with `thenBy` when that difference matters.
- **`defaultIfEmpty` cannot say which row you got.** A row of nulls, or the caller's own default row,
  is what an empty query returns, and is also what a real row that happened to equal it looks like;
  SQL offers nothing to tell them apart once the join has run. Ask `any()` when the distinction
  matters. Filtering after it undoes it for the same reason filtering after a `leftJoin` does.
- **`index` counts from zero, not from one.** `ROW_NUMBER` counts from one, LINQ's `Index` and
  JavaScript both count from zero, and the translation follows the JavaScript reading so
  `index((u, i) => i)` over three rows gives 0, 1, 2. For a standing shown to a person reach for
  `rank`, which counts from one and calls tied rows equal, rather than adding one to a position
  that does neither. A
  `select` or a `where` whose lambda takes a second parameter reaches a statement built the same way
  under the operator's own name, `select`'s the indexed `Select` overload LINQ already has and
  `where`'s the indexed `Where` overload beside it; a one-parameter lambda is unaffected either way,
  since the two are told apart by how many parameters the lambda declares. `where`'s own version
  cannot come free the way `select`'s does: a window function cannot appear inside the `WHERE` that
  would read it, so the position is numbered in a derived table first and the outer statement
  filters against that column.
- **`skipLast` cannot stop early where `takeLast` can.** Both flip the order and cut it `n` rows
  in, but a `LIMIT` lets the database stop there and an `OFFSET` does not: the rows to keep are the
  ones past the cut, so all of them are ordered. Nothing cheaper exists for it, since which rows are
  last is a question about the whole sequence.
- **`takeLast` costs a sort that `reverse` does not.** Both reach the same rows the same cheap
  way, by flipping every sort key and stopping at the limit. Putting them back in the order they
  were asked for is the extra half: a derived table and a second sort, over the `n` rows that
  survived rather than over the table. Reach for `reverse().take(n)` when the order of the answer
  does not matter.
- **`lastIndexOf` needs `REVERSE`, which is not standard SQL.** Every database with a provider here
  spells it that way, as they do `LPAD` and `LTRIM`, so the translation lives in `BaseDialect`; a
  database without it overrides. It also reverses whole strings twice per row, so it will not use an
  index the way a prefix search can.
- **`repeat` is more forgiving than JavaScript.** A negative count throws a `RangeError` in
  JavaScript and answers the empty string here, and a fractional count is truncated there and
  rounded by the cast to int. Neither can be closed in the translation, because a count reaches the
  dialect as a bound parameter and nothing downstream can branch on its value. A count of zero
  agrees: both give the empty string.
- **`toISOString`'s `Z` is an assertion, not a conversion.** `to_char` renders a `timestamp` as
  stored and a `timestamp with time zone` in the session's zone, and the translation appends `Z`
  either way. It is therefore right for a `timestamp` column holding UTC, which is the usual
  convention and what this library's mappings produce, and right for a `timestamptz` only when the
  session is UTC. A dialect is handed an expression rather than a type and cannot tell the two apart,
  so it cannot choose the conversion for you.
- **`countDistinct` counts null as a value.** SQL's `COUNT(DISTINCT ...)` skips nulls where LINQ's
  `Distinct().Count()` counts one, so the generated SQL adds one back when any null is present. That
  is the same reading of a null key `distinctBy` and `exceptBy` take. A column of ten rows holding
  three cities and some nulls answers four, not three. A `groupBy` result selector's own
  `g.countDistinct(...)` shares the same adjustment, so a group answers the same count either way.
- **`contains(null)` finds a null.** SQL's `=` against a null parameter is unknown rather than true,
  so the comparison is written to survive one on either side. `contains` therefore answers true for a
  column that holds a null, which is what LINQ answers and the same reading `countDistinct` above
  takes. It works over a query projecting one value; a query still projecting a row is refused and
  points at `where` with `any`.
- **`getTime` is relative to the database's reading of the column.** PostgreSQL reads `EPOCH` from a
  `timestamp` as though the value were already UTC, while node-postgres parses that same column into
  a `Date` in the machine's zone. The two therefore disagree by the session offset unless the column
  carries a time zone or the process runs in UTC. Anything below a millisecond is floored away, as
  `getSeconds` floors its own fraction.
- **`getDate` and `getDay` are different fields.** `getDate` is the day of the month, 1 through 31,
  and is ANSI; `getDay` is the day of the week, 0 through 6, and is PostgreSQL's alone because no
  two databases spell it the same way. The names are one letter apart and JavaScript's own choice,
  so the translations follow them rather than trying to improve on them.
- **A date part is the database's reading of the column.** `getFullYear` and the rest extract
  from the value as the database sees it: a `timestamp` gives what is stored, and a column carrying
  a time zone is converted to the session's zone first, where JavaScript would have used the
  machine's. For a `timestamp` column the two agree once node-postgres parses it back.
- **`getUTCFullYear` through `getUTCSeconds` are for a column that carries a time zone, and only
  that.** Each is its plain counterpart with the reading pinned:
  `AT TIME ZONE 'UTC'` converts the instant to UTC before the extraction, so a `timestamptz` gives
  the same answer to every session rather than 2024 to one connection and 2025 to another. A plain
  `timestamp` is not an instant and has no zone to convert from; PostgreSQL reads
  `AT TIME ZONE 'UTC'` over one as an assertion instead, and hands back a value the extraction then
  renders in the session's zone, which is the dependence this exists to remove. For a naive
  `timestamp` holding UTC — the convention this library's own mappings produce — `getFullYear`,
  `getMonth`, `getDate`, `getHours`, `getMinutes`, and `getSeconds` already answer the UTC reading
  and are the methods to reach for. What each needs on top of the conversion is its own question,
  and the answers differ: `getUTCMonth` subtracts one as `getMonth` does, since JavaScript numbers
  months from zero; `getUTCSeconds` floors as `getSeconds` does, since `SECOND` is the one field
  `EXTRACT` may answer with a fraction; and the three between them need neither. The conversion
  decides which month, day, hour, minute, or second the instant falls in, and the second adjustment
  decides how that value is spelled, so the two are independent. `getUTCHours` is where the pinned reading reaches furthest, a
  session offset moving the hour for every row of a table where it moves the day boundary for a few
  hours out of each day and the year boundary for a few hours out of each year. `getUTCMinutes` is
  the opposite case and needs the conversion just as much: a whole-hour offset moves no minute at
  all, so the two readings agree in most of the world and part company in the zones that are not a
  whole number of hours off UTC — half an hour in Kolkata's case, three quarters in Kathmandu's,
  where a session reads a minute of 0 or 15 for an instant whose UTC minute is 30. The conversion
  assumes nothing about the size of an offset, which is what makes every field of the family safe
  in such a zone rather than only the calendar ones. `getUTCSeconds` is where that argument finally
  runs out and the translation is still worth having: every zone in use today is a whole number of
  minutes off UTC, so a session reads the same second whatever it is set to, and what is left of
  the case is the local mean time PostgreSQL carries for instants predating a zone's adoption of
  standard time. Read `1870-01-01 00:30:17Z` in Amsterdam, Dublin, New York, or Kolkata and the
  second comes back as 47, 56, 15, or 27; `getUTCSeconds` answers 17 in all four, which is what
  JavaScript answers. `getUTCDate` is a day of the month rather than the day of the week `getDay`
  answers, and `getUTCDay` is the day of the week, which needs the conversion for the day of the
  month's reason: it is the date boundary a session offset moves, so the same instant reads Tuesday
  in New York and Wednesday in UTC. `getUTCDay` is also the only member of the family that would
  live in the PostgreSQL dialect even without a zone to pin, `DOW` being no `EXTRACT` field the
  standard defines. `getUTCMilliseconds` is the one field left untranslated, and deliberately: no
  time zone PostgreSQL carries is offset by a fraction of a second — not one current zone is off by
  even a fraction of a minute, and the local mean times it keeps for old instants are whole seconds
  — so the conversion provably cannot change a millisecond-of-second, and `getMilliseconds` already
  answers the UTC reading for every row there is.
- **`getSeconds` floors the second rather than rounding it.** `SECOND` is the one field `EXTRACT`
  may answer with a fraction, and PostgreSQL does, so a column holding `23:45:59.75` extracts as
  `59.750000` where JavaScript reports `59`. The translation wraps the extraction in `FLOOR`, which
  is why it is not the bare extraction `getHours` and `getMinutes` are. `getMilliseconds` is not
  translated: the fraction `EXTRACT` carries is microseconds and is not the same field.
- **Trimming removes spaces, not all whitespace.** `TRIM`, `LTRIM`, and `RTRIM` strip spaces, while
  `trim`, `trimStart`, and `trimEnd` in JavaScript strip tabs and newlines too. A column holding a
  tab keeps it. Matching JavaScript would mean naming a character set no two databases spell alike,
  and would still miss the Unicode whitespace JavaScript recognises.
- **`all` is exactly as strict as `where`.** A row whose predicate is unknown, which is what a
  comparison against null is in SQL, counts as a failure: `all(p)` is true when `where(p)` would
  have returned every row. Entity Framework Core lets such a row pass instead, and JavaScript never
  had the third answer to begin with.
- **An `update` with no filter updates every row.** SQL says so and this does too, so the missing
  `where` is the whole of the warning. `normalize` translates only the default NFC form, because the
  form is a keyword in SQL rather than a value and a literal argument reaches a dialect as a bound
  parameter; any other form is refused rather than ignored.
- **`include` reads two statements at two moments.** The rows are read first and the related rows
  second, so one written between them is seen and one deleted is not. Read inside a transaction when
  that matters, as `chunk` asks. The children of a collection arrive in whatever order the database
  returns them, and a row with no children gets an empty array.
- **A filter before a `rightJoin` or a `fullJoin` is applied before the join.** A `WHERE` is read
  after the join, so leaving the filter there would drop the rows the join had kept with the filtered
  side null and turn either operator into an `INNER JOIN`. The filter therefore goes into a derived
  table, which is a subquery in the generated SQL and the same rows a reader would expect. A filter
  written _after_ the join still applies after it, and still undoes what the join preserved, as it
  does for a `leftJoin`.
- **A filtered `include` counts rows per parent, and only among the parents it read.** The window
  numbers each parent's rows separately and it sits above the key list, so the ten rows each are the
  ten among that parent's rows in this query rather than in the table. Nothing else about the second
  statement changes: it is still one statement, and it still repeats no parent columns.
- **An include chain's row type claims more than a chain brought back.** The rows a chain hands
  back type as a graph three hops deep, because the type describes what `include` and `thenInclude`
  can reach rather than which of them were written: reading `o.user.city` off a query that included
  only the user compiles and answers `undefined`. That is the trade `include` already made at one
  hop, and the depth is bounded because a model may point back at itself and a type that followed
  that forever would not compile. It is the include chain's own reading of a row, so nothing about
  what a lambda in a `where` may reach through has changed.
- **An included `reference` takes the first row it matches.** More than one row on the other end
  means the column the key matches is not unique, which the database is the place to say so; this
  hands out the first row it was given rather than failing partway through. A row whose key is null,
  or whose key matches nothing, gets null, which a required reference's row type does not admit: the
  type describes the foreign key the model declared and not whether the database is enforcing it.
- **`includes` over an array is unknown, not false, when the array holds a null.** `x = ANY(a)`
  answers null rather than false for a value the array does not hold once one of its elements is
  null, so a filter neither keeps nor rejects that row. Looking for null itself always answers null
  too, where JavaScript would have found it. An array with no elements answers false, as JavaScript
  does.
- **`split` refuses a limit, and parts company on an empty separator.** A second argument capping how
  many pieces come back cannot be honoured, since `string_to_array` splits the whole string, so it is
  refused rather than dropped. An empty separator splits into characters in JavaScript and returns
  the whole string as one element in PostgreSQL; pass a separator that occurs, or split in the
  application.
- **`slice` normalises its start twice.** The start appears in both the position and the length, and
  SQL has nowhere to put a name for it without a `LATERAL` or a `CTE`, so the `CASE` that decides its
  sign is emitted twice. That is `at`'s cost repeated: a bound reaches the dialect as a parameter, so
  the sign cannot be known while compiling and the `CASE` is emitted whether or not it is needed.
- **`groupJoin` costs one subquery per aggregate.** Each aggregate the result selector asks for
  becomes its own correlated subquery over the joined side, and a filter that reads one afterwards
  repeats it. Ask for the aggregates you need, and project before filtering when a query is hot.
- **`fullJoin` is not available on every database.** `FULL JOIN` is standard SQL and PostgreSQL has
  it, but MySQL has no spelling for it at all, so a statement using it is rejected there rather than
  translated to something else. It is also the one join where an all-null row is ambiguous: it may be
  an unmatched row from either side, or a matched pair that was null throughout. Project a column
  that cannot be null on each side when the answer has to say which.
- **`rightJoin` is `leftJoin` with the sides swapped.** `a.rightJoin(b, ...)` keeps every row of `b`,
  which is what `b.leftJoin(a, ...)` keeps with the projector's arguments exchanged. Prefer the
  left-joined spelling when writing a query from scratch, since it reads in the order the rows come
  out; reach for this one when the outer side is a query that was already built elsewhere.
- **Filtering after a `leftJoin` undoes it.** A null fails every comparison, so
  `.leftJoin(...).where((r) => r.total > 5)` discards the very rows the join kept and leaves an
  inner join. That is what SQL does with a `WHERE` over a `LEFT JOIN`. Filter the query being
  joined instead, `db.orders.where(...)`, and the filter runs before the match.
- **`localeCompare` orders by the column's collation, not by a JavaScript locale.** The comparison
  runs in the database, so it follows the collation the column has. The two often agree and need
  not: under a `C` collation `'a' < 'B'` is false, where `'a'.localeCompare('B')` is negative. A
  locale or options argument is rejected rather than dropped, since neither can be honoured.
- **`codePointAt` counts characters, not UTF-16 units.** PostgreSQL indexes a string by character
  and JavaScript by code unit, so the two agree for text in the basic plane and part company after
  an astral character, where JavaScript sees two units and PostgreSQL sees one. Reading past either
  end is null, matching `undefined`. `charCodeAt` is deliberately not translated: it is supposed to
  return a surrogate half, which no database offers.
- **`toFixed` rounds exactly, where JavaScript rounds a double.** `numeric` is exact decimal, so
  `1.005` becomes `1.01`; JavaScript sees the binary value 1.00499… and answers `1.00`. PostgreSQL
  is the more defensible of the two and it is not the same one. Note also that `toFixed` is
  available on an `int` or `float` column, since a `decimal` one is already a `string` here and has
  no such method.
- **The aggregate terminals disagree about an empty query, on purpose.** SQL answers null for every
  one of them, so none reports what the database said; each follows LINQ instead. `sum` answers
  zero, closing the gap in the statement with `COALESCE(SUM(x), 0)`. `average`, `min`, and `max`
  raise a `SequenceError`, as `first` does. Rows whose value is null are skipped by all of them, as
  SQL and LINQ both do, and a query where every value is null is where they part again: it totals
  zero for `sum`, is a second and distinct error for `average`, and is simply null for `min` and
  `max`, whose return type can carry that answer where `average`'s `number` cannot.
- **`sum` and `average` return a `number`, which can lose digits an exact numeric held.** They
  convert what the driver returns, the way `count` does, because that is what those aggregates mean
  in SQL. Two things go missing. PostgreSQL widens `SUM` over an `int` column to `bigint`, so a
  total can outgrow what a double holds exactly even when no single row could. And a `SUM` or `AVG`
  over a `decimal` column is exact in the database, keeping the scale that makes `4.50` different
  from `4.5`, which a double does not. Project the aggregate through `groupBy` and read the column
  yourself when every digit has to survive.
- **`min` and `max` convert nothing, and are not restricted to numbers.** They keep the column's own
  type, so the value arrives as the column's representation and is handed on untouched: a
  `timestamp` is a `Date`, a `decimal` is the exact string it always was. They order whatever the
  column holds, so the smallest `text` is the first alphabetically, under the column's collation
  rather than a JavaScript one, which is the caveat `localeCompare` carries as well.
- **`count` takes a predicate, and it is a filter rather than a position.** `count((u) => u.isActive)`
  is LINQ's own `Count(predicate)` and compiles to exactly what `where(predicate).count()` already
  did, so it buys a way to say it rather than a statement of its own. The one place the two could
  have parted is an ordered query, where `where`'s second parameter is the row's position: `count`
  builds its filter directly rather than through `where`, so its predicate means the same thing
  wherever it is written. Written after a page, it counts within that page rather than around it,
  since the page is taken first and the predicate reads the rows it left.
- **Comparing keys reads two nulls as the same key, where SQL would not.** `NULL = NULL` is
  unknown rather than true, so `chunkBy` would cut a run between every pair of rows missing the
  key and `exceptBy` would never subtract one. LINQ's default comparer holds two nulls equal, and
  so does SQL's own `EXCEPT`, whose set semantics are "not distinct" rather than "equal", so the
  generated condition asks about the null as well and agrees with both. `distinctBy` settles it
  the same way.
- **`exceptBy` compiles to `NOT EXISTS`, never `NOT IN`.** A subquery yielding a single null
  makes `NOT IN` unknown for every row, so the query returns nothing at all, silently and only
  once the data happens to contain a null. `NOT EXISTS` asks whether a row is there rather than
  what is in it, and has no such cliff.
- **`pairwise` drops the first row by position, and neither of its rows can be navigated off.**
  `LAG` answers null for the first row, which no test of the values could tell from a real earlier
  row whose columns were null, so the position decides. Both rows are read back out of one derived
  table, as two views of the same columns, and a join is reused per row and property — so a single
  cached join could not tell the earlier view from the later one, and both would silently get the
  same related row. That is why `pairwise` still refuses a navigation where its neighbours no
  longer do, and it is `zip`'s limit as well: project the navigation before pairing and the pair
  sees an ordinary column.
- **`windowed` returns fewer rows than the query has, and `count()` over a run is always the size.**
  A run of `n` rows needs `n` rows behind it, so the first `n - 1` produce none and a query of
  fewer than `n` rows returns nothing at all. They are dropped by position for `pairwise`'s reason:
  an aggregate over a short run is indistinguishable from one over a full run whose values were
  null. That is also why counting a run says nothing — every run that survives is full — where the
  same `count()` over a `groupBy` group is the reason to reach for it. `countDistinct` is not on a
  run at all, SQL having no `DISTINCT` over a window; group the rows with `groupBy` for that.
- **`expanding` returns every row the query has, and `count()` over its run is the row position.**
  This is `windowed` with the near end of the frame let go, so the two differ in exactly those two
  places. A run reaching back to the start of the ordering is never short, the first row holding
  itself alone, so there is nothing to drop and `n` rows stay `n`; and the count that says nothing
  over a fixed run says where the row sits over a growing one, from one rather than the zero
  `index` counts from. Everything else is `windowed`'s, `countDistinct`'s absence included.
- **`windowedBy` and `expandingBy` restart the frame per key, and `windowedBy` drops the head of
  every key rather than of the query.** They are the same two operators with a partition, so a
  reading is only ever averaged with its own key's neighbours. The consequence to know is the row
  count: `windowedBy(key, n, ...)` needs `n` rows _within a key_, so a key holding fewer than `n`
  rows contributes nothing at all and a query of `m` rows returns `m` less `n - 1` per key rather
  than `n - 1` once. `expandingBy` drops nothing, for `expanding`'s reason, and its `count()` is
  the position within the key. Both return the rows in the query's own ordering rather than grouped
  by key: a partition decides which rows sit behind a row, and the ordering decides where the row
  itself goes, so keys come back interleaved exactly as they were.
- **`rank` counts from one and `index` from zero, because they mean different things.** `index` is
  a position among rows and follows LINQ's `Index`; `rank` is a standing, has no LINQ operator
  behind it, and is read by someone for whom first place is 1. The difference that matters more is
  ties: `index` is `ROW_NUMBER`, so two rows agreeing on every sort key still get different numbers
  and which one goes first is whatever the database reached first, where `rank` gives them the same
  number. `rank` then skips the numbers a tie consumed — 1, 2, 2, 2, 5 — and `denseRank` does not —
  1, 2, 2, 2, 3 — which is the difference between a placing and a band. What ties is what the
  ordering says and nothing else, so `thenBy` a unique key is how a query asks for no ties, at
  which point `rank` and `index((u, i) => i + 1)` agree.
- **`takeBy` narrows each key and `skipBy` can empty one, and neither is `take` or `skip`.**
  `take(3)` keeps three rows in total and hands them to whichever keys they belonged to;
  `takeBy(key, 3)` keeps three of every key, so a key holding fewer keeps all of them and no key
  is ever removed. `skipBy` is the complement and therefore can remove one: a key with `n` rows or
  fewer contributes nothing to `skipBy(key, n)`. Between them the two partition the table. Both
  count within the key over the query's ordering, so reversing the order takes the other end of
  each key, and both return rows in the query's own ordering rather than grouped by key. A filter
  after either one drops rows the window had already counted rather than refilling the key from
  below, which is the point of the window sitting under the numbering.
- **A navigation survives a derived table, and joins after it rather than before.** `u.city.name`
  reads the same after `take`, `skip`, `distinct`, `sample`, `distinctBy`, `takeBy`, `skipBy`,
  `takeLast`, `skipLast`, `takeWhile`, `skipWhile`, `chunkBy`, `index`, `rank`, and a `select` or
  `where` taking a position as it does off the table itself. Each of those pushes the query into a
  derived table, and the foreign key comes out of it under its own name, so the join is emitted
  against the derived table. Where it sits matters: `take(10).select((o) => o.user.name)` pages
  the orders and then names their users, where joining first would have paged the join. Two
  operators withhold it rather than being unable to offer it — `defaultIfEmpty`, whose extra row
  is all nulls including any foreign key, so a required reference would join that row away with an
  `INNER JOIN` and undo the guarantee, and `pairwise`, whose two rows are two views of one derived
  table that a single cached join cannot tell apart. A navigation after a `select` is refused for
  a different reason and always will be: a projection has forgotten which of its expressions were
  columns of what, so there is no relation left to follow.
- **A captured variable is an error, not a silent wrong answer.** The library refuses to guess.
- **Aggregate results arrive in the driver's representation.** `Group`'s return types describe what
  the aggregate means in SQL, so `users.count() > 5` type-checks as the `HAVING` clause it becomes.
  Reading the result row is a separate matter: node-postgres returns `COUNT`, `AVG`, and `SUM` over
  an exact numeric as strings rather than lose precision, so convert those columns yourself. That
  holds wherever an aggregate is projected, including `u.orders.count()` over a collection. Where the
  library knows what a column means it does the converting: the `count` terminal answers a number,
  and so does `index`'s position, which is cast in the statement.
- **`toDictionary` throws on a repeated key rather than keeping the last row.** The selector runs in
  JavaScript over rows already read back, not in SQL, and it is claiming one row per key; a value it
  gives twice is a `SequenceError`, the same claim `single` makes about a whole query. Building a
  `Map` by hand instead would silently keep whichever row happened to be written last.
- **`toLookup` answers `undefined` for a key nothing mapped to, not an empty array.** LINQ's own
  `Lookup` never does that: indexing a key it has never seen still returns an empty sequence there.
  This is a plain `Map`, so `get` follows `Map`'s own contract instead of `Lookup`'s; check with
  `has`, or fall back with `?? []`, when the difference matters.
- **`toHashSet` compares rows by reference, not by column.** A `Set` uses JavaScript's own equality,
  which is reference equality for anything that is not a primitive, so two rows with identical
  columns are still two elements unless they are the same object; `distinctBy` and SQL's own
  `DISTINCT` have no such limit, since they compare the columns themselves. It is therefore most
  useful over a scalar projection, whose values are what the `Set` actually compares.
- **`aggregate` reads every row back rather than asking the database.** The fold runs in JavaScript
  over what `toArray` returns, so nothing about it becomes SQL. Reach for `sum`, `average`, `min`,
  `max`, or a `groupBy` result selector first when one of them already answers the question: those
  compute one value in the database and read back only that.
- **`aggregateBy` groups in JavaScript too, for `aggregate`'s own reason.** The rows are still read
  back with one `toArray`, then folded per key in memory rather than with `GROUP BY`. Reach for
  `groupBy` first when its result selector already answers the question, the same trade `aggregate`
  itself asks a caller to make.
- **A negative `elementAt` needs an ordering, the same reason `last` does.** `elementAt(-1)` is the
  last row, `elementAt(-2)` the one before it, counted the way `Array.prototype.at` counts; a plain
  query has no end to count back from, so this is refused there and accepted only on an ordered one.
  Rows that tie on every sort key make which one a given index lands on the database's choice, as
  they do for `reverse` and `last`; add a tiebreaking key with `thenBy` when that matters.
- **The hyperbolic functions look alike and are not translated alike.** `Math.sinh` needs
  PostgreSQL's own `SINH`, since `(EXP(x) - EXP(-x)) / 2` cancels near zero the way `Math.expm1`'s
  own identity does; `Math.tanh` carries the same trap into a ratio of two such terms and needs
  PostgreSQL's own `TANH` for the same reason, rather than `SINH` divided by `COSH`. `Math.asinh`
  has a trap of its own: `LN(x + SQRT(x * x + 1))` cancels for a large negative `x`, where
  `SQRT(x * x + 1)` comes out nearly `-x` and the sum throws away most of the answer's significant
  digits, so it needs PostgreSQL's own `ASINH` too. `Math.acosh` has the same trap read from the
  domain's other edge: `LN(x + SQRT(x * x - 1))` cancels for an `x` near one, where `x * x` is
  itself nearly one and subtracting one from it loses most of its digits before `SQRT` ever runs,
  so it needs PostgreSQL's own `ACOSH`. `Math.atanh` completes the set and is `Math.log1p`'s trap
  wearing a ratio: `0.5 * LN((1 + x) / (1 - x))` hands `LN` a quotient near one for an `x` near
  zero, and the distance from one is exactly the part that rounded away, so it needs PostgreSQL's
  own `ATANH`. `Math.cosh` is the one with no such trap: its two terms are added rather than
  subtracted, so `(EXP(x) + EXP(-x)) / 2` loses nothing and is built from `EXP` in the base
  dialect instead of reaching for a name PostgreSQL alone agrees on.

## Raw SQL

No translator covers everything, so an entity set has an escape hatch for the statements this one
does not reach: a CTE, a window function this library does not expose, a database-specific hint.

```ts
const adults = await db.users.fromSql`SELECT * FROM users WHERE age >= ${18}`.toArray();
```

That is written with a tagged template on purpose. Every value is a placeholder in the template
rather than text spliced into the fragment, so it travels as an ordinary bound parameter and a value
carrying a quote cannot become a second statement; there is no other way to hand `fromSql` a value at
all. Build the fragment's text with ordinary string concatenation instead and nothing here can protect
the query it becomes.

What comes back is an ordinary `Queryable`, so `where`, `select`, `orderBy`, `include`, and everything
else layered on top keep working exactly as they do over `db.users` itself:

```ts
const names = await db.users.fromSql`SELECT * FROM users WHERE city_id = ${cityId}`
  .where((u) => u.isActive)
  .select((u) => u.name)
  .toArray();
```

That composes because the fragment is read as a derived table under the query built on top of it, the
same way any other subquery is. The one obligation it carries is the fragment's to keep: it has to
answer with every column the entity declares, under the same physical names `db.users` itself would
read them by, since that is what a `where` or a `select` written against the entity's properties
resolves to underneath. A fragment that narrows the columns or renames one breaks whatever reads that
column, the same way a hand-written view would.

This lives on the entity set rather than on `Queryable` for `insert`'s own reason: only the entity set
knows what columns a fragment is on the hook to return, and what comes back cannot itself be written
through with `insert`, since a fragment already chose how its own rows are found.

## Array columns

A column may hold many values of one type. `of` names the element type, and the row type follows:

```ts
const Post = defineEntity({
  name: 'Post',
  columns: {
    id: { type: 'int', primaryKey: true },
    tags: { type: 'array', of: 'text' }, // string[]
  },
});

db.posts.select((p) => ({ first: p.tags.at(0), last: p.tags.at(-1) }));
```

`at` counts the way JavaScript does: from zero, and from the end for a negative index. PostgreSQL
subscripts from one and treats a negative subscript as simply out of range, so the translation
settles both in the index rather than leaving them to the caller. An index past either end reads as
null, as `at` returns `undefined` for one.

`length` counts elements rather than characters:

```ts
db.posts.where((p) => p.tags.length > 2);
// ... WHERE CARDINALITY("t0"."tags") > $1
```

JavaScript spells both lengths the same way, and a dialect is handed an expression rather than a
type, so the compiler looks the declared column type up before delegating and the dialect chooses
`CARDINALITY` over `CHAR_LENGTH`. `CARDINALITY` rather than PostgreSQL's `array_length` because the
two differ on an empty array: `array_length` answers null and `CARDINALITY` answers zero, which is
what JavaScript answers.

The type follows the column rather than stopping at the entity. A derived table hands the question
back to the scope it wrapped, since its columns are that scope's columns under the same names, and a
projection reads the type off the expression each of its columns came from. So
`select((p) => ({ tags: p.tags })).select((r) => r.tags.length)` still counts elements, and so does
the same read after paging. What has no type is what is no longer a column: a projection of
`p.tags.length` is a count, and asking for its length asks about a number.

`includes` asks whether the array holds a value:

```ts
db.posts.where((p) => p.tags.includes('logic'));
// ... WHERE $1 = ANY("t0"."tags")
```

This is the second method whose meaning depends on what it is called on, after `indexOf`, and the
first the library can tell apart: the compiler looks the declared column type up and hands it to the
dialect, so a `text` column still becomes a `LIKE` and only a genuine array becomes an `ANY`. A list
from the parameter bag is a third reading again, settled before the dialect is asked at all, and
still becomes an `IN`.

The type survives a projection and a derived table, so the array reading holds through
`select((p) => ({ tags: p.tags }))` and through paging.

`indexOf` finds where an element sits:

```ts
db.posts.select((p) => ({ at: p.tags.indexOf('logic') }));
// CASE WHEN "t0"."tags" IS NOT NULL
//      THEN COALESCE(array_position("t0"."tags", $1) - 1, -1) END
```

`array_position` counts from one and answers null for an element it did not find, where the string
reading of `indexOf` gets both edges from one subtraction because `POSITION` answers zero. The
`COALESCE` supplies the -1, and the `CASE` around it keeps a null array null: `array_position`
answers null for an element that is not there and for an array that is not there, and only the second
should stay unknown.

`slice` reads part of one:

```ts
db.posts.select((p) => ({ head: p.tags.slice(0, 3), last: p.tags.slice(-1) }));
// "t0"."tags"[... : ...], counted from one and inclusive at both ends
```

JavaScript takes a half-open range of zero-based indices and PostgreSQL an inclusive range of
one-based positions, so the bounds are adjusted differently: the start gains one and the end gains
nothing. A negative bound counts back from the end, as `at`'s index does, and a range reaching past
either end yields the elements that exist rather than failing — an empty array where nothing is left,
which is what JavaScript answers too.

A column declared `{ type: 'array', of: { type: 'array', of: 'text' } }` nests one array inside
another, and `flat()` removes that one level:

```ts
db.posts.select((p) => ({ tags: p.grid.flat() }));
// ARRAY(SELECT unnest("t0"."grid") ...)
```

`unnest` reads every element of every inner array back in one sequence, which `ARRAY(...)` then
rebuilds into a single array — one level of nesting gone, which is all there ever was: the metadata
model allows exactly one `of` inside another and no deeper, so there is nothing left for a second
`flat()` to remove. Nesting further is not attempted because PostgreSQL's own arrays are rectangular
rather than jagged, so a column declared this way is closer to a two-dimensional Postgres array than
to an arbitrarily deep JavaScript one. Called on a column that was never nested, the translation is
still correct: unnesting and rebuilding an ordinary array gives the same array back, which is what
`flat()` answers for one too. A null array stays null rather than becoming `{}`, since `unnest`
alone would drop the column's own nullability along with everything else about it.

`flatMap` is `flat`'s callback taking a hand in what gets unnested:

```ts
db.posts.select((p) => ({ parts: p.tags.flatMap((tag) => tag.split('-')) }));
// ARRAY(SELECT unnest(string_to_array(x.element, '-')) FROM (SELECT unnest("t0"."tags") ...) AS x)
```

The callback is translated rather than run, since it only ever executes as SQL: its one parameter
stands for an element read out of `unnest("t0"."tags")`, and its body — here `split`'s own
translation — is unnested a second time and rebuilt with `ARRAY(...)`, so a callback answering
several pieces per element contributes all of them rather than one. The callback has to itself
produce an array, as `split` does; a callback returning a plain value has no reading here and
reaches PostgreSQL as an argument `unnest` does not accept, which the database refuses rather than
this library guessing at what was meant. The null guard is `flat`'s own.

Only `at`, `length`, `includes`, `indexOf`, `slice`, `flat`, and `flatMap` are translated. An array
column can still be selected whole and comes back as an array; the other array methods are not.

## Navigation properties

A `reference` declares that one column points at another entity's row, and the row type gains a
property for it:

```ts
const Order = defineEntity({
  name: 'Order',
  columns: {
    id: { type: 'int', primaryKey: true },
    userId: { type: 'int', column: 'user_id' },
    total: { type: 'decimal' },
  },
  relations: { user: reference(() => User, 'userId') },
});

db.orders.where((o) => o.user.name === 'Ada');
// SELECT ... FROM "orders" AS "t0"
// INNER JOIN "users" AS "t1" ON "t0"."user_id" = "t1"."id" WHERE "t1"."name" = $1
```

The join is added by the clause that reads through the reference, so the same works in `select`,
`orderBy`, and `groupBy`. A reference read twice in one clause is joined once. The target is named
through a thunk, `() => User`, so two entities can refer to each other whichever is declared first,
and it matches the target's primary key unless `to` names another column.

Mark a reference `optional` when its key is nullable. It is then joined with a `LEFT JOIN`, and the
target's columns read as `T | null` rather than the row itself being nullable, which keeps
`u.city.name` writable:

```ts
relations: {
  city: reference(() => City, 'cityId', { optional: true });
}
// ... LEFT JOIN "cities" AS "t1" ON "t0"."city_id" = "t1"."id"
```

Two limits are enforced rather than left to be discovered. **One hop**: `o.user.name` translates,
`o.user.city.name` does not, and the row type stops at the target's own columns so a second hop
will not type-check either. That is a limit on what one clause can reach through, not on how far a
query can read: `include` and `thenInclude` follow a chain of navigations with a statement each. **References are rows, not values**: read a column off one rather than
projecting the reference itself, or bring the whole row back with `include`, which reads it in a
second statement rather than in the projection.

`collection` declares the other direction, the many rows keyed back at this one. It is read through
`selectMany`, since a column cannot be read off many rows at once:

```ts
const Order = defineEntity({
  name: 'Order',
  columns: { id: {...}, userId: {...} },
  relations: { lines: collection(() => Line, 'orderId') },
});

db.orders.selectMany(
  (o) => o.lines,
  (o, l) => ({ order: o.id, sku: l.sku }),
);
// ... INNER JOIN "order_lines" AS "t1" ON "t1"."order_id" = "t0"."id"
```

**Two entities cannot navigate to each other.** Naming each other in their own declarations makes
each one's type depend on the other's, and TypeScript resolves both to `any` rather than looping.
Declare one direction, whichever the queries need; the error, if it happens, is TypeScript's
`TS7022` about a value referenced in its own initializer.

`rightJoin` keeps every row of the query being joined instead, letting the outer side go null:

```ts
const coverage = await db.users
  .rightJoin(
    db.cities,
    (u) => u.cityId,
    (c) => c.id,
    (u, c) => ({ city: c.name, who: u.name }),
  )
  .toArray();
```

That is every city, with a user where one lives there. The result selector sees a `NullableRow<T>`
for the outer side and a plain `TInner` for the joined one, which is `leftJoin`'s signature with the
nullability exchanged.

Note that `db.cities.leftJoin(db.users, ...)` asks the same question with the sides swapped, and is
the spelling to prefer when the query is new: it reads in the order the rows come out. `rightJoin`
earns its place when the outer side is a query that was already built elsewhere and handed here to
be extended, which is when swapping the sides is not something the call site can do.

`groupJoin` hands each row the matches rather than one row per match:

```ts
const activity = await db.users
  .groupJoin(
    db.orders,
    (u) => u.id,
    (o) => o.userId,
    (u, orders) => ({ who: u.name, placed: orders.count(), spent: orders.sum((o) => o.total) }),
  )
  .toArray();
```

That is LINQ's `GroupJoin`. A row has columns and not a nested sequence, so what the result selector
receives is a `Group<TInner>` — the same one a `groupBy` result selector gets — and what it can read
off the matches is mostly a question about them, `toArray()` below aside. Every outer row survives,
matches or none, which makes this the way to count something that may be zero: `count()` is 0 there,
`sum` is 0 for the reason the terminal `sum` is, and `min`, `max`, and `average` are null, since SQL
has no other answer.

Each aggregate compiles to a correlated subquery over the joined side:

```sql
SELECT "t0"."name" AS "who",
       (SELECT COUNT(*) FROM "sales"."orders" AS "t1" WHERE "t0"."id" = "t1"."user_id") AS "placed"
FROM "users" AS "t0"
```

That is deliberately not a `leftJoin` with a `groupBy` around it. Reassembling the outer row after
such a join means naming every one of its columns in the `GROUP BY`, and two outer rows alike in all
of them then collapse into one where `GroupJoin` answers two. Leaving the outer query alone is what
keeps the result one row per outer row however the outer rows are shaped. The cost is one subquery
per aggregate, so ask for the ones you need.

`toArray()` is the one method on `Group<TInner>` that answers with the matches themselves rather than
a question about them:

```ts
const activity = await db.users
  .groupJoin(
    db.orders,
    (u) => u.id,
    (o) => o.userId,
    (u, orders) => ({ who: u.name, orders: orders.toArray() }),
  )
  .toArray();
// activity[0].orders is that user's own orders, already an array. Nothing
// here needed deduplicating: PostgreSQL never produced a row per match.
```

Still one row per outer row, still one subquery: `json_agg(json_build_object(...))` stands where
`COUNT(*)` or `SUM(...)` would, in the same correlated shape, and a row with no matches reads back as
`[]` rather than null, the same reasoning that gives `count()` zero. A `decimal` or `bigint` column
stays the string this library already reads it as everywhere else, cast to text before it enters the
JSON so PostgreSQL's own number type does not narrow it; a `date` or `timestamp` column has no such
rescue and arrives as text rather than a `Date`, since JSON has nothing to hold one in.

`fullJoin` keeps every row of both sides:

```ts
const coverage = await db.users
  .fullJoin(
    db.cities,
    (u) => u.cityId,
    (c) => c.id,
    (u, c) => ({ who: u.name, city: c.name }),
  )
  .toArray();
```

That is every user and every city, paired where they match. It is the one join that swapping the
sides cannot write, since neither side is preserved at the other's expense, and the one whose result
selector sees a `NullableRow` on both.

## Query filters

`defineEntity` takes a `filter`, a predicate applied to every ordinary query over that entity, the
way a soft delete needs:

```ts
const Post = defineEntity({
  name: 'Post',
  columns: {
    id: { type: 'int', primaryKey: true },
    userId: { type: 'int', column: 'user_id' },
    title: { type: 'text' },
    deletedAt: { type: 'timestamp', column: 'deleted_at', nullable: true },
  },
  filter: (post) => post.deletedAt === null,
});

await db.posts.toArray();
// SELECT ... FROM "posts" AS "t0" WHERE "t0"."deleted_at" IS NULL
```

That is LINQ's `HasQueryFilter`. It reaches every ordinary way this library reads the entity's rows:
`db.posts` itself, a reference or a collection navigated to it, and rows `include` brings back. A
caller's own `where` narrows further rather than replacing it, exactly as if the filter had been
written by hand at the front of every query:

```ts
await db.posts.where((p) => p.title === 'Hello').toArray();
// ... WHERE "t0"."deleted_at" IS NULL AND "t0"."title" = $1

await db.users.select((u) => ({ name: u.name, posts: u.posts.count() })).toArray();
// ... (SELECT COUNT(*) FROM "posts" AS "t1"
//      WHERE "t0"."id" = "t1"."user_id" AND "t1"."deleted_at" IS NULL) AS "posts"
```

Call `ignoreQueryFilters()` on the entity set for the one query that needs the rows the filter would
otherwise hide, an administrative screen showing deleted posts, say:

```ts
const everyPost = await db.posts.ignoreQueryFilters().toArray();
```

That bypasses only the filter on the entity set it is called on. A navigation reached from that query
still carries its own target's filter, the same as it would anywhere else: `ignoreQueryFilters` says
nothing about an entity other than the one it was called on.

The predicate is parsed once, when `defineEntity` runs, rather than on every query it reaches, since
the source behind it never changes afterward. It takes no parameter bag: a filter is a fixed
condition on the entity itself, not something a caller parameterizes per query, and reading a column
off a reference inside it works the same way it does in any other clause.

## Asking about a collection

`selectMany` flattens a collection into rows. When the question is only whether any of those rows
matches, `some` asks it without flattening anything:

```ts
const noted = await db.visits.where((v) => v.notes.some((n) => n.body === 'seine')).toArray();

// SELECT ... FROM "visits" AS "t0"
// WHERE EXISTS (SELECT 1 FROM "notes" AS "t1"
//               WHERE "t1"."visit_id" = "t0"."id" AND "t1"."body" = $1)
```

That is the same key `selectMany` would have joined on, read as a condition rather than as a source.
Two things follow, and both are the reason to reach for it. The row is returned once however many of
its notes match, where a flatten would have returned it once per match and needed a `distinct` to
undo that. And the subquery stops at the first match, so a visit with twenty notes costs what one
with a single note costs.

Nothing restricts it to a filter: `select((v) => ({ noted: v.notes.some(...) }))` reads it as a
boolean column, and `!v.notes.some(...)` compiles to `NOT EXISTS`, which is how to ask for the rows
whose collection is empty.

`every` is the complement, asking whether they all match:

```ts
const settled = await db.visits.where((v) => v.notes.every((n) => n.body !== 'draft')).toArray();
```

One compilation answers both: the same correlated subquery over the same key, differing in what it
looks for and whether the answer is negated. `every` searches for a row that _fails_ and negates, so
a collection with no rows at all satisfies it, as `[].every(...)` does in JavaScript.

A failing row is `NOT p OR p IS NULL` rather than `NOT p` alone. A predicate that is null is unknown
in SQL and `NOT` of unknown is unknown too, so such a row would answer neither and quietly pass. That
makes `every` exactly as strict as the `all` terminal: `every(p)` is true when a filter on `p` would
have kept every row of the collection.

The predicate sees the collection's own rows and nothing else. A value from the outer row has to be
passed through the parameter bag, as it does anywhere else a lambda needs one.

The same shape answers what a collection comes to, rather than whether a row is in it:

```ts
const ranked = await db.users
  .select((u) => ({ who: u.name, placed: u.orders.count(), spent: u.orders.sum((o) => o.total) }))
  .toArray();

// SELECT "t0"."name" AS "who",
//        (SELECT COUNT(*) FROM "orders" AS "t1" WHERE "t1"."user_id" = "t0"."id") AS "placed",
//        COALESCE((SELECT SUM("t1"."total") FROM "orders" AS "t1"
//                  WHERE "t1"."user_id" = "t0"."id"), 0) AS "spent"
// FROM "users" AS "t0"
```

`count`, `sum`, `min`, `max`, and `average` each become a correlated subquery, so the query still
reads one row per user however many orders each has: joining and grouping would have answered the
same numbers over a different number of rows. They are values like any other, so
`orderByDescending((u) => u.orders.count())` ranks by them and `where((u) => u.orders.count() > 5)`
filters by them, and each aggregate written costs one subquery.

A user with no orders is the case to know. `count` is zero and `sum` is zero, as the `sum` terminal
answers zero for no rows; `min`, `max`, and `average` are null, because SQL has no other answer and
LINQ would have thrown rather than invent one, so those three are typed `| null`.

These methods exist for lambdas to be translated from and nowhere else — a JavaScript array has no
`sum` — which is why the rows an `include` hands back type as a plain array. Read a collection's rows
with `include` or `selectMany`; ask what they come to with these.

## Bringing related rows back

`include` reads a row's navigation along with the row:

```ts
const withNotes = await db.visits
  .where((v) => v.city === 'Paris')
  .include((v) => v.notes)
  .toArray();

withNotes[0]!.notes; // Note[]
```

The row type already claimed the collection, because declaring a `collection` puts it there. What
this does is make the claim true; a query without it hands back rows whose collection property is
simply absent.

Two statements are issued rather than one. The rows are read first, their keys collected, and the
collection read with a single `IN` over those keys, then handed to the rows they belong to:

```sql
SELECT ... FROM "visits" AS "t0" WHERE "t0"."city" = $1
SELECT ... FROM "notes" AS "t0" WHERE "t0"."visit_id" IN ($1, $2)
```

A `LEFT JOIN` would have answered one row per note with the visit's columns repeated across them,
which is the multiplication `some` avoids with `EXISTS` and a join cannot avoid here. A row with no
children gets an empty array rather than nothing, so the property is always safe to iterate, and a
query that found no rows at all issues no second statement.

Either end of a foreign key can be named. A `reference` reads as the single row this one points at:

```ts
const withPerson = await db.visits.include((v) => v.person).toArray();

withPerson[0]!.person.name; // string
```

```sql
SELECT ... FROM "visits" AS "t0"
SELECT ... FROM "people" AS "t0" WHERE "t0"."id" IN ($1, $2)
```

The keys change sides and nothing else does. A collection is found by matching this row's key against
the column the other rows carry; a reference is found by matching the key this row carries against
the target's own, which is its primary key unless `to` says otherwise. A row whose key is null, or
whose key points at nothing, gets null rather than a property that is absent, and a query all of
whose keys are null issues no second statement.

A reference multiplies no rows, so the choice there is not the one `include` makes for a collection.
A join would read and return the target's columns once per row; this reads the target table once
however many rows share a key, at the cost of a round trip. Where a few columns are all that is
wanted, `select((v) => ({ id: v.id, who: v.person.name }))` reads them through the navigation in one
statement, which is cheaper than both.

`thenInclude` follows a navigation of the rows the last hop brought back, which is how a chain
longer than one hop is read:

```ts
const graph = await db.orders
  .include((o) => o.user)
  .thenInclude((u) => u.city)
  .toArray();

graph[0]!.user.city.name; // string | null
```

```sql
SELECT ... FROM "orders" AS "t0"
SELECT ... FROM "users" AS "t0" WHERE "t0"."id" IN ($1, $2)
SELECT ... FROM "cities" AS "t0" WHERE "t0"."id" IN ($1)
```

One statement per hop, not one per row. The keys of every row a hop produced are collected before the
next statement runs, so two hops over a thousand rows are three statements rather than the query per
row that reading a graph in a loop would cost. A hop that found nothing ends the chain there.

It extends the hop last written, as `thenBy` extends the last sort key. Start another chain with
`include` and `thenInclude` follows that one instead, and each chain is read on its own: two chains
through the same navigation read it twice, so write one chain per navigation.

A second argument narrows the collection, and the operators it offers describe the related rows of
_one_ row of the outer query:

```ts
const recent = await db.users
  .include(
    (u) => u.orders,
    (orders) =>
      orders
        .where((o) => o.status === 'paid')
        .orderByDescending((o) => o.placedAt)
        .take(10),
  )
  .toArray();
```

```sql
SELECT ... FROM "users" AS "t0"
SELECT * FROM (
  SELECT ..., ROW_NUMBER() OVER (PARTITION BY "t0"."user_id" ORDER BY "t0"."placed_at" DESC) AS ...
  FROM "orders" AS "t0" WHERE "t0"."status" = $1 AND "t0"."user_id" IN ($2, $3)
) AS "t1" WHERE ... <= 10
```

That is ten orders **each**, which is why `take` is not the `take` of a query: a `LIMIT` would have
handed the first ten rows to whichever users they happened to belong to. It compiles to the window
`distinctBy` uses, asked for ten rows of each key rather than one, so it is still one statement. `skip`
pages within each parent the same way.

`take` and `skip` arrive with `orderBy`, since which rows are the first ten is a question only an
ordering answers — the same reason `takeWhile` lives on an ordered query. Filter first, then order,
then take. The ordering is also the order the rows arrive in, so each parent's collection is in it.

What the collection deliberately does not offer is a projection or a terminal: the rows have to stay
the entity the navigation claims, and the `include` is what reads them. A filter binds its values in
the parameter bag as any other lambda does, and the key list is numbered after it.

The same argument works on a reference and on a `thenInclude`. A reference whose row the filter
rejected reads as null, exactly as a key pointing at nothing does.

`include` comes last, before a terminal. What it returns offers the operators that read rows —
`toArray`, `first`, `firstOrDefault`, `single`, `singleOrDefault`, `include` again for another
navigation, and `thenInclude` for another hop of the current one — and not the ones that reshape
them, since a projection would leave nothing for the related rows to attach to. Filter and order
before including, not after.

Two things follow from the two statements being read at different moments. A row written between
them is seen and one deleted is not, so read inside a transaction when that matters, as `chunk` asks.
And the children of a collection arrive in whatever order the database returns them; project the
collection with `selectMany` when the order matters.

A single `include`, with nothing chained after it, has a single-statement alternative:
`asSingleStatement()` reads it as a `LEFT JOIN` instead of a second statement.

```ts
const graph = await db.users
  .include((u) => u.orders)
  .asSingleStatement()
  .toArray();
// SELECT ..., "t1"."id" AS "__sqlinqo_include_id", ... FROM "users" AS "t0"
// LEFT JOIN "orders" AS "t1" ON "t0"."id" = "t1"."user_id"
```

The join's own rows still repeat the parent once per match; what makes the result a graph rather
than a flat list of pairs is that they are read back, recognised as the same parent by primary key,
and folded under `orders` the same way the second statement already would. A parent with no matches
gets `[]`, a reference that matched nothing gets `null`, `include`'s own defaults either way. A
`thenInclude` written after it, a second `include` chain beside it, or a shape ordering or limiting
the matches all still need the two statements: each is a join of its own `asSingleStatement` does
not build yet.

The parent's own columns repeat once per match, so reach for this over a query with few matches per
row; keep the two statements, or reach for `groupJoin`'s `toArray()`, once that stops paying for
itself.

## Flattening

`selectMany` turns many rows per row into one sequence. Given a collection it follows the key back;
given another query it pairs every row with every row of it, which is a `CROSS JOIN`:

```ts
db.users.selectMany(db.cities, (u, c) => ({ who: u.name, city: c.name }));
// ... FROM "users" AS "t0" CROSS JOIN "cities" AS "t1"
```

Unlike every other operator here, this **multiplies** rows: a row with no matches is gone from the
result, and one with three appears three times. That is what flattening means, and it is the
difference from `leftJoin`, which keeps every row of the query it is called on.

A collection may also be read with its own `where`, `orderBy`, `skip`, and `take`, applied per outer
row rather than once over the whole table:

```ts
db.users.selectMany(
  (u) => u.orders,
  (orders) => orders.orderByDescending((o) => o.placedAt).take(3),
  (u, o) => ({ customer: u.name, total: o.total }),
);
// ... FROM "users" AS "t0" CROSS JOIN LATERAL
//     (SELECT ... FROM "sales"."orders" AS "t1"
//      WHERE "t1"."user_id" = "t0"."id"
//      ORDER BY "t1"."placed_at" DESC LIMIT 3) AS "t2"
```

That is each user's three most recent orders, not the three most recent orders overall, still as one
statement: the second argument shapes an ordinary query over the collection's own entity before the
correlation is added, so `where` narrows it, `orderBy` gives `take` and `skip` something to count
from, and any value a filter captures binds in the parameter bag as it would anywhere else. Reading
the same collection through `include` instead reads every parent's rows in one second statement,
whatever order the database returns them in; shaping a `selectMany` this way is how to keep the
result to one statement while still asking for an order or a limit per row.

The row this hands back cannot be included from or navigated further, the same as any other
`selectMany`: the projector already said what shape the result is, and there is nothing left that
still looks like the entity a navigation would resolve against.

## Joining

`join` takes the joined query, a key selector for each side, and a result selector that receives
both rows. The signature is LINQ's, and because the result is a flat row rather than a nested
pair, everything downstream keeps working on it:

```ts
const lines = await db.users
  .join(
    db.orders,
    (u) => u.id,
    (o) => o.userId,
    (u, o) => ({ customer: u.name, total: o.total }),
  )
  .orderBy((row) => row.customer)
  .toArray();

// SELECT "t0"."name" AS "customer", "t1"."total" AS "total"
// FROM "users" AS "t0"
// INNER JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"
// ...
```

Both key selectors return the same `TKey`, so joining on mismatched keys is a compile error rather
than a query that silently matches nothing. A joined query that carries a filter, an ordering, or
paging of its own becomes a derived table, which keeps its meaning intact:

```ts
db.users.join(
  db.orders.where((o, p) => o.total > p.floor, { floor: 100 }),
  (u) => u.id,
  (o) => o.userId,
  (u, o) => ({ customer: u.name, total: o.total }),
);
// ... INNER JOIN (SELECT ... WHERE "t1"."total" > $1) AS "t2" ON "t0"."id" = "t2"."userId"
```

Each side numbers its own parameter bags, so the joined side is renumbered when the two queries
are combined and every value stays bound to the lambda that declared it.

`leftJoin` keeps every row of the query it is called on, matched or not. An unmatched row reads the
joined side as null, which is why its result selector sees a `NullableRow<TInner>`: the row is
always there to read columns off, and every one of those columns may be null.

```ts
db.users.leftJoin(
  db.orders,
  (u) => u.id,
  (o) => o.userId,
  (u, o) => ({ customer: u.name, total: o.total }), // total: string | null
);
// ... LEFT JOIN "sales"."orders" AS "t1" ON "t0"."id" = "t1"."user_id"
```

A result selector's property can also name one of the rows whole, rather than one of its columns:

```ts
const pairs = await db.orders
  .join(
    db.users,
    (o) => o.userId,
    (u) => u.id,
    (o, u) => ({ order: o, user: u }),
  )
  .toArray();

pairs[0]!.order.total; // string
pairs[0]!.user.name; // string
```

Every column of the embedded row travels under its own prefix and is folded back into the shape a
caller named once the driver's flat row comes back. What it does not do is deduplicate: a join on a
non-unique key still repeats a row once per match, exactly as it would flattened by hand, and only
the shape of each row changes. Reach for `groupJoin`'s `toArray()` when what is wanted is one row
per parent with its matches nested, not one row per match.

The row this hands back cannot be filtered, ordered, or projected further, since a property naming a
whole row has no columns of its own for a later operator to read. Read it back after a terminal.

## Grouping

`groupBy` takes a key selector and a result selector, which is LINQ's overload that maps onto SQL:
the key becomes `GROUP BY`, and the result selector becomes the projection over it. Aggregates
come off the group parameter.

```ts
const busiest = await db.users
  .where((u) => u.isActive)
  .groupBy(
    (u) => u.cityId,
    (city, users) => ({ city, headcount: users.count(), oldest: users.max((u) => u.age) }),
  )
  .where((row) => row.headcount > 5)
  .orderByDescending((row) => row.headcount)
  .toArray();

// SELECT "t0"."city_id" AS "city", COUNT(*) AS "headcount", MAX("t0"."age") AS "oldest"
// FROM "users" AS "t0" WHERE "t0"."is_active"
// GROUP BY "t0"."city_id" HAVING COUNT(*) > $1 ORDER BY COUNT(*) DESC
```

A filter placed after `groupBy` becomes `HAVING` rather than `WHERE`, because by the time it runs
the rows it would have filtered no longer exist. One before `groupBy` stays a `WHERE`, so the two
positions mean what they mean in SQL.

Return an object from the key selector to group by more than one expression, and the key parameter
becomes a row:

```ts
db.users.groupBy(
  (u) => ({ city: u.cityId, year: u.createdAt.getFullYear() }),
  (key, users) => ({ city: key.city, year: key.year, headcount: users.count() }),
);
// ... GROUP BY "t0"."city_id", EXTRACT(YEAR FROM "t0"."created_at")
```

Available aggregates are `count()`, `sum`, `average`, `min`, and `max`. Grouping something already
grouped, or joining a grouped query, pushes it into a derived table so each `GROUP BY` keeps its
own meaning.

`countBy` is the shape a `groupBy` most often takes, under a name of its own:

```ts
const perCity = await db.users.countBy((u) => u.cityId).toArray();
// [{ key: 1, count: 12 }, { key: 2, count: 5 }, ...]
```

That is LINQ's `CountBy`, and it compiles to the `GROUP BY` the equivalent `groupBy` would, with a
`COUNT(*)` beside the key. It has no plan node of its own, which is the point: an operator that is a
fixed result selector over one that already exists is a name, not a translation. What comes back is
a `Queryable` like any other, so ordering by the count and taking the top few needs nothing extra.

The key has to be a single expression, since `key` is one column of the result and a composite key
has no column to sit in. Reach for `groupBy` with a result selector when the key is more than one
expression; it names each part itself, which is what makes room for them. Rows sharing a null key
are counted together, as they are in `groupBy` and in a JavaScript `Map`.

`sumBy` is the same shape with a total where the count was, and takes the second lambda `countBy`
has no use for: the value to add up.

```ts
const spentPerUser = await db.orders
  .sumBy(
    (o) => o.userId,
    (o) => o.total,
  )
  .toArray();
// [{ key: 1, sum: '240.00' }, { key: 2, sum: '13.50' }, ...]
```

Everything said about `countBy` holds: one `GROUP BY`, no plan node, an ordinary `Queryable` back, a
single-expression key, and one group for the null key. `aggregateBy` answers the same question from
the other end — it reads every row and folds them in JavaScript, which is what lets it take a fold
no SQL can express. Reach for that one when the fold is the point and this one when the rows are.

The total is what `SUM` means rather than what LINQ's `Sum` means, and the two differ on a group
whose values are every one of them null: this answers null, where LINQ skips the nulls and answers
zero. The standalone `sum` terminal does wrap its aggregate in a `COALESCE`, but that is there for
the empty sequence, and a group is never empty; widening the shorthand past the `g.sum(...)` it
stands for would make the two spellings mean different things. Note also that `minBy` and `maxBy`
are LINQ's and answer with one whole row — the `By` in those names says what the row was chosen by,
where the `By` in `countBy`, `sumBy`, and `aggregateBy` says what the rows were grouped by.

Called with only a key, `groupBy` is LINQ's other overload: rather than an aggregate row per key it
hands back one lazy grouping per distinct key, an ordinary array of the rows themselves carrying the
key they share:

```ts
for await (const group of db.users.groupBy((u) => u.cityId)) {
  console.log(group.key, group.length);
}
```

The distinct keys are read with one statement, and the rows behind each one with a further statement
per key, issued as the loop asks for the next group rather than all at once — the same way `chunkBy`
reads one run at a time. Reach for the result selector overload instead when only an aggregate is
needed, since it never reads a group's rows back at all. An object literal groups by more than one
expression here too, and `group.key` comes back the same shape a result selector's key parameter
would.

When what you want is some of the rows of each key rather than an aggregate over them, `takeBy` is
the operator and no grouping is involved:

```ts
const shortlist = await db.products
  .orderByDescending((p) => p.price)
  .takeBy((p) => p.categoryId, 3)
  .toArray();
```

That is the three most expensive products of every category, in one statement over one pass of the
table. `take(3)` is the query that looks like this and is not: it keeps three rows in total and
hands them to whichever categories they happened to belong to. A `groupBy` cannot answer it either,
since grouping collapses the rows and this keeps them whole.

It is `distinctBy`'s window with its "first of each key" widened into a range — the same
`ROW_NUMBER() OVER (PARTITION BY key ...)`, tested against a range instead of one — so `takeBy(key,
1)` and `distinctBy(key)` are the same query. Which rows survive is the ordering's decision, as it
is for `distinctBy`, which is why both live on an ordered query and why reversing the order takes
the cheapest three of each category instead.

`skipBy` is the complement, keeping what `takeBy` drops, which is the usual shape of a retention
query:

```ts
const stale = await db.backups
  .orderByDescending((b) => b.takenAt)
  .skipBy((b) => b.databaseId, 3)
  .toArray();
```

That is every backup except the three most recent of each database. The two differ in which end of
the window is open and in nothing else, so they share one compilation, and between them they
partition the table. The asymmetry worth knowing is at the short keys: `takeBy` keeps a key holding
fewer than `n` rows whole and so never removes a key, while `skipBy` on the same key contributes
nothing at all.

Both come back in the ordering they were in rather than grouped by key, so categories arrive
interleaved. A filter after either one drops rows the window had already counted rather than
refilling the key from below — `takeBy(key, 3).where(...)` can leave a category with one row, where
filtering first would have given it three.

## Combining queries

Four set operators, matching LINQ's: `union` (`UNION`) and `concat` (`UNION ALL`) combine rows,
`intersect` (`INTERSECT`) keeps the rows both sides have, and `except` (`EXCEPT`) removes the rows
the other side has. Only `concat` keeps duplicates.

```ts
const extremes = await db.users
  .where((u) => u.age < 30)
  .union(db.users.where((u) => u.age > 60))
  .orderBy((u) => u.name)
  .toArray();

// SELECT ... FROM (SELECT ... WHERE "t0"."age" < $1
//                  UNION
//                  SELECT ... WHERE "t1"."age" > $2) AS "t2" ORDER BY "t2"."name" ASC
```

Both sides must project the same columns, and they are paired **by name**, not by position, so two
queries that shaped the same row type in a different order still line up. Mismatched columns are an
error at `toSQL()` rather than a row whose values landed in the wrong properties.

A chain stays one flat statement, `A UNION B UNION C`, while the operators bind equally tightly.
`INTERSECT` binds tighter than the other two, so a chain that mixes them is parenthesised to keep
the grouping you wrote:

```ts
a.union(b).intersect(c);
// SELECT ... FROM (A UNION B) AS "t2" INTERSECT C
```

That is not cosmetic. Flat, SQL would read `A UNION B INTERSECT C` as `A UNION (B INTERSECT C)` and
return different rows.

Anything applied after a set operation goes into a derived table first, since SQL binds a trailing
`WHERE` or `ORDER BY` to the last branch rather than to the operation.

`append` adds one literal row rather than another query's:

```ts
db.users.where((u) => u.isActive).append({ id: 0, name: 'Guest', email: '', age: 0, ... });
```

This is LINQ's `Append`, and it is `concat` against a `SELECT` with no table of its own: the row's
properties become bound values, one column apiece, joined on with the same `UNION ALL` `concat`
uses. It answers no question about position that `concat` does not either, since a SQL result
carries none until an `orderBy` gives it one; reach for that when the row genuinely has to come
last. An entity with a `reference` needs a value for that navigation too, which is rarely one worth
fabricating, so project the columns wanted with `select` first when appending to one of those.

`prepend` is the same operator with the two sides of the `UNION ALL` swapped, and inherits both
`append`'s limits: no ordering is claimed for the row that was not there already, and an entity with
a `reference` wants its columns projected first.

`exceptBy` subtracts by a key rather than by the whole row, which is what lets the two sides be
different entities:

```ts
const reachable = await db.users
  .exceptBy(
    db.suppressions,
    (u) => u.email,
    (s) => s.address,
  )
  .toArray();

// SELECT ... FROM "users" AS "t0"
// WHERE NOT EXISTS (SELECT 1 FROM "suppressions" AS "t1"
//                   WHERE "t0"."email" = "t1"."address" OR ...)
```

`except` could not ask that: it compares whole rows, so it only subtracts a query of the same
shape, and a suppression list is not a user. Both keys are given, as in `join`, since the other
side is a query rather than a sequence of bare keys; both selectors produce a `TKey`, so a
mismatched pair is a compile error. Return an object from either to make the key several
expressions, and its parts are paired by name exactly as a set operation's columns are.

Nothing about it is positional, so it needs no ordering, and because it asks about rows rather than
joining them a duplicate on the other side costs nothing and no row is ever multiplied.

`intersectBy` is the complement, keeping the rows `exceptBy` drops:

```ts
const subscribed = await db.users
  .intersectBy(
    db.subscribers,
    (u) => u.email,
    (s) => s.address,
  )
  .toArray();
```

Between them they partition the query by whether the key was found, so the two return every row
exactly once. One compilation answers both, and the difference is the negation: `EXISTS` here,
`NOT EXISTS` there. Everything said above about keys, nulls, and duplicates holds unchanged.

That `EXISTS` is why this is not a `join` that projects the outer row back. A join would return a
user once per matching subscriber and would need a `distinct` to undo it; this asks whether a row is
there and never reads it, so a user subscribed twice still arrives once. There is no `unionBy` beside
these two, because uniting by key is not a question about whether a row belongs but about which of
two rows carrying one key to keep, which no `EXISTS` can answer.

## Reading a large result

`toArray` builds the whole result in memory. `chunk` holds one batch at a time instead, issuing a
`LIMIT`/`OFFSET` statement per batch, which is what makes a table too large to materialise still
processable:

```ts
for await (const batch of db.users.orderBy((u) => u.id).chunk(500)) {
  await send(batch);
}
```

Batches are read lazily: stop the loop and no further statement is issued. Two things follow from
each batch being its own statement. Order the query, or the pages are cut from a sequence the
database may reorder between statements, which can repeat a row in one batch and skip it in
another. And because the batches are read over time rather than from one snapshot, rows written
while the loop runs shift the ones behind them; read inside a transaction when that matters.

`after` is the other way to page, and the one that scales. It takes the last row of the page before
and seeks past it, where `skip` and the `chunk` built on it count off every row ahead of the page
and throw them away:

```ts
const page = await db.users
  .orderBy((u) => u.id)
  .after({ id: lastSeen })
  .take(20)
  .toArray();
```

```sql
SELECT ... FROM "users" AS "t0" WHERE "t0"."id" > $1 ORDER BY "t0"."id" ASC LIMIT 20
```

That is keyset paging, and the difference from `skip` is not a constant factor. `OFFSET 100000`
reads and discards a hundred thousand rows on every request, so the last page of a table costs the
most and a full walk costs quadratic work, while this page is an index seek whichever page it is. It
is also stable under writes, which `skip` is not: a row inserted ahead of the cursor shifts every
offset by one and makes a paging loop show a row twice or miss one, where a key already passed stays
passed. What it gives up is jumping — a cursor names the row to continue from, so there is no page
seven to ask for directly. Reach for `skip` when a caller can name an arbitrary page, and for this
when they are walking.

Several keys compare the way a dictionary orders words, each key settling only the rows its
predecessors tied on, so `orderBy(name).thenBy(id).after(row)` is
`name > $1 OR (name = $1 AND id > $2)` rather than two independent comparisons — which would drop
every row that comes after on the name while sitting below the cursor on the id. A descending key
reverses its own comparison and nothing else.

Only the sort keys are read off the cursor, so an object carrying just those is enough, which is
what a cursor round-tripped through a URL comes back as. Every sort key has to be a plain property
of the row: `orderBy((u) => u.name.length)` is refused, because the value would have to be read off
a row that never carried it. A null in the cursor's key is refused too — SQL orders nulls but cannot
compare them, so `name > NULL` is unknown rather than true and the walk would stop a page early.
Page by a key that cannot be null, which a cursor key should be anyway. What comes back is an
ordinary query rather than an ordered one, so no `thenBy` can be added behind a cursor that never
accounted for it.

`before` is the complement, and it is what makes the pair a walk rather than a one-way trip. It
takes the first row of the page in hand and seeks the other way:

```ts
const page = await db.users
  .orderBy((u) => u.id)
  .before({ id: firstSeen })
  .take(20)
  .toArray();

const inOrder = page.reverse();
```

```sql
SELECT ... FROM "users" AS "t0" WHERE "t0"."id" < $1 ORDER BY "t0"."id" DESC LIMIT 20
```

Both comparisons are strict, so the cursor row belongs to neither page and stepping back and forth
never hands it out twice. Notice that the `ORDER BY` turned as well as the comparison: this is
`after` over the reversed ordering, so the rows come back from the cursor outward and a `take` of
twenty is the twenty rows immediately behind it. Left as written, `WHERE id < $1 ORDER BY id ASC
LIMIT 20` would have been the first twenty rows of the table — the right predicate and the wrong
page, and wrong silently. SQL pages from the front only, so reaching backwards means reading
backwards.

The page therefore arrives backwards, and turning it round is yours to do: `.reverse()` on the
array, once, over the one page just read. That is the same trade `takeLast` names from the other
end, and it is settled this way here because a `LIMIT` over a reversed ordering is exactly what
paging by key is for. Everything `after` refuses `before` refuses too, naming itself rather than the
`after` whose comparison it borrows.

`chunkBy` reads the same way but lets the data decide where a batch ends, cutting a new one
wherever the key changes from one row to the next:

```ts
for await (const run of db.readings.orderBy((r) => r.takenAt).chunkBy((r) => r.status)) {
  await report(run[0]!.status, run.length);
}
```

That is not `groupBy`. Over statuses reading `ok, ok, failed, ok` this yields three runs where
`groupBy` gives two groups, and the runs are what say the failure was one episode rather than a
share of the day. Being positional it needs an ordering, so it lives on an ordered query as
`distinctBy` does.

The runs are numbered in the database, by asking `LAG` whether each row's key still matches the
one before it and running a sum over the breaks. That numbering is what lets the loop ask for one
run without reading the ones ahead of it, and what lets it stop at the first empty answer rather
than counting the runs first. It also means a run is bounded by the key rather than by a size the
caller chose: a key that never changes is one run and one statement returning every row.

## Reading a sequence against itself

`pairwise` hands each row and the one before it to a single projector, which is how a sequence is
read as its own differences:

```ts
const swings = await db.readings
  .orderBy((r) => r.takenAt)
  .pairwise((before, now) => ({ at: now.takenAt, change: now.value - before.value }))
  .toArray();
```

The earlier row comes first, as in LINQ's `Pairwise`. The first row has nothing before it and makes
no pair, so a query of `n` rows returns `n - 1` and a query of one returns nothing. Which row is
"before" is the ordering's decision, so reversing the order pairs each row with the one after it
instead.

The table is read once: every column is carried alongside a copy of itself taken from the row
before with `LAG`, and the pair is projected over the two. Nothing is joined and nothing is scanned
twice. What comes back is a `Queryable` like any other, so a filter after it filters pairs rather
than the rows they were made from.

`windowed` is the same idea widened from two rows to any number, which is what a moving average
needs:

```ts
const smoothed = await db.readings
  .orderBy((r) => r.takenAt)
  .windowed(7, (week, now) => ({ at: now.takenAt, mean: week.average((r) => r.value) }))
  .toArray();
```

`pairwise` can name both of its rows because there are exactly two; a run of `n` has no name for
each member, so the run arrives as the same aggregate receiver a `groupBy` result selector is
handed and is read with `average`, `sum`, `min`, `max`, `count`, and `toArray`. Only
`countDistinct` is missing, because SQL does not define `DISTINCT` over a window, and the type says
so rather than the database.

A run needs `n` rows to be a run, so the first `n - 1` rows produce none and a query of `m` rows
returns `m - n + 1`, which is `pairwise`'s own `m - 1` at a size of two. The run trails the row it
ends at, so reversing the ordering makes it lead instead. Unlike `pairwise`, both the run and the
row read the query's own rows rather than a derived table's columns, so a navigation off the row
still resolves.

This is one window rather than a copy of the table: the aggregates and a row number are computed
in a derived table over a frame of `n - 1` preceding rows and the current one, and the row number
is what drops the short runs outside it. Dropping them inside would shorten the very frames it was
meant to select from.

`expanding` is the running counterpart, which is the same frame with its near end let go:

```ts
const balances = await db.entries
  .orderBy((e) => e.postedAt)
  .expanding((sofar, now) => ({ at: now.postedAt, balance: sofar.sum((e) => e.amount) }))
  .toArray();
```

That is a running total read off one statement, where `windowed` gives a moving one. The run
arrives as the same receiver and answers the same aggregates, so what to know is where the two
part company, and it is only ever in two places. The frame starts at `UNBOUNDED PRECEDING` rather
than `n - 1` rows back; and because a run up to the first row is that row alone, nothing is short
and nothing is dropped, so a query of `m` rows returns `m` where `windowed(n, ...)` returns
`m - n + 1`.

That second difference is what makes `count()` worth asking here. Over a fixed run it answers the
size for every row and tells you only that the short runs are gone; over a growing one it answers
the row's position, counted from one as `ROW_NUMBER` counts rather than from zero as `index` does.
The ordering decides which rows come before, as it does for `windowed`, so reversing it
accumulates from the other end: the first row handed back then carries every row of the query and
the last carries itself alone.

Neither of those reduces a frame per key, which a table holding several series needs:

```ts
const smoothed = await db.readings
  .orderBy((r) => r.takenAt)
  .windowedBy(
    (r) => r.sensorId,
    7,
    (week, now) => ({
      at: now.takenAt,
      mean: week.average((r) => r.value),
    }),
  )
  .toArray();
```

`windowedBy` and `expandingBy` are `windowed` and `expanding` with a partition, so a reading is
averaged only with the six readings before it _from its own sensor_. `windowed` would have reached
back seven rows whoever they belonged to, and a `groupBy` cannot help: grouping collapses the very
rows a frame has to still find behind each one. Return an object from the key selector to
partition on more than one expression, as `groupBy` does.

What the partition changes beyond the values is how many rows come back, and only for the fixed
run. `windowedBy(key, n, ...)` needs `n` rows within a key, so the first `n - 1` rows of _every_
key produce none and a key with fewer than `n` rows contributes nothing at all. `expandingBy`
drops nothing, since a run up to a row is never short, and its `count()` is the position within
the key rather than within the query.

The rows still come back in the ordering they were in, not grouped by key. A partition decides
which rows sit behind a row and the ordering decides where the row itself goes, so two sensors
reporting alternately come back alternating. In the statement that is two row numbers rather than
one: the frame and the short-run test restart per key, the ordering does not, which is the same
rank-beside-position `distinctBy` computes.

`sequenceEqual` asks the same kind of question `zip` answers, turned into a yes-or-no:

```ts
const inSync = await db.users
  .orderBy((u) => u.id)
  .sequenceEqual(replica.users.orderBy((u) => u.id));
```

Both sides are numbered by position exactly as `zip` numbers them, then compared with a `FULL JOIN`
on that number rather than `zip`'s `INNER JOIN`: a position only one side reaches joins against
nothing there, which is what turns a length mismatch into a row rather than into something read
after the fact. `NOT EXISTS` then asks whether any position disagrees, without a row of either side
ever leaving the database or a count taken of either one. Two empty queries are equal, as they are
in LINQ.

## Reaching the end of a sequence

SQL pages from the front of a result and only from the front, so the end is reached by turning the
query round. `reverse` flips every sort key, which costs nothing:

```ts
const newest = await db.users
  .orderBy((u) => u.createdAt)
  .reverse()
  .take(3)
  .toArray();
```

That is the three newest users, newest first. When the order of the answer matters, `takeLast` is
the same query with the order put back:

```ts
const newest = await db.users
  .orderBy((u) => u.createdAt)
  .takeLast(3)
  .toArray();
```

Those are the same three rows, oldest of the three first, which is what LINQ's `TakeLast` returns.
The rows are still reached by the flipped keys and the limit, so the database stops at three rather
than sorting the table and an index on the key serves the reversed order as well; the three that
survive are then sorted forwards inside a derived table. A window would answer without that second
sort, but `ROW_NUMBER` has to number every row before it can say which three are last, which is the
whole table where the limit is three rows.

Each sort key is carried out of the derived table as a column of its own, since the outer sort has
to reapply it and a key is not always one the query selected: it can be an expression, or reach
through a navigation whose join exists only inside. Those columns are dropped by the select around
them and never reach a row.

What follows lands on the rows that were kept, which is the difference between narrowing the last
three and choosing which three they are:

```ts
db.users
  .orderBy((u) => u.age)
  .takeLast(3)
  .where((u) => u.isActive); // active among the oldest three
db.users
  .where((u) => u.isActive)
  .orderBy((u) => u.age)
  .takeLast(3); // the oldest three active users
```

`skipLast` is the complement, keeping everything `takeLast` drops:

```ts
const settled = await db.readings
  .orderBy((r) => r.takenAt)
  .skipLast(1)
  .toArray();
```

That drops the most recent reading, which is the usual reason to want it: a trailing row still being
written, or a running total whose last bucket is not closed. Between them the two partition the
sequence `n` rows from its end, and one compilation answers both — the order is flipped either way,
and what separates them is a `LIMIT` against an `OFFSET`.

They do not cost the same, though, and the asymmetry is SQL's. `takeLast`'s limit lets the database
stop at `n` rows; `skipLast`'s offset has to reach every row past `n`, so the whole sequence is
ordered. That is inherent rather than a shortcoming of the translation: which rows are last cannot be
known without looking at all of them.

All three operators live on an ordered query, because which rows are last is a question only an
ordering answers. Rows tying on every sort key leave that question to the database, so add a
tiebreaking key with `thenBy` when it matters.

`index` pairs each row with where it sits in the ordering, which is the other thing a sequence
knows about itself that no column holds:

```ts
const numbered = await db.users
  .orderBy((u) => u.score)
  .reverse()
  .index((u, position) => ({ name: u.name, position }))
  .toArray();
```

The position counts from zero, as LINQ's `Index` and JavaScript's own iteration do. `ROW_NUMBER`
counts from one and the difference is closed in the translation rather than left for every caller
to remember. The row comes first and the position second, as they do in JavaScript's `map`.

The number is computed one level down, inside a derived table, and the projection is applied over
it. That is not incidental: a window cannot appear in a `WHERE`, so computing it in place would
make the result unfilterable, and `index(...).where((r) => r.rank < 10)` reads the number as an
ordinary column instead. `where` itself takes a second parameter the same way `select` does, for
filtering by position directly rather than projecting first:

```ts
const top10 = await db.users
  .orderBy((u) => u.score)
  .reverse()
  .where((u, rank) => rank < 10)
  .toArray();
```

Which position a row has is the ordering's decision, so reversing the order numbers from the other
end. The row comes back out of a derived table and can still be navigated off: the foreign key
came out of it under its own name, so `index((o, i) => ({ who: o.user.name, i }))` joins against
the derived table rather than the table inside it.

What `index` is not is a leaderboard, and `rank` is:

```ts
const leaderboard = await db.users
  .orderByDescending((u) => u.score)
  .rank((u, place) => ({ name: u.name, place }))
  .toArray();
```

The difference is ties. `index` is `ROW_NUMBER`, so two users on the same score get different
numbers and which of them comes first is whatever the database reached first — fine for a
position, wrong for a placing. `rank` gives them the same number, which is the only reading a
standing shown to a person can have. It also counts from one rather than zero, deliberately: a
position is a JavaScript index and a placing is what a person calls first place, so this is the
operator to reach for instead of adding one to an `index`.

SQL spells a standing two ways and they disagree about what follows a tie, so both are here.
`rank` skips the places a tie consumed, so three users tied for second are all second and the next
is fifth; `denseRank` does not, and the next is third:

```ts
const tiers = await db.products
  .orderByDescending((p) => p.price)
  .denseRank((p, tier) => ({ name: p.name, tier }))
  .toArray();
```

Reach for `rank` when the number is a placing and `denseRank` when it is a band — "how many
distinct prices are this one and above". The two are one compilation apart, `RANK` against
`DENSE_RANK` over the same window.

What counts as a tie is what the ordering says, and only that. Two rows tie when they agree on
every sort key, so `thenBy((u) => u.id)` is how a query asks for no ties at all — at which point
`rank` and `index((u, i) => i + 1)` answer the same thing, and the choice between them is only
about which reading you want if a tie ever appears. The place is filterable for the reason a
position is, the window sitting a level down, so `rank(...).where((r) => r.place <= 10)` is an
ordinary query and is usually the point.

## Guaranteeing a row

`defaultIfEmpty` makes a query that cannot come back empty. A query that matched nothing answers
with a single row whose every column is null; a query that matched anything is unchanged:

```ts
const [summary] = await db.orders
  .where((o, p) => o.userId === p.id, { id: 7 })
  .select((o) => ({ total: o.total }))
  .defaultIfEmpty()
  .toArray();
```

That is LINQ's `DefaultIfEmpty`, and it is what saves the caller from branching on an empty array
before reading the one row they expected. The columns widen to `NullableRow<T>`, as a `leftJoin`'s
inner side does, so reading `summary.total` off a query that matched nothing is a compile error
rather than a surprise at runtime.

SQL has no operator for this, but a join says it: a source of exactly one row on the left, the query
on the right, and a condition that is always true. Match nothing and the one row survives with the
query's columns null; match anything and it is multiplied away by the rows that matched. The query is
read once, which the obvious `UNION ALL` against a `NOT EXISTS` guard would not manage. A `SELECT`
with no `FROM` is what most databases accept as that one-row source and what the SQL standard does
not, so the spelling comes from the dialect and a database insisting on `DUAL` overrides it.

Two things follow from the default row being nulls. It cannot be told apart from a real row whose
columns happened to be null, so ask `any()` when that matters rather than inspecting the row. And a
filter after it can undo it, exactly as a filter after a `leftJoin` does: a null fails every
comparison, so the predicate meant to inspect the default row is what drops it. Filter before.

A caller can supply that default row instead of leaving it to nulls:

```ts
const [summary] = await db.orders
  .where((o, p) => o.userId === p.id, { id: 7 })
  .select((o) => ({ total: o.total }))
  .defaultIfEmpty({ total: 0 })
  .toArray();
```

That is the other overload of LINQ's `DefaultIfEmpty`. The result stays a `T` rather than widening to
`NullableRow<T>`, since every column that might have gone missing now has a value chosen ahead of
time, and the row travels the way `append`'s does: as ordinary bound values, nothing evaluated in
this process beyond building the literal. Telling a real row from a missing one still needs help
nulls alone no longer give, since a real row can hold the same values as the default by coincidence;
the derived table carries one further column for it, a literal witness that survives only when the
join actually matched, and the outer `CASE` reads that rather than the caller's own columns.

## Adding rows

`insert` is the first operator here that writes. It lives on an entity set rather than on a query,
because a query is a shape and a table is a place: `db.users.where(...)` is still a query, and
inserting into it means nothing.

```ts
const ada = await db.users.insert({ name: 'Ada', email: 'ada@example.com', age: 36 });
ada.id; // the generated key
```

The argument asks for the columns that have no other source and accepts the rest. Anything declared
`generated` comes from the database, and anything `nullable` is the same row whether it is left out
or written as null, so both are optional and the compiler says so. Navigations are not part of it:
inserting through one would be a second statement into a second table, and that is a decision this
does not make for the caller.

What comes back is read from the statement rather than assembled from the argument, which is what
makes a generated key, a column default, and a trigger all visible:

```sql
INSERT INTO "users" ("name", "email", "age") VALUES ($1, $2, $3)
RETURNING "id" AS "id", "name" AS "name", "email" AS "email", "age" AS "age", ...
```

`insertMany` writes several rows in one statement, which is the whole reason to reach for it:

```ts
const added = await db.users.insertMany([
  { name: 'Ada', email: 'ada@example.com', age: 36 },
  { name: 'Grace', email: 'grace@example.com', age: 45 },
]);
```

One statement has one column list, so the list is the union of what the rows mention and a row that
leaves out a column another one named writes null there rather than the column default. Pass rows of
the same shape, or insert them separately. An empty list adds nothing and issues no statement.

`insertFrom` fills the table from a query instead of from rows:

```ts
const archived = await db.archivedUsers.insertFrom(
  db.users.where((u) => !u.isActive).select((u) => ({ name: u.name, email: u.email })),
);
```

```sql
INSERT INTO "archived_users" ("name", "email")
SELECT "t0"."name" AS "name", "t0"."email" AS "email"
FROM "users" AS "t0" WHERE NOT "t0"."is_active" RETURNING ...
```

The difference between it and `insertMany` is where the values come from rather than how many there
are. `insertMany` carries its rows to the database; this names a query and lets the database find
them, so nothing crosses the wire in either direction. That makes it the operator for rows that are
already there — copying a table, archiving what a filter selected, seeding one table from another —
and it stays one statement however many rows the query turns out to match.

The projection names the columns, and the compiler checks each against the entity. A column the
projection leaves out takes the column default rather than null, which is the one place this is
kinder than `insertMany`: there is one column list and the query supplies all of it. The order the
projection is written in does not matter, even though it matters to SQL: `INSERT ... SELECT` lines
the two up by position and ignores the aliases, so the statement puts them in step before printing.

Any query will do, unlike `update` and `delete`, which insist on a bare filter. A join, a grouping,
an ordering, and a page are all fine, because nothing here has to work out which rows of one table
the statement is about, and the query may read the very table being written to. Two projections are
refused: one down to a single unnamed value, which cannot say which column it fills, and one that
nests a whole row inside a property, since a column holds a value rather than a row.

Unlike `insertMany([])`, this always issues its statement. Whether the query finds any rows is the
database's to answer, and an empty array back is that answer rather than a call that did nothing.

`upsert` is `insert` and `where(...).update(values)` combined into the one statement a database
needs to do either without a race between them: it adds the row, or, if one already there conflicts
on the primary key, updates that row with the values just given instead.

```ts
const ada = await db.users.upsert({ id: 1, name: 'Ada', email: 'ada@example.com', age: 36 });
```

```sql
INSERT INTO "users" ("id", "name", "email", "age") VALUES ($1, $2, $3, $4)
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email", "age" = EXCLUDED."age"
RETURNING "id" AS "id", "name" AS "name", "email" AS "email", "age" AS "age", ...
```

The conflict is always detected on the entity's own declared primary key; naming a different column
to conflict on is not part of this. Every other column the argument names is overwritten with the
value just given when a conflicting row is already there, so a call that names nothing but the
primary key is refused: there would be nothing left to update on a conflict. `upsertMany` writes
several rows this way in one statement, following `insertMany`'s own column-list and empty-list
rules.

`update` gives rows new values, and the query is how it says which rows:

```ts
const promoted = await db.users.where((u) => u.age >= 18 && !u.isActive).update({ isActive: true });
```

```sql
UPDATE "users" AS "t0" SET "is_active" = TRUE
WHERE "t0"."age" >= $1 AND NOT "t0"."is_active"
RETURNING "t0"."id" AS "id", ...
```

That is the whole difference between it and `insert`. An insert makes rows and needs a place to put
them, so it lives on the entity set; an update needs to say which rows it means, and a query is how
this library says that. The filter is compiled by the same machinery that compiles it for a read, so
anything writable in a `where` is writable here.

Only a filter, though. A query that has grown a projection, a join, a grouping, an ordering, or a
page is no longer a set of rows in one table, and each is refused by the name of the clause that
caused it — including a navigation in the filter, which reads as an ordinary `where` until it
compiles into a join. Filter the rows to update and nothing else.

A query with no filter updates every row:

```ts
await db.users.update({ isActive: false }); // every user
```

That is a thing SQL can do and a thing this does. It is not a mistake the library catches; it is a
sentence that means what it says, and the way to avoid writing it by accident is to notice that a
`where` is missing.

`update` also takes a lambda, for a value that depends on the row's own current one rather than on
something already known before the statement runs:

```ts
const leveled = await db.users.where((u) => u.isActive).update((u) => ({ score: u.score + 1 }));
```

```sql
UPDATE "users" AS "t0" SET "score" = "t0"."score" + $1 WHERE "t0"."is_active" RETURNING ...
```

Its object literal reads the same way `select`'s does and takes an optional params object the same
way, but it names only columns to overwrite rather than reshaping the row, and it reads no further
than the row itself: a navigation such as `u.city.name` is refused, since a plain
`UPDATE ... SET` has no join for one to lean on.

What comes back is read from the statement rather than assembled from the argument, as an insert's
is, which is what makes a trigger and a computed column visible. The rows arrive in whatever order
the database wrote them, and a filter that selected nothing returns an empty array rather than
faulting.

`delete` removes rows, and the query says which ones in exactly the way it does for an update:

```ts
const removed = await db.users.where((u, p) => !u.isActive && u.age < p.min, { min: 13 }).delete();
```

```sql
DELETE FROM "users" AS "t0" WHERE NOT "t0"."is_active" AND "t0"."age" < $1
RETURNING "t0"."id" AS "id", ...
```

It is the write with nothing to set, which makes it the shortest operator here and the one worth the
most care. Every clause an update refuses is refused here too, by the same name and for the same
reason, since the two statements differ in what they do to a row once it is found and not at all in
how they find it. What an update has and this does not is an argument: an update with nothing to set
is a sentence that does not finish and is refused as one, while a delete has nothing to say by
nature, so the query in front of it is the entire safeguard.

A query with no filter empties the table:

```ts
await db.users.delete(); // every user
```

As with `update`, that is a sentence that means what it says rather than a mistake the library
catches, and a missing `where` is the only thing between the two readings.

The removed rows come back, which is worth more here than for the other two writes: once the
statement has run there is nowhere else left to read them from. That is a record, not an undo. Put
the delete in a transaction when you might want it back, since what comes back can be inspected and
not put back. A filter that selected nothing removes nothing and answers an empty array rather than
faulting, and a row another table still references is the database's to refuse, so its foreign key
error arrives untouched rather than being anticipated here.

Writes are where a transaction starts to earn its keep, since a rollback now has something to undo:

```ts
await db.$transaction(async (tx) => {
  const user = await tx.users.insert({ name: 'Ada', email: 'ada@example.com', age: 36 });
  await tx.orders.insertMany(basket.map((line) => ({ userId: user.id, total: line.total })));
});
```

`RETURNING` is what PostgreSQL, SQLite, and MariaDB call the clause that reads inserted rows back,
and it is not in the SQL standard; SQL Server writes `OUTPUT` and puts it before the values. The
printer asks the dialect for the clause, so a database that spells it differently has somewhere to
say so, and one that cannot express it at all has more than a word to change.

## Tracing a statement back

A statement in the database's log is a statement without a caller. `tag` carries a comment into the
SQL so there is one:

```ts
const digest = await db.users
  .where((u) => u.isActive)
  .tag('nightly digest')
  .toArray();
```

```sql
/* nightly digest */ SELECT "t0"."id" AS "id", ... FROM "users" AS "t0" WHERE "t0"."is_active"
```

The comment is the only thing it adds. Nothing about which rows are read changes, which is why it can
be written anywhere in a chain, and why the writes accept it where they refuse every other clause: a
tag says nothing about which rows are meant, and a slow `UPDATE` or `DELETE` is exactly the statement
worth finding again.

```ts
await db.users
  .where((u) => !u.isActive)
  .tag('monthly purge')
  .delete();
// /* monthly purge */ DELETE FROM "users" AS "t0" WHERE NOT "t0"."is_active" RETURNING ...
```

The tag lands on the statement rather than on the clause it was written over. A query later wrapped
in a derived table, by a page or by `count`, still prints its comment at the top rather than from
inside the subquery, and a tag written on one side of a `union` reaches the statement both sides
compile into. Tag more than once and every tag prints, keeping the order they were written down the
chain.

```ts
await db.users
  .tag('report')
  .orderBy((u) => u.age)
  .take(10)
  .count();
// /* report */ SELECT COUNT(*) AS "count" FROM (SELECT ...) AS "t1"
```

The text is the one thing a caller writes that reaches the statement as text rather than as a bound
value, so it is checked rather than trusted: a tag holding a block comment delimiter is refused, in
either direction, since PostgreSQL nests block comments and an opening pair would leave the comment
unterminated as surely as a closing one would end it early. Describe the query rather than
interpolating a value into it and there is nothing to escape.

One statement carries it. `include` reads its navigation with a second statement, built from a plan
of the library's own, and that one arrives in the log untagged. `insert` cannot be tagged at all,
since a tag decorates a query and an insert has none: it lives on the entity set for the same reason
it takes no `where`.

## Reading from one snapshot

`$transaction` runs a body against a context whose statements share one connection and one
transaction, committing when it returns and rolling back when it throws:

```ts
const report = await db.$transaction(async (tx) => {
  const people = await tx.people.orderBy((p) => p.id).toArray();
  const total = await tx.people.count();
  return { people, total };
});
```

The context handed to the body reads the same entities through the same dialect and logger, so a
query written against one runs against the other unchanged. What it adds is that several statements
see one snapshot, which is exactly what the operators issuing more than one statement have been
asking for:

```ts
await db.$transaction(async (tx) => {
  for await (const batch of tx.people.orderBy((p) => p.id).chunk(500)) {
    await send(batch);
  }
});
```

Without it, `chunk` pages over a table that other writers are moving, and a row can be repeated in
one batch and skipped in another. The same holds for `chunkBy` and for `include`, whose second
statement is read after its first.

Use only the context handed in. A statement issued on the outer `db` during the body runs on a
different connection and is outside the transaction, which is easy to write by accident and
impossible for the library to catch.

A body that throws rolls back, and the error is rethrown untouched rather than replaced by a
rollback failure. The connection goes back to the pool either way. Nesting is not offered: a driver
inside a transaction reports that it has none, rather than issuing a `BEGIN` inside a `BEGIN` that
PostgreSQL would warn about and ignore.

`transaction` is optional on the `Driver` contract, so a driver over something that has no
transactions still satisfies the rest of it. A context whose driver has none refuses `$transaction`
by name, since running the body anyway would look like a transaction and protect nothing.

## Not yet implemented

Change tracking and migrations.

Change tracking clusters behind a foundation this library does not have yet, a change tracker.
Migrations are a separate gap, blocked on model configuration rather than on it.
[Distance from Entity Framework Core](CONTRIBUTING.md#distance-from-entity-framework-core) sets out
what each of these costs, along with a second foundation, a result-shaping layer, that still stands
behind smaller gaps of its own, inheritance mapping and value converters among them, and the
differences that are decisions rather than gaps.

Three more things were once counted among these gaps and are not any more. Transactions turned out
to be mostly already built: `$transaction` already commits or rolls back a body sharing one
connection, and only savepoints and retry on a transient failure are still missing. A lambda
mentioning a query turned out not to be what either `IN (subquery)` or correlated `LATERAL`
flattening needed. And identity resolution off a `.join()` turned out not to need a shaping layer at
all: `groupJoin`'s `toArray()`, `include`'s `asSingleStatement()`, and a join's own nested-embed
projection each answer a different shape of the same question.

## How it works

```
lambda source ──tokenize──▶ tokens ──parse──▶ JS AST ──bind──▶ expression IR
                                                                     │
query plan (where / select / orderBy / ...) ◀────────────────────────┘
      │
      └──compile──▶ SQL AST ──print──▶ { text, parameters } ──bind values──▶ driver
```

Each arrow is a separate module with a single job, which is what keeps the pieces replaceable:

- `src/parser/` turns source text into a small JavaScript AST. It accepts only the subset that has
  a SQL meaning and reports a precise offset for anything else.
- `src/parser/bind.ts` gives identifiers meaning: row alias, parameter bag, or an error.
- `src/expression/` is the intermediate representation. A different front end, such as a
  proxy-based builder, could target it without touching the compiler.
- `src/query/` accumulates the operator tree. Immutable, so queries can be shared and branched.
- `src/sql/` lowers that tree into a relational algebra tree and prints it through a dialect.
- `src/driver.ts` is the whole provider contract: take SQL and values, return rows.

Adding a database means extending `BaseDialect` with identifier quoting, placeholder syntax, and
whatever functions that database spells differently. `@sqlinqo/postgres` is about 90 lines and is
meant to be read as the reference.

## Development

```bash
pnpm install
pnpm verify              # format, lint, typecheck, test, build
pnpm test                # unit tests; integration tests skip without a database
pnpm test:db:up          # start PostgreSQL on port 5433 via docker compose
DATABASE_URL=postgres://sqlinqo:sqlinqo@localhost:5433/sqlinqo pnpm test
pnpm --filter @sqlinqo/example-basic-pg start
```

## Releasing

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets).

```bash
pnpm changeset           # describe the change and pick a bump
pnpm version-packages    # apply versions and write changelogs
pnpm release             # build and publish
```

Publishing to the `@sqlinqo` scope requires that npm scope to exist and be owned by the publishing
account. See [CONTRIBUTING.md](CONTRIBUTING.md) for the one-time setup.

## License

MIT
