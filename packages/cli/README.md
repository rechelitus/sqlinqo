# @sqlinqo/cli

Scaffolds [`@sqlinqo/core`](../core) entity definitions from an existing PostgreSQL schema.

Point it at a database and it writes the model you would otherwise write by hand: one file per
table, the physical names stated explicitly, and a navigation for each end of every foreign key.

```bash
npx @sqlinqo/cli scaffold --url postgres://user@localhost/app --out src/entities
```

```
Read 4 entities from schema "shop".

  created       src/entities/city.ts
  created       src/entities/customer.ts
  created       src/entities/order.ts
  created       src/entities/index.ts

Wrote 4 files to src/entities.
```

## What it writes

A table like this:

```sql
CREATE TABLE customers (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name  text NOT NULL,
  city_id    integer NULL REFERENCES cities (id),
  tags       text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN customers.full_name IS 'Name as the customer wrote it.';
```

becomes this:

```ts
import { collection, defineEntity, reference } from '@sqlinqo/core';
import type { EntityOf } from '@sqlinqo/core';

import { City } from './city.js';
import { Order } from './order.js';

/** Table `customers`. */
export const Customer = defineEntity({
  name: 'Customer',
  table: 'customers',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    /** Name as the customer wrote it. */
    fullName: { type: 'text', column: 'full_name' },
    cityId: { type: 'int', column: 'city_id', nullable: true },
    tags: { type: 'array', of: 'text', generated: true },
    createdAt: { type: 'timestamp', column: 'created_at', generated: true },
  },
  relations: {
    city: reference(() => City, 'cityId', { optional: true }),
    orders: collection(() => Order, 'customerId'),
  },
});

export type Customer = EntityOf<typeof Customer>;
```

Alongside them, an `index.ts` re-exporting every entity and the map a context takes:

```ts
import { entities } from './src/entities/index.js';

const db = createPostgresContext({ connectionString: process.env.DATABASE_URL, entities });
```

## Options

| Option                   | Default         | Meaning                                             |
| ------------------------ | --------------- | --------------------------------------------------- |
| `-u, --url <string>`     | `$DATABASE_URL` | Connection string.                                  |
| `-s, --schema <name>`    | `public`        | Schema to read.                                     |
| `-o, --out <dir>`        | `src/entities`  | Output directory, created if missing.               |
| `--tables <a,b>`         | every table     | Only these tables. Repeatable, or comma separated.  |
| `--exclude <a,b>`        | none            | Tables to leave out, applied after `--tables`.      |
| `--no-relations`         | off             | Map columns only, ignoring foreign keys.            |
| `--qualify-schema`       | off             | Emit `schema` on every entity.                      |
| `--import-extension <e>` | `.js`           | Extension on generated imports. Pass `""` for none. |
| `-f, --force`            | off             | Overwrite files that already exist.                 |
| `--dry-run`              | off             | Print what would be written, and write nothing.     |

It exits `0` on success, `1` on a failure, `2` on a usage mistake, and `3` when every file was
generated but one or more already existed and were kept back.

## Regenerating

The output is a starting point, not a build artefact. Rename anything that reads badly: `table` and
`column` state the physical names, so a better property name costs nothing and breaks nothing.

That is why a second run never overwrites a file you have edited. A file whose contents still match
is reported `unchanged` and not rewritten at all; one that differs is `kept` until you pass
`--force`. Run with `--dry-run` first to see which is which.

## Type mapping

| PostgreSQL                                  | Logical type           |
| ------------------------------------------- | ---------------------- |
| `smallint`, `integer`                       | `int`                  |
| `bigint`                                    | `bigint`               |
| `real`, `double precision`                  | `float`                |
| `numeric`, `money`                          | `decimal`              |
| `text`, `varchar`, `char`, `citext`, `xml`  | `text`                 |
| `time`, `timetz`, `inet`, `cidr`, `macaddr` | `text`                 |
| any `enum`                                  | `text`                 |
| `uuid`                                      | `uuid`                 |
| `boolean`                                   | `boolean`              |
| `date`                                      | `date`                 |
| `timestamp`, `timestamptz`                  | `timestamp`            |
| `json`, `jsonb`                             | `json`                 |
| any array of the above                      | `array`, with its `of` |

The rule is what the driver hands back, not what the column is called. `time` and `inet` are `text`
because node-postgres returns them as strings, and `numeric` is `decimal` rather than `float`
because rounding a financial column silently is worse than making the caller convert.

A domain is mapped as the type it was built over, and an enum as `text`, since every enum reads back
as a string.

## What it declines

Nothing is guessed. Each of these leaves the schema partly unmapped and says so on stderr, naming
what was left out:

- **A type with no logical answer.** `bytea` is a `Buffer` and `interval` is an object, and no
  logical type says so. The column is left out of the entity rather than mapped to something
  plausible and wrong.
- **A composite foreign key.** `reference` names one property, so a key over several columns has no
  navigation to become. The columns themselves are still mapped.
- **A key pointing outside what was read**, whether into another schema or at a table excluded by
  `--tables`. There would be nothing to import.
- **Views.** Base tables and partitioned tables only. A partitioned table is mapped once; its
  partitions are not mapped separately.

A run that prints no warnings mapped the whole schema.

## Naming

Entity and property names are conventions rather than facts the database reported:

- `users` becomes `User`, `order_items` becomes `OrderItem`. Only the last word is singularised.
- Columns become camelCase, and `column` is emitted only where the two differ.
- A foreign key named `city_id` becomes a `city` reference; the collection on the other side is the
  pluralised child table, `users`.
- A name that would collide with another is numbered, which is a signal to look rather than a
  finished answer.

Pluralisation is a heuristic with the usual English gaps: `categories` reads as `category`, and so
would `movies`. Renaming is safe, because the physical names are stated separately.

## Using it as a library

Every step is exported, so a project with its own conventions can take over at any point:

```ts
import { PostgresSchemaReader, buildModel, emitFiles } from '@sqlinqo/cli';

const schema = await new PostgresSchemaReader({ connectionString, schema: 'shop' }).read();
const model = buildModel(schema, { relations: true });
const files = emitFiles(model, { importExtension: '' });
```

`SchemaReader` is the interface a reader for another database, or one that parses a DDL file
offline, would implement. Nothing in `buildModel` or `emitFiles` is PostgreSQL specific.

## Caveats

- **PostgreSQL only**, because it is the only provider. The reader is the part that would change.
- **No write path.** `generated: true` is recorded wherever the database produces the value, but
  the engine has no inserts or updates to use it for yet.
- **`--qualify-schema` is off by default.** A scaffold of `public` that names it stops working
  against a connection whose `search_path` says otherwise, which is how the same code usually
  reaches a test database and a live one.

## Licence

MIT
