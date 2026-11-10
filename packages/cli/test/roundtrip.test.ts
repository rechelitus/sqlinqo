import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyEntity, Driver, PreparedStatement, ResultRow } from '@sqlinqo/core';
import { BaseDialect, createDbContext } from '@sqlinqo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { FakeReader, exampleSchema } from './support.js';

/**
 * Proves the generated code is code.
 *
 * Asserting on the text a generator produces only says it looks right. These
 * tests import what it wrote, hand it to the engine, and read the SQL back out,
 * which is the only check that the output means what it says: a wrong `column`
 * or a navigation pointing at the wrong property compiles here and shows up in
 * the statement.
 */
class TestDialect extends BaseDialect {
  readonly name = 'test';

  override quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  override parameterPlaceholder(index: number): string {
    return `$${index + 1}`;
  }
}

class SilentDriver implements Driver {
  readonly name = 'silent';

  async execute(_statement: PreparedStatement): Promise<ResultRow[]> {
    return [];
  }

  async close(): Promise<void> {}
}

describe('generated entities', () => {
  let directory: string;
  let entities: Record<string, AnyEntity>;

  /**
   * A context over the imported entities.
   *
   * Typed loosely on purpose: the barrel is read at run time, so its shape is
   * not something the compiler can know. What these tests check is the SQL the
   * engine produces, which is exactly the part a type would not have caught.
   */
  const context = (): any =>
    createDbContext({ driver: new SilentDriver(), dialect: new TestDialect(), entities });

  beforeAll(async () => {
    // Written inside the package rather than into the system temp directory:
    // the generated files import `@sqlinqo/core`, which resolves through the
    // workspace, and the test runner only transforms what is under its root.
    directory = path.join(fileURLToPath(new URL('.', import.meta.url)), '.generated');
    await rm(directory, { recursive: true, force: true });
    await scaffold({ out: directory, reader: new FakeReader(exampleSchema()) });

    // The barrel is the entry a caller would use, so it is the entry tested.
    const module = (await import(/* @vite-ignore */ path.join(directory, 'index.ts'))) as {
      entities: Record<string, AnyEntity>;
    };
    entities = module.entities;
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('exports every entity under its context key', () => {
    expect(Object.keys(entities).sort()).toEqual(['cities', 'users']);
  });

  it('carries the mapping the schema described', () => {
    const user = entities['users'] as AnyEntity;
    expect(user.name).toBe('User');
    expect(user.table).toBe('users');
    expect(user.primaryKey).toEqual(['id']);
    expect(user.columns['cityId']).toEqual({ type: 'int', column: 'city_id', nullable: true });
  });

  it('resolves a navigation thunk across two files that import each other', () => {
    // The circular import is the point: `city.ts` imports `user.ts` and back
    // again, which is legal only because neither reads the other's binding
    // while the module is evaluating.
    expect(entities['users']?.relations['city']?.target()).toBe(entities['cities']);
    expect(entities['cities']?.relations['users']?.target()).toBe(entities['users']);
  });

  // The lambdas below are read as source text by the engine, so they are
  // written the way a caller would write them. Only their parameter types are
  // loosened, since the entity they range over was imported at run time.

  it('compiles a query over the generated model', () => {
    const statement = context()
      .users.where((u: any, p: any) => u.age >= p.minimumAge && u.isActive, { minimumAge: 18 })
      .orderBy((u: any) => u.name)
      .take(20)
      .toSQL();

    expect(statement.text).toContain('FROM "users"');
    // The physical names, which is the whole point: the lambda said `isActive`.
    expect(statement.text).toContain('"is_active"');
    expect(statement.text).toContain('LIMIT 20');
    expect(statement.values).toEqual([18]);
  });

  it('left joins an optional reference and reads the target through it', () => {
    const statement = context()
      .users.select((u: any) => ({ name: u.name, city: u.city.name }))
      .toSQL();

    // Optional, because `city_id` is nullable, so the row need not exist.
    expect(statement.text).toContain('LEFT JOIN "cities"');
  });
});
