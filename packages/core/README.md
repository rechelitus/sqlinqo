# @sqlinqo/core

The provider-agnostic half of [sqlinqo](https://github.com/rechelitus/sqlinqo): entity
metadata, the query-lambda parser, the expression IR, and the SQL compiler.

This package never touches a database. Pair it with a provider such as
[`@sqlinqo/postgres`](https://www.npmjs.com/package/@sqlinqo/postgres), or implement the `Driver`
and `SqlDialect` contracts yourself.

```ts
import { createDbContext, defineEntity } from '@sqlinqo/core';

const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    age: { type: 'int' },
  },
});

const db = createDbContext({ driver, dialect, entities: { users: User } });

db.users.where((u, p) => u.age >= p.min, { min: 18 }).toSQL();
// { text: 'SELECT ... WHERE "t0"."age" >= $1', values: [18] }
```

See the [repository README](https://github.com/rechelitus/sqlinqo#readme) for the full guide.
