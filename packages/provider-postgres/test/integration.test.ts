import { collection, defineEntity, reference, SequenceError } from '@sqlinqo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedStatement } from '@sqlinqo/core';
import type { PostgresDriver } from '../src/index.js';
import { createPostgresContext } from '../src/index.js';

/**
 * These tests need a real PostgreSQL instance. `pnpm test:db:up` starts the one
 * described in `docker-compose.yml`, and CI sets `DATABASE_URL` the same way.
 * Without it the suite is skipped rather than failed, so `pnpm test` stays
 * useful on a machine with no database.
 */
const connectionString = 'postgres://linqts:linqts@localhost:5432/linqts'; //process.env['DATABASE_URL'];
const describeIfDatabase = connectionString ? describe : describe.skip;

const Person = defineEntity({
  name: 'Person',
  table: 'people',
  columns: {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text' },
    age: { type: 'int' },
    city: { type: 'text', nullable: true },
    joinedAt: { type: 'timestamp', column: 'joined_at' },
    tags: { type: 'array', of: 'text' },
  },
});

const Visit = defineEntity({
  name: 'Visit',
  table: 'visits',
  columns: {
    id: { type: 'int', primaryKey: true },
    personId: { type: 'int', column: 'person_id' },
    city: { type: 'text' },
  },
  relations: {
    person: reference(() => Person, 'personId'),
    notes: collection(() => Note, 'visitId'),
  },
});

const Writable = defineEntity({
  name: 'Writable',
  table: 'writable',
  columns: {
    id: { type: 'int', primaryKey: true, generated: true },
    label: { type: 'text' },
    note: { type: 'text', nullable: true },
  },
});

/**
 * A column that carries a time zone, which nothing else here has.
 *
 * `timestamp` is one logical type in this library and two physical ones in
 * PostgreSQL, and only the zoned one is rendered in the session's zone whenever
 * anything reads it. That is the difference `getUTCFullYear` exists to remove,
 * so it needs a column of its own to be shown on.
 */
const Instant = defineEntity({
  name: 'Instant',
  table: 'instants',
  columns: {
    id: { type: 'int', primaryKey: true },
    at: { type: 'timestamp' },
  },
});

/**
 * Several rows per key, interleaved, which nothing else here has.
 *
 * Every other table in this file holds one row per key at most, so a frame
 * partitioned by that key would be a run of one and would prove nothing about
 * `windowedBy` or `expandingBy`. Two sensors reporting alternately is the
 * smallest fixture where a per-key frame differs from an unpartitioned one in
 * its values, in how many rows come back, and in the order they come back in.
 */
const Reading = defineEntity({
  name: 'Reading',
  table: 'readings',
  columns: {
    id: { type: 'int', primaryKey: true },
    sensorId: { type: 'text', column: 'sensor_id' },
    value: { type: 'int' },
  },
});

const Note = defineEntity({
  name: 'Note',
  table: 'notes',
  columns: {
    id: { type: 'int', primaryKey: true },
    visitId: { type: 'int', column: 'visit_id' },
    body: { type: 'text' },
  },
});

/**
 * The notes table with the way back to a visit, which `Note` deliberately lacks.
 *
 * Two entities cannot navigate to each other, so the chain is built out of three
 * that each point one way: this to `Visit`, and `Visit` on to `Person`.
 */
const ChainedNote = defineEntity({
  name: 'ChainedNote',
  table: 'notes',
  columns: {
    id: { type: 'int', primaryKey: true },
    visitId: { type: 'int', column: 'visit_id' },
    body: { type: 'text' },
  },
  relations: {
    visit: reference(() => Visit, 'visitId'),
  },
});

describeIfDatabase('PostgreSQL integration', () => {
  const db = createPostgresContext({
    connectionString,
    entities: {
      people: Person,
      visits: Visit,
      notes: Note,
      writable: Writable,
      instants: Instant,
      readings: Reading,
    },
  });

  beforeAll(async () => {
    const pool = (db.$driver as PostgresDriver).connectionPool;
    await pool.query('DROP TABLE IF EXISTS readings');
    await pool.query('DROP TABLE IF EXISTS instants');
    await pool.query('DROP TABLE IF EXISTS writable');
    await pool.query('DROP TABLE IF EXISTS notes');
    await pool.query('DROP TABLE IF EXISTS visits');
    await pool.query('DROP TABLE IF EXISTS people');
    await pool.query(
      `CREATE TABLE people (id int primary key, name text not null, age int not null,
         city text, joined_at timestamp not null, tags text[] not null)`,
    );
    await pool.query(
      // The fractional seconds are what `getSeconds` is tested against: a
      // whole second, one with a fraction below a half, and one above it, since
      // EXTRACT(SECOND ...) carries the fraction and a bare cast to int would
      // round 59.75 up to a sixtieth second. Every other date part is untouched
      // by them.
      `INSERT INTO people (id, name, age, city, joined_at, tags) VALUES
         (1, 'Ada', 36, 'London',   '2024-01-15 09:00:00', ARRAY['maths','logic','poetry']),
         (2, 'Grace', 45, 'New York', '2024-06-30 14:30:07.5', ARRAY['navy']),
         (3, 'Alan', 41, NULL,       '2024-12-01 23:45:59.75', ARRAY[]::text[])`,
    );
    await pool.query(
      'CREATE TABLE visits (id int primary key, person_id int not null, city text not null)',
    );
    await pool.query(
      `INSERT INTO visits (id, person_id, city) VALUES
         (1, 1, 'Paris'),
         (2, 1, 'Rome'),
         (3, 2, 'Lisbon')`,
    );
    await pool.query(
      'CREATE TABLE notes (id int primary key, visit_id int not null, body text not null)',
    );
    await pool.query(
      `INSERT INTO notes (id, visit_id, body) VALUES
         (1, 1, 'louvre'),
         (2, 1, 'seine'),
         (3, 3, 'tram')`,
    );
    // The one table the tests write to. `serial` and the nullable column are
    // what the insert has to leave to the database rather than supply.
    await pool.query(
      `CREATE TABLE writable (id serial primary key, label text not null,
         note text)`,
    );
    // Half an hour into 2025 in UTC, which is still the evening of the 31st
    // anywhere behind it. Nothing else about the row matters: the whole point
    // is that the year it falls in depends on who is asking.
    await pool.query('CREATE TABLE instants (id int primary key, at timestamptz not null)');
    await pool.query(`INSERT INTO instants (id, at) VALUES (1, '2025-01-01 00:30:00+00')`);
    // Two sensors reporting alternately, so ordering by id interleaves the keys.
    // Sensor 'a' has three readings and 'b' has two, which is what lets a run of
    // three come back for one key and nothing at all for the other.
    await pool.query(
      'CREATE TABLE readings (id int primary key, sensor_id text not null, value int not null)',
    );
    await pool.query(
      `INSERT INTO readings (id, sensor_id, value) VALUES
         (1, 'a', 10),
         (2, 'b', 100),
         (3, 'a', 20),
         (4, 'b', 200),
         (5, 'a', 30)`,
    );
  });

  afterAll(async () => {
    await db.$close();
  });

  it('yields one row of nulls when the query matches nothing', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Nobody')
      .select((person) => ({ who: person.name, age: person.age }))
      .defaultIfEmpty()
      .toArray();

    expect(rows).toEqual([{ who: null, age: null }]);
  });

  it('leaves a query that matched anything alone', async () => {
    const rows = await db.people
      .where((person) => person.age > 36)
      .orderBy((person) => person.age)
      .select((person) => ({ who: person.name }))
      .defaultIfEmpty()
      .toArray();

    // Two matches, so the joined row is multiplied away rather than added to.
    expect(rows).toEqual([{ who: 'Alan' }, { who: 'Grace' }]);
  });

  it('counts the default row as a row', async () => {
    const total = await db.people
      .where((person) => person.name === 'Nobody')
      .defaultIfEmpty()
      .count();

    expect(total).toBe(1);
  });

  it('keeps the ordering across the join', async () => {
    const rows = await db.people
      .orderBy((person) => person.joinedAt)
      .defaultIfEmpty()
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('keeps the ordering a limit depended on', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .take(2)
      .defaultIfEmpty()
      .toArray();

    expect(rows.map((row) => row.age)).toEqual([36, 41]);
  });

  it('defaults a scalar projection to a single null', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Nobody')
      .select((person) => person.name)
      .defaultIfEmpty()
      .toArray();

    expect(rows).toEqual([null]);
  });

  it('defaults a grouped query that produced no groups', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Nobody')
      .groupBy(
        (person) => person.city,
        (city, people) => ({ city, n: people.count() }),
      )
      .defaultIfEmpty()
      .toArray();

    expect(rows).toEqual([{ city: null, n: null }]);
  });

  it('is undone by a filter after it, as a leftJoin is', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Nobody')
      .defaultIfEmpty()
      .where((person) => person.age! > 0)
      .toArray();

    // A null fails every comparison, so the very predicate meant to inspect the
    // default row is what drops it. Filter before, not after.
    expect(rows).toEqual([]);
  });

  it('pages by seeking past a cursor row', async () => {
    const page = () => db.people.orderBy((person) => person.id);

    const first = await page().take(2).toArray();
    const next = await page().after(first.at(-1)!).take(2).toArray();

    expect(first.map((row) => row.name)).toEqual(['Ada', 'Grace']);
    expect(next.map((row) => row.name)).toEqual(['Alan']);
  });

  it('lands on the same rows an offset would, without counting them', async () => {
    const ordered = () => db.people.orderBy((person) => person.id);

    const [seeded] = await ordered().take(1).toArray();
    const seeked = await ordered().after(seeded!).toArray();
    const skipped = await ordered().skip(1).toArray();

    // The two spellings agree on the rows and differ on how the database finds
    // them: one seeks to a key, the other reads and discards what came before.
    expect(seeked.map((row) => row.id)).toEqual(skipped.map((row) => row.id));
  });

  it('breaks a tie on the second key rather than dropping the row', async () => {
    const ordered = () => db.people.orderBy((person) => person.age).thenBy((person) => person.id);

    const all = await ordered().toArray();
    const after = await ordered().after(all[0]!).toArray();

    // Ada is 36, Alan 41, Grace 45.
    expect(all.map((row) => row.name)).toEqual(['Ada', 'Alan', 'Grace']);
    expect(after.map((row) => row.name)).toEqual(['Alan', 'Grace']);
  });

  it('seeks the other way down a descending ordering', async () => {
    const ordered = () => db.people.orderByDescending((person) => person.age);

    const all = await ordered().toArray();
    const after = await ordered().after(all[0]!).toArray();

    // Grace 45, Alan 41, Ada 36, so "after" the first means a smaller age.
    expect(all.map((row) => row.name)).toEqual(['Grace', 'Alan', 'Ada']);
    expect(after.map((row) => row.name)).toEqual(['Alan', 'Ada']);
  });

  it('walks the whole table one page at a time', async () => {
    const seen: number[] = [];
    let cursor: { id: number } | undefined;

    for (;;) {
      const base = db.people.orderBy((person) => person.id);
      // Only the sort key is read off the cursor, so `{ id }` is enough — which
      // is what a cursor round-tripped through a URL comes back as.
      const page = await (cursor ? base.after(cursor) : base).take(2).toArray();
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      cursor = page.at(-1)!;
    }

    // Two pages of two and one of one, and every row exactly once. This is the
    // loop the operator exists for, and the one an OFFSET makes progressively
    // more expensive as it runs.
    expect(seen).toEqual([1, 2, 3]);
  });

  it('steps back a page from the row a page begins with', async () => {
    const ordered = () => db.people.orderBy((person) => person.id);

    const [, second] = await ordered().take(2).toArray();
    const back = await ordered().before(second!).take(2).toArray();

    // Ada 1, Grace 2, Alan 3. Stepping back from Grace reaches Ada and stops,
    // and the page arrives nearest the cursor first because that is the order
    // the LIMIT had to read it in.
    expect(back.map((row) => row.name)).toEqual(['Ada']);
  });

  it('hands the page back from the cursor outward, for the caller to turn', async () => {
    const ordered = () => db.people.orderBy((person) => person.id);

    const page = await ordered().before({ id: 3 }).take(2).toArray();

    // The two rows immediately behind Alan, read backwards under the LIMIT.
    // Reversing the array is the caller's one line, and it is what makes the
    // page read the way the query was written.
    expect(page.map((row) => row.id)).toEqual([2, 1]);
    expect(page.reverse().map((row) => row.id)).toEqual([1, 2]);
  });

  it('lands back on the page it stepped off, the cursor row excluded from both', async () => {
    const ordered = () => db.people.orderBy((person) => person.id);

    const first = await ordered().take(2).toArray();
    const next = await ordered().after(first.at(-1)!).take(2).toArray();
    const back = await ordered().before(next[0]!).take(2).toArray();

    // Forward to the second page and straight back again returns the first,
    // which is the round trip the pair exists for. Both comparisons are strict,
    // so the row walked off is in neither page rather than in both.
    expect(back.reverse().map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(back.map((row) => row.id)).not.toContain(next[0]!.id);
  });

  it('walks a descending ordering backwards too', async () => {
    const ordered = () => db.people.orderByDescending((person) => person.age);

    const all = await ordered().toArray();
    const back = await ordered().before(all[2]!).toArray();

    // Grace 45, Alan 41, Ada 36. "Before" Ada in that ordering means an older
    // person, and the rows come back ascending, which is the query's own
    // ordering read from the cursor outward.
    expect(all.map((row) => row.name)).toEqual(['Grace', 'Alan', 'Ada']);
    expect(back.map((row) => row.name)).toEqual(['Alan', 'Grace']);
  });

  it('breaks a tie on the second key the same way after does', async () => {
    const ordered = () => db.people.orderBy((person) => person.age).thenBy((person) => person.id);

    const all = await ordered().toArray();
    const back = await ordered().before(all[2]!).toArray();

    // Ada 36, Alan 41, Grace 45. The lexicographic comparison is the one
    // `after` builds with every key flipped, so a row below the cursor on the
    // age is kept whatever its id.
    expect(back.reverse().map((row) => row.name)).toEqual(['Ada', 'Alan']);
  });

  it('counts the rows carrying each key', async () => {
    const rows = await db.visits
      .countBy((visit) => visit.personId)
      .orderBy((row) => row.key)
      .toArray();

    // Ada made two visits and Grace one. node-postgres returns COUNT as a
    // string, which is why the value is normalised here rather than compared
    // as a number.
    expect(rows.map((row) => [row.key, Number(row.count)])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it('counts rows sharing a null key together', async () => {
    const rows = await db.people
      .countBy((person) => person.city)
      .orderBy((row) => row.count)
      .toArray();

    // Alan has no city, and a null key is one key here as it is in a JavaScript
    // Map, rather than never equal to itself as it is in a SQL comparison.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.key === null)).toHaveLength(1);
  });

  it('counts only the rows a filter left', async () => {
    const rows = await db.people
      .where((person) => person.age > 36)
      .countBy((person) => person.city !== null)
      .toArray();

    expect(rows.map((row) => [row.key, Number(row.count)]).sort()).toEqual([
      [false, 1],
      [true, 1],
    ]);
  });

  it('totals the value carried by the rows under each key', async () => {
    const rows = await db.people
      .sumBy(
        (person) => person.city,
        (person) => person.age,
      )
      .orderBy((row) => row.key)
      .toArray();

    // Ada is 36 in London, Grace 45 in New York, and Alan 41 with no city. The
    // total comes back through `Number` for the reason every group aggregate in
    // this suite does: PostgreSQL widens SUM over an int to bigint and
    // node-postgres renders that as a string rather than lose precision.
    expect(rows.map((row) => [row.key, Number(row.sum)])).toEqual([
      ['London', 36],
      ['New York', 45],
      [null, 41],
    ]);
  });

  it('totals rows sharing a null key together', async () => {
    const rows = await db.people
      .sumBy(
        (person) => person.city,
        (person) => person.age,
      )
      .toArray();

    // A null key is one key here as it is in a JavaScript Map, which is
    // `countBy`'s own reading and comes from the same `GROUP BY`.
    const missing = rows.filter((row) => row.key === null);
    expect(missing).toHaveLength(1);
    expect(Number(missing[0]!.sum)).toBe(41);
  });

  it('totals only the rows a filter left', async () => {
    const rows = await db.people
      .where((person) => person.age > 36)
      .sumBy(
        (person) => person.city !== null,
        (person) => person.age,
      )
      .toArray();

    // Grace (45, New York) and Alan (41, no city) are what the filter leaves.
    expect(rows.map((row) => [row.key, Number(row.sum)]).sort()).toEqual([
      [false, 41],
      [true, 45],
    ]);
  });

  it('reads milliseconds since the epoch', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ t: person.joinedAt.getTime() }))
      .toArray();

    // The column is a `timestamp` and PostgreSQL reads its epoch as though the
    // value were already UTC, which is what this pins: 2024-01-15 09:00:00Z.
    expect(rows).toEqual([{ t: Date.UTC(2024, 0, 15, 9, 0, 0) }]);
  });

  it('floors the epoch to a whole millisecond', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person) => ({ t: person.joinedAt.getTime() }))
      .toArray();

    // Seeded at 23:45:59.75, so the fraction below a millisecond is nothing and
    // the 750 milliseconds survive.
    expect(rows).toEqual([{ t: Date.UTC(2024, 11, 1, 23, 45, 59, 750) }]);
  });

  it('answers an epoch as a number rather than a string', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => person.joinedAt.getTime())
      .toArray();

    // The cast is to double for this reason: `bigint` would come back from
    // node-postgres as a string, protecting a precision a double already has.
    expect(typeof rows[0]).toBe('number');
  });

  it('keeps the rows whose key is found in another query', async () => {
    const rows = await db.people
      .intersectBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .orderBy((person) => person.id)
      .toArray();

    // Ada and Grace have visits; Alan has none. Ada has two, and is returned
    // once, which is what `EXISTS` buys over a join.
    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('partitions the query with exceptBy', async () => {
    const kept = await db.people
      .intersectBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .toArray();
    const dropped = await db.people
      .exceptBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .toArray();

    // Between them they account for every row exactly once.
    expect([...kept, ...dropped].map((row) => row.name).sort()).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('repeats a string', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ shout: person.name.repeat(3) }))
      .toArray();

    expect(rows).toEqual([{ shout: 'AdaAdaAda' }]);
  });

  it('repeats zero times into an empty string', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ shout: person.name.repeat(0) }))
      .toArray();

    // Zero is the edge the two languages agree on; a negative count does not,
    // answering the empty string here where JavaScript throws.
    expect(rows).toEqual([{ shout: '' }]);
  });

  it('finds the last occurrence of a substring', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, at: person.name.lastIndexOf('a') }))
      .toArray();

    // Ada has an 'a' at 0 and 2, Grace one at 2, Alan one at 2. The last is
    // what comes back, which is what separates this from `indexOf`.
    expect(rows).toEqual([
      { who: 'Ada', at: 2 },
      { who: 'Grace', at: 2 },
      { who: 'Alan', at: 2 },
    ]);
  });

  it('answers -1 for a substring that is not there', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ at: person.name.lastIndexOf('z') }))
      .toArray();

    expect(rows).toEqual([{ at: -1 }]);
  });

  it('answers the string length for an empty substring', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ at: person.name.lastIndexOf('') }))
      .toArray();

    // What JavaScript answers too, and it falls out of the arithmetic rather
    // than needing a case: POSITION answers one for an empty needle.
    expect(rows).toEqual([{ at: 3 }]);
  });

  it('leaves a null string null rather than calling the substring absent', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person) => ({ at: person.city!.lastIndexOf('o') }))
      .toArray();

    // Alan has no city. A -1 here would have claimed the substring was merely
    // missing from a string that does not exist.
    expect(rows).toEqual([{ at: null }]);
  });

  it('differs from indexOf where a substring occurs twice', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({
        first: person.name.indexOf('a'),
        last: person.name.lastIndexOf('a'),
      }))
      .toArray();

    // 'Ada' has a lowercase 'a' only at index 2; the leading 'A' is a different
    // character, which is what makes this a real pair rather than a coincidence.
    expect(rows).toEqual([{ first: 2, last: 2 }]);
  });

  it('keeps every row of the joined side', async () => {
    const rows = await db.visits
      .rightJoin(
        db.people,
        (visit) => visit.personId,
        (person) => person.id,
        (visit, person) => ({ who: person.name, city: visit.city }),
      )
      .orderBy((row) => row.who)
      .toArray();

    // Alan made no visits and is kept with the visit's columns null, which is
    // exactly what a leftJoin from people would have given.
    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
      { who: 'Alan', city: null },
      { who: 'Grace', city: 'Lisbon' },
    ]);
  });

  it('slices the last characters for a negative start', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ tail: person.name.slice(-3) }))
      .toArray();

    expect(rows).toEqual([{ tail: 'Ada' }, { tail: 'ace' }, { tail: 'lan' }]);
  });

  it('clamps a start that reaches past the beginning', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ tail: person.name.slice(-10) }))
      .toArray();

    // JavaScript clamps to the whole string rather than erroring, and so does
    // the GREATEST around the normalised bound.
    expect(rows).toEqual([{ tail: 'Ada' }]);
  });

  it('slices a half-open range', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person) => ({ mid: person.name.slice(1, 3) }))
      .toArray();

    expect(rows).toEqual([{ mid: 'ra' }]);
  });

  it('slices between two negative bounds', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person) => ({ mid: person.name.slice(-3, -1) }))
      .toArray();

    expect(rows).toEqual([{ mid: 'ac' }]);
  });

  it('gives an empty string for a range that ends before it begins', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person) => ({ mid: person.name.slice(4, 2) }))
      .toArray();

    expect(rows).toEqual([{ mid: '' }]);
  });

  it('counts the matches of each row, zero included', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .groupJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visits) => ({ who: person.name, trips: visits.count() }),
      )
      .toArray();

    // Alan made no visits and is still a row, with a count of zero rather than
    // a null or no row at all, which is what separates this from `join`.
    expect(rows.map((row) => [row.who, Number(row.trips)])).toEqual([
      ['Ada', 2],
      ['Grace', 1],
      ['Alan', 0],
    ]);
  });

  it('returns one row per outer row even where two are alike', async () => {
    const rows = await db.people
      .select((person) => ({ city: person.city }))
      .groupJoin(
        db.visits,
        (row) => row.city,
        (visit) => visit.city,
        (row, visits) => ({ city: row.city, seen: visits.count() }),
      )
      .toArray();

    // Three people, so three rows, even though a LEFT JOIN with a GROUP BY
    // around it would have collapsed any two sharing a city.
    expect(rows).toHaveLength(3);
  });

  it('sums the matches to zero where there are none', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .groupJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (_person, visits) => ({ n: visits.sum((visit) => visit.id) }),
      )
      .toArray();

    // SUM over no rows is null in SQL and zero in LINQ; the COALESCE is what
    // makes this agree with the terminal `sum`.
    expect(rows.map((row) => Number(row.n))).toEqual([0]);
  });

  it('leaves max null where there are no matches', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .groupJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (_person, visits) => ({ biggest: visits.max((visit) => visit.id) }),
      )
      .toArray();

    expect(rows).toEqual([{ biggest: null }]);
  });

  it('counts only the matches a filtered joined side left', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .groupJoin(
        db.visits.where((visit) => visit.city === 'Paris'),
        (person) => person.id,
        (visit) => visit.personId,
        (_person, visits) => ({ trips: visits.count() }),
      )
      .toArray();

    // Ada made two visits, one of them to Paris.
    expect(rows.map((row) => Number(row.trips))).toEqual([1]);
  });

  it('counts the different values a selector takes', async () => {
    const cities = await db.people.countDistinct((person) => person.city);

    // London, New York, and Alan's null, which LINQ counts as a value and
    // `COUNT(DISTINCT ...)` on its own would have skipped.
    expect(cities).toBe(3);
  });

  it('counts a null-free column without adding to it', async () => {
    const names = await db.people.countDistinct((person) => person.name);

    expect(names).toBe(3);
  });

  it('counts one for a column that is entirely null', async () => {
    const cities = await db.people
      .where((person) => person.name === 'Alan')
      .countDistinct((person) => person.city);

    expect(cities).toBe(1);
  });

  it('counts nothing over an empty query', async () => {
    const cities = await db.people
      .where((person) => person.name === 'Nobody')
      .countDistinct((person) => person.city);

    expect(cities).toBe(0);
  });

  it('counts repeated values once', async () => {
    const people = await db.visits.countDistinct((visit) => visit.personId);

    // Three visits, made by two people.
    expect(people).toBe(2);
  });

  it('formats a date as ISO 8601 text', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ at: person.joinedAt.toISOString() }))
      .toArray();

    // The column is a `timestamp` holding UTC, which is the reading the Z
    // asserts and the convention this library's own mappings produce.
    expect(rows).toEqual([{ at: '2024-01-15T09:00:00.000Z' }]);
  });

  it('carries the milliseconds it was given', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person) => ({ at: person.joinedAt.toISOString() }))
      .toArray();

    // Seeded at 23:45:59.75, which is 750 milliseconds.
    expect(rows).toEqual([{ at: '2024-12-01T23:45:59.750Z' }]);
  });

  it('counts the elements of an array column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, tags: person.tags.length }))
      .toArray();

    // Ada has three tags, Grace one, and Alan an empty array. CARDINALITY
    // answers zero for the empty one where `array_length` would answer null.
    expect(rows).toEqual([
      { who: 'Ada', tags: 3 },
      { who: 'Grace', tags: 1 },
      { who: 'Alan', tags: 0 },
    ]);
  });

  it('filters on the number of elements', async () => {
    const rows = await db.people.where((person) => person.tags.length > 1).toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('keeps every row of both sides', async () => {
    const rows = await db.visits
      .fullJoin(
        db.people,
        (visit) => visit.personId,
        (person) => person.id,
        (visit, person) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    const sorted = rows
      .map((row) => [row.who, row.city])
      .sort((a, b) => String(a).localeCompare(String(b)));

    // Alan made no visits and is kept with the visit null. Every visit has a
    // person here, so nothing is kept from the other side, which is the shape
    // this fixture can show.
    expect(sorted).toEqual([
      ['Ada', 'Paris'],
      ['Ada', 'Rome'],
      ['Alan', null],
      ['Grace', 'Lisbon'],
    ]);
  });

  it('keeps an unmatched row from the joined side too', async () => {
    const rows = await db.visits
      .where((visit) => visit.city === 'Lisbon')
      .fullJoin(
        db.people,
        (visit) => visit.personId,
        (person) => person.id,
        (visit, person) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    // Only Grace's visit survives the filter, so Ada and Alan come through with
    // the visit null: a left join would have dropped them and a right join
    // would have dropped nothing to notice.
    const names = rows.map((row) => row.who).sort();
    expect(names).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('splits a string into an array on a separator', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ parts: person.name.split('d') }))
      .toArray();

    expect(rows).toEqual([{ parts: ['A', 'a'] }]);
  });

  it('returns a one-element array when the separator is absent', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ parts: person.name.split(',') }))
      .toArray();

    // What JavaScript answers too: nothing to split on leaves the whole string.
    expect(rows).toEqual([{ parts: ['Ada'] }]);
  });

  it('filters on whether any row of a collection matches', async () => {
    const rows = await db.visits
      .where((visit) => visit.notes.some((note) => note.body === 'seine'))
      .toArray();

    // Visit 1 has the notes 'louvre' and 'seine'; visit 3 has 'tram'.
    expect(rows.map((row) => row.id)).toEqual([1]);
  });

  it('returns the row once however many rows of the collection match', async () => {
    const rows = await db.visits
      .where((visit) => visit.notes.some((note) => note.id > 0))
      .orderBy((visit) => visit.id)
      .toArray();

    // Visit 1 has two notes and appears once, which a `selectMany` would not
    // have managed without a `distinct` after it.
    expect(rows.map((row) => row.id)).toEqual([1, 3]);
  });

  it('excludes the rows whose collection is empty', async () => {
    const rows = await db.visits
      .where((visit) => !visit.notes.some((note) => note.id > 0))
      .toArray();

    // Visit 2 has no notes at all.
    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it('projects the answer as a boolean column', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .select((visit) => ({ id: visit.id, noted: visit.notes.some((note) => note.id > 0) }))
      .toArray();

    expect(rows).toEqual([
      { id: 1, noted: true },
      { id: 2, noted: false },
      { id: 3, noted: true },
    ]);
  });

  it('keeps a row whose collection rows all match', async () => {
    const rows = await db.visits
      .where((visit) => visit.notes.every((note) => note.id < 10))
      .orderBy((visit) => visit.id)
      .toArray();

    // Every note has a small id, so every visit with notes qualifies, and so
    // does visit 2, whose collection is empty.
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it('is satisfied by a collection with no rows at all', async () => {
    const rows = await db.visits
      .where((visit) => visit.notes.every((note) => note.body === 'nothing'))
      .toArray();

    // Visit 2 has no notes, so nothing fails, which is what `[].every(...)`
    // answers in JavaScript too.
    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it('rejects a row where one of the collection rows fails', async () => {
    const rows = await db.visits
      .where((visit) => visit.notes.every((note) => note.body === 'louvre'))
      .orderBy((visit) => visit.id)
      .toArray();

    // Visit 1 has 'louvre' and 'seine', so it fails on the second; visit 3 has
    // only 'tram' and fails on that; visit 2 has nothing to fail.
    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it('partitions the rows with some, once the empty collection is set aside', async () => {
    const some = await db.visits
      .where((visit) => visit.notes.some((note) => note.body === 'louvre'))
      .toArray();
    const every = await db.visits
      .where((visit) => visit.notes.every((note) => note.body === 'louvre'))
      .toArray();

    // Visit 1 has a 'louvre' note and also a note that is not one, so it
    // satisfies `some` and not `every`, which is the pair working as intended.
    expect(some.map((row) => row.id)).toEqual([1]);
    expect(every.map((row) => row.id)).toEqual([2]);
  });

  it('tests an array column for a value', async () => {
    const rows = await db.people.where((person) => person.tags.includes('logic')).toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('joins an array column to a bound list', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person, args) => ({ all: person.tags.concat(args.more) }), { more: ['wren'] })
      .toArray();

    // Grace carries one tag, and the parameter is spliced in rather than
    // appended whole, which is what `concat` does with an array argument.
    expect(rows).toEqual([{ all: ['navy', 'wren'] }]);
  });

  it('joins an empty array column to a list, keeping the list', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person, args) => ({ all: person.tags.concat(args.more) }), { more: ['maths'] })
      .toArray();

    // Alan's array has no elements, so the join is the argument alone rather
    // than null, which is what `array_cat` answers and what `[].concat(x)`
    // answers too.
    expect(rows).toEqual([{ all: ['maths'] }]);
  });

  it('answers false for an array with no elements', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, navy: person.tags.includes('navy') }))
      .toArray();

    // Alan's array is empty, which answers false rather than null, as
    // `[].includes(...)` answers false in JavaScript.
    expect(rows).toEqual([
      { who: 'Ada', navy: false },
      { who: 'Grace', navy: true },
      { who: 'Alan', navy: false },
    ]);
  });

  it('finds the position of an element in an array column', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ at: person.tags.indexOf('logic') }))
      .toArray();

    // Seeded as ARRAY['maths','logic','poetry'], so the second element, which
    // is index one counting the way JavaScript counts.
    expect(rows).toEqual([{ at: 1 }]);
  });

  it('answers -1 for an element the array does not hold', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ at: person.tags.indexOf('navy') }))
      .toArray();

    expect(rows).toEqual([{ at: -1 }]);
  });

  it('answers -1 for an empty array rather than null', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person) => ({ at: person.tags.indexOf('navy') }))
      .toArray();

    // Alan holds an empty array, which is a real array and so a real "not
    // found" rather than the null a missing array would give.
    expect(rows).toEqual([{ at: -1 }]);
  });

  it('brings a collection back with the rows that own it', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .include((visit) => visit.notes)
      .toArray();

    expect(rows.map((row) => [row.id, row.notes.map((note) => note.body).sort()])).toEqual([
      [1, ['louvre', 'seine']],
      [2, []],
      [3, ['tram']],
    ]);
  });

  it('reads part of an array column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, some: person.tags.slice(1, 3) }))
      .toArray();

    // Ada holds three tags, Grace one, and Alan none at all, which is what says
    // that a range past the end yields what exists rather than null.
    expect(rows).toEqual([
      { who: 'Ada', some: ['logic', 'poetry'] },
      { who: 'Grace', some: [] },
      { who: 'Alan', some: [] },
    ]);
  });

  it('counts an array slice back from the end', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ last: person.tags.slice(-1) }))
      .toArray();

    expect(rows).toEqual([{ last: ['poetry'] }]);
  });

  it('aggregates a collection without reading its rows', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .select((visit) => ({
        id: visit.id,
        notes: visit.notes.count(),
        ids: visit.notes.sum((note) => note.id),
        first: visit.notes.min((note) => note.body),
      }))
      .toArray();

    // Visit 1 has notes 1 and 2, visit 2 none, visit 3 note 3. The empty one is
    // the case worth reading: zero for the count and the sum, null for the min.
    //
    // The numbers come back through `Number`, as the group and groupJoin
    // aggregates in this suite do: node-postgres renders COUNT and a SUM over an
    // exact numeric as strings rather than lose precision, and a projected
    // aggregate is not a column the library can normalise on the way out.
    expect(rows.map((row) => ({ ...row, notes: Number(row.notes), ids: Number(row.ids) }))).toEqual(
      [
        { id: 1, notes: 2, ids: 3, first: 'louvre' },
        { id: 2, notes: 0, ids: 0, first: null },
        { id: 3, notes: 1, ids: 3, first: 'tram' },
      ],
    );
  });

  it('orders by what a collection comes to', async () => {
    const rows = await db.visits
      .orderByDescending((visit) => visit.notes.count())
      .thenBy((visit) => visit.id)
      .select((visit) => ({ id: visit.id }))
      .toArray();

    // Two notes, then one, then none, and no visit read twice.
    expect(rows).toEqual([{ id: 1 }, { id: 3 }, { id: 2 }]);
  });

  it('reads the millisecond within the second', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, ms: person.joinedAt.getMilliseconds() }))
      .toArray();

    // The three joined_at values are a whole second, one and a half, and one and
    // three quarters, which is what the getSeconds fixture was built for.
    expect(rows).toEqual([
      { who: 'Ada', ms: 0 },
      { who: 'Grace', ms: 500 },
      { who: 'Alan', ms: 750 },
    ]);
  });

  it('reads a sign back as a number rather than as text', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, sign: Math.sign(person.age - 40) }))
      .toArray();

    // Ada is 36, Grace 45, Alan 41. The cast is what makes these numbers: sign
    // of an integer yields numeric, which node-postgres returns as a string.
    expect(rows).toEqual([
      { who: 'Ada', sign: -1 },
      { who: 'Grace', sign: 1 },
      { who: 'Alan', sign: 1 },
    ]);
  });

  it('reads two hops of a graph, one statement per hop', async () => {
    const statements: PreparedStatement[] = [];
    const logged = createPostgresContext({
      connectionString,
      entities: { chainedNotes: ChainedNote },
      logger: (statement) => statements.push(statement),
    });

    try {
      const rows = await logged.chainedNotes
        .orderBy((note) => note.id)
        .include((note) => note.visit)
        .thenInclude((visit) => visit.person)
        .toArray();

      // Notes 1 and 2 belong to Ada's visit and note 3 to Grace's.
      expect(rows.map((row) => [row.body, row.visit.person.name])).toEqual([
        ['louvre', 'Ada'],
        ['seine', 'Ada'],
        ['tram', 'Grace'],
      ]);

      // Three statements for two hops however many rows each one found, which is
      // the query per row an include chain exists to avoid.
      expect(statements).toHaveLength(3);
      expect(statements[2]!.text).toContain('IN (');
    } finally {
      await logged.$close();
    }
  });

  it('brings the row on the other end of a reference back with each row', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .include((visit) => visit.person)
      .toArray();

    // Visits 1 and 2 are Ada's and visit 3 is Grace's, so two of the three rows
    // are handed the same person and neither is repeated.
    expect(rows.map((row) => [row.id, row.person.name])).toEqual([
      [1, 'Ada'],
      [2, 'Ada'],
      [3, 'Grace'],
    ]);
  });

  it('reads a reference once however many rows point at it', async () => {
    const statements: PreparedStatement[] = [];
    const logged = createPostgresContext({
      connectionString,
      entities: { visits: Visit, notes: Note, people: Person },
      logger: (statement) => statements.push(statement),
    });

    try {
      await logged.visits.include((visit) => visit.person).toArray();
    } finally {
      await logged.$close();
    }

    expect(statements).toHaveLength(2);
    // Three visits, two distinct people: the keys are deduplicated before the
    // second statement, which is what a join could not have done.
    expect(statements[1]!.values).toEqual([1, 2]);
  });

  it('reads the rows and the collection in two statements', async () => {
    const statements: string[] = [];
    const logged = createPostgresContext({
      connectionString,
      entities: { visits: Visit, notes: Note, people: Person },
      logger: (statement) => statements.push(statement.text),
    });

    try {
      await logged.visits.include((visit) => visit.notes).toArray();
    } finally {
      await logged.$close();
    }

    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain('IN (');
  });

  it('never multiplies the rows it reads', async () => {
    const rows = await db.visits
      .where((visit) => visit.id === 1)
      .include((visit) => visit.notes)
      .toArray();

    // Visit 1 has two notes. A LEFT JOIN would have answered two rows.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toHaveLength(2);
  });

  it('carries the collection through first', async () => {
    const row = await db.visits
      .orderBy((visit) => visit.id)
      .include((visit) => visit.notes)
      .first();

    expect(row.id).toBe(1);
    expect(row.notes).toHaveLength(2);
  });

  it('reads several statements from one transaction', async () => {
    const names = await db.$transaction(async (tx) => {
      const people = await tx.people.orderBy((person) => person.id).toArray();
      const total = await tx.people.count();
      expect(total).toBe(people.length);
      return people.map((person) => person.name);
    });

    expect(names).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('rolls back and rethrows what the body threw', async () => {
    const boom = new Error('boom');

    await expect(
      db.$transaction(async (tx) => {
        await tx.people.count();
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The connection went back to the pool rather than being stranded, so the
    // next query works.
    await expect(db.people.count()).resolves.toBe(3);
  });

  it('runs a paging operator inside one snapshot', async () => {
    const batches = await db.$transaction(async (tx) => {
      const seen: number[][] = [];
      for await (const batch of tx.people.orderBy((person) => person.id).chunk(2)) {
        seen.push(batch.map((person) => person.id));
      }
      return seen;
    });

    // What `chunk` asks for: every statement of the loop on one connection.
    expect(batches).toEqual([[1, 2], [3]]);
  });

  it('reads a collection and its rows from one snapshot', async () => {
    const rows = await db.$transaction((tx) =>
      tx.visits
        .orderBy((visit) => visit.id)
        .include((visit) => visit.notes)
        .toArray(),
    );

    expect(rows.map((row) => row.notes.length)).toEqual([2, 0, 1]);
  });

  it('reads the character at an index', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ initial: person.name.charAt(0) }))
      .toArray();

    expect(rows).toEqual([{ initial: 'A' }, { initial: 'G' }, { initial: 'A' }]);
  });

  it('reads an empty string past either end', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ far: person.name.charAt(9), before: person.name.charAt(-1) }))
      .toArray();

    // What JavaScript answers for both, and it falls out of SUBSTRING covering
    // no characters rather than needing a case.
    expect(rows).toEqual([{ far: '', before: '' }]);
  });

  it('adds a row and reads back what the database made of it', async () => {
    const added = await db.writable.insert({ label: 'first' });

    // The key is the sequence's and the stamp is the column default, and
    // neither was in the argument.
    expect(added.label).toBe('first');
    expect(typeof added.id).toBe('number');
    expect(added.note).toBeNull();

    const read = await db.writable
      .where((row, args) => row.id === args.id, { id: added.id })
      .first();
    expect(read.label).toBe('first');
  });

  it('adds several rows in one statement', async () => {
    const added = await db.writable.insertMany([{ label: 'a', note: 'one' }, { label: 'b' }]);

    expect(added.map((row) => row.label)).toEqual(['a', 'b']);
    // A column only the first row named is null in the second.
    expect(added.map((row) => row.note)).toEqual(['one', null]);
  });

  it('fills a table from a query, without the rows crossing the wire', async () => {
    const added = await db.writable.insertFrom(
      db.people.where((person) => person.age >= 41).select((person) => ({ label: person.name })),
    );

    // Two people match, and neither was read into this process on the way.
    expect(added.map((row) => row.label).sort()).toEqual(['Alan', 'Grace']);
    // The key came from the sequence and the column the projection left out
    // from its default, exactly as they do for a VALUES insert.
    expect(added.every((row) => typeof row.id === 'number')).toBe(true);
    expect(added.map((row) => row.note)).toEqual([null, null]);
  });

  it('writes nothing and faults nothing when the query matches no rows', async () => {
    const added = await db.writable.insertFrom(
      db.people.where((person) => person.age > 200).select((person) => ({ label: person.name })),
    );

    // The statement ran and the database answered that there was nothing to
    // write, which is not the same as a call that never asked.
    expect(added).toEqual([]);
  });

  it('fills a table from a query over that same table', async () => {
    const [seed] = await db.writable.insertMany([{ label: 'original', note: 'copied' }]);

    const copied = await db.writable.insertFrom(
      db.writable
        .where((row, args) => row.id === args.id, { id: seed!.id })
        .select((row) => ({ label: row.label, note: row.note })),
    );

    expect(copied).toHaveLength(1);
    expect(copied[0]!.note).toBe('copied');
    // A new row rather than the one read, since the key is the sequence's and
    // the projection did not name it.
    expect(copied[0]!.id).not.toBe(seed!.id);
  });

  it('rolls an insert back with the transaction it ran in', async () => {
    const before = await db.writable.count();

    await expect(
      db.$transaction(async (tx) => {
        await tx.writable.insert({ label: 'doomed' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The write is the first thing here a rollback can actually undo.
    await expect(db.writable.count()).resolves.toBe(before);
  });

  it('folds a string into its normal form', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ folded: person.name.normalize() }))
      .toArray();

    // Already normal, so the value is unchanged; what is being pinned is that
    // the function exists and takes the column.
    expect(rows).toEqual([{ folded: 'Ada' }]);
  });

  it('gives the rows a filter selects new values', async () => {
    const added = await db.writable.insertMany([{ label: 'x' }, { label: 'y' }]);

    const updated = await db.writable
      .where((row, args) => row.id === args.id, { id: added[0]!.id })
      .update({ note: 'touched' });

    expect(updated.map((row) => row.note)).toEqual(['touched']);

    // The row the filter did not select is untouched, which is the whole point
    // of the clause.
    const other = await db.writable
      .where((row, args) => row.id === args.id, { id: added[1]!.id })
      .first();
    expect(other.note).toBeNull();
  });

  it('hands back the rows as the database left them', async () => {
    const [added] = await db.writable.insertMany([{ label: 'before' }]);

    const [updated] = await db.writable
      .where((row, args) => row.id === args.id, { id: added!.id })
      .update({ label: 'after' });

    expect(updated!.label).toBe('after');
    expect(updated!.id).toBe(added!.id);
  });

  it('updates nothing when the filter selects nothing', async () => {
    const updated = await db.writable
      .where((row) => row.label === 'nobody has this label')
      .update({ note: 'x' });

    expect(updated).toEqual([]);
  });

  it('rolls an update back with the transaction it ran in', async () => {
    const [added] = await db.writable.insertMany([{ label: 'keep', note: 'original' }]);

    await expect(
      db.$transaction(async (tx) => {
        await tx.writable
          .where((row, args) => row.id === args.id, { id: added!.id })
          .update({ note: 'lost' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const read = await db.writable
      .where((row, args) => row.id === args.id, { id: added!.id })
      .first();
    expect(read.note).toBe('original');
  });

  it('removes the rows a filter selects and leaves the rest', async () => {
    const added = await db.writable.insertMany([{ label: 'doomed' }, { label: 'spared' }]);

    const removed = await db.writable
      .where((row, args) => row.id === args.id, { id: added[0]!.id })
      .delete();

    expect(removed.map((row) => row.label)).toEqual(['doomed']);

    // The row the filter did not select is still there, which is the whole
    // point of the clause and the only thing standing between a delete and the
    // table.
    const survivor = await db.writable
      .where((row, args) => row.id === args.id, { id: added[1]!.id })
      .first();
    expect(survivor.label).toBe('spared');
  });

  it('hands back the removed rows, which nothing else can answer for', async () => {
    const [added] = await db.writable.insertMany([{ label: 'gone', note: 'with it' }]);

    const [removed] = await db.writable
      .where((row, args) => row.id === args.id, { id: added!.id })
      .delete();

    expect(removed!.id).toBe(added!.id);
    expect(removed!.note).toBe('with it');

    // The row is not there to be read a second time, so what came back above is
    // the only record of it.
    await expect(
      db.writable.where((row, args) => row.id === args.id, { id: added!.id }).count(),
    ).resolves.toBe(0);
  });

  it('removes nothing when the filter selects nothing', async () => {
    const before = await db.writable.count();

    const removed = await db.writable.where((row) => row.label === 'no such label').delete();

    expect(removed).toEqual([]);
    await expect(db.writable.count()).resolves.toBe(before);
  });

  it('rolls a delete back with the transaction it ran in', async () => {
    const [added] = await db.writable.insertMany([{ label: 'keep me', note: 'original' }]);

    await expect(
      db.$transaction(async (tx) => {
        await tx.writable.where((row, args) => row.id === args.id, { id: added!.id }).delete();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // A delete has nothing to put back once it commits, so the transaction is
    // the only way to change one's mind about it.
    const read = await db.writable
      .where((row, args) => row.id === args.id, { id: added!.id })
      .first();
    expect(read.note).toBe('original');
  });

  it('refuses to delete through a query that is more than a filter', async () => {
    await expect(
      db.writable
        .orderBy((row) => row.id)
        .take(1)
        .delete(),
    ).rejects.toThrow(/this query has a page/);
  });

  it('joins strings with concat', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person, args) => ({ label: person.name.concat(' of ', args.city) }), {
        city: 'London',
      })
      .toArray();

    expect(rows).toEqual([{ label: 'Ada of London' }]);
  });

  it('answers null for a concat with a null part', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      // A nullable column is `string | null`, which `String.prototype.concat`
      // does not accept and the cast is the caller saying so knowingly.
      .select((person) => ({ label: person.name.concat(' of ', person.city as string) }))
      .toArray();

    // Alan has no city, and `||` over a null answers null where JavaScript
    // would have written "null" into the string. The SQL reading stands, and
    // the README says so.
    expect(rows).toEqual([{ label: null }]);
  });

  it('folds an array column into one string', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ all: person.tags.join(', ') }))
      .toArray();

    expect(rows).toEqual([{ all: 'maths, logic, poetry' }]);
  });

  it('separates with a comma when join is called bare', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ all: (person.tags as unknown as { join(): string }).join() }))
      .toArray();

    expect(rows).toEqual([{ all: 'maths,logic,poetry' }]);
  });

  it('folds an empty array into an empty string, as JavaScript does', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .select((person) => ({ all: person.tags.join(', ') }))
      .toArray();

    // Both sides answer the empty string here, so the agreement fell out rather
    // than being arranged.
    expect(rows).toEqual([{ all: '' }]);
  });

  it('carries a tag into the statement it was written on', async () => {
    const logged: string[] = [];
    const tagged = createPostgresContext({
      connectionString,
      entities: { people: Person },
      logger: (statement) => logged.push(statement.text),
    });

    try {
      await tagged.people
        .tag('integration trace')
        .where((p) => p.age > 0)
        .toArray();
    } finally {
      await tagged.$close();
    }

    // The point of the operator: the text the database was asked to run, and so
    // the text its log holds, names the code that wrote it.
    expect(logged[0]?.startsWith('/* integration trace */ SELECT')).toBe(true);
  });

  it('reads every row', async () => {
    const people = await db.people.orderBy((p) => p.id).toArray();
    expect(people.map((p) => p.name)).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('filters with a bound parameter', async () => {
    const people = await db.people.where((p, args) => p.age >= args.min, { min: 41 }).toArray();
    expect(people).toHaveLength(2);
  });

  it('filters on null', async () => {
    const people = await db.people.where((p) => p.city === null).toArray();
    expect(people.map((p) => p.name)).toEqual(['Alan']);
  });

  it('projects a shaped row', async () => {
    const rows = await db.people
      .where((p) => p.name === 'Ada')
      .select((p) => ({ who: p.name, decade: p.age }))
      .toArray();

    expect(rows).toEqual([{ who: 'Ada', decade: 36 }]);
  });

  it('projects a scalar', async () => {
    const names = await db.people
      .orderBy((p) => p.name)
      .select((p) => p.name)
      .toArray();

    expect(names).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('matches with LIKE', async () => {
    const rows = await db.people
      .where((p, args) => p.name.startsWith(args.prefix), { prefix: 'A' })
      .toArray();
    expect(rows.map((p) => p.name).sort()).toEqual(['Ada', 'Alan']);
  });

  it('expands a list into IN', async () => {
    const rows = await db.people
      .where((p, args) => args.ids.includes(p.id), { ids: [1, 3] })
      .toArray();
    expect(rows.map((p) => p.id).sort()).toEqual([1, 3]);
  });

  it('pages deterministically', async () => {
    const page = await db.people
      .orderBy((p) => p.id)
      .skip(1)
      .take(1)
      .toArray();

    expect(page.map((p) => p.name)).toEqual(['Grace']);
  });

  it('counts through a subquery', async () => {
    await expect(db.people.where((p) => p.age > 40).count()).resolves.toBe(2);
  });

  it('joins two tables and shapes the result', async () => {
    const rows = await db.people
      .join(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .orderBy((row) => row.city)
      .toArray();

    expect(rows).toEqual([
      { who: 'Grace', city: 'Lisbon' },
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
    ]);
  });

  it('joins a filtered query, keeping both parameter bags bound', async () => {
    const rows = await db.people
      .where((person, args) => person.age >= args.min, { min: 40 })
      .join(
        db.visits.where((visit, args) => visit.city === args.city, { city: 'Lisbon' }),
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    expect(rows).toEqual([{ who: 'Grace', city: 'Lisbon' }]);
  });

  it('groups and counts', async () => {
    const rows = await db.visits
      .groupBy(
        (visit) => visit.personId,
        (personId, visits) => ({ personId, trips: visits.count() }),
      )
      .orderBy((row) => row.personId)
      .toArray();

    // node-postgres returns COUNT as a string, which is why the value is
    // normalised here rather than compared as a number.
    expect(rows.map((row) => [row.personId, Number(row.trips)])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it('filters groups with HAVING', async () => {
    const rows = await db.visits
      .groupBy(
        (visit) => visit.personId,
        (personId, visits) => ({ personId, trips: visits.count() }),
      )
      .where((row) => row.trips > 1)
      .toArray();

    expect(rows.map((row) => row.personId)).toEqual([1]);
    expect(rows.map((row) => Number(row.trips))).toEqual([2]);
  });

  it('aggregates over a join, grouped by a column of the other side', async () => {
    const rows = await db.people
      .join(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, age: person.age, city: visit.city }),
      )
      .groupBy(
        (row) => row.who,
        (who, rows) => ({ who, trips: rows.count(), oldest: rows.max((row) => row.age) }),
      )
      .orderBy((row) => row.who)
      .toArray();

    expect(rows.map((row) => [row.who, Number(row.trips), row.oldest])).toEqual([
      ['Ada', 2, 36],
      ['Grace', 1, 45],
    ]);
  });

  it('groups by an expression and counts the groups', async () => {
    const total = await db.people
      .groupBy(
        (person) => person.age >= 41,
        (senior, people) => ({ senior, n: people.count() }),
      )
      .count();

    expect(total).toBe(2);
  });

  it('samples rows at random', async () => {
    const rows = await db.people.sample(2).toArray();

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(['Ada', 'Grace', 'Alan']).toContain(row.name);
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('returns every row when the sample is larger than the table', async () => {
    const rows = await db.people.sample(50).toArray();
    expect(rows.map((row) => row.name).sort()).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('samples the rows a filter left', async () => {
    const rows = await db.people
      .where((person) => person.age > 40)
      .sample(1)
      .toArray();

    expect(rows).toHaveLength(1);
    expect(['Grace', 'Alan']).toContain(rows[0]?.name);
  });

  it('samples groups, which PostgreSQL allows a random ordering over', async () => {
    const rows = await db.visits
      .groupBy(
        (visit) => visit.personId,
        (personId, visits) => ({ personId, trips: visits.count() }),
      )
      .sample(1)
      .toArray();

    expect(rows).toHaveLength(1);
    expect([1, 2]).toContain(rows[0]?.personId);
  });

  it('samples a DISTINCT projection without tripping its ORDER BY rule', async () => {
    const rows = await db.visits
      .select((visit) => ({ city: visit.city }))
      .distinct()
      .sample(2)
      .toArray();

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.city)).size).toBe(2);
  });

  it('orders a sample when the ordering is chained after it', async () => {
    const rows = await db.people
      .sample(3)
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('trims only the leading or trailing side', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({
        left: ('  ' + person.name + '  ').trimStart(),
        right: ('  ' + person.name + '  ').trimEnd(),
      }))
      .toArray();

    expect(rows).toEqual([{ left: 'Ada  ', right: '  Ada' }]);
  });

  it('unions two filters, removing the row they share', async () => {
    // Ada is 36 and Alan is 41, so both branches return Alan; UNION keeps one.
    const rows = await db.people
      .where((person) => person.age >= 36)
      .union(db.people.where((person) => person.age <= 41))
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('keeps the shared row twice for concat', async () => {
    const rows = await db.people
      .where((person) => person.age === 41)
      .concat(db.people.where((person) => person.age > 40))
      .toArray();

    expect(rows.map((row) => row.name).sort()).toEqual(['Alan', 'Alan', 'Grace']);
  });

  it('pairs columns by name even when the branches projected them in a different order', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ who: person.name, years: person.age }))
      .union(
        db.people
          .where((person) => person.name === 'Grace')
          .select((person) => ({ years: person.age, who: person.name })),
      )
      .orderBy((row) => row.who)
      .toArray();

    // Both branches carry a text and an int in opposite positions. Pairing them
    // by position would put a name where a number belongs, which PostgreSQL
    // would reject outright rather than return.
    expect(rows).toEqual([
      { who: 'Ada', years: 36 },
      { who: 'Grace', years: 45 },
    ]);
  });

  it('counts the rows a union produced', async () => {
    const total = await db.people
      .where((person) => person.age >= 36)
      .union(db.people.where((person) => person.age <= 41))
      .count();

    expect(total).toBe(3);
  });

  it('unions three queries in one statement', async () => {
    const named = (name: string) =>
      db.people.where((person, args) => person.name === args.name, { name });
    const rows = await named('Ada')
      .union(named('Grace'))
      .union(named('Alan'))
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('unions across two tables through a shared projection', async () => {
    const rows = await db.people
      .select((person) => ({ label: person.name }))
      .union(db.visits.select((visit) => ({ label: visit.city })))
      .orderBy((row) => row.label)
      .toArray();

    expect(rows.map((row) => row.label)).toEqual([
      'Ada',
      'Alan',
      'Grace',
      'Lisbon',
      'Paris',
      'Rome',
    ]);
  });

  it('intersects two filters down to the rows they share', async () => {
    // Ada is 36, Alan 41, Grace 45.
    const rows = await db.people
      .where((person) => person.age >= 36)
      .intersect(db.people.where((person) => person.age <= 41))
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan']);
  });

  it('subtracts one query from another', async () => {
    const rows = await db.people
      .where((person) => person.age >= 36)
      .except(db.people.where((person) => person.age > 40))
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('groups a union before intersecting it, rather than the other way round', async () => {
    // (Ada ∪ Grace) ∩ {over 40} is {Grace}. Written flat, SQL binds INTERSECT
    // tighter and computes Ada ∪ (Grace ∩ {over 40}) instead, which is
    // {Ada, Grace}. The two disagree, so this pins the grouping.
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .union(db.people.where((person) => person.name === 'Grace'))
      .intersect(db.people.where((person) => person.age > 40))
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('reads a run of UNION and EXCEPT left to right', async () => {
    // (Ada ∪ {over 40}) except Alan is {Ada, Grace}.
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .union(db.people.where((person) => person.age > 40))
      .except(db.people.where((person) => person.name === 'Alan'))
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('counts the rows an intersect produced', async () => {
    const total = await db.people
      .where((person) => person.age >= 36)
      .intersect(db.people.where((person) => person.age <= 41))
      .count();

    expect(total).toBe(2);
  });

  it('numbers months from zero, the way JavaScript does', async () => {
    // Ada joined in January, Grace in June, Alan in December. Read straight out
    // of EXTRACT these would be 1, 6 and 12; a JavaScript Date reports 0, 5, 11.
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, month: person.joinedAt.getMonth() }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', month: 0 },
      { who: 'Grace', month: 5 },
      { who: 'Alan', month: 11 },
    ]);
  });

  it('agrees with the Date the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ fromSql: person.joinedAt.getMonth(), value: person.joinedAt }))
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.value.getMonth());
    }
  });

  it('filters on a zero-based month', async () => {
    const rows = await db.people.where((person) => person.joinedAt.getMonth() === 0).toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('groups by year and month together', async () => {
    const rows = await db.people
      .groupBy(
        (person) => ({ year: person.joinedAt.getFullYear(), month: person.joinedAt.getMonth() }),
        (key, people) => ({ year: key.year, month: key.month, joined: people.count() }),
      )
      .orderBy((row) => row.month)
      .toArray();

    expect(rows.map((row) => [row.year, row.month, Number(row.joined)])).toEqual([
      [2024, 0, 1],
      [2024, 5, 1],
      [2024, 11, 1],
    ]);
  });

  it('reads the row at an index', async () => {
    const person = await db.people.orderBy((row) => row.id).elementAt(1);
    expect(person.name).toBe('Grace');
  });

  it('reads the first row at index zero', async () => {
    const person = await db.people.orderBy((row) => row.id).elementAt(0);
    expect(person.name).toBe('Ada');
  });

  it('throws past the end and returns null with the default variant', async () => {
    const ordered = db.people.orderBy((row) => row.id);

    await expect(ordered.elementAt(3)).rejects.toBeInstanceOf(SequenceError);
    await expect(ordered.elementAtOrDefault(3)).resolves.toBeNull();
  });

  it('indexes into a filtered query', async () => {
    const person = await db.people
      .where((row) => row.age > 40)
      .orderBy((row) => row.name)
      .elementAt(1);

    expect(person.name).toBe('Grace');
  });

  it('skips within the rows take limited, not before them', async () => {
    // The first two by id are Ada and Grace; dropping one leaves just Grace.
    // Folded into a single LIMIT 2 OFFSET 1 this would return Grace and Alan.
    const rows = await db.people
      .orderBy((row) => row.id)
      .take(2)
      .skip(1)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('reads a table in batches', async () => {
    const batches: string[][] = [];
    for await (const batch of db.people.orderBy((row) => row.id).chunk(2)) {
      batches.push(batch.map((row) => row.name));
    }

    expect(batches).toEqual([['Ada', 'Grace'], ['Alan']]);
  });

  it('covers every row exactly once', async () => {
    const seen: number[] = [];
    for await (const batch of db.people.orderBy((row) => row.id).chunk(1)) {
      seen.push(...batch.map((row) => row.id));
    }

    expect(seen).toEqual([1, 2, 3]);
  });

  it('batches a filtered query', async () => {
    const batches: string[][] = [];
    for await (const batch of db.people
      .where((row) => row.age > 40)
      .orderBy((row) => row.name)
      .chunk(1)) {
      batches.push(batch.map((row) => row.name));
    }

    expect(batches).toEqual([['Alan'], ['Grace']]);
  });

  it('yields nothing when the query matches nothing', async () => {
    const batches: unknown[][] = [];
    for await (const batch of db.people.where((row) => row.age > 200).chunk(2)) {
      batches.push(batch);
    }

    expect(batches).toEqual([]);
  });

  it('batches a projection, keeping its shape', async () => {
    const batches: { who: string }[][] = [];
    for await (const batch of db.people
      .orderBy((row) => row.id)
      .select((row) => ({ who: row.name }))
      .chunk(2)) {
      batches.push(batch);
    }

    expect(batches).toEqual([[{ who: 'Ada' }, { who: 'Grace' }], [{ who: 'Alan' }]]);
  });

  it('reads a sequence as its own differences', async () => {
    // By id the ages run 36, 45, 41.
    const rows = await db.people
      .orderBy((person) => person.id)
      .pairwise((before, now) => ({ at: now.name, change: now.age - before.age }))
      .toArray();

    expect(rows).toEqual([
      { at: 'Grace', change: 9 },
      { at: 'Alan', change: -4 },
    ]);
  });

  it('returns one fewer row than the query has', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .pairwise((before, now) => before.id * 10 + now.id)
      .toArray();

    expect(rows).toEqual([12, 23]);
  });

  it('returns nothing for a single row and nothing for none', async () => {
    const one = await db.people
      .where((person) => person.id === 1)
      .orderBy((person) => person.id)
      .pairwise((before, now) => now.age - before.age)
      .toArray();

    expect(one).toEqual([]);

    const none = await db.people
      .where((person) => person.age > 200)
      .orderBy((person) => person.id)
      .pairwise((before, now) => now.age - before.age)
      .toArray();

    expect(none).toEqual([]);
  });

  it('pairs each row with the one after it when the ordering is reversed', async () => {
    const rows = await db.people
      .orderByDescending((person) => person.id)
      .pairwise((before, now) => before.id * 10 + now.id)
      .toArray();

    expect(rows).toEqual([32, 21]);
  });

  it('drops the first row by position, not by its earlier columns being null', async () => {
    // Reversed, Alan comes first and his city is null, so the pair after him
    // carries a genuinely null earlier column. Reading that as "no earlier row"
    // would lose a pair that should be there.
    const rows = await db.people
      .orderByDescending((person) => person.id)
      .pairwise((before, now) => ({ at: now.name, was: before.city }))
      .toArray();

    expect(rows).toEqual([
      { at: 'Grace', was: null },
      { at: 'Ada', was: 'New York' },
    ]);
  });

  it('calls a method on either row of the pair', async () => {
    // Ada joined in January, Grace in June, Alan in December.
    const rows = await db.people
      .orderBy((person) => person.id)
      .pairwise((before, now) => now.joinedAt.getMonth() - before.joinedAt.getMonth())
      .toArray();

    expect(rows).toEqual([5, 6]);
  });

  it('hands back the earlier row whole', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .pairwise((before) => before)
      .toArray();

    // Two pairs, so the two rows that led one.
    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
    expect(rows[0]?.tags).toEqual(['maths', 'logic', 'poetry']);
  });

  it('filters the pairs, not the rows they were made from', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .pairwise((before, now) => ({ at: now.name, change: now.age - before.age }))
      .where((pair) => pair.change > 0)
      .toArray();

    // `change` exists only once the pair does, so this necessarily runs after
    // the pairing: Alan's pair is made, then dropped for a fall in age.
    expect(rows).toEqual([{ at: 'Grace', change: 9 }]);
  });

  it('pairs the rows paging kept', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .take(2)
      .orderBy((person) => person.id)
      .pairwise((before, now) => before.id * 10 + now.id)
      .toArray();

    // Alan is not there to be paired with Grace, so one pair rather than two.
    expect(rows).toEqual([12]);
  });

  it('pairs a projection, keeping its shape', async () => {
    const rows = await db.people
      .select((person) => ({ who: person.name, years: person.age }))
      .orderBy((row) => row.years)
      .pairwise((before, now) => ({ from: before.who, to: now.who }))
      .toArray();

    // By age: Ada 36, Alan 41, Grace 45.
    expect(rows).toEqual([
      { from: 'Ada', to: 'Alan' },
      { from: 'Alan', to: 'Grace' },
    ]);
  });

  it('reads a moving average off one statement', async () => {
    // By id the ages run 36, 45, 41, so the runs of two average 40.5 and 43.
    const rows = await db.people
      .orderBy((person) => person.id)
      .windowed(2, (run, row) => ({ at: row.name, mean: run.average((r) => r.age) }))
      .toArray();

    // AVG over an exact numeric comes back as a string, as it does from a
    // group, which is the trade that keeps a decimal from losing precision.
    expect(rows.map((row) => ({ at: row.at, mean: Number(row.mean) }))).toEqual([
      { at: 'Grace', mean: 40.5 },
      { at: 'Alan', mean: 43 },
    ]);
  });

  it('returns one row per full run, so size minus one fewer than the query has', async () => {
    const of = async (size: number) =>
      (
        await db.people
          .orderBy((person) => person.id)
          .windowed(size, (run) => run.sum((r) => r.age))
          .toArray()
      ).map(Number);

    // Three rows: three runs of one, two of two, one of three, none of four.
    expect(await of(1)).toEqual([36, 45, 41]);
    expect(await of(2)).toEqual([81, 86]);
    expect(await of(3)).toEqual([122]);
    expect(await of(4)).toEqual([]);
  });

  it('answers the run size for every row it returns', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .windowed(2, (run) => run.count())
      .toArray();

    // The short runs are dropped, so every run that survives is full. Counting
    // one is a way of saying that rather than a way of learning anything.
    expect(rows.map(Number)).toEqual([2, 2]);
  });

  it('runs ahead of each row when the ordering is reversed', async () => {
    const rows = await db.people
      .orderByDescending((person) => person.id)
      .windowed(2, (run) => run.sum((r) => r.age))
      .toArray();

    // Reversed the ages run 41, 45, 36, so the runs are the same pairs read
    // from the other end: the run trails the row in whichever direction the
    // ordering goes.
    expect(rows.map(Number)).toEqual([86, 81]);
  });

  it('takes the smallest and largest of a run as well as its mean', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .windowed(3, (run) => ({
        low: run.min((r) => r.age),
        high: run.max((r) => r.age),
      }))
      .toArray();

    expect(rows).toEqual([{ low: 36, high: 45 }]);
  });

  it('reads back every row of the run when asked for the run itself', async () => {
    const rows = await db.people
      .select((person) => ({ who: person.name, years: person.age }))
      .orderBy((row) => row.years)
      .windowed(2, (run, row) => ({ at: row.who, run: run.toArray() }))
      .toArray();

    // By age: Ada 36, Alan 41, Grace 45. `toArray` over a run is `json_agg`
    // over a frame, which is the literal reading of "every run of two rows".
    expect(rows).toEqual([
      {
        at: 'Alan',
        run: [
          { who: 'Ada', years: 36 },
          { who: 'Alan', years: 41 },
        ],
      },
      {
        at: 'Grace',
        run: [
          { who: 'Alan', years: 41 },
          { who: 'Grace', years: 45 },
        ],
      },
    ]);
  });

  it('drops the short runs by position, not by an aggregate reading null', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .orderBy((person) => person.id)
      .windowed(1, (run, row) => ({ at: row.name, city: run.min((r) => r.city) }))
      .toArray();

    // Alan's city is null, so his run reduces to null. It is a full run all the
    // same and still comes back: a null aggregate cannot be told from a run
    // that was too short, so only the position is asked.
    expect(rows).toEqual([{ at: 'Alan', city: null }]);
  });

  it('filters the runs, not the rows they were made from', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .windowed(2, (run, row) => ({ at: row.name, mean: run.average((r) => r.age) }))
      .where((w) => w.mean > 41)
      .toArray();

    // `mean` exists only once the run does, so this necessarily runs after the
    // windowing: Grace's run is made at 40.5, then dropped.
    expect(rows.map((row) => row.at)).toEqual(['Alan']);
  });

  it('frames the rows paging kept', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .take(2)
      .orderBy((person) => person.id)
      .windowed(2, (run) => run.sum((r) => r.age))
      .toArray();

    // Alan is not there to end a run, so one run rather than two.
    expect(rows.map(Number)).toEqual([81]);
  });

  it('follows a navigation off the row it ends at', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .windowed(2, (run, row) => ({ who: row.person.name, ids: run.sum((v) => v.id) }))
      .toArray();

    // The run and the row both read the query's own rows, so the entity a
    // navigation needs is still there. `pairwise` reads its rows back out of a
    // derived table and cannot do this.
    expect(rows.map((row) => ({ who: row.who, ids: Number(row.ids) }))).toEqual([
      { who: 'Ada', ids: 3 },
      { who: 'Grace', ids: 5 },
    ]);
  });
  it('reads a running total off one statement', async () => {
    // By id the ages run 36, 45, 41, so the totals up to each row are 36, 81,
    // and 122.
    const rows = await db.people
      .orderBy((person) => person.id)
      .expanding((sofar, row) => ({ at: row.name, total: sofar.sum((r) => r.age) }))
      .toArray();

    // SUM over an exact numeric comes back as a string, as it does from a group
    // and from a fixed run, which is the trade that keeps a decimal from losing
    // precision.
    expect(rows.map((row) => ({ at: row.at, total: Number(row.total) }))).toEqual([
      { at: 'Ada', total: 36 },
      { at: 'Grace', total: 81 },
      { at: 'Alan', total: 122 },
    ]);
  });

  it('returns a row for every row the query has, where a fixed run does not', async () => {
    const running = await db.people
      .orderBy((person) => person.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toArray();
    const moving = await db.people
      .orderBy((person) => person.id)
      .windowed(3, (run) => run.sum((r) => r.age))
      .toArray();

    // Three rows in, three rows out: a run up to the first row is that row
    // alone and is still a run, so there is nothing short to drop. The same
    // query windowed at three keeps only the row that has three behind it.
    expect(running.map(Number)).toEqual([36, 81, 122]);
    expect(moving.map(Number)).toEqual([122]);
  });

  it('counts the rows up to each one, which is its position', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .expanding((sofar) => sofar.count())
      .toArray();

    // The same `count()` that answers the size for every row of a fixed run
    // and says nothing. Over a growing run it is the row position, counted
    // from one as `ROW_NUMBER` counts and not from zero as `index` does.
    expect(rows.map(Number)).toEqual([1, 2, 3]);
  });

  it('accumulates from the other end when the ordering is reversed', async () => {
    const rows = await db.people
      .orderByDescending((person) => person.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toArray();

    // Reversed the ages run 41, 45, 36, so the totals are 41, 86, 122. The last
    // row of either direction carries every row of the query, which is the one
    // value the two orderings have to agree on.
    expect(rows.map(Number)).toEqual([41, 86, 122]);
  });

  it('takes a running mean and a running extreme as well as a total', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .expanding((sofar) => ({
        mean: sofar.average((r) => r.age),
        low: sofar.min((r) => r.age),
        high: sofar.max((r) => r.age),
      }))
      .toArray();

    // Ada 36, then Grace 45, then Alan 41. The extremes settle as the run grows
    // and the mean keeps moving, which is what makes all three worth asking.
    expect(
      rows.map((row) => ({ mean: Number(row.mean).toFixed(2), low: row.low, high: row.high })),
    ).toEqual([
      { mean: '36.00', low: 36, high: 36 },
      { mean: '40.50', low: 36, high: 45 },
      { mean: '40.67', low: 36, high: 45 },
    ]);
  });

  it('reads back one more row than the row before it when asked for the run itself', async () => {
    const rows = await db.people
      .select((person) => ({ who: person.name, years: person.age }))
      .orderBy((row) => row.years)
      .expanding((sofar, row) => ({ at: row.who, run: sofar.toArray() }))
      .toArray();

    // By age: Ada 36, Alan 41, Grace 45. `toArray` over a growing frame is the
    // literal reading of "every row up to this one".
    expect(rows.map((row) => ({ at: row.at, run: row.run.map((r) => r.who) }))).toEqual([
      { at: 'Ada', run: ['Ada'] },
      { at: 'Alan', run: ['Ada', 'Alan'] },
      { at: 'Grace', run: ['Ada', 'Alan', 'Grace'] },
    ]);
  });

  it('filters the running values, not the rows they were made from', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .expanding((sofar, row) => ({ at: row.name, total: sofar.sum((r) => r.age) }))
      .where((w) => w.total > 50)
      .toArray();

    // Ada's own total is 36 and she is dropped, but the 81 and the 122 after
    // her still include her age. Filtering before accumulating would have
    // restarted the totals from Grace.
    expect(rows.map((row) => ({ at: row.at, total: Number(row.total) }))).toEqual([
      { at: 'Grace', total: 81 },
      { at: 'Alan', total: 122 },
    ]);
  });

  it('accumulates over the rows paging kept', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .skip(1)
      .orderBy((person) => person.id)
      .expanding((sofar) => sofar.sum((r) => r.age))
      .toArray();

    // Ada is off the page, so the totals start at Grace rather than carrying
    // the rows the page skipped.
    expect(rows.map(Number)).toEqual([45, 86]);
  });

  it('follows a navigation off the row it ends at, as windowed does', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .expanding((sofar, row) => ({ who: row.person.name, ids: sofar.sum((v) => v.id) }))
      .toArray();

    // Both readings are of the query's own rows, so the entity a navigation
    // needs is still there.
    expect(rows.map((row) => ({ who: row.who, ids: Number(row.ids) }))).toEqual([
      { who: 'Ada', ids: 1 },
      { who: 'Ada', ids: 3 },
      { who: 'Grace', ids: 6 },
    ]);
  });
  it('reads a moving average per key off one statement', async () => {
    const rows = await db.readings
      .orderBy((r) => r.id)
      .windowedBy(
        (r) => r.sensorId,
        2,
        (run, row) => ({ at: row.id, mean: run.average((x) => x.value) }),
      )
      .toArray();

    // Sensor 'a' reads 10, 20, 30 and 'b' reads 100, 200, interleaved by id. The
    // runs of two are per sensor, so no average mixes the two series, which is
    // the whole point of the operator.
    expect(rows.map((row) => ({ at: row.at, mean: Number(row.mean) }))).toEqual([
      { at: 3, mean: 15 },
      { at: 4, mean: 150 },
      { at: 5, mean: 25 },
    ]);
  });

  it('gives different values and a different row count from the unpartitioned run', async () => {
    const keyed = await db.readings
      .orderBy((r) => r.id)
      .windowedBy(
        (r) => r.sensorId,
        2,
        (run) => run.sum((x) => x.value),
      )
      .toArray();
    const plain = await db.readings
      .orderBy((r) => r.id)
      .windowed(2, (run) => run.sum((x) => x.value))
      .toArray();

    // Five rows give four unpartitioned runs of two and three partitioned ones,
    // because the head of each key is dropped rather than only the head of the
    // query. Not one of the sums agrees.
    expect(keyed.map(Number)).toEqual([30, 300, 50]);
    expect(plain.map(Number)).toEqual([110, 120, 220, 230]);
  });

  it('drops the first rows of every key, not only of the query', async () => {
    const rows = await db.readings
      .orderBy((r) => r.id)
      .windowedBy(
        (r) => r.sensorId,
        2,
        (run, row) => ({ at: row.id, total: run.sum((x) => x.value) }),
      )
      .toArray();

    // Ids 1 and 2 are the first reading of each sensor and both go, where
    // `windowed(2)` would have dropped id 1 alone. The rows that survive are
    // the second and later reading of each key.
    expect(rows.map((row) => row.at)).toEqual([3, 4, 5]);
  });

  it('returns nothing for a key with fewer rows than the run needs', async () => {
    const rows = await db.readings
      .orderBy((r) => r.id)
      .windowedBy(
        (r) => r.sensorId,
        3,
        (run, row) => ({ at: row.id, total: run.sum((x) => x.value) }),
      )
      .toArray();

    // Sensor 'a' has three readings and reaches a full run exactly once; 'b' has
    // two and contributes nothing at all. A short key is silent rather than
    // partial, which is `windowed`'s own reading applied per key.
    expect(rows.map((row) => ({ at: row.at, total: Number(row.total) }))).toEqual([
      { at: 5, total: 60 },
    ]);
  });

  it('returns the rows in the query ordering rather than grouped by key', async () => {
    const rows = await db.readings
      .orderBy((r) => r.id)
      .expandingBy(
        (r) => r.sensorId,
        (sofar, row) => ({ at: row.id, who: row.sensorId, total: sofar.sum((x) => x.value) }),
      )
      .toArray();

    // The keys alternate and the result alternates with them: a partition says
    // which rows are behind a row, and the ordering says where the row sits.
    // Ordering by the per-key number instead would have grouped this by sensor.
    expect(rows.map((row) => ({ at: row.at, who: row.who, total: Number(row.total) }))).toEqual([
      { at: 1, who: 'a', total: 10 },
      { at: 2, who: 'b', total: 100 },
      { at: 3, who: 'a', total: 30 },
      { at: 4, who: 'b', total: 300 },
      { at: 5, who: 'a', total: 60 },
    ]);
  });

  it('reads a running total per key, keeping every row', async () => {
    const keyed = await db.readings
      .orderBy((r) => r.id)
      .expandingBy(
        (r) => r.sensorId,
        (sofar) => sofar.sum((x) => x.value),
      )
      .toArray();
    const plain = await db.readings
      .orderBy((r) => r.id)
      .expanding((sofar) => sofar.sum((x) => x.value))
      .toArray();

    // Both keep all five rows, unlike the fixed runs above: a run up to a row is
    // never short, so partitioning costs no rows here. Only the totals differ.
    expect(keyed.map(Number)).toEqual([10, 100, 30, 300, 60]);
    expect(plain.map(Number)).toEqual([10, 110, 130, 330, 360]);
  });

  it('counts the rows up to each one within its key', async () => {
    const keyed = await db.readings
      .orderBy((r) => r.id)
      .expandingBy(
        (r) => r.sensorId,
        (sofar) => sofar.count(),
      )
      .toArray();

    // 'a' is numbered 1, 2, 3 and 'b' is numbered 1, 2, interleaved. Over an
    // unpartitioned run the same count is the position in the query; here it is
    // the position within the key.
    expect(keyed.map(Number)).toEqual([1, 1, 2, 2, 3]);
  });

  it('filters the per-key running values, not the rows they were made from', async () => {
    const rows = await db.readings
      .orderBy((r) => r.id)
      .expandingBy(
        (r) => r.sensorId,
        (sofar, row) => ({ at: row.id, total: sofar.sum((x) => x.value) }),
      )
      .where((w) => w.total >= 60)
      .toArray();

    // Sensor 'a' only reaches 60 at its last reading and 'b' passes it at its
    // first, so the filter cuts across the keys rather than within one.
    expect(rows.map((row) => ({ at: row.at, total: Number(row.total) }))).toEqual([
      { at: 2, total: 100 },
      { at: 4, total: 300 },
      { at: 5, total: 60 },
    ]);
  });

  it('partitions on a key reached through a navigation', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .expandingBy(
        (visit) => visit.person.name,
        (sofar, row) => ({
          at: row.id,
          ids: sofar.sum((v) => v.id),
        }),
      )
      .toArray();

    // Ada made visits 1 and 2, Grace visit 3, so the totals restart at Grace.
    // The join the key raised sits inside the derived table, which is the only
    // place the column it partitions on is in scope.
    expect(rows.map((row) => ({ at: row.at, ids: Number(row.ids) }))).toEqual([
      { at: 1, ids: 1 },
      { at: 2, ids: 3 },
      { at: 3, ids: 3 },
    ]);
  });

  it('restarts the runs per key when the ordering is reversed', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.id)
      .expandingBy(
        (r) => r.sensorId,
        (sofar) => sofar.sum((x) => x.value),
      )
      .toArray();

    // Reversed, 'a' accumulates 30, 50, 60 and 'b' accumulates 200, 300, still
    // interleaved. The last row of each key carries that key entire, in either
    // direction.
    expect(rows.map(Number)).toEqual([30, 200, 50, 300, 60]);
  });

  it('gives tied rows the same place and skips the ones a tie consumed', async () => {
    const rows = await db.readings
      .orderBy((r) => r.sensorId)
      .rank((reading, place) => ({ id: reading.id, who: reading.sensorId, place }))
      .toArray();

    // Ordering by sensor alone makes the three 'a' readings tie and the two 'b'
    // readings tie. `RANK` calls all of the first group first and then jumps to
    // fourth, because three rows have already been placed.
    expect(rows.map((row) => ({ who: row.who, place: row.place }))).toEqual([
      { who: 'a', place: 1 },
      { who: 'a', place: 1 },
      { who: 'a', place: 1 },
      { who: 'b', place: 4 },
      { who: 'b', place: 4 },
    ]);
  });

  it('counts the places without gaps when asked densely', async () => {
    const rows = await db.readings
      .orderBy((r) => r.sensorId)
      .denseRank((reading, tier) => ({ who: reading.sensorId, tier }))
      .toArray();

    // The same ties read the other way: the second distinct value is the second
    // tier rather than the fourth place. This is the whole of what `dense`
    // changes, and the row count and order are identical.
    expect(rows.map((row) => row.tier)).toEqual([1, 1, 1, 2, 2]);
  });

  it('differs from index, which numbers tied rows apart', async () => {
    const ranked = await db.readings
      .orderBy((r) => r.sensorId)
      .rank((_r, place) => place)
      .toArray();
    const numbered = await db.readings
      .orderBy((r) => r.sensorId)
      .index((_r, position) => position)
      .toArray();

    // The reason the operator exists. `index` hands five tied-or-not rows five
    // different numbers and says nothing about which of them tied; `rank` says
    // it. Both count over the same ordering.
    expect(ranked).toEqual([1, 1, 1, 4, 4]);
    expect(numbered).toEqual([0, 1, 2, 3, 4]);
  });

  it('counts from one, so it needs no addition where index does', async () => {
    const ranked = await db.readings
      .orderByDescending((r) => r.value)
      .rank((_r, place) => place)
      .toArray();
    const numbered = await db.readings
      .orderByDescending((r) => r.value)
      .index((_r, position) => position)
      .toArray();

    // Every value is distinct here, so nothing ties and the two operators are
    // measuring the same thing from different starts. That is what makes
    // `rank` the operator to reach for over `index((u, i) => i + 1)`.
    expect(ranked).toEqual([1, 2, 3, 4, 5]);
    expect(numbered.map((position) => position + 1)).toEqual(ranked);
  });

  it('breaks a tie when the ordering is given a key that separates the rows', async () => {
    const rows = await db.readings
      .orderBy((r) => r.sensorId)
      .thenBy((r) => r.id)
      .rank((_r, place) => place)
      .toArray();

    // What ties is what the ordering says and nothing else, so adding a unique
    // key is how a query asks for no ties. The same five rows now place 1
    // through 5.
    expect(rows).toEqual([1, 2, 3, 4, 5]);
  });

  it('filters on the place, which is what a leaderboard is for', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .rank((reading, place) => ({ value: reading.value, place }))
      .where((r) => r.place <= 2)
      .toArray();

    // The window sits a level down, so this is an ordinary filter rather than a
    // window in a `WHERE`, which SQL would refuse.
    expect(rows).toEqual([
      { value: 200, place: 1 },
      { value: 100, place: 2 },
    ]);
  });

  it('answers a number rather than the string the driver would hand back', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .rank((_r, place) => place)
      .toArray();

    // `RANK` is an exact numeric and node-postgres returns those as strings, so
    // the cast is what makes the projector's own `number` true, exactly as it
    // does for `index`' position.
    expect(rows.every((place) => typeof place === 'number')).toBe(true);
  });

  it('ranks the rows paging kept, not the ones behind them', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .skip(2)
      .orderByDescending((r) => r.value)
      .rank((reading, place) => ({ value: reading.value, place }))
      .toArray();

    // The two largest readings are off the page, so first place is the third
    // largest rather than carrying its place from the whole table.
    expect(rows).toEqual([
      { value: 30, place: 1 },
      { value: 20, place: 2 },
      { value: 10, place: 3 },
    ]);
  });

  it('keeps the first n rows of each key over one pass of the table', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 2)
      .toArray();

    // Sensor 'a' reads 10, 20, 30 and 'b' reads 100, 200. The two largest of
    // each are 30 and 20 for one, 200 and 100 for the other, and they come back
    // in the query ordering rather than grouped by sensor.
    expect(rows.map((row) => ({ who: row.sensorId, value: row.value }))).toEqual([
      { who: 'b', value: 200 },
      { who: 'b', value: 100 },
      { who: 'a', value: 30 },
      { who: 'a', value: 20 },
    ]);
  });

  it('is not take, which keeps that many rows in total', async () => {
    const perKey = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 2)
      .toArray();
    const perStatement = await db.readings
      .orderByDescending((r) => r.value)
      .take(2)
      .toArray();

    // The whole reason the operator exists. `take(2)` hands two rows to
    // whichever sensors they happened to belong to, and here they are both 'b'.
    expect(perKey).toHaveLength(4);
    expect(perStatement.map((row) => row.sensorId)).toEqual(['b', 'b']);
  });

  it('keeps a key whole when it holds fewer rows than the count', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 10)
      .toArray();

    // Narrowing each key never removes one, unlike `windowedBy`, which needs a
    // full run and drops a short key entirely. Every row comes back.
    expect(rows).toHaveLength(5);
  });

  it('keeps everything past the first n of each key, which is the complement', async () => {
    const kept = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 1)
      .toArray();
    const rest = await db.readings
      .orderByDescending((r) => r.value)
      .skipBy((r) => r.sensorId, 1)
      .toArray();

    // The two partition the table between them, which is the claim worth
    // checking against a database rather than against generated text: the
    // largest of each sensor, and everything else.
    expect(kept.map((row) => row.id).sort()).toEqual([4, 5]);
    expect(rest.map((row) => row.id).sort()).toEqual([1, 2, 3]);
    expect(kept.length + rest.length).toBe(5);
  });

  it('drops a key entirely when skipping past everything it holds', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .skipBy((r) => r.sensorId, 2)
      .toArray();

    // Sensor 'b' has exactly two readings and contributes nothing; 'a' has
    // three and contributes its smallest. That is the mirror of `takeBy`
    // keeping a short key whole.
    expect(rows.map((row) => ({ who: row.sensorId, value: row.value }))).toEqual([
      { who: 'a', value: 10 },
    ]);
  });

  it('agrees with distinctBy at a count of one', async () => {
    const taken = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 1)
      .toArray();
    const distinct = await db.readings
      .orderByDescending((r) => r.value)
      .distinctBy((r) => r.sensorId)
      .toArray();

    // The same window by two names, which is why the node cannot tell which
    // operator was written from its numbers and has to be told.
    expect(taken).toEqual(distinct);
  });

  it('takes the other end of each key when the ordering is reversed', async () => {
    const rows = await db.readings
      .orderBy((r) => r.value)
      .takeBy((r) => r.sensorId, 1)
      .toArray();

    // Which rows survive is the ordering's decision, so ascending takes the
    // smallest of each sensor where descending took the largest.
    expect(rows.map((row) => row.value)).toEqual([10, 100]);
  });

  it('filters the rows each key kept, not the rows it counted', async () => {
    const rows = await db.readings
      .orderByDescending((r) => r.value)
      .takeBy((r) => r.sensorId, 2)
      .where((r) => r.value < 150)
      .toArray();

    // The 200 was counted into 'b's two and then dropped by the filter, so 'b'
    // comes back with one row rather than being refilled from below. Filtering
    // first would have given 100 and 20 instead.
    expect(rows.map((row) => row.value)).toEqual([100, 30, 20]);
  });

  it('follows a reference off a row a per-key window kept', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .takeBy((visit) => visit.personId, 1)
      .select((visit) => ({ who: visit.person.name, city: visit.city }))
      .toArray();

    // Ada made visits 1 and 2 and Grace visit 3, so the first of each key is
    // Paris and Lisbon. The join runs after the window, which is what makes
    // the answer the first visit of each person rather than of each pairing.
    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Grace', city: 'Lisbon' },
    ]);
  });

  it('follows a reference off a paged row', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .take(2)
      .select((visit) => ({ who: visit.person.name, city: visit.city }))
      .toArray();

    // The plainest case and the one that was refused longest: a page and then
    // a navigation off what the page kept. Both of Ada's visits.
    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
    ]);
  });

  it('filters on a navigated column after the window', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .takeBy((visit) => visit.personId, 2)
      .where((visit) => visit.person.name === 'Ada')
      .toArray();

    // The window kept up to two visits per person and the filter then dropped
    // the people. Ada's two survive, Grace's one does not, and the numbering
    // was never affected by the filter.
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it('reads a collection through a derived table', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .take(2)
      .select((visit) => ({ city: visit.city, notes: visit.notes.count() }))
      .toArray();

    // A collection correlates on the primary key, which survives a derived
    // table as a foreign key does. The Paris visit has two notes and Rome none.
    // COUNT over a collection comes back a string, as it does anywhere else
    // in this library, which the derived table changes nothing about.
    expect(rows.map((row) => ({ city: row.city, notes: Number(row.notes) }))).toEqual([
      { city: 'Paris', notes: 2 },
      { city: 'Rome', notes: 0 },
    ]);
  });

  it('joins after the page rather than before it, which changes the answer', async () => {
    const afterPaging = await db.visits
      .orderBy((visit) => visit.id)
      .take(2)
      .where((visit) => visit.person.name === 'Grace')
      .toArray();
    const beforePaging = await db.visits
      .where((visit) => visit.person.name === 'Grace')
      .orderBy((visit) => visit.id)
      .take(2)
      .toArray();

    // The two orders are different questions and now both are writable. The
    // first two visits are Ada's, so filtering after the page finds none;
    // filtering first finds the one visit Grace made.
    expect(afterPaging).toEqual([]);
    expect(beforePaging.map((row) => row.id)).toEqual([3]);
  });

  it('drops the rows whose key appears in another query', async () => {
    // Ada and Grace have visits; Alan has none.
    const rows = await db.people
      .exceptBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Alan']);
  });

  it('never multiplies a row, however often the key appears on the other side', async () => {
    // Ada has two visits, so a join would return her twice before anything
    // filtered. `NOT EXISTS` asks once and answers once.
    const rows = await db.people
      .exceptBy(
        db.visits.where((visit) => visit.city !== 'Lisbon'),
        (person) => person.id,
        (visit) => visit.personId,
      )
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);
  });

  it('keeps a row whose key is not null when the other side holds one that is', async () => {
    // Alan is the only person with no city, so the subtracted query's one key is
    // null. Under `NOT IN` that single null would make the test unknown for
    // every row and the whole query would return nothing.
    const rows = await db.people
      .exceptBy(
        db.people.where((person) => person.id === 3),
        (person) => person.city,
        (person) => person.city,
      )
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('drops a row whose key is null when the other side holds one too', async () => {
    // The other half of the same query: Alan's null city matches the null city
    // on the other side, as it does in LINQ and in SQL's own `EXCEPT`.
    const rows = await db.people
      .exceptBy(
        db.people.where((person) => person.id === 3),
        (person) => person.city,
        (person) => person.city,
      )
      .toArray();

    expect(rows.map((row) => row.name)).not.toContain('Alan');
  });

  it('pairs the parts of an object key by name', async () => {
    // Visits 1 and 3 have notes, visit 2 has none. The two selectors declare
    // their parts in opposite orders, which must not change the answer.
    const rows = await db.visits
      .exceptBy(
        db.notes,
        (visit) => ({ ref: visit.id, kind: visit.id }),
        (note) => ({ kind: note.visitId, ref: note.visitId }),
      )
      .orderBy((visit) => visit.id)
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it('follows a navigation on this side', async () => {
    // Visits 1 and 2 are Ada's, visit 3 is Grace's.
    const rows = await db.visits
      .exceptBy(
        db.people.where((person) => person.name === 'Ada'),
        (visit) => visit.person.name,
        (person) => person.name,
      )
      .orderBy((visit) => visit.id)
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([3]);
  });

  it('follows a navigation on the other side', async () => {
    // The join belongs to the subquery. Ada and Grace both have a visit under
    // their name, Alan does not.
    const rows = await db.people
      .exceptBy(
        db.visits,
        (person) => person.name,
        (visit) => visit.person.name,
      )
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Alan']);
  });

  it('subtracts from the rows paging kept', async () => {
    // Ada and Grace are the first two by id, and both have visits, so nothing
    // survives. Alan would have, had the limit not already excluded him.
    const rows = await db.people
      .orderBy((person) => person.id)
      .take(2)
      .exceptBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .toArray();

    expect(rows).toEqual([]);
  });

  it('filters and pages what survived', async () => {
    const rows = await db.people
      .exceptBy(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
      )
      .where((person) => person.age > 40)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Alan']);
  });

  it('subtracts nothing when the other query is empty', async () => {
    const rows = await db.people
      .exceptBy(
        db.visits.where((visit) => visit.city === 'nowhere'),
        (person) => person.id,
        (visit) => visit.personId,
      )
      .orderBy((person) => person.id)
      .toArray();

    expect(rows).toHaveLength(3);
  });

  it('cuts a run wherever the key changes', async () => {
    // By id the ages run 36, 45, 41, so `age > 40` reads false, true, true and
    // the last two rows share a run while the first stands alone.
    const runs: string[][] = [];
    for await (const run of db.people.orderBy((row) => row.id).chunkBy((row) => row.age > 40)) {
      runs.push(run.map((row) => row.name));
    }

    expect(runs).toEqual([['Ada'], ['Grace', 'Alan']]);
  });

  it('is not groupBy, which collects a key wherever it sits', async () => {
    // `id === 2` reads false, true, false down the table, so the key comes back
    // after giving way. That is two runs of false here and one group of false
    // under `groupBy`, which is the case that tells the two operators apart.
    const runs: number[][] = [];
    for await (const run of db.people.orderBy((row) => row.id).chunkBy((row) => row.id === 2)) {
      runs.push(run.map((row) => row.id));
    }

    expect(runs).toEqual([[1], [2], [3]]);

    const groups = await db.people
      .groupBy(
        (row) => row.id === 2,
        (key, rows) => ({ key, count: rows.count() }),
      )
      .toArray();

    expect(groups).toHaveLength(2);
  });

  it('holds consecutive null keys in one run', async () => {
    // Ada has three tags, Grace one, and Alan none, so the second tag is
    // present, null, and null down the table. SQL reads `NULL = NULL` as
    // unknown, which would cut between Grace and Alan; LINQ's default comparer
    // holds them together and so does this.
    const runs: string[][] = [];
    for await (const run of db.people.orderBy((row) => row.id).chunkBy((row) => row.tags.at(1))) {
      runs.push(run.map((row) => row.name));
    }

    expect(runs).toEqual([['Ada'], ['Grace', 'Alan']]);
  });

  it('starts a run at the first row even when its key is null', async () => {
    // Reversed, the null-tagged rows come first, so the very first row has no
    // row before it and a null key. Reading the absent row as a null key would
    // number the first run zero and lose it entirely.
    const runs: string[][] = [];
    for await (const run of db.people
      .orderByDescending((row) => row.id)
      .chunkBy((row) => row.tags.at(1))) {
      runs.push(run.map((row) => row.name));
    }

    expect(runs).toEqual([['Alan', 'Grace'], ['Ada']]);
  });

  it('runs the whole table as one run when the key never changes', async () => {
    const runs: number[][] = [];
    for await (const run of db.people.orderBy((row) => row.id).chunkBy((row) => row.age > 0)) {
      runs.push(run.map((row) => row.id));
    }

    // A run is bounded by the key rather than by a size the caller chose, so
    // this is one statement returning every row and one more to learn there is
    // nothing behind it.
    expect(runs).toEqual([[1, 2, 3]]);
  });

  it('follows a navigation the key reaches through', async () => {
    // Two visits by Ada then one by Grace, which is what the join has to be
    // inside the window to see.
    const runs: number[][] = [];
    for await (const run of db.visits
      .orderBy((visit) => visit.id)
      .chunkBy((visit) => visit.person.name)) {
      runs.push(run.map((visit) => visit.id));
    }

    expect(runs).toEqual([[1, 2], [3]]);
  });

  it('cuts a filtered and projected query, keeping its shape', async () => {
    const runs: { who: string }[][] = [];
    for await (const run of db.people
      .where((row) => row.age > 0)
      .select((row) => ({ who: row.name, old: row.age > 40 }))
      .orderBy((row) => row.who)
      .chunkBy((row) => row.old)) {
      runs.push(run.map((row) => ({ who: row.who })));
    }

    // By name the table reads Ada (36), Alan (41), Grace (45).
    expect(runs).toEqual([[{ who: 'Ada' }], [{ who: 'Alan' }, { who: 'Grace' }]]);
  });

  it('yields nothing when the query matches nothing', async () => {
    const runs: unknown[][] = [];
    for await (const run of db.people
      .where((row) => row.age > 200)
      .orderBy((row) => row.id)
      .chunkBy((row) => row.age)) {
      runs.push(run);
    }

    expect(runs).toEqual([]);
  });

  it('stops at the first failure, where a filter would keep going', async () => {
    // By id the ages run 36, 45, 41. Under `age < 42` the middle row fails, so
    // `takeWhile` keeps only Ada while `where` keeps Ada and Alan. This is the
    // case that tells the two operators apart.
    const ordered = db.people.orderBy((row) => row.id);

    const taken = await ordered.takeWhile((row) => row.age < 42).toArray();
    const filtered = await db.people
      .where((row) => row.age < 42)
      .orderBy((row) => row.id)
      .toArray();

    expect(taken.map((row) => row.name)).toEqual(['Ada']);
    expect(filtered.map((row) => row.name)).toEqual(['Ada', 'Alan']);
  });

  it('keeps every row when none of them fails', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .takeWhile((row) => row.age > 30)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('keeps nothing when the first row fails', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .takeWhile((row) => row.age > 40)
      .toArray();

    expect(rows).toEqual([]);
  });

  it('follows the ordering it was given', async () => {
    // By age ascending the order is Ada 36, Alan 41, Grace 45.
    const rows = await db.people
      .orderBy((row) => row.age)
      .takeWhile((row) => row.age < 45)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan']);
  });

  it('stops on a predicate that is null rather than true', async () => {
    // Alan has no city, so the comparison is unknown rather than true, and an
    // unknown is not a pass.
    const rows = await db.people
      .orderByDescending((row) => row.id)
      .takeWhile((row) => row.city !== 'London')
      .toArray();

    expect(rows).toEqual([]);
  });

  it('binds a value from the parameter bag', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .takeWhile((row, args) => row.age < args.limit, { limit: 42 })
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('counts what it kept', async () => {
    const total = await db.people
      .orderBy((row) => row.id)
      .takeWhile((row) => row.age < 42)
      .count();

    expect(total).toBe(1);
  });

  it('resumes at the first failure and keeps the rest', async () => {
    // By id the ages run 36, 45, 41. Under `age < 42` the middle row is the
    // first failure, so it and everything behind it are kept.
    const rows = await db.people
      .orderBy((row) => row.id)
      .skipWhile((row) => row.age < 42)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);
  });

  it('partitions the sequence with takeWhile, losing nothing', async () => {
    const ordered = () => db.people.orderBy((row) => row.id);

    const taken = await ordered()
      .takeWhile((row) => row.age < 42)
      .toArray();
    const skipped = await ordered()
      .skipWhile((row) => row.age < 42)
      .toArray();
    const all = await ordered().toArray();

    expect([...taken, ...skipped].map((row) => row.id)).toEqual(all.map((row) => row.id));
  });

  it('keeps nothing when no row fails', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .skipWhile((row) => row.age > 30)
      .toArray();

    expect(rows).toEqual([]);
  });

  it('keeps everything when the first row fails', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .skipWhile((row) => row.age > 40)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('resumes on a predicate that is null rather than true', async () => {
    // Alan has no city, so the comparison is unknown, which is not a pass, and
    // the sequence resumes at him.
    const rows = await db.people
      .orderByDescending((row) => row.id)
      .skipWhile((row) => row.city !== 'London')
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Alan', 'Grace', 'Ada']);
  });

  it('pages what it kept', async () => {
    const rows = await db.people
      .orderBy((row) => row.id)
      .skipWhile((row) => row.age < 42)
      .take(1)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('keeps an outer row that matches nothing, where an inner join drops it', async () => {
    // Alan has no visits at all, which is the whole difference between the two.
    const shape = (source: typeof db.people) =>
      source.leftJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      );

    const outer = await shape(db.people)
      .orderBy((row) => row.who)
      .toArray();

    const inner = await db.people
      .join(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .orderBy((row) => row.who)
      .toArray();

    expect(outer).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
      { who: 'Alan', city: null },
      { who: 'Grace', city: 'Lisbon' },
    ]);
    expect(inner.map((row) => row.who)).toEqual(['Ada', 'Ada', 'Grace']);
  });

  it('reads the missing side as null rather than dropping the row', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Alan')
      .leftJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    expect(rows).toEqual([{ who: 'Alan', city: null }]);
  });

  it('counts the outer rows, unmatched ones included', async () => {
    const total = await db.people
      .leftJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .count();

    // Ada twice, Grace once, Alan once with nothing on the right.
    expect(total).toBe(4);
  });

  it('collapses back to an inner join when the joined side is filtered afterwards', async () => {
    // The documented trap: a null fails every comparison, so filtering on a
    // column of the joined side discards the very rows the join kept.
    const rows = await db.people
      .leftJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .where((row) => row.city !== 'Rome')
      .orderBy((row) => row.who)
      .toArray();

    expect(rows.map((row) => row.who)).toEqual(['Ada', 'Grace']);
  });

  it('keeps the unmatched row when the joined query is filtered instead', async () => {
    // The same intent expressed so the filter runs before the match.
    const rows = await db.people
      .leftJoin(
        db.visits.where((visit) => visit.city !== 'Rome'),
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .orderBy((row) => row.who)
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Alan', city: null },
      { who: 'Grace', city: 'Lisbon' },
    ]);
  });

  it('groups over a left join, counting the matches each row has', async () => {
    const rows = await db.people
      .leftJoin(
        db.visits,
        (person) => person.id,
        (visit) => visit.personId,
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .groupBy(
        (row) => row.who,
        (who, matches) => ({ who, trips: matches.count() }),
      )
      .orderBy((row) => row.who)
      .toArray();

    // Alan's null still counts as a row, which is what COUNT(*) means here.
    expect(rows.map((row) => [row.who, Number(row.trips)])).toEqual([
      ['Ada', 2],
      ['Alan', 1],
      ['Grace', 1],
    ]);
  });

  it('filters on a column of the referenced row', async () => {
    const rows = await db.visits
      .where((visit) => visit.person.name === 'Ada')
      .orderBy((visit) => visit.city)
      .toArray();

    expect(rows.map((row) => row.city)).toEqual(['Paris', 'Rome']);
  });

  it('projects a column of the referenced row', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .select((visit) => ({ who: visit.person.name, city: visit.city }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
      { who: 'Grace', city: 'Lisbon' },
    ]);
  });

  it('follows one reference once however often a clause reads it', async () => {
    const rows = await db.visits
      .where((visit) => visit.person.name === 'Ada' && visit.person.age === 36)
      .toArray();

    expect(rows).toHaveLength(2);
  });

  it('orders by a column of the referenced row', async () => {
    const rows = await db.visits
      .orderByDescending((visit) => visit.person.age)
      .thenBy((visit) => visit.city)
      .select((visit) => ({ who: visit.person.name, city: visit.city }))
      .toArray();

    // Grace is 45 and Ada 36, so Grace's visit comes first.
    expect(rows.map((row) => row.city)).toEqual(['Lisbon', 'Paris', 'Rome']);
  });

  it('groups by a column of the referenced row', async () => {
    const rows = await db.visits
      .groupBy(
        (visit) => visit.person.name,
        (who, visits) => ({ who, trips: visits.count() }),
      )
      .orderBy((row) => row.who)
      .toArray();

    expect(rows.map((row) => [row.who, Number(row.trips)])).toEqual([
      ['Ada', 2],
      ['Grace', 1],
    ]);
  });

  it('numbers the day of the week the way JavaScript does', async () => {
    // Ada joined on a Monday, Grace and Alan on Sundays.
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, day: person.joinedAt.getDay() }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', day: 1 },
      { who: 'Grace', day: 0 },
      { who: 'Alan', day: 0 },
    ]);
  });

  it('agrees with the Date the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ fromSql: person.joinedAt.getDay(), value: person.joinedAt }))
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.value.getDay());
    }
  });

  it('filters on a day of the week', async () => {
    const rows = await db.people
      .where((person) => person.joinedAt.getDay() === 0)
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);
  });

  it('returns a sign for each row, zero where the values match', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select(
        (person, args) => ({
          who: person.name,
          order: person.name.localeCompare(args.pivot),
        }),
        { pivot: 'Grace' },
      )
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', order: -1 },
      { who: 'Grace', order: 0 },
      { who: 'Alan', order: -1 },
    ]);
  });

  it('agrees with JavaScript for these names under this database collation', async () => {
    // Whether the two agree is a property of the collation, not of the
    // translation. They do for ASCII names under a language-aware collation,
    // and would not under a byte-ordered `C` one.
    const rows = await db.people
      .orderBy((person) => person.id)
      .select(
        (person, args) => ({
          who: person.name,
          order: person.name.localeCompare(args.pivot),
        }),
        { pivot: 'Grace' },
      )
      .toArray();

    for (const row of rows) {
      expect(row.order).toBe(Math.sign(row.who.localeCompare('Grace')));
    }
  });

  it('filters on the sign of the comparison', async () => {
    const rows = await db.people
      .where((person, args) => person.name.localeCompare(args.pivot) > 0, { pivot: 'B' })
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('reads an array element, counting from zero as JavaScript does', async () => {
    // Ada has three tags, Grace one, Alan none.
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, first: person.tags.at(0) }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', first: 'maths' },
      { who: 'Grace', first: 'navy' },
      { who: 'Alan', first: null },
    ]);
  });

  it('counts back from the end for a negative index', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, last: person.tags.at(-1) }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', last: 'poetry' },
      { who: 'Grace', last: 'navy' },
      { who: 'Alan', last: null },
    ]);
  });

  it('agrees with the array the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ fromSql: person.tags.at(args.n), all: person.tags }), { n: 1 })
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.all.at(1) ?? null);
    }
  });

  it('reads past either end as null', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person) => ({ past: person.tags.at(5), before: person.tags.at(-5) }))
      .toArray();

    expect(rows).toEqual([{ past: null, before: null }]);
  });

  it('filters on an element', async () => {
    const rows = await db.people
      .where((person, args) => person.tags.at(0) === args.tag, { tag: 'navy' })
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('returns an array column as an array', async () => {
    const ada = await db.people.where((person) => person.name === 'Ada').single();
    expect(ada.tags).toEqual(['maths', 'logic', 'poetry']);
  });

  it('flattens a collection, multiplying rows rather than preserving them', async () => {
    // Paris has two notes, Rome one, Lisbon none.
    const rows = await db.visits
      .selectMany(
        (visit) => visit.notes,
        (visit, note) => ({ city: visit.city, body: note.body }),
      )
      .orderBy((row) => row.body)
      .toArray();

    expect(rows).toEqual([
      { city: 'Paris', body: 'louvre' },
      { city: 'Paris', body: 'seine' },
      { city: 'Lisbon', body: 'tram' },
    ]);
  });

  it('drops a row with nothing to flatten, unlike leftJoin', async () => {
    const flattened = await db.visits
      .selectMany(
        (visit) => visit.notes,
        (visit) => visit.city,
      )
      .toArray();
    const all = await db.visits.select((visit) => visit.city).toArray();

    // Rome has no notes at all, so it survives one and not the other.
    expect(new Set(flattened)).toEqual(new Set(['Paris', 'Lisbon']));
    expect(new Set(all)).toEqual(new Set(['Paris', 'Rome', 'Lisbon']));
  });

  it('filters the flattened rows', async () => {
    const rows = await db.visits
      .selectMany(
        (visit) => visit.notes,
        (visit, note) => ({ city: visit.city, body: note.body }),
      )
      .where((row) => row.city === 'Paris')
      .orderBy((row) => row.body)
      .toArray();

    expect(rows.map((row) => row.body)).toEqual(['louvre', 'seine']);
  });

  it('counts what the flattening produced', async () => {
    const total = await db.visits
      .selectMany(
        (visit) => visit.notes,
        (visit, note) => ({ city: visit.city, body: note.body }),
      )
      .count();

    expect(total).toBe(3);
  });

  it('pairs every row with every row of another query', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .selectMany(db.visits, (person, visit) => ({ who: person.name, city: visit.city }))
      .orderBy((row) => row.city)
      .toArray();

    // One person against all three visits, regardless of who they belong to.
    expect(rows).toEqual([
      { who: 'Ada', city: 'Lisbon' },
      { who: 'Ada', city: 'Paris' },
      { who: 'Ada', city: 'Rome' },
    ]);
  });

  it('flattens what a page of the source left', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .take(1)
      .selectMany(
        (visit) => visit.notes,
        (visit, note) => ({ city: visit.city, body: note.body }),
      )
      .orderBy((row) => row.body)
      .toArray();

    // Only the first visit is paged in, and both of its notes come with it.
    expect(rows).toEqual([
      { city: 'Paris', body: 'louvre' },
      { city: 'Paris', body: 'seine' },
    ]);
  });

  it('agrees with JavaScript for the code points of a name', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select(
        (person, args) => ({
          who: person.name,
          first: person.name.codePointAt(args.zero),
          second: person.name.codePointAt(args.one),
        }),
        { zero: 0, one: 1 },
      )
      .toArray();

    for (const row of rows) {
      expect(row.first).toBe(row.who.codePointAt(0));
      expect(row.second).toBe(row.who.codePointAt(1));
    }
  });

  it('reads past the end as null, not as zero', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ past: person.name.codePointAt(99) }))
      .toArray();

    // `ASCII('')` would be 0, which is a code point and would read as a real
    // answer. JavaScript returns undefined here, so null is the honest one.
    expect(rows).toEqual([{ past: null }]);
  });

  it('reads a negative index as null', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ before: person.name.codePointAt(-1) }))
      .toArray();

    expect(rows).toEqual([{ before: null }]);
  });

  it('filters on a code point', async () => {
    const rows = await db.people
      .where((person, args) => person.name.codePointAt(args.zero) === args.code, {
        zero: 0,
        code: 'A'.codePointAt(0),
      })
      .orderBy((person) => person.name)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan']);
  });

  it('returns a string with the trailing zeros kept', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ who: person.name, age: person.age.toFixed(args.digits) }), {
        digits: 2,
      })
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', age: '36.00' },
      { who: 'Grace', age: '45.00' },
      { who: 'Alan', age: '41.00' },
    ]);
  });

  it('agrees with JavaScript on a value that has no binary surprise', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ age: person.age, fixed: person.age.toFixed(args.digits) }), {
        digits: 1,
      })
      .toArray();

    for (const row of rows) {
      expect(row.fixed).toBe(row.age.toFixed(1));
    }
  });

  it('rounds a half up, where JavaScript rounds the double beneath it', async () => {
    // The documented divergence, pinned rather than papered over. `numeric` is
    // exact decimal, so 1.005 rounds to 1.01; JavaScript sees 1.00499… and
    // answers 1.00.
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((_person, args) => ({ fixed: args.value.toFixed(args.digits) }), {
        value: 1.005,
        digits: 2,
      })
      .toArray();

    expect(rows).toEqual([{ fixed: '1.01' }]);
    expect((1.005).toFixed(2)).toBe('1.00');
  });

  it('drops the decimal point entirely at zero digits', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({ age: person.age.toFixed() }))
      .toArray();

    expect(rows).toEqual([{ age: '36' }]);
  });

  it('pairs by position rather than by any key the rows share', async () => {
    // People are Ada 1, Grace 2, Alan 3; visits are Paris 1, Rome 2, Lisbon 3.
    // By id the pairs are Ada/Paris, Grace/Rome, Alan/Lisbon, which is not how
    // they are actually related: Lisbon belongs to Grace, and Alan has none.
    const rows = await db.people
      .orderBy((person) => person.id)
      .zip(
        db.visits.orderBy((visit) => visit.id),
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', city: 'Paris' },
      { who: 'Grace', city: 'Rome' },
      { who: 'Alan', city: 'Lisbon' },
    ]);
  });

  it('stops when this side runs out first', async () => {
    // Two people against three visits: the third visit pairs with nothing.
    const rows = await db.people
      .where((person) => person.age > 40)
      .orderBy((person) => person.id)
      .zip(
        db.visits.orderBy((visit) => visit.id),
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    expect(rows).toEqual([
      { who: 'Grace', city: 'Paris' },
      { who: 'Alan', city: 'Rome' },
    ]);
  });

  it('drops the rows the shorter side never reaches', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .zip(
        db.visits.where((visit) => visit.city === 'Paris').orderBy((visit) => visit.id),
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    // One visit left, so only the first person is paired at all.
    expect(rows).toEqual([{ who: 'Ada', city: 'Paris' }]);
  });

  it('follows the ordering each side was given', async () => {
    const rows = await db.people
      .orderByDescending((person) => person.id)
      .zip(
        db.visits.orderBy((visit) => visit.id),
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .toArray();

    // People reversed, visits not, so the pairing changes with the ordering.
    expect(rows).toEqual([
      { who: 'Alan', city: 'Paris' },
      { who: 'Grace', city: 'Rome' },
      { who: 'Ada', city: 'Lisbon' },
    ]);
  });

  it('counts the pairs it produced', async () => {
    const total = await db.people
      .orderBy((person) => person.id)
      .zip(
        db.visits.where((visit) => visit.city === 'Paris').orderBy((visit) => visit.id),
        (person, visit) => ({ who: person.name, city: visit.city }),
      )
      .count();

    expect(total).toBe(1);
  });

  it('replaces every occurrence, as JavaScript does', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select(
        (person, args) => ({
          who: person.name,
          masked: person.name.replaceAll(args.from, args.to),
        }),
        { from: 'a', to: 'X' },
      )
      .toArray();

    for (const row of rows) {
      expect(row.masked).toBe(row.who.replaceAll('a', 'X'));
    }
    // Grace has two occurrences, which is what tells the two operators apart.
    expect(rows.map((row) => row.masked)).toEqual(['AdX', 'GrXce', 'AlXn']);
  });

  it('differs from replacing only the first, which is why replace is refused', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Grace')
      .select((person, args) => ({ all: person.name.replaceAll(args.from, args.to) }), {
        from: 'a',
        to: 'X',
      })
      .toArray();

    expect(rows).toEqual([{ all: 'GrXce' }]);
    // What `replace` would have meant, and what the old translation returned
    // for it regardless.
    expect('Grace'.replace('a', 'X')).toBe('GrXce');
    expect('Banana'.replace('a', 'X')).not.toBe('Banana'.replaceAll('a', 'X'));
  });

  it('replaces with an empty string', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person, args) => ({ stripped: person.name.replaceAll(args.from, args.to) }), {
        from: 'a',
        to: '',
      })
      .toArray();

    expect(rows).toEqual([{ stripped: 'Ad' }]);
  });

  it('keeps the first row of each key in this order', async () => {
    // Visits 1 and 2 both belong to Ada, so one of them has to go, and the
    // ordering says which.
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => visit.personId)
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([1, 3]);
  });

  it('keeps the last of each key when the order is reversed', async () => {
    const rows = await db.visits
      .orderByDescending((visit) => visit.id)
      .distinctBy((visit) => visit.personId)
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([3, 2]);
  });

  it('compares only the key, unlike distinct', async () => {
    // Every person differs in some column, so `distinct` keeps all three. Two
    // of them are over forty, so the key keeps two.
    const whole = await db.people.distinct().count();
    const byKey = await db.people
      .orderBy((person) => person.id)
      .distinctBy((person) => person.age > 40)
      .toArray();

    expect(whole).toBe(3);
    expect(byKey.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('takes an object key, matching on every property of it', async () => {
    // Ada's two visits share a person but not a city, so nothing collides.
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => ({ person: visit.personId, city: visit.city }))
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it('follows a navigation in the key', async () => {
    // Ada's two visits both key on London, so the second is dropped.
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => visit.person.city)
      .toArray();

    expect(rows.map((row) => row.id)).toEqual([1, 3]);
  });

  it('treats null as a key of its own, matching other nulls', async () => {
    // Grace has one tag and Alan none, so a second tag is null for both, and
    // they share that key even though `null = null` is not true in SQL.
    const rows = await db.people
      .orderBy((person) => person.id)
      .distinctBy((person) => person.tags.at(1))
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('filters and pages what survived', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => visit.personId)
      .where((visit) => visit.city !== 'Paris')
      .toArray();

    // Visit 2 is Ada's other one, already dropped for sharing her key, so
    // filtering Paris away does not bring it back.
    expect(rows.map((row) => row.id)).toEqual([3]);

    const first = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => visit.personId)
      .take(1)
      .toArray();

    expect(first.map((row) => row.id)).toEqual([1]);
  });

  it('counts what survived', async () => {
    const total = await db.visits
      .orderBy((visit) => visit.id)
      .distinctBy((visit) => visit.personId)
      .count();

    expect(total).toBe(2);
  });

  it('reports the same position JavaScript does', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ who: person.name, at: person.name.indexOf(args.needle) }), {
        needle: 'a',
      })
      .toArray();

    for (const row of rows) {
      expect(row.at).toBe(row.who.indexOf('a'));
    }
    expect(rows.map((row) => row.at)).toEqual([2, 2, 2]);
  });

  it('answers -1 for a substring that is not there', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ who: person.name, at: person.name.indexOf(args.needle) }), {
        needle: 'an',
      })
      .toArray();

    // Only Alan contains it, and the two that do not answer -1 rather than the
    // zero POSITION would have given.
    expect(rows).toEqual([
      { who: 'Ada', at: -1 },
      { who: 'Grace', at: -1 },
      { who: 'Alan', at: 2 },
    ]);
    expect('Ada'.indexOf('an')).toBe(-1);
  });

  it('finds the empty string at the front, as JavaScript does', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person, args) => ({ at: person.name.indexOf(args.needle) }), { needle: '' })
      .toArray();

    expect(rows).toEqual([{ at: 'Ada'.indexOf('') }]);
    expect(rows).toEqual([{ at: 0 }]);
  });

  it('filters on a position', async () => {
    const rows = await db.people
      .where((person, args) => person.name.indexOf(args.needle) === 3, { needle: 'c' })
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('yields null for a null column rather than a position', async () => {
    // JavaScript has no answer to compare against here: reading `indexOf` off a
    // null would throw. SQL propagates the null instead, as it does everywhere.
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person, args) => ({ who: person.name, at: person.city!.indexOf(args.needle) }), {
        needle: 'o',
      })
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', at: 1 },
      { who: 'Grace', at: 5 },
      { who: 'Alan', at: null },
    ]);
  });

  it('numbers the rows from zero over the ordering', async () => {
    const rows = await db.people
      .orderBy((person) => person.joinedAt)
      .index((person, position) => ({ who: person.name, position }))
      .toArray();

    // `ROW_NUMBER` counts from one and LINQ's `Index` from zero, so a bare
    // window would have shifted every row by one.
    expect(rows).toEqual([
      { who: 'Ada', position: 0 },
      { who: 'Grace', position: 1 },
      { who: 'Alan', position: 2 },
    ]);
  });

  it('numbers from the other end when the ordering is reversed', async () => {
    const rows = await db.people
      .orderBy((person) => person.joinedAt)
      .reverse()
      .index((person, position) => ({ who: person.name, position }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Alan', position: 0 },
      { who: 'Grace', position: 1 },
      { who: 'Ada', position: 2 },
    ]);
  });

  it('filters on a position the database computed', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .index((person, position) => ({ who: person.name, position }))
      .where((row) => row.position > 0)
      .toArray();

    // A window cannot sit in a WHERE, so this is the derived table paying off:
    // the number is an ordinary column by the time the filter reads it.
    expect(rows).toEqual([
      { who: 'Alan', position: 1 },
      { who: 'Grace', position: 2 },
    ]);
  });

  it('projects the position alone', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .index((_person, position) => position)
      .toArray();

    expect(rows).toEqual([0, 1, 2]);
  });

  it('numbers the rows a filter left rather than the rows behind them', async () => {
    const rows = await db.people
      .where((person) => person.age > 36)
      .orderBy((person) => person.age)
      .index((person, position) => ({ who: person.name, position }))
      .toArray();

    // Ada is filtered out before the numbering, so Alan is row zero.
    expect(rows).toEqual([
      { who: 'Alan', position: 0 },
      { who: 'Grace', position: 1 },
    ]);
  });

  it('returns the rows in the opposite order', async () => {
    const forwards = await db.people.orderBy((person) => person.id).toArray();
    const backwards = await db.people
      .orderBy((person) => person.id)
      .reverse()
      .toArray();

    expect(backwards.map((row) => row.name)).toEqual(['Alan', 'Grace', 'Ada']);
    expect(backwards.map((row) => row.name)).toEqual(forwards.map((row) => row.name).reverse());
  });

  it('reaches the end of a sequence, which paging cannot', async () => {
    const newest = await db.people
      .orderBy((person) => person.joinedAt)
      .reverse()
      .take(2)
      .toArray();

    expect(newest.map((row) => row.name)).toEqual(['Alan', 'Grace']);

    const last = await db.people
      .orderBy((person) => person.joinedAt)
      .reverse()
      .first();

    expect(last.name).toBe('Alan');
  });

  it('returns the last rows in the order they were already in', async () => {
    const rows = await db.people
      .orderBy((person) => person.joinedAt)
      .takeLast(2)
      .toArray();

    // The same two rows `reverse().take(2)` reaches, the other way round, which
    // is the whole of the difference between the two.
    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);

    const backwards = await db.people
      .orderBy((person) => person.joinedAt)
      .reverse()
      .take(2)
      .toArray();

    expect(backwards.map((row) => row.name)).toEqual(['Alan', 'Grace']);
  });

  it('returns everything when the count runs past the start', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .takeLast(10)
      .toArray();

    expect(rows.map((row) => row.age)).toEqual([36, 41, 45]);
  });

  it('returns nothing for a count of none', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .takeLast(0)
      .toArray();

    expect(rows).toEqual([]);
  });

  it('takes from the end of a sort key it never selected', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.person.name)
      .thenBy((visit) => visit.id)
      .takeLast(2)
      .toArray();

    // Ordered by Ada, Ada, Grace, so the last two are the second Ada and Grace,
    // and the key comes out of a join the answer does not carry.
    //
    // The second key is what makes that a fact rather than a coincidence: Ada's
    // two visits tie on the name, and which of them the flipped order reaches
    // first is SQL's to decide, so without a tie-break either one is a correct
    // answer to "the last two".
    expect(rows.map((row) => row.id)).toEqual([2, 3]);
  });

  it('takes from the end of the rows a filter left', async () => {
    const rows = await db.people
      .where((person) => person.age > 36)
      .orderBy((person) => person.age)
      .takeLast(1)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('narrows the rows it kept when a filter follows it', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .takeLast(2)
      .where((person) => person.city !== null)
      .toArray();

    // The last two by age are Alan and Grace; only Grace has a city. A filter
    // applied before the limit would have answered Ada and Grace instead.
    expect(rows.map((row) => row.name)).toEqual(['Grace']);
  });

  it('counts the rows it kept', async () => {
    const total = await db.people
      .orderBy((person) => person.age)
      .takeLast(2)
      .count();

    expect(total).toBe(2);
  });

  it('drops the last rows and keeps the order of the rest', async () => {
    const rows = await db.people
      .orderBy((person) => person.joinedAt)
      .skipLast(1)
      .toArray();

    // Alan joined last, so he is the row dropped, and the two left arrive in
    // the order they were already in.
    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Grace']);
  });

  it('partitions the sequence with takeLast', async () => {
    const ordered = db.people.orderBy((person) => person.joinedAt);

    const kept = await ordered.skipLast(2).toArray();
    const dropped = await ordered.takeLast(2).toArray();

    // Between them they account for every row exactly once, which is what makes
    // them complements rather than two operators that look alike.
    expect([...kept, ...dropped].map((row) => row.name)).toEqual(['Ada', 'Grace', 'Alan']);
  });

  it('keeps everything for a count of none', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .skipLast(0)
      .toArray();

    expect(rows.map((row) => row.age)).toEqual([36, 41, 45]);
  });

  it('returns nothing when the count reaches past the start', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .skipLast(10)
      .toArray();

    expect(rows).toEqual([]);
  });

  it('drops from the end of a sort key it never selected', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.person.name)
      .skipLast(1)
      .toArray();

    // Ordered by Ada, Ada, Grace, so Grace's visit is the one dropped and the
    // key comes out of a join the answer does not carry.
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it('narrows the rows it kept when a filter follows it', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .skipLast(1)
      .where((person) => person.city !== null)
      .toArray();

    // The oldest is dropped first, leaving Ada and Alan; only Ada has a city.
    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('is the query it started as when applied twice', async () => {
    const rows = await db.people
      .orderBy((person) => person.age)
      .reverse()
      .reverse()
      .toArray();

    expect(rows.map((row) => row.age)).toEqual([36, 41, 45]);
  });

  it('swaps which row of each key distinctBy keeps', async () => {
    const rows = await db.visits
      .orderBy((visit) => visit.id)
      .reverse()
      .distinctBy((visit) => visit.personId)
      .toArray();

    // Forwards this keeps visits 1 and 3; reversed it keeps the last of each
    // person instead, and returns them in the reversed order.
    expect(rows.map((row) => row.id)).toEqual([3, 2]);
  });

  it('reports the day of the month the column holds', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, day: person.joinedAt.getDate() }))
      .toArray();

    // The seed dates are the 15th, the 30th, and the 1st. Both JavaScript and
    // EXTRACT number the month from one, so these are the dates as written.
    expect(rows).toEqual([
      { who: 'Ada', day: 15 },
      { who: 'Grace', day: 30 },
      { who: 'Alan', day: 1 },
    ]);
  });

  it('filters on a day of the month', async () => {
    const rows = await db.people.where((person) => person.joinedAt.getDate() === 1).toArray();

    expect(rows.map((row) => row.name)).toEqual(['Alan']);
  });

  it('answers a day of the month apart from a day of the week', async () => {
    const rows = await db.people
      .where((person) => person.name === 'Ada')
      .select((person) => ({
        date: person.joinedAt.getDate(),
        day: person.joinedAt.getDay(),
      }))
      .toArray();

    // 2024-01-15 is the 15th of the month and a Monday, which is the whole
    // point of the two methods being different fields.
    expect(rows).toEqual([{ date: 15, day: 1 }]);
  });

  it('reports the hour the column holds', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, hour: person.joinedAt.getHours() }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', hour: 9 },
      { who: 'Grace', hour: 14 },
      { who: 'Alan', hour: 23 },
    ]);
    // A number rather than the string numeric EXTRACT would have yielded.
    expect(typeof rows[0]?.hour).toBe('number');
  });

  it('agrees with the Date the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ fromSql: person.joinedAt.getHours(), value: person.joinedAt }))
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.value.getHours());
    }
  });

  it('filters on an hour of the day', async () => {
    const rows = await db.people
      .where((person) => person.joinedAt.getHours() >= 14)
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);
  });

  it('groups by the hour', async () => {
    const rows = await db.people
      .groupBy(
        (person) => person.joinedAt.getHours(),
        (hour, people) => ({ hour, joined: people.count() }),
      )
      .orderBy((row) => row.hour)
      .toArray();

    expect(rows.map((row) => [row.hour, Number(row.joined)])).toEqual([
      [9, 1],
      [14, 1],
      [23, 1],
    ]);
  });

  it('reports the minute the column holds', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, minute: person.joinedAt.getMinutes() }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', minute: 0 },
      { who: 'Grace', minute: 30 },
      { who: 'Alan', minute: 45 },
    ]);
    // A number rather than the string numeric EXTRACT would have yielded.
    expect(typeof rows[0]?.minute).toBe('number');
  });

  it('reads a year in UTC rather than in whatever zone the session is set to', async () => {
    await db.$transaction(async (tx) => {
      // `SET LOCAL` reaches the one connection the transaction pinned and is
      // undone with it, which is the only way to change the session zone here
      // without the change leaking to whatever the pool hands out next.
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ year: row.at.getFullYear() })).first();
      const utc = await tx.instants.select((row) => ({ year: row.at.getUTCFullYear() })).first();

      // One row, one instant, two answers. The column is half an hour into
      // 2025 in UTC and still the evening of the 31st in New York, so the
      // plain extraction reads the column the way the session does while
      // `getUTCFullYear` converts first and answers the year the instant is
      // actually in.
      expect(local.year).toBe(2024);
      expect(utc.year).toBe(2025);
    });
  });

  it('reads a UTC month, across both the zone and the zero-based numbering', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ month: row.at.getMonth() })).first();
      const utc = await tx.instants.select((row) => ({ month: row.at.getUTCMonth() })).first();

      // The instant is half an hour into January 2025 UTC and half past seven
      // on the evening of 31 December in New York, so the two disagree about
      // the month as well as the year. Both count from zero: 11 is December and
      // 0 is January, which is the second adjustment the translation makes and
      // the one a bare EXTRACT would have got wrong in the other direction.
      expect(local.month).toBe(11);
      expect(utc.month).toBe(0);
    });
  });

  it('gives the same UTC month whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ month: r.at.getUTCMonth() })).first();
        return row.month;
      });

    expect(await asked('America/New_York')).toBe(0);
    expect(await asked('UTC')).toBe(0);
    expect(await asked('Pacific/Auckland')).toBe(0);
  });

  it('gives the same UTC year whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ year: r.at.getUTCFullYear() })).first();
        return row.year;
      });

    // Three zones either side of the boundary. Being the same answer in all of
    // them is the whole claim: the conversion happens before the extraction, so
    // there is no zone left for the extraction to vary with.
    expect(await asked('America/New_York')).toBe(2025);
    expect(await asked('UTC')).toBe(2025);
    expect(await asked('Pacific/Auckland')).toBe(2025);
  });

  it('reads a day of the month in UTC rather than in the session zone', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ day: row.at.getDate() })).first();
      const utc = await tx.instants.select((row) => ({ day: row.at.getUTCDate() })).first();

      // Half an hour into the first of January in UTC and half past seven on
      // the evening of the thirty-first in New York. Both count the month from
      // one, so the gap here is the conversion and nothing else, which is what
      // separates this from `getUTCMonth` needing a subtraction as well.
      expect(local.day).toBe(31);
      expect(utc.day).toBe(1);
    });
  });

  it('gives the same UTC day whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ day: r.at.getUTCDate() })).first();
        return row.day;
      });

    // Three zones either side of the boundary, as the year and the month are
    // asked across. The day is the field this matters most for: an offset moves
    // the day boundary once a day where it moves the year boundary once a year,
    // so a session zone left to itself would misread a slice of any table.
    expect(await asked('America/New_York')).toBe(1);
    expect(await asked('UTC')).toBe(1);
    expect(await asked('Pacific/Auckland')).toBe(1);
  });

  it('reads an hour of the day in UTC rather than in the session zone', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ hour: row.at.getHours() })).first();
      const utc = await tx.instants.select((row) => ({ hour: row.at.getUTCHours() })).first();

      // Half an hour past midnight in UTC and half past seven in the evening in
      // New York. Both count the hour from zero, so the gap is the conversion
      // and nothing else, which is what makes this `getUTCDate`'s shape rather
      // than `getUTCMonth`'s.
      expect(local.hour).toBe(19);
      expect(utc.hour).toBe(0);
    });
  });

  it('gives the same UTC hour whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ hour: r.at.getUTCHours() })).first();
        return row.hour;
      });

    // The calendar fields are asked across three zones and agree because the
    // conversion happens before the extraction. The hour is where that claim is
    // widest: two of these zones disagree with UTC about the hour for every
    // instant there is, not only for the ones near a boundary.
    expect(await asked('America/New_York')).toBe(0);
    expect(await asked('UTC')).toBe(0);
    expect(await asked('Pacific/Auckland')).toBe(0);
  });

  it('reads the same UTC hour from a zone offset by half an hour', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ hour: r.at.getUTCHours() })).first();
        return row.hour;
      });

    // Kolkata is five and a half hours ahead and Kathmandu five and three
    // quarters, which is the case a translation assuming whole-hour offsets
    // would get wrong for entire zones rather than for an edge case. The
    // conversion makes no such assumption, so both still answer the UTC hour.
    expect(await asked('Asia/Kolkata')).toBe(0);
    expect(await asked('Asia/Kathmandu')).toBe(0);
  });
  it('reads a minute of the hour in UTC rather than in the session zone', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'Asia/Kolkata'`, values: [] });

      const local = await tx.instants.select((row) => ({ minute: row.at.getMinutes() })).first();
      const utc = await tx.instants.select((row) => ({ minute: row.at.getUTCMinutes() })).first();

      // Half an hour past midnight in UTC and six in the morning in Kolkata,
      // which is five and a half hours ahead. Both count the minute from zero,
      // so the gap is the conversion and nothing else.
      expect(local.minute).toBe(0);
      expect(utc.minute).toBe(30);
    });
  });

  it('reads the same minute either way in a zone a whole number of hours off UTC', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ minute: row.at.getMinutes() })).first();
      const utc = await tx.instants.select((row) => ({ minute: row.at.getUTCMinutes() })).first();

      // This is why the conversion looks unnecessary on a minute: New York is
      // five whole hours behind, so the two readings agree and a translation
      // that dropped the conversion would pass every test taken from here. The
      // test above is the one that finds it out.
      expect(local.minute).toBe(30);
      expect(utc.minute).toBe(30);
    });
  });

  it('gives the same UTC minute whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ minute: r.at.getUTCMinutes() })).first();
        return row.minute;
      });

    // The two fractional zones are the ones that make this claim worth testing.
    // Kolkata reads the minute as 0 and Kathmandu as 15 without the conversion,
    // so a whole zone rather than an edge case rides on it.
    expect(await asked('Asia/Kolkata')).toBe(30);
    expect(await asked('Asia/Kathmandu')).toBe(30);
    expect(await asked('America/New_York')).toBe(30);
    expect(await asked('UTC')).toBe(30);
  });

  it('comes back a whole number, the conversion having taken it off no cast', async () => {
    const rows = await db.instants.select((row) => ({ minute: row.at.getUTCMinutes() })).toArray();

    // EXTRACT yields numeric either side of the conversion, so the field stays
    // in the set PostgresDialect casts to int and the value arrives a number
    // rather than the string node-postgres would otherwise hand back.
    expect(rows.map((row) => row.minute)).toEqual([30]);
  });
  it('reads the same second as the session zone, every current offset being whole minutes', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants
          .select((r) => ({ plain: r.at.getSeconds(), utc: r.at.getUTCSeconds() }))
          .first();
        return row;
      });

    // This is the field where the argument that carried `getUTCMinutes` runs
    // out. Kolkata and Kathmandu read a different minute from UTC and the same
    // second, because every zone in use today is a whole number of minutes off
    // UTC. The conversion is not wrong here, it is merely invisible.
    expect(await asked('Asia/Kolkata')).toEqual({ plain: 0, utc: 0 });
    expect(await asked('Asia/Kathmandu')).toEqual({ plain: 0, utc: 0 });
    expect(await asked('Pacific/Chatham')).toEqual({ plain: 0, utc: 0 });
  });

  it('parts company with the session zone over an instant older than standard time', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const rows = await tx.$driver.execute({
          text: `SELECT FLOOR(EXTRACT(SECOND FROM $1 :: timestamptz)) :: int AS plain,
                        FLOOR(EXTRACT(SECOND FROM $1 :: timestamptz AT TIME ZONE 'UTC')) :: int AS utc`,
          values: ['1870-01-01 00:30:17+00'],
        });
        return rows[0] as { plain: number; utc: number };
      });

    // The surviving case for the conversion, and the reason it is translated at
    // all. PostgreSQL carries local mean time for instants before a zone
    // adopted standard time, and those offsets are seconds rather than whole
    // minutes: Amsterdam, Dublin, New York, and Kolkata each read a different
    // second from this one instant. Every one of them reads 17 in UTC, which is
    // what JavaScript's own getUTCSeconds answers for it.
    expect(new Date('1870-01-01T00:30:17Z').getUTCSeconds()).toBe(17);

    expect(await asked('Europe/Amsterdam')).toEqual({ plain: 47, utc: 17 });
    expect(await asked('Europe/Dublin')).toEqual({ plain: 56, utc: 17 });
    expect(await asked('America/New_York')).toEqual({ plain: 15, utc: 17 });
    expect(await asked('Asia/Kolkata')).toEqual({ plain: 27, utc: 17 });
  });

  it('drops the fraction rather than rounding it, as getSeconds does', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, second: person.joinedAt.getSeconds() }))
      .toArray();

    // The seeded rows carry .0, .5, and .75 of a second. The UTC spelling wraps
    // the same FLOOR, so 59.75 reads as 59 through either one and never as the
    // sixtieth second a bare cast would give.
    expect(rows.map((row) => row.second)).toEqual([0, 7, 59]);
  });
  it('reads a day of the week in UTC rather than in the session zone', async () => {
    await db.$transaction(async (tx) => {
      await tx.$driver.execute({ text: `SET LOCAL TIME ZONE 'America/New_York'`, values: [] });

      const local = await tx.instants.select((row) => ({ day: row.at.getDay() })).first();
      const utc = await tx.instants.select((row) => ({ day: row.at.getUTCDay() })).first();

      // The instant is half an hour into Wednesday 1 January in UTC and still
      // Tuesday evening in New York. A weekday looked too coarse for the
      // conversion to reach and is not: it inherits the day of the month's
      // answer, because it is the date boundary that a session offset moves.
      expect(local.day).toBe(2);
      expect(utc.day).toBe(3);
    });
  });

  it('gives the same UTC weekday whatever the session zone is', async () => {
    const asked = async (zone: string) =>
      db.$transaction(async (tx) => {
        await tx.$driver.execute({ text: `SET LOCAL TIME ZONE '${zone}'`, values: [] });
        const row = await tx.instants.select((r) => ({ day: r.at.getUTCDay() })).first();
        return row.day;
      });

    // Three zones either side of the boundary, as the year, month, and day are
    // asked across. All three read Wednesday because the conversion happens
    // before the extraction.
    expect(await asked('America/New_York')).toBe(3);
    expect(await asked('UTC')).toBe(3);
    expect(await asked('Pacific/Auckland')).toBe(3);
  });

  it('numbers the week from Sunday, as JavaScript does and ISODOW does not', async () => {
    // The whole of why no adjustment is needed, measured against the language
    // rather than assumed: DOW and getUTCDay both call Sunday zero. ISODOW,
    // the field next to it, calls Sunday seven and would have been wrong for
    // one day in seven.
    const pool = (db.$driver as PostgresDriver).connectionPool;
    const { rows } = await pool.query<{ day: string; dow: string; isodow: string }>(
      `SELECT d::date::text AS day,
              EXTRACT(DOW FROM d AT TIME ZONE 'UTC') :: int :: text AS dow,
              EXTRACT(ISODOW FROM d AT TIME ZONE 'UTC') :: int :: text AS isodow
         FROM generate_series('2025-01-05'::timestamptz, '2025-01-11'::timestamptz,
                              '1 day') AS d`,
    );

    for (const row of rows) {
      const expected = new Date(row.day + 'T00:00:00Z').getUTCDay();
      expect(Number(row.dow)).toBe(expected);
    }
    expect(rows[0]?.dow).toBe('0');
    expect(rows[0]?.isodow).toBe('7');
  });

  it('stays a different field from the day of the month', async () => {
    const row = await db.instants
      .select((r) => ({ weekday: r.at.getUTCDay(), monthday: r.at.getUTCDate() }))
      .first();

    // One letter apart in JavaScript and two `EXTRACT` fields here, which is
    // `getDate` against `getDay` arriving a second time. Wednesday the first.
    expect(row).toEqual({ weekday: 3, monthday: 1 });
  });

  it('carries no fraction, where an extracted second would', async () => {
    // The whole reason `getSeconds` is not this translation: PostgreSQL types
    // EXTRACT as numeric, and MINUTE fills it with a whole number while SECOND
    // would not. Measured rather than assumed from the neighbouring case.
    const pool = (db.$driver as PostgresDriver).connectionPool;
    const { rows } = await pool.query<{ minute: string; second: string }>(
      `SELECT EXTRACT(MINUTE FROM joined_at) AS minute, EXTRACT(SECOND FROM joined_at) AS second
         FROM people WHERE id = 2`,
    );

    expect(rows[0]?.minute).toBe('30');
    expect(rows[0]?.second).toContain('.');
  });

  it('agrees with the Date the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ fromSql: person.joinedAt.getMinutes(), value: person.joinedAt }))
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.value.getMinutes());
    }
  });

  it('filters on a minute of the hour', async () => {
    const rows = await db.people
      .where((person) => person.joinedAt.getMinutes() >= 30)
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Grace', 'Alan']);
  });

  it('reads an hour and a minute from the same column', async () => {
    const rows = await db.people
      .where((person) => person.id === 2)
      .select((person) => ({
        hour: person.joinedAt.getHours(),
        minute: person.joinedAt.getMinutes(),
      }))
      .toArray();

    expect(rows).toEqual([{ hour: 14, minute: 30 }]);
  });

  it('reports the second the column holds, with the fraction dropped', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ who: person.name, second: person.joinedAt.getSeconds() }))
      .toArray();

    expect(rows).toEqual([
      { who: 'Ada', second: 0 },
      { who: 'Grace', second: 7 },
      { who: 'Alan', second: 59 },
    ]);
    // A number rather than the string numeric EXTRACT would have yielded.
    expect(typeof rows[0]?.second).toBe('number');
  });

  it('floors the fraction rather than rounding it', async () => {
    // Alan joined at 23:45:59.75. `EXTRACT(SECOND ...) :: int` alone rounds
    // that to 60, a second no clock shows and one no `getSeconds` returns.
    // This is the row the FLOOR exists for.
    const pool = (db.$driver as PostgresDriver).connectionPool;
    const { rows } = await pool.query<{ rounded: number }>(
      'SELECT EXTRACT(SECOND FROM joined_at) :: int AS rounded FROM people WHERE id = 3',
    );

    expect(rows[0]?.rounded).toBe(60);

    const floored = await db.people
      .where((person) => person.id === 3)
      .select((person) => ({ second: person.joinedAt.getSeconds() }))
      .toArray();

    expect(floored).toEqual([{ second: 59 }]);
  });

  it('agrees with the Date the driver returns for the same column', async () => {
    const rows = await db.people
      .orderBy((person) => person.id)
      .select((person) => ({ fromSql: person.joinedAt.getSeconds(), value: person.joinedAt }))
      .toArray();

    for (const row of rows) {
      expect(row.fromSql).toBe(row.value.getSeconds());
    }
  });

  it('filters on a second of the minute', async () => {
    const rows = await db.people
      .where((person) => person.joinedAt.getSeconds() === 0)
      .orderBy((person) => person.id)
      .toArray();

    expect(rows.map((row) => row.name)).toEqual(['Ada']);
  });

  it('averages a column to one number', async () => {
    // 36, 45 and 41.
    await expect(db.people.average((person) => person.age)).resolves.toBeCloseTo(40.6667, 4);
  });

  it('hands back a number, not the string numeric AVG arrives as', async () => {
    const mean = await db.people.average((person) => person.age);

    // PostgreSQL types AVG over an int as numeric and node-postgres returns
    // numeric as a string. The terminal normalises it the way count does.
    expect(typeof mean).toBe('number');
  });

  it('averages only the rows that survive a filter', async () => {
    await expect(
      db.people.where((person) => person.age >= 41).average((person) => person.age),
    ).resolves.toBe(43);
  });

  it('averages the rows paging kept rather than all of them', async () => {
    const mean = await db.people
      .orderBy((person) => person.id)
      .take(2)
      .average((person) => person.age);

    // Ada and Grace, not all three. The aggregate sits outside the paged query
    // so LIMIT applies to the rows going into it.
    expect(mean).toBe(40.5);
  });

  it('averages across a navigation', async () => {
    // Two visits belong to Ada at 36 and one to Grace at 45.
    await expect(db.visits.average((visit) => visit.person.age)).resolves.toBe(39);
  });

  it('averages a computed value', async () => {
    await expect(db.people.average((person) => person.age * 2)).resolves.toBeCloseTo(81.3333, 4);
  });

  it('faults an empty query rather than answering zero', async () => {
    await expect(
      db.people.where((person) => person.age > 100).average((person) => person.age),
    ).rejects.toThrow(SequenceError);
  });

  it('separates every value being null from there being no rows', async () => {
    // Alan is the one person with no city, so this averages one null value over
    // one row. AVG answers null for that and for an empty query alike, which is
    // what the COUNT(*) alongside it is there to tell apart.
    await expect(
      db.people
        .where((person) => person.id === 3)
        .average((person) => (person.city as string).length),
    ).rejects.toThrow(/Every row the query returned had a null value/);
  });

  it('adds a column up', async () => {
    // 36 + 45 + 41.
    await expect(db.people.sum((person) => person.age)).resolves.toBe(122);
  });

  it('hands back a number, not the string a bigint SUM arrives as', async () => {
    const total = await db.people.sum((person) => person.age);

    // PostgreSQL widens SUM over an int to bigint, which node-postgres returns
    // as a string. AVG over the same column is numeric, so the two aggregates
    // arrive as strings for different reasons.
    expect(typeof total).toBe('number');
  });

  it('totals an empty query to zero, where average faults', async () => {
    const empty = db.people.where((person) => person.age > 100);

    await expect(empty.count()).resolves.toBe(0);
    // The divergence worth measuring: SQL sums no rows to null, LINQ sums them
    // to zero, and the COALESCE in the statement is what makes this a number
    // rather than the error the same query gives `average`.
    await expect(empty.sum((person) => person.age)).resolves.toBe(0);
    await expect(empty.average((person) => person.age)).rejects.toThrow(SequenceError);
  });

  it('totals every value being null to zero as well', async () => {
    // Alan alone has no city, so this is one row whose only value is null.
    // `average` calls that an error; a total of nothing is zero.
    await expect(
      db.people.where((person) => person.id === 3).sum((person) => (person.city as string).length),
    ).resolves.toBe(0);
  });

  it('totals only the rows that survive a filter', async () => {
    await expect(
      db.people.where((person) => person.age >= 41).sum((person) => person.age),
    ).resolves.toBe(86);
  });

  it('totals the rows paging kept rather than all of them', async () => {
    const total = await db.people
      .orderBy((person) => person.id)
      .take(2)
      .sum((person) => person.age);

    // Ada and Grace, not all three.
    expect(total).toBe(81);
  });

  it('totals across a navigation', async () => {
    // Two visits belong to Ada at 36 and one to Grace at 45.
    await expect(db.visits.sum((visit) => visit.person.age)).resolves.toBe(117);
  });

  it('finds the smallest value in a numeric column', async () => {
    await expect(db.people.min((person) => person.age)).resolves.toBe(36);
  });

  it('keeps the column type rather than normalising to a number', async () => {
    // MIN over an int stays an int, where SUM widens to bigint and AVG to
    // numeric, so this arrives from node-postgres already a number.
    const smallest = await db.people.min((person) => person.age);

    expect(typeof smallest).toBe('number');
  });

  it('finds the first text value in the column collation', async () => {
    // Ada, Alan, Grace. The ordering is the column's collation rather than a
    // JavaScript one, which is the caveat localeCompare carries too.
    await expect(db.people.min((person) => person.name)).resolves.toBe('Ada');
  });

  it('finds the earliest timestamp, handed back as a Date', async () => {
    const earliest = await db.people.min((person) => person.joinedAt);

    // The proof that nothing is normalised on the way back: converting the way
    // count, sum and average do would have made this a number.
    expect(earliest).toBeInstanceOf(Date);
    expect(earliest.getFullYear()).toBe(2024);
    expect(earliest.getMonth()).toBe(0);
  });

  it('faults an empty query, where sum answers zero', async () => {
    const empty = db.people.where((person) => person.age > 100);

    await expect(empty.min((person) => person.age)).rejects.toThrow(SequenceError);
    await expect(empty.sum((person) => person.age)).resolves.toBe(0);
  });

  it('answers null when the rows were there but every value was null', async () => {
    // Alan alone has no city. `average` calls this an error because a number
    // cannot carry the answer; `min` can, and LINQ answers null here.
    await expect(
      db.people.where((person) => person.id === 3).min((person) => (person.city as string).length),
    ).resolves.toBeNull();
  });

  it('takes the smallest of the rows paging kept', async () => {
    const smallest = await db.people
      .orderBy((person) => person.id)
      .reverse()
      .take(2)
      .min((person) => person.age);

    // Alan at 41 and Grace at 45, so 36 is out of range even though it is the
    // smallest in the table.
    expect(smallest).toBe(41);
  });

  it('finds the smallest across a navigation', async () => {
    await expect(db.visits.min((visit) => visit.person.age)).resolves.toBe(36);
  });

  it('finds the largest value in a numeric column', async () => {
    await expect(db.people.max((person) => person.age)).resolves.toBe(45);
  });

  it('brackets the column with min, reading the same rows both ways', async () => {
    // 36, 45, 41.
    await expect(db.people.min((person) => person.age)).resolves.toBe(36);
    await expect(db.people.max((person) => person.age)).resolves.toBe(45);
  });

  it('keeps the column type rather than normalising to a number', async () => {
    const largest = await db.people.max((person) => person.age);

    expect(typeof largest).toBe('number');
  });

  it('finds the last text value in the column collation', async () => {
    // Ada, Alan, Grace.
    await expect(db.people.max((person) => person.name)).resolves.toBe('Grace');
  });

  it('finds the latest timestamp, handed back as a Date', async () => {
    const latest = await db.people.max((person) => person.joinedAt);

    expect(latest).toBeInstanceOf(Date);
    expect(latest.getFullYear()).toBe(2024);
    expect(latest.getMonth()).toBe(11);
  });

  it('faults an empty query, as min does and sum does not', async () => {
    const empty = db.people.where((person) => person.age > 100);

    await expect(empty.max((person) => person.age)).rejects.toThrow(SequenceError);
    await expect(empty.min((person) => person.age)).rejects.toThrow(SequenceError);
    await expect(empty.sum((person) => person.age)).resolves.toBe(0);
  });

  it('answers null when the rows were there but every value was null', async () => {
    await expect(
      db.people.where((person) => person.id === 3).max((person) => (person.city as string).length),
    ).resolves.toBeNull();
  });

  it('takes the largest of the rows paging kept', async () => {
    const largest = await db.people
      .orderBy((person) => person.id)
      .take(1)
      .max((person) => person.age);

    // Ada alone, so 36 rather than the 45 in the table.
    expect(largest).toBe(36);
  });

  it('finds the largest across a navigation', async () => {
    await expect(db.visits.max((visit) => visit.person.age)).resolves.toBe(45);
  });

  it('is true when every row matches', async () => {
    await expect(db.people.all((person) => person.age >= 36)).resolves.toBe(true);
  });

  it('is false when one row does not', async () => {
    // Ada is 36, so one row is enough to answer the whole question.
    await expect(db.people.all((person) => person.age >= 40)).resolves.toBe(false);
  });

  it('is true of a query with no rows', async () => {
    const empty = db.people.where((person) => person.age > 100);

    await expect(empty.count()).resolves.toBe(0);
    await expect(empty.all((person) => person.age > 0)).resolves.toBe(true);
  });

  it('counts a comparison against null as a failure, as the filter does', async () => {
    // Alan has no city, so `city <> 'Nowhere'` is unknown for him rather than
    // true. `all` and `where` agree about that row, which is the point: `all(p)`
    // is true exactly when `where(p)` would have returned everything.
    const matching = await db.people.where((person) => person.city !== 'Nowhere').count();

    expect(matching).toBe(2);
    await expect(db.people.count()).resolves.toBe(3);
    await expect(db.people.all((person) => person.city !== 'Nowhere')).resolves.toBe(false);
  });

  it('asks about the rows a filter left, with a value from the bag', async () => {
    const older = db.people.where((person) => person.age > 40);

    await expect(older.all((person, args) => person.age >= args.min, { min: 41 })).resolves.toBe(
      true,
    );
    await expect(older.all((person, args) => person.age >= args.min, { min: 45 })).resolves.toBe(
      false,
    );
  });

  it('asks about the rows a page settled on', async () => {
    const youngest = db.people.orderBy((person) => person.age).take(1);

    // Ada alone, so a bound that the other two fail is still true here.
    await expect(youngest.all((person) => person.age < 40)).resolves.toBe(true);
    await expect(db.people.all((person) => person.age < 40)).resolves.toBe(false);
  });
});
