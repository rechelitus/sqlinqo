# @sqlinqo/postgres

PostgreSQL provider for [`@sqlinqo/core`](https://www.npmjs.com/package/@sqlinqo/core): the dialect,
a [node-postgres](https://node-postgres.com) driver, and a one-call context factory.

```bash
npm install @sqlinqo/core @sqlinqo/postgres pg
```

`pg` is a peer dependency, so your application controls the client version.

```ts
import { defineEntity } from '@sqlinqo/core';
import { createPostgresContext } from '@sqlinqo/postgres';

const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    age: { type: 'int' },
  },
});

const db = createPostgresContext({
  connectionString: process.env.DATABASE_URL,
  entities: { users: User },
});

const adults = await db.users.where((u, p) => u.age >= p.min, { min: 18 }).toArray();
await db.$close();
```

Pass an existing `Pool` as `pool` to share one with the rest of your application. When you do,
`$close()` leaves that pool open, since its lifetime belongs to whoever created it.

See the [repository README](https://github.com/rechelitus/sqlinqo#readme) for the full guide.
