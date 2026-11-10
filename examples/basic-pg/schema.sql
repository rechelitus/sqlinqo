-- Schema for the `User` entity declared in src/main.ts.
--
--   psql "$DATABASE_URL" -f examples/basic-pg/schema.sql
--
-- Every column mirrors one entry of the entity's column map: the physical name
-- comes from `column` where it is given, and only `cityId` is declared
-- `nullable`, so every other column is NOT NULL.

DROP TABLE IF EXISTS users;

CREATE TABLE users (
  -- `generated: true` on the model side: the database produces the value.
  id         integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  email      text        NOT NULL,
  age        integer     NOT NULL,
  -- The only column mapped as `nullable: true`.
  city_id    integer     NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  -- `timestamptz` rather than `timestamp`: node-postgres returns a JavaScript
  -- Date for both, and storing an instant with its offset is the right default
  -- for a creation time.
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the example's main filter, `age >= $1 AND is_active`, and lets the
-- `ORDER BY name` that follows it read in order.
CREATE INDEX users_active_age_name_idx ON users (is_active, age, name);

INSERT INTO users (name, email, age, city_id, is_active) VALUES
  ('Ada Lovelace',    'ada@example.com',    36,    1, true),
  ('Grace Hopper',    'grace@example.com',  45,    2, true),
  ('Alan Turing',     'alan@example.com',   41, NULL, true),
  ('Edsger Dijkstra', 'edsger@example.com', 72,    3, true),
  ('Barbara Liskov',  'barbara@example.com', 17,   1, false);

-- Schema for the `City` entity, joined to `users` through `users.city_id`.

DROP TABLE IF EXISTS cities;

CREATE TABLE cities (
  id      integer PRIMARY KEY,
  name    text    NOT NULL,
  country text    NOT NULL
);

INSERT INTO cities (id, name, country) VALUES
  (1, 'London',   'United Kingdom'),
  (2, 'New York', 'United States'),
  (3, 'Rotterdam', 'Netherlands');
