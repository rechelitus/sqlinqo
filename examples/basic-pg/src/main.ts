/**
 * A runnable tour of the query API.
 *
 * With DATABASE_URL set it executes against PostgreSQL. Without it, the script
 * still prints the SQL each query compiles to, which is the quickest way to see
 * what the translator does with a given lambda.
 *
 *   pnpm --filter @sqlinqo/example-basic-pg start
 */
import { defineEntity, reference } from '@sqlinqo/core';
import type { EntityOf } from '@sqlinqo/core';
import { createPostgresContext } from '@sqlinqo/postgres';

const User = defineEntity({
  name: 'User',
  table: 'users',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    name: { type: 'text' },
    email: { type: 'text' },
    age: { type: 'int' },
    cityId: { type: 'int', column: 'city_id', nullable: true },
    isActive: { type: 'boolean', column: 'is_active' },
    createdAt: { type: 'timestamp', column: 'created_at' },
  },
  // The city a user belongs to. `cityId` is nullable, so the reference is
  // optional and is joined with a LEFT JOIN.
  relations: {
    city: reference(() => City, 'cityId', { optional: true }),
  },
});

const City = defineEntity({
  name: 'City',
  table: 'cities',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    country: { type: 'text' },
  },
});

// The row type is derived from the mapping, so nothing is declared twice.
type User = EntityOf<typeof User>;
type City = EntityOf<typeof City>;

const connectionString = process.env['DATABASE_URL'];

const db = createPostgresContext({
  connectionString,
  entities: { users: User, cities: City },
  logger: (statement) => console.log(`[sql ${statement.durationMs}ms] ${statement.text}`),
});

function show(
  label: string,
  query: { toSQL(): { text: string; values: readonly unknown[] } },
): void {
  const { text, values } = query.toSQL();
  console.log(`\n${label}\n  ${text}\n  values: ${JSON.stringify(values)}`);
}

// Filtering. Values from the surrounding scope travel in the parameter bag,
// which is what keeps the compiled statement reusable and injection-free.
const minimumAge = 18;
const adults = db.users.where((u, p) => u.age >= p.minimumAge && u.isActive, { minimumAge });
show('adults', adults);

// Projection into a new shape. The result type follows the object literal.
const summaries = adults
  .orderBy((u) => u.name)
  .thenByDescending((u) => u.age)
  .select((u) => ({ id: u.id, label: u.name, initial: u.email.substring(0, 1) }));
show('summaries', summaries);

// Paging. A filter applied after paging is pushed into a subquery so it runs
// over the limited rows rather than the whole table.
show(
  'second page',
  adults
    .orderBy((u) => u.id)
    .skip(20)
    .take(10),
);

// Set membership. The list is expanded into one placeholder per element.
show(
  'by id',
  db.users.where((u, p) => p.ids.includes(u.id), { ids: [1, 2, 3] }),
);

// Conditional projection.
show(
  'tiers',
  db.users.select((u) => ({ id: u.id, tier: u.age >= 65 ? 'senior' : 'standard' })),
);

// Inner join. The result selector sees both rows and flattens them, so the
// ordering below applies to the joined shape rather than to either input.
show(
  'residents',
  db.users
    .join(
      db.cities,
      (u) => u.cityId,
      (c) => c.id,
      (u, c) => ({ who: u.name, city: c.name, country: c.country }),
    )
    .orderBy((row) => row.city),
);

// A joined query that carries its own filter becomes a derived table, and its
// parameter bag is renumbered so it cannot collide with the outer one.
show(
  'dutch residents',
  db.users
    .where((u, p) => u.age >= p.minimumAge, { minimumAge })
    .join(
      db.cities.where((c, p) => c.country === p.country, { country: 'Netherlands' }),
      (u) => u.cityId,
      (c) => c.id,
      (u, c) => ({ who: u.name, city: c.name }),
    ),
);

// A navigation property. Reading through `city` joins the cities table into
// whichever clause read it, so no join has to be written by hand.
show(
  'residents by navigation',
  db.users
    .where((u) => u.city.country === 'Netherlands')
    .select((u) => ({ who: u.name, city: u.city.name })),
);

// Grouping. The key selector becomes GROUP BY and the result selector the
// projection over it, with aggregates read off the group parameter.
show(
  'headcount by city',
  db.users.groupBy(
    (u) => u.cityId,
    (city, users) => ({ city, headcount: users.count(), oldest: users.max((u) => u.age) }),
  ),
);

// A filter after grouping becomes HAVING, because the rows it would have
// filtered no longer exist by the time it runs. One before it stays a WHERE.
show(
  'crowded cities',
  db.users
    .where((u) => u.isActive)
    .groupBy(
      (u) => u.cityId,
      (city, users) => ({ city, headcount: users.count() }),
    )
    .where((row) => row.headcount > 1)
    .orderByDescending((row) => row.headcount),
);

if (connectionString) {
  const rows = await summaries.take(5).toArray();
  console.log('\nrows:', rows);
  const total = await adults.count();
  console.log('matching adults:', total);
} else {
  console.log('\nSet DATABASE_URL to run these queries against a database.');
}

await db.$close();
