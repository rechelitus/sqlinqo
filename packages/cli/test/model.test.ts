import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/generate/model.js';
import type { GeneratedCollection, GeneratedReference } from '../src/generate/model.js';
import { column, exampleSchema, foreignKey, schema, table } from './support.js';

/** Reads one entity out of a model by name, failing loudly when it is absent. */
function entity(model: ReturnType<typeof buildModel>, name: string) {
  const found = model.entities.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No entity named ${name} in ${model.entities.map((e) => e.name)}`);
  return found;
}

describe('buildModel', () => {
  it('names the entity, the table, the context key and the file', () => {
    const model = buildModel(schema([table('order_items', [column('id', 'int4')])]));
    expect(model.entities).toHaveLength(1);
    expect(model.entities[0]).toMatchObject({
      name: 'OrderItem',
      table: 'order_items',
      contextKey: 'orderItems',
      file: 'order-item',
    });
  });

  it('states the physical name only where it differs from the property', () => {
    const model = buildModel(exampleSchema());
    const columns = entity(model, 'User').columns;

    expect(columns.find((c) => c.property === 'name')).toMatchObject({
      property: 'name',
      column: 'name',
    });
    expect(columns.find((c) => c.property === 'cityId')).toMatchObject({
      property: 'cityId',
      column: 'city_id',
      nullable: true,
    });
  });

  it('records every value the database produces as generated', () => {
    const model = buildModel(exampleSchema());
    const columns = entity(model, 'User').columns;

    // An identity, a default and a stored generated column are all values the
    // caller does not supply, which is the one thing `generated` records.
    expect(columns.find((c) => c.property === 'id')).toMatchObject({
      primaryKey: true,
      generated: true,
    });
    expect(columns.find((c) => c.property === 'isActive')?.generated).toBe(true);
    expect(columns.find((c) => c.property === 'age')?.generated).toBe(false);
  });

  it('gives a foreign key both of its ends', () => {
    const model = buildModel(exampleSchema());

    const reference = entity(model, 'User').relations[0] as GeneratedReference;
    expect(reference).toEqual({
      kind: 'reference',
      property: 'city',
      target: 'City',
      targetFile: 'city',
      from: 'cityId',
      optional: true,
    });

    const collection = entity(model, 'City').relations[0] as GeneratedCollection;
    expect(collection).toEqual({
      kind: 'collection',
      property: 'users',
      target: 'User',
      targetFile: 'user',
      from: 'cityId',
    });
  });

  it('omits `to` when the key points at the target primary key', () => {
    const model = buildModel(exampleSchema());
    expect(entity(model, 'User').relations[0]).not.toHaveProperty('to');
    expect(entity(model, 'City').relations[0]).not.toHaveProperty('to');
  });

  it('states `to` when the key points somewhere other than the primary key', () => {
    const model = buildModel(
      schema([
        table('users', [column('id', 'int4', { primaryKey: true }), column('email', 'text')]),
        table(
          'sessions',
          [column('id', 'int4', { primaryKey: true }), column('user_email', 'text')],
          [foreignKey('sessions_user_email_fkey', ['sessions', 'user_email'], ['users', 'email'])],
        ),
      ]),
    );

    expect(entity(model, 'Session').relations[0]).toMatchObject({ from: 'userEmail', to: 'email' });
    expect(entity(model, 'User').relations[0]).toMatchObject({ from: 'userEmail', to: 'email' });
  });

  it('marks a reference optional exactly when its key is nullable', () => {
    const model = buildModel(
      schema([
        table('cities', [column('id', 'int4', { primaryKey: true })]),
        table(
          'users',
          [column('id', 'int4', { primaryKey: true }), column('city_id', 'int4')],
          [foreignKey('fk', ['users', 'city_id'], ['cities', 'id'])],
        ),
      ]),
    );
    expect(entity(model, 'User').relations[0]).toMatchObject({ optional: false });
  });

  it('handles a table that points at itself', () => {
    const model = buildModel(
      schema([
        table(
          'employees',
          [
            column('id', 'int4', { primaryKey: true }),
            column('manager_id', 'int4', { nullable: true }),
          ],
          [foreignKey('fk', ['employees', 'manager_id'], ['employees', 'id'])],
        ),
      ]),
    );

    const relations = entity(model, 'Employee').relations;
    expect(relations.map((relation) => relation.property)).toEqual(['manager', 'employees']);
    expect(relations.every((relation) => relation.target === 'Employee')).toBe(true);
  });

  it('keeps a relation from colliding with a column of the same name', () => {
    // `defineEntity` rejects an entity that declares both, so the generator has
    // to settle the clash before it emits anything.
    const model = buildModel(
      schema([
        table('cities', [column('id', 'int4', { primaryKey: true })]),
        table(
          'users',
          [
            column('id', 'int4', { primaryKey: true }),
            column('city_id', 'int4'),
            column('city', 'text'),
          ],
          [foreignKey('fk', ['users', 'city_id'], ['cities', 'id'])],
        ),
      ]),
    );

    const user = entity(model, 'User');
    expect(user.columns.map((c) => c.property)).toContain('city');
    expect(user.relations[0]?.property).toBe('city2');
  });

  it('leaves out a column it cannot map, and says so', () => {
    const model = buildModel(
      schema([
        table('users', [column('id', 'int4', { primaryKey: true }), column('avatar', 'bytea')]),
      ]),
    );

    expect(entity(model, 'User').columns.map((c) => c.property)).toEqual(['id']);
    expect(model.warnings).toHaveLength(1);
    expect(model.warnings[0]).toContain('users.avatar');
    expect(model.warnings[0]).toContain('bytea');
  });

  it('declines a composite foreign key rather than half-mapping it', () => {
    const model = buildModel(
      schema([
        table('cities', [
          column('country', 'text', { primaryKey: true }),
          column('name', 'text', { primaryKey: true }),
        ]),
        table(
          'users',
          [column('city_country', 'text'), column('city_name', 'text')],
          [
            {
              name: 'users_city_fkey',
              table: 'users',
              columns: ['city_country', 'city_name'],
              targetTable: 'cities',
              targetColumns: ['country', 'name'],
            },
          ],
        ),
      ]),
    );

    expect(entity(model, 'User').relations).toEqual([]);
    expect(entity(model, 'City').relations).toEqual([]);
    expect(model.warnings.some((warning) => warning.includes('users_city_fkey'))).toBe(true);
  });

  it('drops an entity whose every column was unmappable', () => {
    const model = buildModel(schema([table('blobs', [column('data', 'bytea')])]));
    expect(model.entities).toEqual([]);
    expect(model.warnings.some((warning) => warning.includes('no entity was generated'))).toBe(
      true,
    );
  });

  it('warns about a table with no primary key but still generates it', () => {
    const model = buildModel(schema([table('audit_log', [column('message', 'text')])]));
    expect(model.entities).toHaveLength(1);
    expect(model.warnings.some((warning) => warning.includes('no primary key'))).toBe(true);
  });

  it('reads foreign keys as plain columns when relations are off', () => {
    const model = buildModel(exampleSchema(), { relations: false });
    expect(model.entities.every((e) => e.relations.length === 0)).toBe(true);
    expect(entity(model, 'User').columns.map((c) => c.property)).toContain('cityId');
  });

  it('names the schema only when asked to', () => {
    expect(buildModel(exampleSchema()).entities[0]?.schema).toBeUndefined();
    expect(buildModel(exampleSchema(), { qualifySchema: true }).entities[0]?.schema).toBe('public');
  });

  it('scaffolds a clean schema without a single warning', () => {
    expect(buildModel(exampleSchema()).warnings).toEqual([]);
  });
});
